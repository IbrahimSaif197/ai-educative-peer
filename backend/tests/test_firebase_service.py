import sys
import types
import pytest
from unittest.mock import MagicMock, patch, call


def _patch_firebase_admin():
    """Replace firebase_admin in sys.modules with a lightweight mock."""
    admin_mock = MagicMock()
    admin_mock._apps = {}
    cred_mock = MagicMock()
    cred_mock.Certificate = MagicMock(return_value=MagicMock())
    fs_mock = MagicMock()
    fs_mock.SERVER_TIMESTAMP = "SERVER_TS"
    sys.modules["firebase_admin"] = admin_mock
    sys.modules["firebase_admin.credentials"] = cred_mock
    sys.modules["firebase_admin.firestore"] = fs_mock
    return admin_mock, cred_mock, fs_mock


def _make_service(fs_mock, user_doc_data=None):
    import importlib, os
    os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
    os.environ.setdefault("FIREBASE_PRIVATE_KEY", "test-key")
    os.environ.setdefault("FIREBASE_CLIENT_EMAIL", "test@test.iam.gserviceaccount.com")

    if "firebase_service" in sys.modules:
        del sys.modules["firebase_service"]

    snap = MagicMock()
    snap.exists = user_doc_data is not None
    snap.to_dict.return_value = user_doc_data or {}

    doc_ref = MagicMock()
    doc_ref.get.return_value = snap
    doc_ref.set = MagicMock()

    collection_mock = MagicMock()
    collection_mock.return_value.add = MagicMock()
    collection_mock.return_value.document.return_value = doc_ref

    fs_mock.client.return_value.collection = collection_mock

    from firebase_service import FirebaseService
    svc = FirebaseService()
    svc._client = fs_mock.client.return_value
    return svc, doc_ref


class TestBadgeLogic:
    def setup_method(self):
        self.admin_mock, self.cred_mock, self.fs_mock = _patch_firebase_admin()

    def _svc(self, user_data=None):
        return _make_service(self.fs_mock, user_data)

    def test_first_question_awarded_on_first_interaction(self):
        svc, doc_ref = self._svc(None)
        badges = svc._update_user_and_award_badges_sync("u1", 1, ["variables"], False)
        assert "First Question" in badges

    def test_first_question_not_duplicated(self):
        svc, doc_ref = self._svc({"badges": ["First Question"], "total_interactions": 1,
                                  "sessions": 1, "concept_tags_seen": [], "solved_at_level_1": 0})
        badges = svc._update_user_and_award_badges_sync("u1", 1, ["loops"], False)
        assert badges.count("First Question") == 1

    def test_persistent_learner_awarded_at_5_sessions(self):
        svc, doc_ref = self._svc({"badges": [], "total_interactions": 10,
                                  "sessions": 4, "concept_tags_seen": [], "solved_at_level_1": 0})
        badges = svc._update_user_and_award_badges_sync("u1", 1, [], True)
        assert "Persistent Learner" in badges

    def test_hint_minimiser_awarded_at_3_level1_solves(self):
        svc, doc_ref = self._svc({"badges": [], "total_interactions": 3,
                                  "sessions": 1, "concept_tags_seen": [], "solved_at_level_1": 2})
        badges = svc._update_user_and_award_badges_sync("u1", 1, [], False)
        assert "Hint Minimiser" in badges

    def test_hint_minimiser_not_awarded_below_threshold(self):
        svc, doc_ref = self._svc({"badges": [], "total_interactions": 2,
                                  "sessions": 1, "concept_tags_seen": [], "solved_at_level_1": 1})
        badges = svc._update_user_and_award_badges_sync("u1", 2, [], False)
        assert "Hint Minimiser" not in badges

    def test_concept_explorer_awarded_at_5_unique_concepts(self):
        svc, doc_ref = self._svc({"badges": [], "total_interactions": 5,
                                  "sessions": 1, "concept_tags_seen": ["loops", "variables", "strings", "lists"],
                                  "solved_at_level_1": 0})
        badges = svc._update_user_and_award_badges_sync("u1", 1, ["functions"], False)
        assert "Concept Explorer" in badges

    def test_concept_explorer_not_awarded_below_threshold(self):
        svc, doc_ref = self._svc({"badges": [], "total_interactions": 2,
                                  "sessions": 1, "concept_tags_seen": ["loops", "variables"],
                                  "solved_at_level_1": 0})
        badges = svc._update_user_and_award_badges_sync("u1", 1, ["strings"], False)
        assert "Concept Explorer" not in badges

    def test_new_session_increments_session_count(self):
        svc, doc_ref = self._svc({"badges": [], "total_interactions": 2,
                                  "sessions": 2, "concept_tags_seen": [], "solved_at_level_1": 0})
        svc._update_user_and_award_badges_sync("u1", 1, [], True)
        set_call = doc_ref.set.call_args
        data = set_call[0][0]
        assert data["sessions"] == 3

    def test_enabled_false_when_client_none(self):
        from firebase_service import FirebaseService
        svc = FirebaseService.__new__(FirebaseService)
        svc._client = None
        assert svc.enabled is False

    def test_get_user_badges_sync_returns_empty_when_disabled(self):
        from firebase_service import FirebaseService
        svc = FirebaseService.__new__(FirebaseService)
        svc._client = None
        result = svc.get_user_badges_sync("u1")
        assert result == []

    def test_get_user_badges_sync_returns_empty_when_doc_missing(self):
        svc, doc_ref = self._svc(None)
        result = svc.get_user_badges_sync("u1")
        assert result == []

    def test_get_user_badges_sync_returns_badges_list(self):
        svc, doc_ref = self._svc({"badges": ["First Question", "Concept Explorer"]})
        result = svc.get_user_badges_sync("u1")
        assert "First Question" in result
        assert "Concept Explorer" in result
