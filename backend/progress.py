"""Pure helpers for progress reporting, adaptive pacing and spaced review.

Everything here works on the plain dicts stored in the users document so it
can be tested without Firestore.
"""

from datetime import date, datetime
from typing import Any, Dict, List, Optional

# A concept is a "struggle" when the student repeatedly needed deep hints and
# a "strength" when they consistently solved at the first question.
STRUGGLE_MIN_ENCOUNTERS = 2
STRUGGLE_MIN_AVG_LEVEL = 2.0
STRENGTH_MIN_ENCOUNTERS = 3
STRENGTH_MAX_AVG_LEVEL = 1.3

REVIEW_MIN_DAYS = 3
REVIEW_MAX_DAYS = 7


def _avg_level(entry: Dict[str, Any]) -> float:
    encounters = int(entry.get("encounters", 0))
    if encounters <= 0:
        return 0.0
    return int(entry.get("level_sum", 0)) / encounters


def concept_struggles(concept_stats: Optional[Dict[str, Any]], limit: int = 5) -> List[dict]:
    items = []
    for tag, entry in (concept_stats or {}).items():
        if not isinstance(entry, dict):
            continue
        avg = _avg_level(entry)
        if int(entry.get("encounters", 0)) >= STRUGGLE_MIN_ENCOUNTERS and avg >= STRUGGLE_MIN_AVG_LEVEL:
            items.append(
                {"concept": tag, "encounters": int(entry.get("encounters", 0)),
                 "avg_level": round(avg, 2)}
            )
    items.sort(key=lambda x: (-x["avg_level"], -x["encounters"]))
    return items[:limit]


def concept_strengths(concept_stats: Optional[Dict[str, Any]], limit: int = 5) -> List[dict]:
    items = []
    for tag, entry in (concept_stats or {}).items():
        if not isinstance(entry, dict):
            continue
        avg = _avg_level(entry)
        if int(entry.get("encounters", 0)) >= STRENGTH_MIN_ENCOUNTERS and avg <= STRENGTH_MAX_AVG_LEVEL:
            items.append(
                {"concept": tag, "encounters": int(entry.get("encounters", 0)),
                 "avg_level": round(avg, 2)}
            )
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
    }
