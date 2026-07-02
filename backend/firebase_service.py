import os
import asyncio
from typing import List, Optional, Dict, Any

import firebase_admin
from firebase_admin import credentials, firestore


BADGE_FIRST_QUESTION = "First Question"
BADGE_PERSISTENT_LEARNER = "Persistent Learner"
BADGE_HINT_MINIMISER = "Hint Minimiser"
BADGE_CONCEPT_EXPLORER = "Concept Explorer"


def _apply_badge_rules(badges, total_interactions, sessions, solved_at_level_1, concept_tags_seen):
    """Return the badge list with any newly-earned badges appended."""
    result = list(badges)

    def award(name: str):
        if name not in result:
            result.append(name)

    if total_interactions >= 1:
        award(BADGE_FIRST_QUESTION)
    if sessions >= 5:
        award(BADGE_PERSISTENT_LEARNER)
    if solved_at_level_1 >= 3:
        award(BADGE_HINT_MINIMISER)
    if len(concept_tags_seen) >= 5:
        award(BADGE_CONCEPT_EXPLORER)
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

            badges = _apply_badge_rules(
                badges, total_interactions, sessions, solved_at_level_1, concept_tags_seen
            )

            user_ref.set(
                {
                    "badges": badges,
                    "total_interactions": total_interactions,
                    "sessions": sessions,
                    "concept_tags_seen": concept_tags_seen,
                    "solved_at_level_1": solved_at_level_1,
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
        )
        loop.run_in_executor(
            None,
            self._update_user_and_award_badges_sync,
            user_id,
            hint_level_used,
            concept_tags,
            new_session,
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
                )
            )
            self._pending_tasks.add(task)
            task.add_done_callback(self._pending_tasks.discard)
        except RuntimeError:
            pass

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
            badges = _apply_badge_rules(badges, total, sessions, solved_1, tags)

            tgt_ref.set(
                {
                    "badges": badges,
                    "total_interactions": total,
                    "sessions": sessions,
                    "concept_tags_seen": tags,
                    "solved_at_level_1": solved_1,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            users.document(source_uid).delete()
            return True
        except Exception as e:
            print(f"[firebase] merge failed: {e}")
            return False
