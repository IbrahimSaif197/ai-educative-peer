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

    def test_appends_socratic_question_if_missing(self):
        engine = self._engine("Look at your loop carefully.")
        hint, _ = engine.generate_hint("for i in range(10):", "help", 1)
        assert hint.endswith("What do you think should happen next?")

    def test_does_not_double_append_socratic_question(self):
        text = "Consider the index. What do you think should happen next?"
        engine = self._engine(text)
        hint, _ = engine.generate_hint("x[5]", "help", 2)
        assert hint.count("What do you think should happen next?") == 1

    def test_level_clamped_to_3(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client("hint text. What do you think should happen next?")
        engine.generate_hint("", "q", 99)
        call_kwargs = engine.client.chat.completions.create.call_args
        # messages[0] is the system prompt, messages[1] is the user message
        msg_content = call_kwargs.kwargs["messages"][1]["content"]
        assert "hint_level: 3" in msg_content

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

    def test_closing_question_appended_after_strip(self):
        engine = self._engine("Look closely.\n[concepts: loops]")
        hint, tags = engine.generate_hint("while True: pass", "help", 1)
        assert hint.endswith("What do you think should happen next?")
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
        assert "```python" in messages[-1]["content"]

    def test_java_prompt_uses_java(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("int x = 1;", "help", 1, language="java")
        messages = self._sent_messages(engine)
        assert "Java students" in messages[0]["content"]
        assert "never real Java syntax" in messages[0]["content"]
        assert "```java" in messages[-1]["content"]

    def test_alias_language_normalized(self):
        engine = self._engine("ok. What do you think should happen next?")
        engine.generate_hint("let x = 1;", "help", 1, language="js")
        messages = self._sent_messages(engine)
        assert "JavaScript students" in messages[0]["content"]

    def test_language_specific_concept_tags(self):
        engine = self._engine(
            "Think about your pointers here. What do you think should happen next?"
        )
        _, tags = engine.generate_hint("int *p;", "why segfault?", 1, language="c")
        assert "pointers" in tags
        assert "segfault" in tags

    def test_scan_prompt_uses_language(self):
        engine = self._engine('{"flags":[]}')
        engine.scan_code("int main() { return 0; }", language="cpp")
        messages = self._sent_messages(engine)
        assert "C++ code" in messages[0]["content"]
        assert "```cpp" in messages[1]["content"]

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
        engine = self._engine(["Consider the index."])
        events = list(engine.stream_hint("x[5]", "help", 2))
        done = events[-1]
        assert done["hint"].endswith("What do you think should happen next?")


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
        engine = self._engine("ok")
        hint, _ = engine.generate_hint("x=1", "q", 1, mode="not-a-mode")
        assert hint.endswith("What do you think should happen next?")


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
