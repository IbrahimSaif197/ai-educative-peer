import sys
import types
import pytest
from unittest.mock import MagicMock, patch


def _make_mock_client(text: str):
    block = MagicMock()
    block.type = "text"
    block.text = text
    msg = MagicMock()
    msg.content = [block]
    client = MagicMock()
    client.messages.create.return_value = msg
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
        call_kwargs = engine.client.messages.create.call_args
        msg_content = call_kwargs.kwargs["messages"][0]["content"]
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
        engine.client.messages.create.side_effect = RuntimeError("API down")
        with pytest.raises(RuntimeError, match="API down"):
            engine.generate_hint("x=1", "help", 1)
