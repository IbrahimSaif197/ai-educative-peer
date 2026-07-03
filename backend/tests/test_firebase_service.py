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


class TestConceptStatsHelpers:
    def test_new_concept_creates_entry(self):
        from datetime import date
        from firebase_service import _update_concept_stats
        stats = _update_concept_stats({}, ["loops"], 1, date(2026, 7, 4))
        assert stats["loops"]["encounters"] == 1
        assert stats["loops"]["level_sum"] == 1
        assert stats["loops"]["max_level"] == 1
        assert stats["loops"]["last_seen"] == "2026-07-04"
        assert stats["loops"]["last_struggled"] is None

    def test_level_2_marks_struggle(self):
        from datetime import date
        from firebase_service import _update_concept_stats
        stats = _update_concept_stats({}, ["loops"], 2, date(2026, 7, 4))
        assert stats["loops"]["last_struggled"] == "2026-07-04"

    def test_existing_concept_accumulates(self):
        from datetime import date
        from firebase_service import _update_concept_stats
        existing = {"loops": {"encounters": 2, "level_sum": 4, "max_level": 3,
                              "last_seen": "2026-07-01", "last_struggled": "2026-07-01"}}
        stats = _update_concept_stats(existing, ["loops"], 1, date(2026, 7, 4))
        assert stats["loops"]["encounters"] == 3
        assert stats["loops"]["level_sum"] == 5
        assert stats["loops"]["max_level"] == 3
        assert stats["loops"]["last_seen"] == "2026-07-04"
        # level 1 is not a struggle; timestamp untouched
        assert stats["loops"]["last_struggled"] == "2026-07-01"

    def test_input_dict_not_mutated(self):
        from datetime import date
        from firebase_service import _update_concept_stats
        existing = {"loops": {"encounters": 1, "level_sum": 1, "max_level": 1,
                              "last_seen": "2026-07-01", "last_struggled": None}}
        _update_concept_stats(existing, ["loops"], 3, date(2026, 7, 4))
        assert existing["loops"]["encounters"] == 1

    def test_merge_concept_stats_sums_and_maxes(self):
        from firebase_service import _merge_concept_stats
        a = {"loops": {"encounters": 2, "level_sum": 3, "max_level": 2,
                       "last_seen": "2026-07-01", "last_struggled": "2026-06-30"}}
        b = {"loops": {"encounters": 1, "level_sum": 3, "max_level": 3,
                       "last_seen": "2026-07-03", "last_struggled": None},
             "strings": {"encounters": 1, "level_sum": 1, "max_level": 1,
                         "last_seen": "2026-07-02", "last_struggled": None}}
        merged = _merge_concept_stats(a, b)
        assert merged["loops"]["encounters"] == 3
        assert merged["loops"]["level_sum"] == 6
        assert merged["loops"]["max_level"] == 3
        assert merged["loops"]["last_seen"] == "2026-07-03"
        assert merged["loops"]["last_struggled"] == "2026-06-30"
        assert merged["strings"]["encounters"] == 1


class TestStreakHelper:
    def test_first_activity_starts_streak(self):
        from datetime import date
        from firebase_service import _update_streak
        assert _update_streak(None, 0, date(2026, 7, 4)) == ("2026-07-04", 1)

    def test_same_day_keeps_streak(self):
        from datetime import date
        from firebase_service import _update_streak
        assert _update_streak("2026-07-04", 5, date(2026, 7, 4)) == ("2026-07-04", 5)

    def test_consecutive_day_increments(self):
        from datetime import date
        from firebase_service import _update_streak
        assert _update_streak("2026-07-03", 5, date(2026, 7, 4)) == ("2026-07-04", 6)

    def test_gap_resets_to_one(self):
        from datetime import date
        from firebase_service import _update_streak
        assert _update_streak("2026-07-01", 5, date(2026, 7, 4)) == ("2026-07-04", 1)


class TestUserDocEnrichment:
    def setup_method(self):
        self.admin_mock, self.cred_mock, self.fs_mock = _patch_firebase_admin()

    def _svc(self, user_data=None):
        return _make_service(self.fs_mock, user_data)

    def test_concept_stats_written_to_user_doc(self):
        svc, doc_ref = self._svc(None)
        svc._update_user_and_award_badges_sync("u1", 2, ["loops"], False)
        data = doc_ref.set.call_args[0][0]
        assert data["concept_stats"]["loops"]["encounters"] == 1
        assert data["concept_stats"]["loops"]["max_level"] == 2

    def test_language_recorded(self):
        svc, doc_ref = self._svc({"languages_used": ["python"]})
        svc._update_user_and_award_badges_sync("u1", 1, [], False, language="java")
        data = doc_ref.set.call_args[0][0]
        assert sorted(data["languages_used"]) == ["java", "python"]

    def test_streak_fields_written(self):
        svc, doc_ref = self._svc(None)
        svc._update_user_and_award_badges_sync("u1", 1, [], False)
        data = doc_ref.set.call_args[0][0]
        assert data["streak_days"] == 1
        assert data["last_active_date"]


class TestMergeUser:
    def setup_method(self):
        self.admin_mock, self.cred_mock, self.fs_mock = _patch_firebase_admin()

    def _svc_with_users(self, source_data, target_data):
        import os
        os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
        os.environ.setdefault("FIREBASE_PRIVATE_KEY", "test-key")
        os.environ.setdefault("FIREBASE_CLIENT_EMAIL", "test@test.iam.gserviceaccount.com")
        if "firebase_service" in sys.modules:
            del sys.modules["firebase_service"]

        def make_ref(data):
            snap = MagicMock()
            snap.exists = data is not None
            snap.to_dict.return_value = data or {}
            ref = MagicMock()
            ref.get.return_value = snap
            return ref

        self.source_ref = make_ref(source_data)
        self.target_ref = make_ref(target_data)
        refs = {"old-uid": self.source_ref, "new-uid": self.target_ref}

        collection_mock = MagicMock()
        collection_mock.return_value.document.side_effect = lambda uid: refs[uid]
        self.fs_mock.client.return_value.collection = collection_mock

        from firebase_service import FirebaseService
        svc = FirebaseService()
        svc._client = self.fs_mock.client.return_value
        return svc

    def test_counters_added_lists_unioned_badges_recomputed(self):
        svc = self._svc_with_users(
            {"total_interactions": 3, "sessions": 2, "solved_at_level_1": 1,
             "concept_tags_seen": ["loops", "strings"], "badges": ["First Question"]},
            {"total_interactions": 4, "sessions": 3, "solved_at_level_1": 2,
             "concept_tags_seen": ["strings", "recursion"], "badges": ["First Question"]},
        )
        assert svc.merge_user_sync("old-uid", "new-uid") is True
        data = self.target_ref.set.call_args[0][0]
        assert data["total_interactions"] == 7
        assert data["sessions"] == 5
        assert data["solved_at_level_1"] == 3
        assert sorted(data["concept_tags_seen"]) == ["loops", "recursion", "strings"]
        # merged stats cross new thresholds -> badges recomputed
        assert "Persistent Learner" in data["badges"]
        assert "Hint Minimiser" in data["badges"]
        assert data["badges"].count("First Question") == 1
        self.source_ref.delete.assert_called_once()

    def test_concept_stats_and_languages_merged(self):
        svc = self._svc_with_users(
            {"total_interactions": 1, "languages_used": ["python"], "streak_days": 2,
             "last_active_date": "2026-07-01",
             "concept_stats": {"loops": {"encounters": 1, "level_sum": 2, "max_level": 2,
                                         "last_seen": "2026-07-01", "last_struggled": "2026-07-01"}}},
            {"total_interactions": 1, "languages_used": ["java"], "streak_days": 4,
             "last_active_date": "2026-07-03",
             "concept_stats": {"loops": {"encounters": 2, "level_sum": 2, "max_level": 1,
                                         "last_seen": "2026-07-03", "last_struggled": None}}},
        )
        assert svc.merge_user_sync("old-uid", "new-uid") is True
        data = self.target_ref.set.call_args[0][0]
        assert data["concept_stats"]["loops"]["encounters"] == 3
        assert data["concept_stats"]["loops"]["max_level"] == 2
        assert sorted(data["languages_used"]) == ["java", "python"]
        assert data["streak_days"] == 4
        assert data["last_active_date"] == "2026-07-03"

    def test_missing_source_doc_returns_false(self):
        svc = self._svc_with_users(None, {"total_interactions": 1})
        assert svc.merge_user_sync("old-uid", "new-uid") is False
        self.target_ref.set.assert_not_called()

    def test_same_uid_is_noop(self):
        svc = self._svc_with_users({"total_interactions": 1}, {"total_interactions": 1})
        assert svc.merge_user_sync("new-uid", "new-uid") is False

    def test_disabled_service_returns_false(self):
        from firebase_service import FirebaseService
        svc = FirebaseService.__new__(FirebaseService)
        svc._client = None
        assert svc.merge_user_sync("a", "b") is False
