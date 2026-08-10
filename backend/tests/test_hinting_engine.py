import sys
import types
import pytest
from unittest.mock import MagicMock, patch


def _make_mock_client(text: str):
    message = MagicMock()
    message.content = text
    choice = MagicMock()
    choice.message = message
    resp = MagicMock()
    resp.choices = [choice]
    client = MagicMock()
    client.chat.completions.create.return_value = resp
    return client


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
        engine.client.chat.completions.create.side_effect = RuntimeError("API down")
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


def _make_stream_chunk(text):
    delta = MagicMock()
    delta.content = text
    choice = MagicMock()
    choice.delta = delta
    chunk = MagicMock()
    chunk.choices = [choice]
    return chunk


class TestStreamHint:
    def _engine(self, chunks):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        client = MagicMock()
        client.chat.completions.create.return_value = iter(
            [_make_stream_chunk(c) for c in chunks]
        )
        engine.client = client
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
        engine = self._engine(["ok"])
        list(engine.stream_hint("x=1", "q", 1))
        assert engine.client.chat.completions.create.call_args.kwargs["stream"] is True

    def test_done_hint_matches_generate_hint_contract(self):
        text = "Consider the index."
        stream_engine = self._engine([text])
        streamed = list(stream_engine.stream_hint("x[5]", "help", 2))[-1]["hint"]

        from hinting_engine import HintingEngine
        one_shot = HintingEngine(api_key="test-key")
        one_shot.client = _make_mock_client(text)
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
