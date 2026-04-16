import pytest
from pydantic import ValidationError
from models import HintRequest, HintResponse, ResetSessionRequest, HealthResponse, UserBadges


class TestHintRequest:
    def test_valid_full(self):
        req = HintRequest(code="x = 1", question="What is x?", user_id="u1", hint_level=2)
        assert req.code == "x = 1"
        assert req.question == "What is x?"
        assert req.user_id == "u1"
        assert req.hint_level == 2

    def test_defaults(self):
        req = HintRequest(question="help", user_id="u1")
        assert req.code == ""
        assert req.hint_level == 1

    def test_missing_question_raises(self):
        with pytest.raises(ValidationError):
            HintRequest(user_id="u1")

    def test_missing_user_id_raises(self):
        with pytest.raises(ValidationError):
            HintRequest(question="help")

    def test_hint_level_below_min_raises(self):
        with pytest.raises(ValidationError):
            HintRequest(question="q", user_id="u1", hint_level=0)

    def test_hint_level_above_max_raises(self):
        with pytest.raises(ValidationError):
            HintRequest(question="q", user_id="u1", hint_level=4)


class TestHintResponse:
    def test_valid(self):
        r = HintResponse(hint="Think about it.", hint_level=1, concept_tags=["loops"])
        assert r.hint == "Think about it."
        assert r.concept_tags == ["loops"]

    def test_empty_tags(self):
        r = HintResponse(hint="A hint", hint_level=3, concept_tags=[])
        assert r.concept_tags == []


class TestResetSessionRequest:
    def test_valid(self):
        r = ResetSessionRequest(user_id="abc")
        assert r.user_id == "abc"

    def test_missing_raises(self):
        with pytest.raises(ValidationError):
            ResetSessionRequest()


class TestHealthResponse:
    def test_valid(self):
        r = HealthResponse(status="ok", service="edupeer-backend")
        assert r.status == "ok"


class TestUserBadges:
    def test_defaults(self):
        u = UserBadges(user_id="u1")
        assert u.badges == []
        assert u.total_interactions == 0
        assert u.sessions == 0
        assert u.concept_tags_seen == []
        assert u.solved_at_level_1 == 0
