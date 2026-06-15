import os
import asyncio
from typing import List, Optional, Dict, Any

import firebase_admin
from firebase_admin import credentials, firestore


BADGE_FIRST_QUESTION = "First Question"
BADGE_PERSISTENT_LEARNER = "Persistent Learner"
BADGE_HINT_MINIMISER = "Hint Minimiser"
BADGE_CONCEPT_EXPLORER = "Concept Explorer"


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

            def award(name: str):
                if name not in badges:
                    badges.append(name)

            if total_interactions >= 1:
                award(BADGE_FIRST_QUESTION)
            if sessions >= 5:
                award(BADGE_PERSISTENT_LEARNER)
            if solved_at_level_1 >= 3:
                award(BADGE_HINT_MINIMISER)
            if len(concept_tags_seen) >= 5:
                award(BADGE_CONCEPT_EXPLORER)

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
    ) -> None:
        try:
            task = asyncio.create_task(
                self.log_interaction_async(
                    user_id, code_snippet, question, hint_level_used, concept_tags, new_session
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
