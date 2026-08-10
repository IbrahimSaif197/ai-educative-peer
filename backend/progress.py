"""Pure helpers for progress reporting, adaptive pacing and spaced review.

Everything here works on the plain dicts stored in the users document so it
can be tested without Firestore.
"""

from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from models import MAX_HINT_LEVEL

# A concept is a "struggle" when the student repeatedly needed deep hints and
# a "strength" when they consistently solved at the first question.
STRUGGLE_MIN_ENCOUNTERS = 2
STRUGGLE_MIN_AVG_LEVEL = 2.0
STRENGTH_MIN_ENCOUNTERS = 3
STRENGTH_MAX_AVG_LEVEL = 1.3

REVIEW_MIN_DAYS = 3
REVIEW_MAX_DAYS = 7

# Below this many rated hints the calibration score is noise, so the dashboard
# says "not enough data" instead of showing a number.
CALIBRATION_MIN_SAMPLES = 4


def _rated_encounters(entry: Dict[str, Any]) -> int:
    """How many of this concept's encounters carried a meaningful hint level.

    Only `hint`-mode turns are rated. Documents written before the distinction
    existed have no `rated_encounters` key; for those, every encounter counted
    towards the average, so fall back to `encounters`.
    """
    raw = entry.get("rated_encounters")
    if raw is None:
        return int(entry.get("encounters", 0))
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def _avg_level(entry: Dict[str, Any]) -> float:
    rated = _rated_encounters(entry)
    if rated <= 0:
        return 0.0
    return int(entry.get("level_sum", 0)) / rated


def concept_struggles(concept_stats: Optional[Dict[str, Any]], limit: int = 5) -> List[dict]:
    items = []
    for tag, entry in (concept_stats or {}).items():
        if not isinstance(entry, dict):
            continue
        avg = _avg_level(entry)
        rated = _rated_encounters(entry)
        if rated >= STRUGGLE_MIN_ENCOUNTERS and avg >= STRUGGLE_MIN_AVG_LEVEL:
            items.append({"concept": tag, "encounters": rated, "avg_level": round(avg, 2)})
    items.sort(key=lambda x: (-x["avg_level"], -x["encounters"]))
    return items[:limit]


def concept_strengths(concept_stats: Optional[Dict[str, Any]], limit: int = 5) -> List[dict]:
    items = []
    for tag, entry in (concept_stats or {}).items():
        if not isinstance(entry, dict):
            continue
        avg = _avg_level(entry)
        rated = _rated_encounters(entry)
        # `rated >= STRENGTH_MIN_ENCOUNTERS` also keeps a concept that has only
        # ever been seen in non-hint modes (avg 0.0) out of the strengths list.
        if rated >= STRENGTH_MIN_ENCOUNTERS and avg <= STRENGTH_MAX_AVG_LEVEL:
            items.append({"concept": tag, "encounters": rated, "avg_level": round(avg, 2)})
    items.sort(key=lambda x: (x["avg_level"], -x["encounters"]))
    return items[:limit]


def pacing_summary(concept_stats: Optional[Dict[str, Any]], goal_text: str = "") -> str:
    """One paragraph of tutor-facing context, or "" when there is no signal."""
    struggles = concept_struggles(concept_stats, limit=3)
    strengths = concept_strengths(concept_stats, limit=3)
    parts: List[str] = []
    if struggles:
        names = ", ".join(s["concept"] for s in struggles)
        parts.append(
            f"The student has repeatedly needed deep hints on: {names}. "
            "Scaffold these concepts more gently."
        )
    if strengths:
        names = ", ".join(s["concept"] for s in strengths)
        parts.append(
            f"The student usually solves these at the first question: {names}. "
            "Stay terse there."
        )
    if goal_text:
        parts.append(f"The student's stated learning goal: {goal_text}.")
    if not parts:
        return ""
    return "Tutor pacing context (never mention this to the student): " + " ".join(parts)


def classify_calibration(confidence: int, hint_level: int) -> Optional[str]:
    """Compare a pre-hint confidence rating (1-3) against the depth of hint
    the student actually needed.

    Returns "overconfident", "underconfident", "calibrated", or None when no
    rating was given.
    """
    if confidence < 1 or confidence > 3:
        return None
    if confidence == 3 and hint_level >= 3:
        return "overconfident"
    if confidence == 1 and hint_level <= 1:
        return "underconfident"
    return "calibrated"


def calibration_summary(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Shape the stored calibration counters into the /progress payload."""
    raw = (data or {}).get("calibration")
    raw = raw if isinstance(raw, dict) else {}
    calibrated = int(raw.get("calibrated", 0))
    over = int(raw.get("overconfident", 0))
    under = int(raw.get("underconfident", 0))
    samples = calibrated + over + under
    score = round(calibrated / samples, 2) if samples else 0.0
    return {
        "samples": samples,
        "score": score,
        "calibrated": calibrated,
        "overconfident": over,
        "underconfident": under,
        "enough_data": samples >= CALIBRATION_MIN_SAMPLES,
    }


def _parse_iso(value: Any) -> Optional[date]:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def review_due_concepts(
    concept_stats: Optional[Dict[str, Any]], today: date, limit: int = 3
) -> List[str]:
    """Concepts struggled with 3-7 days ago, ripest (most encounters) first."""
    due = []
    for tag, entry in (concept_stats or {}).items():
        if not isinstance(entry, dict):
            continue
        struggled = _parse_iso(entry.get("last_struggled"))
        if struggled is None:
            continue
        age = (today - struggled).days
        if REVIEW_MIN_DAYS <= age <= REVIEW_MAX_DAYS:
            due.append((int(entry.get("encounters", 0)), tag))
    due.sort(reverse=True)
    return [tag for _, tag in due[:limit]]


ACTIVITY_WINDOW_DAYS = 14


def hint_level_counts(data: Optional[Dict[str, Any]]) -> Dict[str, int]:
    """How many hints landed at each level, for the dashboard distribution."""
    raw = (data or {}).get("hint_level_counts")
    raw = raw if isinstance(raw, dict) else {}
    counts = {}
    for level in (str(n) for n in range(1, MAX_HINT_LEVEL + 1)):
        try:
            counts[level] = max(0, int(raw.get(level, 0)))
        except (TypeError, ValueError):
            counts[level] = 0
    return counts


def activity_strip(
    data: Optional[Dict[str, Any]], today: date, days: int = ACTIVITY_WINDOW_DAYS
) -> List[dict]:
    """One entry per day for the last `days` days, oldest first."""
    raw = (data or {}).get("activity")
    raw = raw if isinstance(raw, dict) else {}
    strip = []
    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        iso = day.isoformat()
        try:
            count = max(0, int(raw.get(iso, 0)))
        except (TypeError, ValueError):
            count = 0
        strip.append({"date": iso, "count": count})
    return strip


def build_progress(data: Optional[Dict[str, Any]], today: date) -> Dict[str, Any]:
    """Shape the users doc into the /progress response."""
    data = data or {}
    concept_stats = data.get("concept_stats") or {}
    goal = data.get("goal") or None
    if goal and not (isinstance(goal, dict) and str(goal.get("text", "")).strip()):
        goal = None
    summaries = [s for s in (data.get("session_summaries") or []) if isinstance(s, dict)]
    return {
        "badges": list(data.get("badges", [])),
        "total_interactions": int(data.get("total_interactions", 0)),
        "sessions": int(data.get("sessions", 0)),
        "streak_days": int(data.get("streak_days", 0)),
        "languages_used": list(data.get("languages_used", [])),
        "goal": goal,
        "concept_struggles": concept_struggles(concept_stats),
        "concept_strengths": concept_strengths(concept_stats),
        "session_summaries": summaries[-5:],
        "review_due": bool(review_due_concepts(concept_stats, today)),
        "calibration": calibration_summary(data),
        "hint_level_counts": hint_level_counts(data),
        "activity": activity_strip(data, today),
    }
