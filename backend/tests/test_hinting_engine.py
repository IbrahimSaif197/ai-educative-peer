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
