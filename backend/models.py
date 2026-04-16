from pydantic import BaseModel, Field
from typing import List, Optional


class HintRequest(BaseModel):
    code: str = Field(default="", description="The student's current Python code")
    question: str = Field(..., description="The student's question or described error")
    user_id: str = Field(..., description="Persistent user identifier")
    hint_level: int = Field(default=1, ge=1, le=3)


class HintResponse(BaseModel):
    hint: str
    hint_level: int
    concept_tags: List[str]


class ResetSessionRequest(BaseModel):
    user_id: str


class HealthResponse(BaseModel):
    status: str
    service: str


class UserBadges(BaseModel):
    user_id: str
    badges: List[str] = []
    total_interactions: int = 0
    sessions: int = 0
    concept_tags_seen: List[str] = []
    solved_at_level_1: int = 0
