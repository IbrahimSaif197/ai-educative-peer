from datetime import date

from progress import (
    CALIBRATION_MIN_SAMPLES,
    activity_strip,
    build_progress,
    calibration_summary,
    classify_calibration,
    concept_strengths,
    concept_struggles,
    goal_concepts_of,
    hint_level_counts,
    normalise_goal_concepts,
    pacing_summary,
    review_due_concepts,
)

TODAY = date(2026, 7, 4)


def entry(encounters, level_sum, last_struggled=None):
    return {
        "encounters": encounters,
        "level_sum": level_sum,
        "max_level": 3,
        "last_seen": "2026-07-01",
        "last_struggled": last_struggled,
    }


class TestStrugglesAndStrengths:
    def test_high_avg_level_is_struggle(self):
        stats = {"recursion": entry(3, 8)}  # avg 2.67
        assert concept_struggles(stats)[0]["concept"] == "recursion"

    def test_single_encounter_not_a_struggle(self):
        stats = {"recursion": entry(1, 3)}
        assert concept_struggles(stats) == []

    def test_low_avg_with_enough_encounters_is_strength(self):
        stats = {"loops": entry(4, 4)}  # avg 1.0
        assert concept_strengths(stats)[0]["concept"] == "loops"

    def test_strength_needs_three_encounters(self):
        stats = {"loops": entry(2, 2)}
        assert concept_strengths(stats) == []

    def test_struggles_sorted_by_depth(self):
        stats = {"a": entry(2, 6), "b": entry(2, 4)}  # avg 3.0 vs 2.0
        result = concept_struggles(stats)
        assert [r["concept"] for r in result] == ["a", "b"]

    def test_empty_stats(self):
        assert concept_struggles(None) == []
        assert concept_strengths({}) == []


class TestPacingSummary:
    def test_empty_when_no_signal(self):
        assert pacing_summary({}) == ""
        assert pacing_summary({"x": entry(1, 1)}) == ""

    def test_mentions_struggles(self):
        text = pacing_summary({"recursion": entry(3, 8)})
        assert "recursion" in text
        assert "never mention" in text

    def test_includes_goal(self):
        text = pacing_summary({}, goal_text="get comfortable with recursion")
        assert "get comfortable with recursion" in text


class TestReviewDue:
    def test_struggle_four_days_ago_is_due(self):
        stats = {"loops": entry(2, 4, "2026-06-30")}
        assert review_due_concepts(stats, TODAY) == ["loops"]

    def test_struggle_yesterday_not_due(self):
        stats = {"loops": entry(2, 4, "2026-07-03")}
        assert review_due_concepts(stats, TODAY) == []

    def test_struggle_ten_days_ago_not_due(self):
        stats = {"loops": entry(2, 4, "2026-06-24")}
        assert review_due_concepts(stats, TODAY) == []

    def test_boundaries_inclusive(self):
        stats = {"a": entry(1, 2, "2026-07-01"), "b": entry(1, 2, "2026-06-27")}
        assert sorted(review_due_concepts(stats, TODAY)) == ["a", "b"]

    def test_capped_and_sorted_by_encounters(self):
        stats = {
            "a": entry(1, 2, "2026-06-30"),
            "b": entry(5, 10, "2026-06-30"),
            "c": entry(3, 6, "2026-06-30"),
            "d": entry(2, 4, "2026-06-30"),
        }
        assert review_due_concepts(stats, TODAY) == ["b", "c", "d"]

    def test_never_struggled_ignored(self):
        stats = {"loops": entry(5, 5, None)}
        assert review_due_concepts(stats, TODAY) == []


class TestGoalConcepts:
    """The tags `/goal` mapped, read back off a users document.

    Until 1.7.0 these were computed by an LLM call, stored, shown once in a
    toast, and then read by nothing. These tests exist because the way that
    happens again is for the reading end to have no coverage.
    """

    def test_reads_the_tags_off_a_goal(self):
        profile = {"goal": {"text": "get better at recursion", "concepts": ["recursion"]}}
        assert goal_concepts_of(profile) == ["recursion"]

    def test_a_cleared_goal_takes_its_tags_with_it(self):
        # `set_goal_sync` writes None for empty text, but a document written
        # by an older build can carry tags beside blank text. They are stale.
        profile = {"goal": {"text": "  ", "concepts": ["recursion"]}}
        assert goal_concepts_of(profile) == []

    def test_no_goal_is_no_tags(self):
        assert goal_concepts_of({}) == []
        assert goal_concepts_of(None) == []
        assert goal_concepts_of({"goal": "recursion"}) == []

    def test_normalises_case_whitespace_and_duplicates(self):
        assert normalise_goal_concepts([" Loops ", "loops", "RECURSION"]) == [
            "loops",
            "recursion",
        ]

    def test_survives_a_shape_it_did_not_write(self):
        # The value has been through Firestore and a client since it was
        # produced, so it is treated as untrusted shape.
        assert normalise_goal_concepts(None) == []
        assert normalise_goal_concepts("recursion") == []
        assert normalise_goal_concepts([1, None, {"a": 1}, "loops"]) == ["loops"]


class TestGoalSteersPacing:
    def test_names_the_tags_in_the_tutor_vocabulary(self):
        out = pacing_summary(None, goal_text="get better at recursion",
                             goal_concepts=["recursion", "base-case"])
        assert "get better at recursion" in out
        assert "In concept tags, that is: recursion, base-case." in out

    def test_tells_the_tutor_it_may_not_reach_for_them(self):
        # The whole risk of steering: a student whose goal is recursion asking
        # about a string-formatting bug must not be answered about recursion.
        out = pacing_summary(None, goal_text="recursion", goal_concepts=["recursion"])
        assert "Never steer towards a concept the code does not raise." in out

    def test_goal_text_alone_still_works(self):
        out = pacing_summary(None, goal_text="get better at recursion")
        assert "get better at recursion" in out
        assert "In concept tags" not in out

    def test_no_goal_adds_nothing(self):
        assert pacing_summary(None, goal_text="", goal_concepts=["recursion"]) == ""


class TestGoalSteersReview:
    def test_a_goal_concept_outranks_a_riper_one(self):
        stats = {
            "loops": entry(9, 20, "2026-06-30"),
            "recursion": entry(2, 5, "2026-06-30"),
        }
        # Without the goal, ripeness wins.
        assert review_due_concepts(stats, TODAY) == ["loops", "recursion"]
        # With it, the goal concept leads and the other still comes.
        assert review_due_concepts(stats, TODAY, goal_concepts=["recursion"]) == [
            "recursion",
            "loops",
        ]

    def test_a_goal_does_not_make_a_concept_due(self):
        # The 3-7 day window is the spacing interval the feature rests on.
        # Pulling a concept forward because the student said they cared about
        # it would make the review worse at the one thing it is for.
        stats = {"recursion": entry(2, 5, "2026-07-03")}  # yesterday
        assert review_due_concepts(stats, TODAY, goal_concepts=["recursion"]) == []

    def test_a_goal_concept_never_struggled_with_is_not_invented(self):
        stats = {"loops": entry(2, 4, "2026-06-30")}
        assert review_due_concepts(stats, TODAY, goal_concepts=["monads"]) == ["loops"]

    def test_goal_ranking_respects_the_limit(self):
        stats = {
            "a": entry(9, 20, "2026-06-30"),
            "b": entry(8, 20, "2026-06-30"),
            "c": entry(7, 20, "2026-06-30"),
            "recursion": entry(1, 3, "2026-06-30"),
        }
        out = review_due_concepts(stats, TODAY, goal_concepts=["recursion"])
        assert len(out) == 3
        assert out[0] == "recursion"

    def test_matching_is_case_insensitive(self):
        stats = {"Recursion": entry(2, 5, "2026-06-30"), "loops": entry(9, 20, "2026-06-30")}
        assert review_due_concepts(stats, TODAY, goal_concepts=["RECURSION"])[0] == "Recursion"


class TestBuildProgress:
    def test_empty_doc(self):
        result = build_progress(None, TODAY)
        assert result["badges"] == []
        assert result["review_due"] is False
        assert result["goal"] is None

    def test_shapes_fields(self):
        data = {
            "badges": ["First Question"],
            "total_interactions": 7,
            "sessions": 2,
            "streak_days": 3,
            "languages_used": ["python"],
            "goal": {"text": "learn recursion", "concepts": ["recursion"]},
            "concept_stats": {"recursion": entry(3, 8, "2026-06-30")},
            "session_summaries": [{"text": f"s{i}", "date": "2026-07-01"} for i in range(8)],
        }
        result = build_progress(data, TODAY)
        assert result["total_interactions"] == 7
        assert result["goal"]["text"] == "learn recursion"
        assert result["concept_struggles"][0]["concept"] == "recursion"
        assert len(result["session_summaries"]) == 5
        assert result["session_summaries"][-1]["text"] == "s7"
        assert result["review_due"] is True

    def test_blank_goal_treated_as_none(self):
        assert build_progress({"goal": {"text": "  "}}, TODAY)["goal"] is None


class TestClassifyCalibration:
    def test_no_rating_returns_none(self):
        assert classify_calibration(0, 2) is None

    def test_out_of_range_rating_returns_none(self):
        assert classify_calibration(9, 2) is None
        assert classify_calibration(-1, 2) is None

    def test_sure_but_needed_pseudocode_is_overconfident(self):
        assert classify_calibration(3, 3) == "overconfident"

    def test_no_idea_but_solved_at_level_1_is_underconfident(self):
        assert classify_calibration(1, 1) == "underconfident"

    def test_sure_and_solved_at_level_1_is_calibrated(self):
        assert classify_calibration(3, 1) == "calibrated"

    def test_no_idea_and_needed_level_3_is_calibrated(self):
        assert classify_calibration(1, 3) == "calibrated"

    def test_middling_confidence_is_always_calibrated(self):
        assert [classify_calibration(2, level) for level in (1, 2, 3)] == [
            "calibrated", "calibrated", "calibrated"
        ]


class TestCalibrationSummary:
    def test_no_data_is_zeroed_and_not_enough(self):
        summary = calibration_summary({})
        assert summary["samples"] == 0
        assert summary["score"] == 0.0
        assert summary["enough_data"] is False

    def test_score_is_calibrated_over_total(self):
        data = {"calibration": {"calibrated": 3, "overconfident": 1, "underconfident": 0}}
        summary = calibration_summary(data)
        assert summary["samples"] == 4
        assert summary["score"] == 0.75

    def test_enough_data_at_the_threshold(self):
        data = {"calibration": {"calibrated": CALIBRATION_MIN_SAMPLES}}
        assert calibration_summary(data)["enough_data"] is True

    def test_one_below_threshold_is_not_enough(self):
        data = {"calibration": {"calibrated": CALIBRATION_MIN_SAMPLES - 1}}
        assert calibration_summary(data)["enough_data"] is False

    def test_non_dict_calibration_is_ignored(self):
        assert calibration_summary({"calibration": "corrupt"})["samples"] == 0

    def test_none_data_is_safe(self):
        assert calibration_summary(None)["samples"] == 0


class TestHintLevelCounts:
    def test_missing_counts_are_zero(self):
        assert hint_level_counts({}) == {"1": 0, "2": 0, "3": 0, "4": 0}

    def test_reads_stored_counts(self):
        data = {"hint_level_counts": {"1": 5, "2": 2, "3": 1}}
        assert hint_level_counts(data) == {"1": 5, "2": 2, "3": 1, "4": 0}

    def test_garbage_values_fall_back_to_zero(self):
        data = {"hint_level_counts": {"1": "many", "2": None, "3": -4}}
        assert hint_level_counts(data) == {"1": 0, "2": 0, "3": 0, "4": 0}

    def test_hint_level_counts_reports_four_buckets(self):
        assert hint_level_counts({}) == {"1": 0, "2": 0, "3": 0, "4": 0}

    def test_hint_level_counts_reads_a_fourth_bucket(self):
        data = {"hint_level_counts": {"1": 5, "2": 2, "3": 1, "4": 3}}
        assert hint_level_counts(data) == {"1": 5, "2": 2, "3": 1, "4": 3}

    def test_a_legacy_document_without_a_fourth_bucket_reads_zero(self):
        data = {"hint_level_counts": {"1": 5, "2": 2, "3": 1}}
        assert hint_level_counts(data)["4"] == 0


class TestActivityStrip:
    def test_length_matches_window(self):
        assert len(activity_strip({}, TODAY, days=14)) == 14

    def test_oldest_first_ending_today(self):
        strip = activity_strip({}, TODAY, days=3)
        assert strip[0]["date"] == "2026-07-02"
        assert strip[-1]["date"] == TODAY.isoformat()

    def test_counts_are_picked_up_by_date(self):
        data = {"activity": {"2026-07-04": 3, "2026-07-03": 1}}
        strip = activity_strip(data, TODAY, days=3)
        assert [d["count"] for d in strip] == [0, 1, 3]

    def test_days_outside_the_window_are_dropped(self):
        data = {"activity": {"2026-01-01": 99}}
        assert all(d["count"] == 0 for d in activity_strip(data, TODAY, days=3))

    def test_garbage_counts_become_zero(self):
        data = {"activity": {TODAY.isoformat(): "lots"}}
        assert activity_strip(data, TODAY, days=1)[0]["count"] == 0


class TestBuildProgressNewFields:
    def test_includes_calibration_levels_and_activity(self):
        data = {
            "calibration": {"calibrated": 4, "overconfident": 1},
            "hint_level_counts": {"1": 3, "2": 1, "3": 0},
            "activity": {TODAY.isoformat(): 2},
        }
        report = build_progress(data, TODAY)
        assert report["calibration"]["samples"] == 5
        assert report["hint_level_counts"]["1"] == 3
        assert len(report["activity"]) == 14
        assert report["activity"][-1]["count"] == 2

    def test_empty_profile_still_produces_the_new_keys(self):
        report = build_progress({}, TODAY)
        assert report["calibration"]["samples"] == 0
        assert report["hint_level_counts"] == {"1": 0, "2": 0, "3": 0, "4": 0}
        assert len(report["activity"]) == 14
