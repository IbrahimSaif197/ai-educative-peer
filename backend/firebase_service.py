import os
import asyncio
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional, Dict, Any, Tuple

import firebase_admin
from firebase_admin import credentials, firestore


from languages import LANGUAGES
from progress import classify_calibration

BADGE_FIRST_QUESTION = "First Question"
BADGE_PERSISTENT_LEARNER = "Persistent Learner"
BADGE_HINT_MINIMISER = "Hint Minimiser"
BADGE_CONCEPT_EXPLORER = "Concept Explorer"
BADGE_STREAK_3 = "3-Day Streak"
BADGE_STREAK_7 = "Week Streak"
BADGE_STREAK_30 = "Month Streak"
BADGE_POLYGLOT = "Polyglot"
BADGE_HINT_MINIMISER_2 = "Hint Minimiser II"
BADGE_HINT_MINIMISER_3 = "Hint Minimiser III"
BADGE_MARATHON = "Marathon Learner"
BADGE_SCHOLAR = "Scholar"


def _apply_badge_rules(
    badges,
    total_interactions,
    sessions,
    solved_at_level_1,
    concept_tags_seen,
    streak_days=0,
    languages_used=(),
):
    """Return the badge list with any newly-earned badges appended."""
    result = list(badges)

    def award(name: str):
        if name not in result:
            result.append(name)

    if total_interactions >= 1:
        award(BADGE_FIRST_QUESTION)
    if sessions >= 5:
        award(BADGE_PERSISTENT_LEARNER)
    if sessions >= 15:
        award(BADGE_MARATHON)
    if sessions >= 50:
        award(BADGE_SCHOLAR)
    if solved_at_level_1 >= 3:
        award(BADGE_HINT_MINIMISER)
    if solved_at_level_1 >= 10:
        award(BADGE_HINT_MINIMISER_2)
    if solved_at_level_1 >= 25:
        award(BADGE_HINT_MINIMISER_3)
    if len(concept_tags_seen) >= 5:
        award(BADGE_CONCEPT_EXPLORER)
    if streak_days >= 3:
        award(BADGE_STREAK_3)
    if streak_days >= 7:
        award(BADGE_STREAK_7)
    if streak_days >= 30:
        award(BADGE_STREAK_30)
    known_languages = [l for l in languages_used if l in LANGUAGES]
    for lang_id in known_languages:
        award(f"{LANGUAGES[lang_id]['display_name']} Learner")
    if len(known_languages) >= 3:
        award(BADGE_POLYGLOT)
    return result


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _update_streak(
    last_active_date: Optional[str], streak_days: int, today: date
) -> Tuple[str, int]:
    """Return (new last_active_date, new streak_days) for an activity today."""
    today_iso = today.isoformat()
    if last_active_date == today_iso:
        return today_iso, max(1, int(streak_days or 0))
    yesterday_iso = (today - timedelta(days=1)).isoformat()
    if last_active_date == yesterday_iso:
        return today_iso, int(streak_days or 0) + 1
    return today_iso, 1


def _update_concept_stats(
    stats: Optional[Dict[str, Any]],
    concept_tags: List[str],
    hint_level: int,
    today: date,
) -> Dict[str, Any]:
    """Fold one interaction into the per-concept stats map (copy, not in place)."""
    result = {k: dict(v) for k, v in (stats or {}).items() if isinstance(v, dict)}
    today_iso = today.isoformat()
    for tag in concept_tags:
        entry = result.setdefault(
            tag,
            {"encounters": 0, "level_sum": 0, "max_level": 0,
             "last_seen": today_iso, "last_struggled": None},
        )
        entry["encounters"] = int(entry.get("encounters", 0)) + 1
        entry["level_sum"] = int(entry.get("level_sum", 0)) + int(hint_level)
        entry["max_level"] = max(int(entry.get("max_level", 0)), int(hint_level))
        entry["last_seen"] = today_iso
        if hint_level >= 2:
            entry["last_struggled"] = today_iso
    return result


def _update_calibration(
    calibration: Optional[Dict[str, Any]], verdict: Optional[str]
) -> Dict[str, Any]:
    """Fold one confidence-vs-outcome verdict into the counters (copy)."""
    result = {
        key: int((calibration or {}).get(key, 0))
        for key in ("calibrated", "overconfident", "underconfident")
    }
    if verdict in result:
        result[verdict] += 1
    return result


def _update_hint_level_counts(
    counts: Optional[Dict[str, Any]], hint_level: int
) -> Dict[str, int]:
    result = {key: int((counts or {}).get(key, 0)) for key in ("1", "2", "3")}
    key = str(max(1, min(3, int(hint_level))))
    result[key] += 1
    return result


def _update_activity(
    activity: Optional[Dict[str, Any]], today: date, keep_days: int = 30
) -> Dict[str, int]:
    """Per-day interaction counts, trimmed to the most recent `keep_days`."""
    result: Dict[str, int] = {}
    for iso, value in (activity or {}).items():
        try:
            result[str(iso)] = int(value)
        except (TypeError, ValueError):
            continue
    today_iso = today.isoformat()
    result[today_iso] = result.get(today_iso, 0) + 1
    cutoff = (today - timedelta(days=keep_days)).isoformat()
    return {iso: n for iso, n in result.items() if iso >= cutoff}


def _merge_activity(
    a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]
) -> Dict[str, int]:
    result: Dict[str, int] = {}
    for source in (a or {}), (b or {}):
        for iso, value in source.items():
            try:
                result[str(iso)] = result.get(str(iso), 0) + int(value)
            except (TypeError, ValueError):
                continue
    return result


def _merge_counters(
    a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]], keys: Tuple[str, ...]
) -> Dict[str, int]:
    return {
        key: int((a or {}).get(key, 0)) + int((b or {}).get(key, 0)) for key in keys
    }


def _merge_concept_stats(
    a: Optional[Dict[str, Any]], b: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    result = {k: dict(v) for k, v in (a or {}).items() if isinstance(v, dict)}
    for tag, entry in (b or {}).items():
        if not isinstance(entry, dict):
            continue
        if tag not in result:
            result[tag] = dict(entry)
            continue
        tgt = result[tag]
        tgt["encounters"] = int(tgt.get("encounters", 0)) + int(entry.get("encounters", 0))
        tgt["level_sum"] = int(tgt.get("level_sum", 0)) + int(entry.get("level_sum", 0))
        tgt["max_level"] = max(int(tgt.get("max_level", 0)), int(entry.get("max_level", 0)))
        tgt["last_seen"] = max(tgt.get("last_seen") or "", entry.get("last_seen") or "") or None
        tgt["last_struggled"] = (
            max(tgt.get("last_struggled") or "", entry.get("last_struggled") or "") or None
        )
    return result


class FirebaseService:
    def __init__(self):
        self._client = None
        self._init_error: Optional[str] = None
        # Hold strong references to in-flight fire-and-forget tasks so the
        # event loop doesn't garbage-collect them before they complete.
        self._pending_tasks: set = set()
        try:
            project_id = os.environ["FIREBASE_PROJECT_ID"]
            private_key = os.environ["FIREBASE_PRIVATE_KEY"].replace("\\n", "\n")
            client_email = os.environ["FIREBASE_CLIENT_EMAIL"]
            cred_dict = {
                "type": "service_account",
                "project_id": project_id,
                "private_key": private_key,
                "client_email": client_email,
                "token_uri": "https://oauth2.googleapis.com/token",
            }
            if not firebase_admin._apps:
                cred = credentials.Certificate(cred_dict)
                firebase_admin.initialize_app(cred, {"projectId": project_id})
            self._client = firestore.client()
        except Exception as e:
            self._init_error = str(e)
            print(f"[firebase] initialization failed: {e}")

    @property
    def enabled(self) -> bool:
        return self._client is not None

    @property
    def client(self):
        return self._client

    def _log_interaction_sync(
        self,
        user_id: str,
        code_snippet: str,
        question: str,
        hint_level_used: int,
        concept_tags: List[str],
        language: str = "python",
        confidence: int = 0,
    ) -> None:
        if not self.enabled:
            return
        try:
            doc = {
                "user_id": user_id,
                "timestamp": firestore.SERVER_TIMESTAMP,
                "code_snippet": code_snippet,
                "question": question,
                "hint_level_used": hint_level_used,
                "concept_tags": concept_tags,
                "language": language,
                "confidence": int(confidence or 0),
            }
            self._client.collection("interactions").add(doc)
        except Exception as e:
            print(f"[firebase] interaction write failed: {e}")

    def _update_user_and_award_badges_sync(
        self,
        user_id: str,
        hint_level_used: int,
        concept_tags: List[str],
        new_session: bool,
        language: str = "python",
        confidence: int = 0,
    ) -> List[str]:
        if not self.enabled:
            return []
        try:
            user_ref = self._client.collection("users").document(user_id)
            snap = user_ref.get()
            data: Dict[str, Any] = snap.to_dict() if snap.exists else {}

            badges = list(data.get("badges", []))
            total_interactions = int(data.get("total_interactions", 0)) + 1
            sessions = int(data.get("sessions", 0))
            if new_session or sessions == 0:
                sessions += 1
            concept_tags_seen = list(set(list(data.get("concept_tags_seen", [])) + concept_tags))
            solved_at_level_1 = int(data.get("solved_at_level_1", 0))
            if hint_level_used == 1:
                solved_at_level_1 += 1

            today = _today()
            concept_stats = _update_concept_stats(
                data.get("concept_stats"), concept_tags, hint_level_used, today
            )
            languages_used = sorted(set(list(data.get("languages_used", [])) + [language]))
            last_active_date, streak_days = _update_streak(
                data.get("last_active_date"), int(data.get("streak_days", 0)), today
            )

            calibration = _update_calibration(
                data.get("calibration"),
                classify_calibration(int(confidence or 0), hint_level_used),
            )
            level_counts = _update_hint_level_counts(
                data.get("hint_level_counts"), hint_level_used
            )
            activity = _update_activity(data.get("activity"), today)

            badges = _apply_badge_rules(
                badges, total_interactions, sessions, solved_at_level_1, concept_tags_seen,
                streak_days=streak_days, languages_used=languages_used,
            )

            user_ref.set(
                {
                    "badges": badges,
                    "total_interactions": total_interactions,
                    "sessions": sessions,
                    "concept_tags_seen": concept_tags_seen,
                    "solved_at_level_1": solved_at_level_1,
                    "concept_stats": concept_stats,
                    "languages_used": languages_used,
                    "last_active_date": last_active_date,
                    "streak_days": streak_days,
                    "calibration": calibration,
                    "hint_level_counts": level_counts,
                    "activity": activity,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            return badges
        except Exception as e:
            print(f"[firebase] user update failed: {e}")
            return []

    async def log_interaction_async(
        self,
        user_id: str,
        code_snippet: str,
        question: str,
        hint_level_used: int,
        concept_tags: List[str],
        new_session: bool,
        language: str = "python",
        confidence: int = 0,
    ) -> None:
        loop = asyncio.get_running_loop()
        loop.run_in_executor(
            None,
            self._log_interaction_sync,
            user_id,
            code_snippet,
            question,
            hint_level_used,
            concept_tags,
            language,
            confidence,
        )
        loop.run_in_executor(
            None,
            self._update_user_and_award_badges_sync,
            user_id,
            hint_level_used,
            concept_tags,
            new_session,
            language,
            confidence,
        )

    def fire_and_forget(
        self,
        user_id: str,
        code_snippet: str,
        question: str,
        hint_level_used: int,
        concept_tags: List[str],
        new_session: bool,
        language: str = "python",
        confidence: int = 0,
    ) -> None:
        try:
            task = asyncio.create_task(
                self.log_interaction_async(
                    user_id,
                    code_snippet,
                    question,
                    hint_level_used,
                    concept_tags,
                    new_session,
                    language,
                    confidence,
                )
            )
            self._pending_tasks.add(task)
            task.add_done_callback(self._pending_tasks.discard)
        except RuntimeError:
            pass

    def get_user_profile_sync(self, user_id: str) -> Dict[str, Any]:
        """The full users doc, or {} when unavailable."""
        if not self.enabled:
            return {}
        try:
            snap = self._client.collection("users").document(user_id).get()
            return snap.to_dict() or {} if snap.exists else {}
        except Exception as e:
            print(f"[firebase] read profile failed: {e}")
            return {}

    def set_goal_sync(self, user_id: str, text: str, concepts: List[str]) -> None:
        if not self.enabled:
            return
        try:
            goal = (
                {"text": text, "concepts": concepts, "set_at": _today().isoformat()}
                if text.strip()
                else None
            )
            self._client.collection("users").document(user_id).set(
                {"goal": goal, "updated_at": firestore.SERVER_TIMESTAMP}, merge=True
            )
        except Exception as e:
            print(f"[firebase] set goal failed: {e}")

    def get_recent_interactions_sync(self, user_id: str, limit: int = 10) -> List[Dict[str, Any]]:
        if not self.enabled:
            return []
        try:
            query = self._client.collection("interactions").where("user_id", "==", user_id)
            try:
                docs = list(
                    query.order_by("timestamp", direction=firestore.Query.DESCENDING)
                    .limit(limit)
                    .stream()
                )
            except Exception:
                # Ordered query needs a composite index; fall back to unordered.
                docs = list(query.limit(limit).stream())
            return [d.to_dict() or {} for d in docs]
        except Exception as e:
            print(f"[firebase] read interactions failed: {e}")
            return []

    def append_session_summary_sync(self, user_id: str, summary: str) -> None:
        if not self.enabled or not summary.strip():
            return
        try:
            ref = self._client.collection("users").document(user_id)
            snap = ref.get()
            data = snap.to_dict() or {} if snap.exists else {}
            summaries = [s for s in data.get("session_summaries", []) if isinstance(s, dict)]
            summaries.append({"text": summary, "date": _today().isoformat()})
            ref.set(
                {"session_summaries": summaries[-20:], "updated_at": firestore.SERVER_TIMESTAMP},
                merge=True,
            )
        except Exception as e:
            print(f"[firebase] append summary failed: {e}")

    def get_user_badges_sync(self, user_id: str) -> List[str]:
        if not self.enabled:
            return []
        try:
            snap = self._client.collection("users").document(user_id).get()
            if not snap.exists:
                return []
            return list(snap.to_dict().get("badges", []))
        except Exception as e:
            print(f"[firebase] read badges failed: {e}")
            return []

    def merge_user_sync(self, source_uid: str, target_uid: str) -> bool:
        """Merge one user's stats/badges doc into another's, then delete the
        source doc. Returns True only when a merge actually happened."""
        if not self.enabled or source_uid == target_uid:
            return False
        try:
            users = self._client.collection("users")
            src_snap = users.document(source_uid).get()
            if not src_snap.exists:
                return False
            src: Dict[str, Any] = src_snap.to_dict() or {}
            tgt_ref = users.document(target_uid)
            tgt_snap = tgt_ref.get()
            tgt: Dict[str, Any] = tgt_snap.to_dict() if tgt_snap.exists else {}

            total = int(src.get("total_interactions", 0)) + int(tgt.get("total_interactions", 0))
            sessions = int(src.get("sessions", 0)) + int(tgt.get("sessions", 0))
            solved_1 = int(src.get("solved_at_level_1", 0)) + int(tgt.get("solved_at_level_1", 0))
            tags = list(set(list(src.get("concept_tags_seen", [])) + list(tgt.get("concept_tags_seen", []))))
            badges = list(set(list(src.get("badges", [])) + list(tgt.get("badges", []))))
            concept_stats = _merge_concept_stats(
                src.get("concept_stats"), tgt.get("concept_stats")
            )
            languages_used = sorted(
                set(list(src.get("languages_used", [])) + list(tgt.get("languages_used", [])))
            )
            streak_days = max(int(src.get("streak_days", 0)), int(tgt.get("streak_days", 0)))
            last_active_date = (
                max(src.get("last_active_date") or "", tgt.get("last_active_date") or "") or None
            )
            calibration = _merge_counters(
                src.get("calibration"),
                tgt.get("calibration"),
                ("calibrated", "overconfident", "underconfident"),
            )
            level_counts = _merge_counters(
                src.get("hint_level_counts"), tgt.get("hint_level_counts"), ("1", "2", "3")
            )
            activity = _merge_activity(src.get("activity"), tgt.get("activity"))
            badges = _apply_badge_rules(
                badges, total, sessions, solved_1, tags,
                streak_days=streak_days, languages_used=languages_used,
            )

            tgt_ref.set(
                {
                    "badges": badges,
                    "total_interactions": total,
                    "sessions": sessions,
                    "concept_tags_seen": tags,
                    "solved_at_level_1": solved_1,
                    "concept_stats": concept_stats,
                    "languages_used": languages_used,
                    "streak_days": streak_days,
                    "last_active_date": last_active_date,
                    "calibration": calibration,
                    "hint_level_counts": level_counts,
                    "activity": activity,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            users.document(source_uid).delete()
            return True
        except Exception as e:
            print(f"[firebase] merge failed: {e}")
            return False
