import sys
import types
import pytest
from unittest.mock import MagicMock, patch


class RecordingBackend:
    """Stands in for AnthropicBackend / GroqBackend in tests.

    Records what the engine asked for and ALSO replays the call into a
    MagicMock shaped like the old Groq client, so assertions written against
    `client.chat.completions.create.call_args` keep working unchanged. Those
    assertions are about prompt *content* - which system prompt, which turns,
    in what order - and none of that changed when the provider did. Only the
    transport did, and the transport is what this class stands in for.

    `last_system` / `last_messages` are the direct way to read the same thing
    in new tests; prefer them over reaching through `.chat`.
    """

    def __init__(self, text: str = "", chunks=None):
        self.text = text
        self.chunks = chunks
        self.chat = MagicMock()
        self.last_system = ""
        self.last_messages = []
        self.last_max_tokens = 0

    def _record(self, system, messages, max_tokens):
        self.last_system = system
        self.last_messages = list(messages)
        self.last_max_tokens = max_tokens
        # Replayed in the pre-Anthropic shape: system first, then the turns.
        self.chat.completions.create(
            model="test-model",
            max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, *messages],
        )

    def complete(self, system, messages, max_tokens):
        self._record(system, messages, max_tokens)
        return self.text

    def stream(self, system, messages, max_tokens):
        self._record(system, messages, max_tokens)
        for chunk in (self.chunks if self.chunks is not None else [self.text]):
            yield chunk


def _make_mock_client(text: str):
    return RecordingBackend(text)


class TestHintingEngine:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def test_returns_hint_and_tags(self):
        engine = self._engine("Have you checked line 3? What do you think should happen next?")
        hint, tags = engine.generate_hint("x = 1\n", "Why is x wrong?", 1)
        assert "What do you think should happen next?" in hint
        assert isinstance(tags, list)
        assert len(tags) >= 1

    def test_does_not_append_a_stock_closing_sentence(self):
        engine = self._engine("Look at your loop carefully.")
        hint, _ = engine.generate_hint("for i in range(10):", "help", 1)
        assert hint == "Look at your loop carefully."

    def test_leaves_the_models_own_closing_question_alone(self):
        # Only the append is going. Text the model chose to write is untouched.
        text = "Consider the index. What do you think should happen next?"
        engine = self._engine(text)
        hint, _ = engine.generate_hint("x[5]", "help", 2)
        assert hint == text

    def test_level_clamped_to_max_hint_level(self):
        from hinting_engine import HintingEngine, clamp_hint_level
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client("hint text. What do you think should happen next?")
        engine.generate_hint("", "q", 99)
        # Level 99 clamps to MAX_HINT_LEVEL (4), which switches to worked-example mode.
        # Worked-example mode doesn't include the hint_level in the user message.
        assert clamp_hint_level(99) == 4
        call_kwargs = engine.client.chat.completions.create.call_args
        system_content = call_kwargs.kwargs["messages"][0]["content"]
        assert "WORKED EXAMPLE" in system_content

    def test_concept_tag_extraction_variables(self):
        engine = self._engine("Think about your variables. What do you think should happen next?")
        _, tags = engine.generate_hint("x = 1", "what are variables?", 1)
        assert "variables" in tags

    def test_concept_tag_extraction_loops(self):
        engine = self._engine("Think about your for-loop. What do you think should happen next?")
        _, tags = engine.generate_hint("for i in range(5):", "help with for-loop", 1)
        assert "for-loop" in tags

    def test_concept_tag_fallback_general(self):
        engine = self._engine("Think again. What do you think should happen next?")
        _, tags = engine.generate_hint("", "something random", 1)
        assert "general" in tags

    def test_empty_code_accepted(self):
        engine = self._engine("What do you think should happen next?")
        hint, tags = engine.generate_hint("", "help", 1)
        assert isinstance(hint, str)

    def test_api_error_propagates(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = MagicMock()
        engine.client.complete.side_effect = RuntimeError("API down")
        with pytest.raises(RuntimeError, match="API down"):
            engine.generate_hint("x=1", "help", 1)


class TestLLMConceptTags:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def test_concepts_line_parsed_and_stripped(self):
        engine = self._engine(
            "Check your loop bounds. What do you think should happen next?\n"
            "[concepts: off-by-one, for-loop]"
        )
        hint, tags = engine.generate_hint("for i in range(11):", "help", 1)
        assert tags == ["off-by-one", "for-loop"]
        assert "[concepts" not in hint

    def test_invalid_tags_filtered(self):
        engine = self._engine(
            "Think. What do you think should happen next?\n"
            "[concepts: off-by-one, flux-capacitor]"
        )
        _, tags = engine.generate_hint("x", "help", 1)
        assert "off-by-one" in tags
        assert "flux-capacitor" not in tags

    def test_all_invalid_tags_fall_back_to_keywords(self):
        engine = self._engine(
            "Look at your variables. What do you think should happen next?\n"
            "[concepts: flux-capacitor]"
        )
        _, tags = engine.generate_hint("x = 1", "what are variables?", 1)
        assert "variables" in tags

    def test_missing_concepts_line_falls_back_to_keywords(self):
        engine = self._engine(
            "Think about your for-loop. What do you think should happen next?"
        )
        _, tags = engine.generate_hint("for i in range(5):", "help with for-loop", 1)
        assert "for-loop" in tags

    def test_concepts_line_stripped_from_hint(self):
        engine = self._engine("Look closely.\n[concepts: loops]")
        hint, tags = engine.generate_hint("while True: pass", "help", 1)
        assert hint == "Look closely."
        assert "[concepts" not in hint
        assert tags == ["loops"]

    def test_system_prompt_instructs_concepts_line(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x = 1", "help", 1)
        system = engine.client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
        assert "[concepts:" in system

    def test_language_specific_tags_accepted(self):
        engine = self._engine(
            "Consider it. What do you think should happen next?\n[concepts: pointers]"
        )
        _, tags = engine.generate_hint("int *p;", "help", 1, language="c")
        assert tags == ["pointers"]


class TestMultiLanguage:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _sent_messages(self, engine):
        call_kwargs = engine.client.chat.completions.create.call_args
        return call_kwargs.kwargs["messages"]

    def test_default_language_is_python(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x = 1", "help", 1)
        messages = self._sent_messages(engine)
        assert "Python students" in messages[0]["content"]
        assert "language: Python" in messages[-1]["content"]

    def test_java_prompt_uses_java(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("int x = 1;", "help", 1, language="java")
        messages = self._sent_messages(engine)
        assert "Java students" in messages[0]["content"]
        assert "never real Java syntax" in messages[0]["content"]
        assert "language: Java" in messages[-1]["content"]

    def test_alias_language_normalized(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("let x = 1;", "help", 1, language="js")
        messages = self._sent_messages(engine)
        assert "JavaScript students" in messages[0]["content"]

    def test_language_specific_concept_tags(self):
        engine = self._engine(
            "Think about it. What do you think should happen next?"
        )
        _, tags = engine.generate_hint(
            "int *p;", "why segfault? my pointers are wrong", 1, language="c"
        )
        assert "pointers" in tags
        assert "segfault" in tags

    def test_scan_prompt_uses_language(self):
        engine = self._engine('{"flags":[]}')
        engine.scan_code("int main() { return 0; }", language="cpp")
        messages = self._sent_messages(engine)
        assert "C++ code" in messages[0]["content"]
        assert "1: int main() { return 0; }" in messages[1]["content"]

    def test_line_hint_prompt_uses_language(self):
        engine = self._engine('{"hint":"check the type","concept":"variables"}')
        engine.generate_line_hint("string s = null;", 1, language="csharp")
        messages = self._sent_messages(engine)
        assert "C#" in messages[0]["content"]


class TestScanKinds:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def test_kind_parsed_and_defaults_to_bug(self):
        engine = self._engine(
            '{"flags":[{"line":1,"end_line":1,"question":"Whats the loop bound?",'
            '"concept":"off-by-one","severity":"warning","kind":"bug"},'
            '{"line":2,"end_line":2,"question":"Does this name say what it holds?",'
            '"concept":"variables","severity":"info","kind":"style"},'
            '{"line":3,"end_line":3,"question":"No kind given?",'
            '"concept":"general","severity":"info"}]}'
        )
        flags = engine.scan_code("a\nb\nc\n")
        assert flags[0]["kind"] == "bug"
        assert flags[1]["kind"] == "style"
        assert flags[2]["kind"] == "bug"

    def test_invalid_kind_coerced_to_bug(self):
        engine = self._engine(
            '{"flags":[{"line":1,"end_line":1,"question":"q?","kind":"vibes"}]}'
        )
        flags = engine.scan_code("a\n")
        assert flags[0]["kind"] == "bug"

    def test_style_flags_capped_at_two(self):
        items = ",".join(
            f'{{"line":{i},"end_line":{i},"question":"q{i}?","kind":"style"}}'
            for i in range(1, 5)
        )
        engine = self._engine(f'{{"flags":[{items}]}}')
        flags = engine.scan_code("a\nb\nc\nd\n")
        assert sum(1 for f in flags if f["kind"] == "style") == 2

    def test_scan_prompt_mentions_style(self):
        engine = self._engine('{"flags":[]}')
        engine.scan_code("x = 1")
        system = engine.client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
        assert "style" in system.lower()


class TestTutorModes:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _system(self, engine):
        return engine.client.chat.completions.create.call_args.kwargs["messages"][0]["content"]

    def test_default_mode_is_socratic_hint(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x=1", "help", 1)
        assert "Socratic" in self._system(engine)
        assert "hint_level" in self._system(engine)

    def test_reflect_mode_prompt(self):
        engine = self._engine("Why did that work?")
        engine.generate_hint("x=1", "quiz me", 1, mode="reflect")
        assert "FIXED" in self._system(engine)

    def test_translate_mode_prompt(self):
        engine = self._engine("Close. What does your loop do first?")
        engine.generate_hint("x=1", "my translation", 1, mode="translate")
        assert "translation" in self._system(engine)

    def test_worked_example_mode_prompt(self):
        engine = self._engine("Consider counting apples instead.")
        engine.generate_hint("x=1", "show me", 1, mode="worked-example")
        assert "WORKED EXAMPLE" in self._system(engine)

    def test_explain_error_mode_prompt(self):
        engine = self._engine("The last line names the exception.")
        engine.generate_hint("", "Traceback ...", 1, mode="explain-error")
        assert "error message" in self._system(engine).lower()

    def test_non_hint_mode_skips_closing_question(self):
        engine = self._engine("Why does swapping the operands fix it?")
        hint, _ = engine.generate_hint("x=1", "quiz me", 1, mode="reflect")
        assert "What do you think should happen next?" not in hint

    def test_all_modes_emit_concepts_footer(self):
        engine = self._engine("ok\n[concepts: variables]")
        for mode in ("hint", "reflect", "translate", "worked-example",
                     "explain-error", "explain-concept", "predict-output",
                     "review-exercise"):
            engine.generate_hint("x=1", "q", 1, mode=mode)
            assert "[concepts:" in self._system(engine), mode

    def test_unknown_mode_falls_back_to_hint(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x=1", "q", 1, mode="bogus")
        assert "Socratic" in self._system(engine)

    def test_concept_tags_still_parsed_in_modes(self):
        engine = self._engine("Why did it work?\n[concepts: off-by-one]")
        hint, tags = engine.generate_hint("x=1", "quiz me", 1, mode="reflect")
        assert tags == ["off-by-one"]
        assert "[concepts" not in hint


class TestStreamHint:
    def _engine(self, chunks):
        from hinting_engine import HintingEngine
        engine = HintingEngine(client=RecordingBackend(chunks=list(chunks)))
        return engine

    def test_deltas_then_done(self):
        text = "Look at your loop bounds carefully. What do you think should happen next?"
        engine = self._engine([text, "\n[concepts: off-by-one]"])
        events = list(engine.stream_hint("for i in range(11):", "help", 1))
        assert events[-1]["type"] == "done"
        assert events[-1]["concept_tags"] == ["off-by-one"]
        assert "[concepts" not in events[-1]["hint"]
        deltas = "".join(e["text"] for e in events if e["type"] == "delta")
        assert "[concepts" not in deltas
        assert deltas.startswith("Look at your loop")

    def test_stream_requests_streaming(self):
        # Streaming is its own backend method now rather than a `stream=True`
        # kwarg, so the thing to assert is that text actually arrived as
        # deltas. It has to exceed STREAM_HOLDBACK_CHARS to do so: the last 40
        # characters are withheld until the end so the "[concepts: ...]"
        # footer never flashes in the panel.
        engine = self._engine(["Look at the loop bounds on line 11. ", "What runs first?"])
        events = list(engine.stream_hint("x=1", "q", 1))
        assert [e["text"] for e in events if e["type"] == "delta"] != []
        assert engine.client.last_messages[-1]["role"] == "user"

    def test_done_hint_matches_generate_hint_contract(self):
        text = "Consider the index."
        stream_engine = self._engine([text])
        streamed = list(stream_engine.stream_hint("x[5]", "help", 2))[-1]["hint"]

        from hinting_engine import HintingEngine
        one_shot = HintingEngine(client=_make_mock_client(text))
        generated, _ = one_shot.generate_hint("x[5]", "help", 2)

        assert streamed == generated == text


class TestConversationHistory:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _sent_messages(self, engine):
        call_kwargs = engine.client.chat.completions.create.call_args
        return call_kwargs.kwargs["messages"]

    def test_history_turns_included_in_order(self):
        engine = self._engine("ok. What do you think should happen next?")
        history = [
            {"role": "student", "content": "Why does my loop never end?"},
            {"role": "tutor", "content": "What changes your loop variable?"},
        ]
        engine.generate_hint("while x < 5: pass", "I still don't get it", 2, history=history)
        messages = self._sent_messages(engine)
        assert messages[0]["role"] == "system"
        assert messages[1] == {"role": "user", "content": "Why does my loop never end?"}
        assert messages[2] == {"role": "assistant", "content": "What changes your loop variable?"}
        assert messages[3]["role"] == "user"
        assert "I still don't get it" in messages[3]["content"]

    def test_history_capped_to_last_six_turns(self):
        from hinting_engine import MAX_HISTORY_TURNS
        engine = self._engine("ok. What do you think should happen next?")
        history = [
            {"role": "student", "content": f"question {i}"} for i in range(20)
        ]
        engine.generate_hint("x=1", "help", 1, history=history)
        messages = self._sent_messages(engine)
        # system + capped history + current user message
        assert len(messages) == 1 + MAX_HISTORY_TURNS + 1
        assert messages[1]["content"] == "question 14"

    def test_empty_history_turns_skipped(self):
        engine = self._engine("ok. What do you think should happen next?")
        history = [{"role": "student", "content": "   "}]
        engine.generate_hint("x=1", "help", 1, history=history)
        messages = self._sent_messages(engine)
        assert len(messages) == 2  # system + current question only

    def test_no_history_behaves_as_before(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x=1", "help", 1)
        messages = self._sent_messages(engine)
        assert len(messages) == 2


class TestEditSummary:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def test_edit_summary_reaches_the_prompt(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint(
            "x = 1", "still broken", 2, edit_summary="12 - range(n)\n12 + range(n+1)"
        )
        content = self._user_message(engine)
        assert "changed since the last hint" in content
        assert "range(n+1)" in content

    def test_no_edit_summary_adds_no_section(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x = 1", "help", 1)
        assert "changed since the last hint" not in self._user_message(engine)

    def test_whitespace_only_summary_is_ignored(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("x = 1", "help", 1, edit_summary="   \n  ")
        assert "changed since the last hint" not in self._user_message(engine)

    def test_edit_summary_included_for_non_hint_modes(self):
        engine = self._engine("ok")
        engine.generate_hint(
            "x = 1", "here is my fix", 1, mode="reflect", edit_summary="3 + fixed"
        )
        assert "3 + fixed" in self._user_message(engine)

    def test_streaming_passes_edit_summary_through(self):
        engine = self._engine("ok")
        chunk = MagicMock()
        chunk.choices[0].delta.content = "hi"
        engine.client.chat.completions.create.return_value = [chunk]
        list(engine.stream_hint("x=1", "q", 1, edit_summary="9 + total = 0"))
        assert "9 + total = 0" in self._user_message(engine)


class TestTheTutorCanSeeLineNumbers:
    """`focus_instruction` ends with "cite real line numbers when you point at
    code", and the tutor was handed an unnumbered block to do it from.

    So it counted lines by eye across the whole file and got them wrong
    constantly - opening with "On line 5, you're looping over the list" when
    line 5 was a different function's `def` and the loop was on line 11. A
    wrong line number is worse than none: it sends the student to code that
    has nothing to do with the point being made, and every following turn
    argues about a line neither of them is looking at.

    `scan_code` (:386) and `generate_line_hint` (:466) have numbered their
    input from the start. This is the same thing for the tutor the student
    actually talks to.
    """

    FILE = (
        "def add_numbers(a, b):\n"
        "    return a + b\n"
        "\n"
        "\n"
        "def average(numbers):\n"
        "    total = 0\n"
        "    for i in range(len(numbers)):\n"
        "        total = total + numbers[i]\n"
    )

    def _engine(self, response_text: str = "ok"):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def test_each_line_carries_its_editor_number(self):
        engine = self._engine()
        engine.generate_hint(self.FILE, "help", 1)
        content = self._user_message(engine)
        assert "1: def add_numbers(a, b):" in content
        assert "5: def average(numbers):" in content
        assert "7:     for i in range(len(numbers)):" in content

    def test_leading_blank_lines_do_not_shift_the_numbering(self):
        # The client sends the whole document, so line 1 here has to be line 1
        # in the editor. Stripping the code first shifted every number after a
        # leading blank line - and the tutor quoted the shifted ones back.
        engine = self._engine()
        engine.generate_hint("\n\nx = 1\n", "help", 1)
        assert "3: x = 1" in self._user_message(engine)

    def test_indentation_survives_the_numbering(self):
        # "line 8 is indented under the for" is a thing the tutor says; it
        # cannot say it if the numbering ate the leading spaces.
        engine = self._engine()
        engine.generate_hint(self.FILE, "help", 1)
        assert "8:         total = total + numbers[i]" in self._user_message(engine)

    def test_blank_lines_are_numbered_too(self):
        # Skipping them would put every later line one number out.
        engine = self._engine()
        engine.generate_hint(self.FILE, "help", 1)
        assert "\n3: \n" in self._user_message(engine) or "3: " in self._user_message(engine)
        assert "5: def average(numbers):" in self._user_message(engine)

    def test_every_mode_gets_the_numbering(self):
        engine = self._engine()
        engine.generate_hint(self.FILE, "help", 1, mode="explain-error")
        assert "5: def average(numbers):" in self._user_message(engine)

    def test_streaming_gets_the_numbering(self):
        engine = self._engine()
        chunk = MagicMock()
        chunk.choices[0].delta.content = "hi"
        engine.client.chat.completions.create.return_value = [chunk]
        list(engine.stream_hint(self.FILE, "q", 1))
        assert "5: def average(numbers):" in self._user_message(engine)

    def test_empty_code_still_says_so(self):
        engine = self._engine()
        engine.generate_hint("   \n  ", "help", 1)
        assert "(no code provided)" in self._user_message(engine)


class TestABigFileIsWindowedNotSentWhole:
    """The whole document rode on every request, numbered, unbounded.

    A 241-line student file spent 2,289 tokens on code in EVERY turn of a
    conversation - three times the entire system prompt - to re-send methods
    nobody was discussing. Over `MAX_CODE_LINES_SENT` the file is now
    windowed around the block the student is working on.

    The numbers must stay absolute through it: citing real line numbers is
    the whole reason numbering exists (see the class above), and a window
    that renumbers from 1 breaks exactly that. And an elision has to be
    announced - a tutor that cannot see the top of the file will otherwise
    report a missing import that is merely out of frame.
    """

    def _engine(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client("ok")
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def _file(self, n):
        return "".join(f"line_{i} = {i}\n" for i in range(1, n + 1))

    def _sent(self, code, focus=None):
        engine = self._engine()
        engine.generate_hint(code, "help", 1, focus=focus)
        return self._user_message(engine)

    def test_a_small_file_still_goes_whole(self):
        # Every exercise file we have seen is under the bound, so the common
        # case must be byte-for-byte what it was before windowing existed.
        from hinting_engine import MAX_CODE_LINES_SENT
        sent = self._sent(self._file(MAX_CODE_LINES_SENT))
        assert "1: line_1 = 1" in sent
        assert f"{MAX_CODE_LINES_SENT}: line_{MAX_CODE_LINES_SENT} = " in sent
        assert "not shown" not in sent

    def test_a_big_file_drops_the_lines_nobody_is_discussing(self):
        from hinting_engine import MAX_CODE_LINES_SENT
        sent = self._sent(self._file(400), focus={"start_line": 200, "end_line": 210})
        assert "200: line_200 = 200" in sent
        assert "210: line_210 = 210" in sent
        assert "5: line_5 = 5" not in sent
        assert "390: line_390 = 390" not in sent
        body = [ln for ln in sent.splitlines() if ln[:1].isdigit()]
        assert len(body) <= MAX_CODE_LINES_SENT

    def test_the_numbers_stay_the_editors_numbers(self):
        # The window starts partway down the file; if it renumbered from 1,
        # every hint would send the student to the wrong line.
        sent = self._sent(self._file(400), focus={"start_line": 200, "end_line": 201})
        assert "200: line_200 = 200" in sent
        assert "1: line_200" not in sent

    def test_context_survives_around_the_focus(self):
        # Clipping to the focus alone is how you get a tutor that cannot see
        # why the argument two lines above is the wrong type.
        sent = self._sent(self._file(400), focus={"start_line": 200, "end_line": 200})
        assert "190: line_190 = 190" in sent
        assert "210: line_210 = 210" in sent

    def test_the_elision_is_announced_on_both_sides(self):
        sent = self._sent(self._file(400), focus={"start_line": 200, "end_line": 210})
        assert "lines 1-" in sent and "not shown" in sent
        assert "-400 of this file are not shown" in sent

    def test_no_focus_falls_back_to_the_head_of_the_file(self):
        from hinting_engine import MAX_CODE_LINES_SENT
        sent = self._sent(self._file(400))
        assert "1: line_1 = 1" in sent
        assert f"{MAX_CODE_LINES_SENT}: line_{MAX_CODE_LINES_SENT} = " in sent
        assert "not shown" in sent

    def test_a_focus_at_the_top_does_not_run_off_the_start(self):
        sent = self._sent(self._file(400), focus={"start_line": 1, "end_line": 3})
        assert "1: line_1 = 1" in sent
        # Nothing above line 1 to elide. Bracketed, because the focus
        # instruction says "you are working on lines 1-3" further down.
        assert "[lines 1-" not in sent

    def test_a_focus_at_the_end_does_not_run_off_the_finish(self):
        sent = self._sent(self._file(400), focus={"start_line": 398, "end_line": 400})
        assert "400: line_400 = 400" in sent
        assert "not shown]" in sent
        assert "-400 of this file are not shown" not in sent

    def test_a_nonsense_focus_does_not_lose_the_file(self):
        # An older extension, or a block that could not be resolved. Falling
        # back to the head beats sending nothing.
        for focus in ({"start_line": "x"}, {"end_line": 4}, {"start_line": 900}):
            sent = self._sent(self._file(400), focus=focus)
            assert "line_" in sent

    def test_a_focus_bigger_than_the_budget_still_fits_the_budget(self):
        from hinting_engine import MAX_CODE_LINES_SENT
        sent = self._sent(self._file(400), focus={"start_line": 10, "end_line": 380})
        body = [ln for ln in sent.splitlines() if ln[:1].isdigit()]
        assert len(body) <= MAX_CODE_LINES_SENT


class TestLineHintMayStaySilent:
    """The line hint fires on every cursor move, so it lands on correct lines
    constantly - and its prompt had no way to say "nothing to report here".

    The schema was `{"hint":"<=12 words>","concept":"<tag>"}` with the
    instruction "respond with ONE Socratic nudge", unconditionally. So resting
    the cursor on a correct `total = 0` produced an invented doubt
    ("initialize with first number") that was not only wrong but worse than
    the code it questioned. `scan_code`'s prompt has had "If nothing is
    suspicious, output {"flags":[]}" all along; this is the same escape hatch.

    The client is already built for it: `inlineTutor.ts:415-423` clears the
    hint and shows an empty lens when the hint comes back blank.
    """

    def test_the_prompt_offers_an_empty_hint(self):
        from hinting_engine import LINE_HINT_SYSTEM_PROMPT_TEMPLATE
        prompt = LINE_HINT_SYSTEM_PROMPT_TEMPLATE.format(language="Python")
        assert '"hint":""' in prompt.replace(" ", "")
        assert "fine" in prompt.lower() or "nothing" in prompt.lower()

    def test_an_empty_hint_survives_the_round_trip(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client('{"hint":"","concept":"general"}')
        hint, concept = engine.generate_line_hint("x = 1\n", 1)
        assert hint == ""
        assert concept == "general"

    def test_a_real_hint_is_unaffected(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client('{"hint":"What if the list is empty?","concept":"loops"}')
        hint, concept = engine.generate_line_hint("x = 1\n", 1)
        assert hint == "What if the list is empty?"
        assert concept == "loops"


class TestSubgoalAndTraceModes:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _system_message(self, engine):
        return engine.client.chat.completions.create.call_args.kwargs["messages"][0]["content"]

    def test_subgoal_label_mode_uses_its_own_prompt(self):
        engine = self._engine("Good label for step 2.")
        engine.generate_hint("", "step 1 sets up the counter", 1, mode="subgoal-label")
        assert "label" in self._system_message(engine).lower()

    def test_trace_check_mode_uses_its_own_prompt(self):
        engine = self._engine("Step 3 diverges.")
        engine.generate_hint("", "i=0 total=0", 1, mode="trace-check")
        system = self._system_message(engine).lower()
        assert "desk check" in system or "hand-trace" in system

    def test_worked_example_asks_for_unlabelled_numbered_steps(self):
        engine = self._engine("1. do a thing")
        engine.generate_hint("", "stuck", 3, mode="worked-example")
        system = self._system_message(engine)
        assert "NUMBERED" in system
        assert "student will do that" in system

    def test_non_hint_modes_do_not_append_the_socratic_closer(self):
        engine = self._engine("Nicely labelled.")
        hint, _ = engine.generate_hint("", "labels", 1, mode="subgoal-label")
        assert "What do you think should happen next?" not in hint

    def test_unknown_mode_falls_back_to_hint(self):
        bogus = self._engine("ok")
        bogus.generate_hint("x=1", "q", 1, mode="not-a-mode")

        hint_mode = self._engine("ok")
        hint_mode.generate_hint("x=1", "q", 1, mode="hint")

        assert self._system_message(bogus) == self._system_message(hint_mode)


class TestDesignTraceTable:
    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def test_parses_a_well_formed_reply(self):
        engine = self._engine(
            '{"variables": ["i", "total"], "steps": 4, "prompt": "Trace the loop."}'
        )
        variables, steps, prompt = engine.design_trace_table("for i in range(4): total += i")
        assert variables == ["i", "total"]
        assert steps == 4
        assert prompt == "Trace the loop."

    def test_empty_snippet_makes_no_llm_call(self):
        engine = self._engine('{"variables": ["i", "j"], "steps": 3, "prompt": "x"}')
        assert engine.design_trace_table("   ") == ([], 0, "")
        engine.client.chat.completions.create.assert_not_called()

    def test_model_declining_yields_nothing_to_trace(self):
        engine = self._engine('{"variables": [], "steps": 0, "prompt": ""}')
        assert engine.design_trace_table("x = 1") == ([], 0, "")

    def test_unparseable_reply_yields_nothing(self):
        engine = self._engine("I am afraid I cannot do that")
        assert engine.design_trace_table("for i in range(3): pass") == ([], 0, "")

    def test_single_variable_is_rejected(self):
        engine = self._engine('{"variables": ["i"], "steps": 4, "prompt": "Trace it."}')
        assert engine.design_trace_table("code") == ([], 0, "")

    def test_variables_capped_at_four(self):
        engine = self._engine(
            '{"variables": ["a","b","c","d","e","f"], "steps": 4, "prompt": "Trace."}'
        )
        variables, _, _ = engine.design_trace_table("code")
        assert variables == ["a", "b", "c", "d"]

    def test_duplicate_variables_dropped(self):
        engine = self._engine('{"variables": ["i","i","total"], "steps": 3, "prompt": "Trace."}')
        variables, _, _ = engine.design_trace_table("code")
        assert variables == ["i", "total"]

    def test_prose_masquerading_as_a_variable_is_dropped(self):
        engine = self._engine(
            '{"variables": ["i", "the running total; watch it", "total"], '
            '"steps": 3, "prompt": "Trace."}'
        )
        variables, _, _ = engine.design_trace_table("code")
        assert variables == ["i", "total"]

    def test_indexed_and_dotted_names_are_allowed(self):
        engine = self._engine('{"variables": ["arr[0]", "obj.count"], "steps": 3, "prompt": "T."}')
        variables, _, _ = engine.design_trace_table("code")
        assert variables == ["arr[0]", "obj.count"]

    def test_overlong_variable_name_dropped(self):
        from hinting_engine import MAX_TRACE_VARIABLE_CHARS
        long_name = "v" * (MAX_TRACE_VARIABLE_CHARS + 1)
        engine = self._engine(
            '{"variables": ["i", "' + long_name + '", "total"], "steps": 3, "prompt": "T."}'
        )
        variables, _, _ = engine.design_trace_table("code")
        assert variables == ["i", "total"]

    def test_steps_clamped_up_to_the_minimum(self):
        from hinting_engine import MIN_TRACE_STEPS
        engine = self._engine('{"variables": ["i","j"], "steps": 1, "prompt": "T."}')
        _, steps, _ = engine.design_trace_table("code")
        assert steps == MIN_TRACE_STEPS

    def test_steps_clamped_down_to_the_maximum(self):
        from hinting_engine import MAX_TRACE_STEPS
        engine = self._engine('{"variables": ["i","j"], "steps": 500, "prompt": "T."}')
        _, steps, _ = engine.design_trace_table("code")
        assert steps == MAX_TRACE_STEPS

    def test_non_numeric_steps_yields_nothing(self):
        engine = self._engine('{"variables": ["i","j"], "steps": "four", "prompt": "T."}')
        assert engine.design_trace_table("code") == ([], 0, "")

    def test_missing_prompt_yields_nothing(self):
        engine = self._engine('{"variables": ["i","j"], "steps": 4, "prompt": ""}')
        assert engine.design_trace_table("code") == ([], 0, "")

    def test_prompt_is_collapsed_and_truncated(self):
        padding = "x" * 300
        engine = self._engine(
            '{"variables": ["i","j"], "steps": 4, '
            '"prompt": "  Trace\\n  the   loop. ' + padding + '"}'
        )
        _, _, prompt = engine.design_trace_table("code")
        assert prompt.startswith("Trace the loop.")
        assert len(prompt) <= 200

    def test_variables_of_wrong_type_yields_nothing(self):
        engine = self._engine('{"variables": "i and j", "steps": 4, "prompt": "T."}')
        assert engine.design_trace_table("code") == ([], 0, "")


from hinting_engine import focus_instruction


def test_focus_instruction_is_empty_without_a_focus():
    assert focus_instruction(None) == ""


def test_focus_instruction_names_the_span_and_the_label():
    text = focus_instruction({"start_line": 12, "end_line": 19, "label": "calculate_average"})
    assert "lines 12-19" in text
    assert "calculate_average" in text
    assert "background context" in text


def test_focus_instruction_says_line_singular_for_one_line():
    text = focus_instruction({"start_line": 7, "end_line": 7, "label": ""})
    assert "line 7" in text
    assert "lines" not in text


def test_focus_instruction_ignores_a_nonsense_span():
    assert focus_instruction({"start_line": 0, "end_line": 4}) == ""
    assert focus_instruction({"start_line": 9, "end_line": 2}) == ""


class TestGenerateLineHintFocusWindow:
    """Which lines `generate_line_hint` actually shows the model, focus vs. default."""

    def _engine(self, response_text: str):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _user_message(self, engine):
        call_kwargs = engine.client.chat.completions.create.call_args
        return call_kwargs.kwargs["messages"][-1]["content"]

    @staticmethod
    def _numbered_code(n):
        # Zero-padded so "code_002" can never be a substring of "code_020" —
        # assertions below rely on exact line-content membership.
        return "\n".join(f"code_{i:03d}" for i in range(1, n + 1))

    def test_a_focus_containing_the_cursor_widens_the_window(self):
        engine = self._engine('{"hint":"h","concept":"general"}')
        code = self._numbered_code(20)
        engine.generate_line_hint(
            code, 10, "python", {"start_line": 1, "end_line": 15, "label": ""}
        )
        message = self._user_message(engine)
        # Line 2 sits outside the default +/-3 window around line 10 (lines
        # 7-13) but inside the focus (1-15) - only the focus explains it.
        assert "code_002" in message
        # Still bounded by the focus, not the whole file.
        assert "code_018" not in message
        assert "code_020" not in message

    def test_a_focus_not_containing_the_cursor_line_is_ignored(self):
        engine = self._engine('{"hint":"h","concept":"general"}')
        code = self._numbered_code(20)
        engine.generate_line_hint(
            code, 10, "python", {"start_line": 1, "end_line": 5, "label": ""}
        )
        message = self._user_message(engine)
        # Cursor (line 10) is outside the focus (1-5), so it must fall back
        # to the default +/-3 window (lines 7-13).
        assert "code_007" in message
        assert "code_013" in message
        # The ignored focus must not have leaked any of its lines in.
        assert "code_002" not in message

    def test_a_focus_wider_than_the_cap_is_capped(self):
        engine = self._engine('{"hint":"h","concept":"general"}')
        code = self._numbered_code(100)
        engine.generate_line_hint(
            code, 50, "python", {"start_line": 1, "end_line": 100, "label": ""}
        )
        message = self._user_message(engine)
        # The focus spans the whole file, but the window caps at +/-30 from
        # the cursor (line 50): line 20 is the first line shown...
        assert "code_020" in message
        assert "code_019" not in message
        # ...and a line well outside the cap stays hidden even though the
        # focus includes it.
        assert "code_010" not in message

    def test_a_focus_ending_past_the_files_real_length_is_ignored(self):
        # end_line one past the file's real length used to be caught by the
        # old guard's `f_end <= len(lines)` clause. Without an equivalent, a
        # focus the file cannot back up would still widen the window instead
        # of being rejected like any other nonsense span.
        engine = self._engine('{"hint":"h","concept":"general"}')
        code = self._numbered_code(10)
        engine.generate_line_hint(
            code, 6, "python", {"start_line": 5, "end_line": 11, "label": ""}
        )
        message = self._user_message(engine)
        # The focus is rejected outright, so the tight +/-3 default applies
        # (lines 3-9 around cursor line 6) rather than the widened window
        # the unusable focus would have produced (lines 5-10).
        assert "code_003" in message
        assert "code_009" in message
        assert "code_010" not in message


class TestTheFourthRungIsTheWorkedExample:
    """Level 4 is not a fourth Socratic hint - it *is* the worked example.

    The worked-example prompt was previously reachable only by a button in the
    panel, which a stuck student had to notice at the moment they were least
    likely to go looking. Reaching level 3 and asking again now gets there on
    its own.
    """

    def _engine(self, response_text: str = "ok"):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _system_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[0]["content"]

    def test_effective_mode_is_worked_example_at_level_four(self):
        from hinting_engine import effective_mode
        assert effective_mode("hint", 4) == "worked-example"

    def test_effective_mode_is_hint_below_level_four(self):
        from hinting_engine import effective_mode
        assert [effective_mode("hint", n) for n in (1, 2, 3)] == ["hint"] * 3

    def test_effective_mode_leaves_other_modes_alone(self):
        # A translate or reflect request is not on the ladder, so its level -
        # whatever the client sent - must not turn it into a worked example.
        from hinting_engine import effective_mode
        assert effective_mode("translate", 4) == "translate"
        assert effective_mode("reflect", 4) == "reflect"

    def test_effective_mode_falls_back_to_hint_for_an_unknown_mode(self):
        from hinting_engine import effective_mode
        assert effective_mode("nonsense", 1) == "hint"

    def test_a_level_four_ask_gets_the_worked_example_prompt(self):
        engine = self._engine()
        engine.generate_hint("x = 1", "still stuck", 4)
        assert "WORKED EXAMPLE" in self._system_message(engine)

    def test_a_level_three_ask_still_gets_the_socratic_prompt(self):
        engine = self._engine()
        engine.generate_hint("x = 1", "still stuck", 3)
        system = self._system_message(engine)
        assert "hint_level 3: pseudocode only" in system
        assert "WORKED EXAMPLE" not in system

    def test_streaming_gets_the_worked_example_prompt_too(self):
        engine = self._engine()
        chunk = MagicMock()
        chunk.choices[0].delta.content = "hi"
        engine.client.chat.completions.create.return_value = [chunk]
        list(engine.stream_hint("x = 1", "still stuck", 4))
        assert "WORKED EXAMPLE" in self._system_message(engine)


class TestAnswerMode:
    """Asked outright for the answer, the tutor gives it.

    Everything else in EduPeer withholds. This one mode does not - a student
    who has decided they want the answer will get it somewhere, and getting it
    here, with the bug named and the reasoning attached, beats getting it from
    a search engine with neither.
    """

    def _engine(self, response_text: str = "ok"):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _system_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[0]["content"]

    def test_answer_mode_has_a_template(self):
        from hinting_engine import MODE_SYSTEM_TEMPLATES
        assert "answer" in MODE_SYSTEM_TEMPLATES

    def test_answer_mode_selects_its_own_prompt(self):
        engine = self._engine()
        engine.generate_hint("x = 1", "just tell me the answer", 1, mode="answer")
        assert "asked you outright for the answer" in self._system_message(engine)

    def test_the_answer_prompt_bounds_what_it_shows(self):
        from hinting_engine import ANSWER_TEMPLATE
        prompt = ANSWER_TEMPLATE.format(language="Python")
        assert "ONLY the line" in prompt
        assert "Never the whole function" in prompt

    def test_answer_mode_is_not_swapped_for_a_worked_example_at_level_four(self):
        # It is not on the ladder, so the level it happens to carry is inert.
        from hinting_engine import effective_mode
        assert effective_mode("answer", 4) == "answer"


class TestThePromptsAnswerTheQuestionAsked:
    """Rules added after a transcript where the tutor did none of this.

    The observed failures, in one session: an ANSWER card that opened "the bug
    is in line 12" and then corrected line 13; a "corrected" line 12 that was
    character-for-character what the student had already written; an answer
    about empty lists when the whole thread had been about `enumerate`; a bare
    "Other bugs are present in the file"; and a worked example that answered
    "fix line 11" with an eight-step labelling exercise built from the
    student's own loop with the variables renamed.

    Each assertion below pins the rule that closes one of those. They are
    string checks on the prompt, which is weak evidence that the model obeys -
    but strong evidence that a later edit did not quietly delete the rule.
    """

    def test_the_answer_names_and_changes_the_same_line(self):
        from hinting_engine import ANSWER_TEMPLATE
        assert "MUST be the same line" in ANSWER_TEMPLATE

    def test_the_answer_rejects_an_unchanged_correction(self):
        from hinting_engine import ANSWER_TEMPLATE
        assert "must differ from" in ANSWER_TEMPLATE
        assert "character-for-character" in ANSWER_TEMPLATE

    def test_the_answer_is_scoped_to_what_they_asked(self):
        from hinting_engine import ANSWER_TEMPLATE
        assert "fix line 11" in ANSWER_TEMPLATE
        assert "NOT whichever defect you happen to notice first" in ANSWER_TEMPLATE

    def test_the_answer_may_not_hand_wave_at_other_bugs(self):
        from hinting_engine import ANSWER_TEMPLATE
        assert "other bugs are present in the file" in ANSWER_TEMPLATE

    def test_the_answer_may_decline_to_invent_a_fault(self):
        from hinting_engine import ANSWER_TEMPLATE
        assert "Do not manufacture a fault" in ANSWER_TEMPLATE

    def test_the_worked_example_answers_a_direct_request_first(self):
        from hinting_engine import WORKED_EXAMPLE_TEMPLATE
        assert "ONE sentence first" in WORKED_EXAMPLE_TEMPLATE

    def test_the_worked_example_must_not_be_their_loop_renamed(self):
        from hinting_engine import WORKED_EXAMPLE_TEMPLATE
        assert "Renaming their" in WORKED_EXAMPLE_TEMPLATE

    def test_the_worked_example_is_one_program(self):
        from hinting_engine import WORKED_EXAMPLE_TEMPLATE
        assert "ONE program" in WORKED_EXAMPLE_TEMPLATE

    def test_a_hint_defines_a_word_the_student_says_they_do_not_know(self):
        from hinting_engine import SYSTEM_PROMPT_TEMPLATE
        assert "I don't know what X is" in SYSTEM_PROMPT_TEMPLATE

    def test_every_rewritten_template_still_formats(self):
        # These are .format(language=...)-ed; an unescaped brace raises here.
        from hinting_engine import (
            ANSWER_TEMPLATE,
            SYSTEM_PROMPT_TEMPLATE,
            WORKED_EXAMPLE_TEMPLATE,
        )
        for template in (ANSWER_TEMPLATE, SYSTEM_PROMPT_TEMPLATE, WORKED_EXAMPLE_TEMPLATE):
            assert template.format(language="Python")


class TestTheProviderSeam:
    """The provider is now behind two methods; these cover that seam.

    Everything else in this file tests prompt assembly through a fake, so
    without this the only untested code on the branch would be the part that
    actually talks to Anthropic.
    """

    def test_split_system_peels_the_system_message_off(self):
        from hinting_engine import split_system
        system, turns = split_system([
            {"role": "system", "content": "S"},
            {"role": "user", "content": "U"},
            {"role": "assistant", "content": "A"},
        ])
        assert system == "S"
        assert turns == [
            {"role": "user", "content": "U"},
            {"role": "assistant", "content": "A"},
        ]

    def test_split_system_joins_multiple_system_messages(self):
        from hinting_engine import split_system
        system, turns = split_system([
            {"role": "system", "content": "one"},
            {"role": "system", "content": "two"},
            {"role": "user", "content": "U"},
        ])
        assert system == "one\n\ntwo"
        assert turns == [{"role": "user", "content": "U"}]

    def test_split_system_survives_no_system_message(self):
        from hinting_engine import split_system
        assert split_system([{"role": "user", "content": "U"}]) == (
            "", [{"role": "user", "content": "U"}]
        )

    @pytest.mark.real_backend
    def test_anthropic_backend_joins_text_blocks_and_ignores_others(self):
        # `content` is a list of blocks. Reading [0].text blindly breaks the
        # day anything but text leads, so the backend filters by type.
        from hinting_engine import AnthropicBackend

        backend = AnthropicBackend.__new__(AnthropicBackend)
        backend.model = "claude-haiku-4-5"
        text_a, text_b, other = MagicMock(), MagicMock(), MagicMock()
        text_a.type, text_a.text = "text", "Hello "
        text_b.type, text_b.text = "text", "world"
        other.type = "thinking"
        response = MagicMock()
        response.content = [other, text_a, text_b]
        backend._client = MagicMock()
        backend._client.messages.create.return_value = response

        assert backend.complete("S", [{"role": "user", "content": "U"}], 400) == "Hello world"

    @pytest.mark.real_backend
    def test_anthropic_backend_sends_system_as_its_own_argument(self):
        from hinting_engine import AnthropicBackend

        backend = AnthropicBackend.__new__(AnthropicBackend)
        backend.model = "claude-haiku-4-5"
        backend._client = MagicMock()
        response = MagicMock()
        response.content = []
        backend._client.messages.create.return_value = response

        backend.complete("SYSTEM", [{"role": "user", "content": "U"}], 400)
        kwargs = backend._client.messages.create.call_args.kwargs
        assert kwargs["system"] == "SYSTEM"
        assert kwargs["messages"] == [{"role": "user", "content": "U"}]
        assert kwargs["max_tokens"] == 400
        # A system message left in `messages` is a 400 from the API.
        assert all(m["role"] != "system" for m in kwargs["messages"])

    @pytest.mark.real_backend
    def test_anthropic_backend_streams_only_text_deltas(self):
        from hinting_engine import AnthropicBackend

        def event(kind, delta_kind=None, text=""):
            e = MagicMock()
            e.type = kind
            if delta_kind is None:
                e.delta = None
            else:
                e.delta = MagicMock()
                e.delta.type = delta_kind
                e.delta.text = text
            return e

        backend = AnthropicBackend.__new__(AnthropicBackend)
        backend.model = "claude-haiku-4-5"
        backend._client = MagicMock()
        backend._client.messages.create.return_value = [
            event("message_start"),
            event("content_block_delta", "text_delta", "Hel"),
            event("content_block_delta", "input_json_delta", "{ignored}"),
            event("content_block_delta", "text_delta", "lo"),
            event("message_stop"),
        ]

        assert list(backend.stream("S", [], 400)) == ["Hel", "lo"]


class TestBuildEnginePicksAProvider:
    def test_anthropic_when_its_key_is_set(self, monkeypatch):
        import hinting_engine
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
        monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
        built = {}
        monkeypatch.setattr(
            hinting_engine, "AnthropicBackend",
            lambda key: built.setdefault("anthropic", key) or MagicMock(),
        )
        hinting_engine.build_engine()
        assert built == {"anthropic": "sk-ant-test"}

    def test_groq_while_the_anthropic_key_is_still_missing(self, monkeypatch):
        # The rollover case: the deploy has GROQ_API_KEY and not yet the other,
        # and the tutor must keep answering rather than 500 on every request.
        import hinting_engine
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
        built = {}
        monkeypatch.setattr(
            hinting_engine, "GroqBackend",
            lambda key: built.setdefault("groq", key) or MagicMock(),
        )
        hinting_engine.build_engine()
        assert built == {"groq": "gsk-test"}

    def test_raises_when_neither_key_is_set(self, monkeypatch):
        import hinting_engine
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GROQ_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
            hinting_engine.build_engine()


class TestACodeViewRebuildsAbsoluteLineNumbers:
    """`code` is a digest now, so position in the string is not the line number.

    Three places derived line numbers from position and would each be quietly
    wrong on a digest: the prompt's numbering, `generate_line_hint`'s window,
    and `scan_code`'s flag validation. This is the one object all three ask.
    """

    DIGEST = "import math\nfrom stats import mean\ndef deep(x):\n    return mean(x)"
    BANDS = [{"start": 1, "end": 2}, {"start": 173, "end": 174}]

    def _view(self):
        from hinting_engine import CodeView
        return CodeView.of(self.DIGEST, self.BANDS, total_lines=241)

    def test_it_numbers_each_band_at_its_real_lines(self):
        numbered = self._view().numbered()
        assert "1: import math" in numbered
        assert "2: from stats import mean" in numbered
        assert "173: def deep(x):" in numbered
        assert "174:     return mean(x)" in numbered

    def test_it_announces_the_gap_between_bands(self):
        # A tutor that cannot see lines 3-172 must know that, or it reports an
        # import missing when the import is merely out of frame.
        assert "[lines 3-172 of this file are not shown]" in self._view().numbered()

    def test_it_announces_the_tail_when_it_knows_the_file_is_longer(self):
        assert "[lines 175-241 of this file are not shown]" in self._view().numbered()

    def test_it_announces_nothing_after_the_end_when_the_length_is_unknown(self):
        from hinting_engine import CodeView
        view = CodeView.of(self.DIGEST, self.BANDS)
        assert "175" not in view.numbered()

    def test_it_announces_the_head_when_the_first_band_does_not_start_at_one(self):
        from hinting_engine import CodeView
        view = CodeView.of("def deep(x):\n    return x", [{"start": 40, "end": 41}], 60)
        assert "[lines 1-39 of this file are not shown]" in view.numbered()

    def test_line_at_reaches_across_the_gap(self):
        assert self._view().line_at(173) == "def deep(x):"
        assert self._view().line_at(1) == "import math"

    def test_line_at_returns_nothing_for_a_line_it_does_not_hold(self):
        assert self._view().line_at(100) is None

    def test_contains_rejects_a_line_in_the_gap(self):
        view = self._view()
        assert view.contains(174) is True
        assert view.contains(3) is False

    def test_slice_skips_the_numbers_it_does_not_hold(self):
        assert self._view().slice(1, 173) == [
            (1, "import math"),
            (2, "from stats import mean"),
            (173, "def deep(x):"),
        ]

    def test_max_line_is_the_last_line_it_holds(self):
        assert self._view().max_line == 174

    def test_no_bands_means_the_whole_file_starting_at_line_one(self):
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2")
        assert view.numbered() == "1: a = 1\n2: b = 2"
        assert view.line_at(2) == "b = 2"

    def test_bands_that_disagree_with_the_code_fall_back_to_the_whole_file(self):
        # Two bands claiming six lines against a two-line digest. Believing
        # them would renumber every line and cite the wrong one; the safe
        # reading is that this client does not speak bands.
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", [{"start": 1, "end": 3}, {"start": 9, "end": 11}])
        assert view.numbered() == "1: a = 1\n2: b = 2"

    def test_overlapping_bands_fall_back_to_the_whole_file(self):
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", [{"start": 1, "end": 1}, {"start": 1, "end": 1}])
        assert view.line_at(1) == "a = 1"
        assert view.line_at(2) == "b = 2"

    def test_descending_bands_fall_back_to_the_whole_file(self):
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", [{"start": 9, "end": 9}, {"start": 1, "end": 1}])
        assert view.line_at(2) == "b = 2"

    def test_an_empty_digest_holds_nothing(self):
        from hinting_engine import CodeView
        view = CodeView.of("")
        assert view.line_at(1) is None
        assert view.max_line == 0

    def test_whitespace_only_code_is_no_code(self):
        # `number_lines` treats anything that strips to empty as "no code".
        # splitlines() alone does not agree - "   " is one non-empty line by
        # that measure - so a digest of pure whitespace must be caught the
        # same way number_lines catches it, not numbered as "1:    ".
        from hinting_engine import CodeView
        view = CodeView.of("   ")
        assert view.numbered() == "(no code provided)"

    def test_blank_lines_only_code_is_no_code(self):
        from hinting_engine import CodeView
        view = CodeView.of("\n\n\n")
        assert view.numbered() == "(no code provided)"

    def test_blank_code_outranks_bands_that_would_otherwise_be_believed(self):
        # This band is internally coherent - it claims exactly the two lines
        # the digest has - so a blank check placed after band-parsing would
        # still number them. A digest that is entirely whitespace carries
        # nothing to number regardless of what its bands claim.
        from hinting_engine import CodeView
        view = CodeView.of("   \n   ", [{"start": 5, "end": 6}], total_lines=10)
        assert view.numbered() == "(no code provided)"

    def test_a_non_iterable_bands_value_falls_back_instead_of_raising(self):
        # A caller handing a stray int, or a single band object instead of a
        # list containing one, must degrade like any other unbelievable
        # bands - never raise past this class.
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", bands=42)
        assert view.numbered() == "1: a = 1\n2: b = 2"

    def test_a_non_numeric_total_lines_is_treated_as_unknown(self):
        from hinting_engine import CodeView
        view = CodeView.of(self.DIGEST, self.BANDS, total_lines="lots")
        assert "175" not in view.numbered()


class TestTheConversationReadsTheDigest:
    """The panel sends a digest; the prompt has to number it correctly."""

    def _engine(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client("ok")
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def test_a_request_with_no_view_is_unchanged(self):
        # The published 1.5.1 extension sends whole files and must keep
        # producing the prompt it produces today, byte for byte.
        from hinting_engine import number_lines
        engine = self._engine()
        code = "a = 1\nb = 2"
        engine.generate_hint(code, "help", 1)
        assert number_lines(code) in self._user_message(engine)

    def test_a_view_puts_the_imports_and_the_block_in_the_prompt(self):
        from hinting_engine import CodeView
        engine = self._engine()
        view = CodeView.of(
            "import math\ndef deep(x):\n    return math.sqrt(x)",
            [{"start": 1, "end": 1}, {"start": 173, "end": 174}],
            total_lines=241,
        )
        engine.generate_hint("ignored", "help", 1, view=view)
        sent = self._user_message(engine)
        assert "1: import math" in sent
        assert "173: def deep(x):" in sent
        assert "[lines 2-172 of this file are not shown]" in sent

    def test_the_streaming_path_reads_the_view_too(self):
        from hinting_engine import CodeView
        engine = self._engine()
        view = CodeView.of("def deep(x):\n    return x", [{"start": 40, "end": 41}], 60)
        list(engine.stream_hint("ignored", "help", 1, view=view))
        assert "40: def deep(x):" in self._user_message(engine)


class TestTheLineHintReadsAbsoluteLineNumbers:
    """The cursor's line number is absolute; the code it arrives with is not.

    `generate_line_hint` indexed `code.splitlines()[line_number - 1]`. Against
    a digest, line 200 of a 42-line digest is out of range and the function
    returns an empty hint - the whole inline surface going quiet on exactly
    the long files the digest exists for.
    """

    def _engine(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client('{"hint": "check the bound", "concept": "loops"}')
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def _view(self):
        from hinting_engine import CodeView
        return CodeView.of(
            "import math\ndef deep(n):\n    for i in range(1, n):\n        print(i)",
            [{"start": 1, "end": 1}, {"start": 198, "end": 200}],
            total_lines=241,
        )

    def test_it_answers_about_a_line_in_the_second_band(self):
        engine = self._engine()
        hint, concept = engine.generate_line_hint("ignored", 199, "python", view=self._view())
        assert hint == "check the bound"
        assert concept == "loops"

    def test_it_marks_the_cursor_line_at_its_real_number(self):
        engine = self._engine()
        engine.generate_line_hint("ignored", 199, "python", view=self._view())
        sent = self._user_message(engine)
        assert "The student's cursor is on line 199" in sent
        assert "199>     for i in range(1, n):" in sent
        assert "198: def deep(n):" in sent

    def test_it_skips_the_numbers_the_view_does_not_hold(self):
        engine = self._engine()
        engine.generate_line_hint("ignored", 199, "python", view=self._view())
        # "197:" rather than bare "197" - the message also carries a random
        # 16-hex-char nonce, which can coincidentally contain "197" as a
        # substring on about one run in three hundred. A pure-hex nonce can
        # never contain a colon, so "197:" only matches an actual line 197.
        assert "197:" not in self._user_message(engine)

    def test_it_declines_a_line_the_view_does_not_hold(self):
        engine = self._engine()
        assert engine.generate_line_hint("ignored", 50, "python", view=self._view()) == (
            "",
            "general",
        )

    def test_a_request_with_no_view_behaves_as_it_does_today(self):
        engine = self._engine()
        code = "x = 1\ny = 2\nz = 3"
        hint, _ = engine.generate_line_hint(code, 2, "python")
        assert hint == "check the bound"
        assert "2> y = 2" in self._user_message(engine)

    def test_a_line_past_the_end_of_a_whole_file_still_declines(self):
        engine = self._engine()
        assert engine.generate_line_hint("x = 1", 9, "python") == ("", "general")


class TestTheScanReviewsTheBlockNotTheFile:
    """A scan of the whole file marks up code the student is not working on.

    A student editing `parse` collected lenses and Problems entries on three
    other functions - and, because the scan also fired on activation, on a
    file they had only just opened.
    """

    FLAGS = (
        '{"flags": ['
        '{"line": 174, "end_line": 174, "question": "Off by one?", "concept": "loops"},'
        '{"line": 2, "end_line": 2, "question": "Unused import?", "concept": "imports"}'
        "]}"
    )

    def _engine(self, reply=None):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(reply if reply is not None else self.FLAGS)
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def _view(self):
        from hinting_engine import CodeView
        return CodeView.of(
            "import math\nfrom stats import mean\ndef deep(n):\n    return n - 1",
            [{"start": 1, "end": 2}, {"start": 173, "end": 174}],
            total_lines=241,
        )

    FOCUS = {"start_line": 173, "end_line": 174, "label": "deep"}

    def test_it_names_the_block_it_is_reviewing(self):
        engine = self._engine()
        engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert "Review lines 173-174 (deep)" in self._user_message(engine)

    def test_it_keeps_a_flag_inside_the_block(self):
        engine = self._engine()
        flags = engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert [f["line"] for f in flags] == [174]

    def test_it_drops_a_flag_on_an_import_it_was_only_shown_for_context(self):
        engine = self._engine()
        flags = engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert all(f["line"] != 2 for f in flags)

    def test_it_drops_a_flag_on_a_line_the_view_never_held(self):
        engine = self._engine('{"flags": [{"line": 90, "end_line": 90, "question": "Why?"}]}')
        assert engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view()) == []

    def test_it_clamps_a_flag_that_runs_past_the_block(self):
        engine = self._engine(
            '{"flags": [{"line": 173, "end_line": 400, "question": "Why?"}]}'
        )
        flags = engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert flags[0]["end_line"] == 174

    def test_a_scan_with_no_focus_keeps_todays_wording(self):
        # The published extension sends no focus and must get the prompt it
        # gets today, byte for byte.
        engine = self._engine('{"flags": []}')
        engine.scan_code("x = 1\ny = 2", "python")
        assert "Review this beginner's Python file." in self._user_message(engine)

    def test_a_scan_with_no_focus_still_flags_anywhere_in_the_file(self):
        engine = self._engine('{"flags": [{"line": 2, "end_line": 2, "question": "Why?"}]}')
        flags = engine.scan_code("x = 1\ny = 2", "python")
        assert [f["line"] for f in flags] == [2]

    def test_it_numbers_the_digest_at_its_real_lines(self):
        engine = self._engine()
        engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        sent = self._user_message(engine)
        assert "173: def deep(n):" in sent
        assert "[lines 3-172 of this file are not shown]" in sent
