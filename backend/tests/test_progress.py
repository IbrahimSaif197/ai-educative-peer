from datetime import date

from progress import (
    build_progress,
    concept_strengths,
    concept_struggles,
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
