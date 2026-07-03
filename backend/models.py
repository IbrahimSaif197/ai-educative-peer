from pydantic import BaseModel, Field
from typing import List, Literal, Optional


class ChatTurn(BaseModel):
    role: Literal["student", "tutor"]
    content: str


TutorMode = Literal[
    "hint", "reflect", "translate", "worked-example",
    "explain-error", "explain-concept", "predict-output", "review-exercise",
]


class HintRequest(BaseModel):
    code: str = Field(default="", description="The student's current code")
    question: str = Field(..., description="The student's question or described error")
    hint_level: int = Field(default=1, ge=1, le=3)
    language: str = Field(default="python", description="VS Code languageId of the code")
    mode: TutorMode = Field(
        default="hint",
        description="Tutor mode; only 'hint' advances the progressive hint level",
    )
    history: List[ChatTurn] = Field(
        default_factory=list,
        description="Prior conversation turns, oldest first",
    )


class HintResponse(BaseModel):
    hint: str
    hint_level: int
    concept_tags: List[str]


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


class ScanRequest(BaseModel):
    code: str = Field(default="", description="Full file content")
    language: str = Field(default="python", description="VS Code languageId of the code")


class LineFlag(BaseModel):
    line: int = Field(..., ge=1, description="1-based start line")
    end_line: int = Field(..., ge=1, description="1-based inclusive end line")
    question: str = Field(..., description="Short Socratic question (<=14 words)")
    concept: str = Field(default="general")
    severity: str = Field(default="info", description="info | warning")
    kind: Literal["bug", "style"] = Field(
        default="bug", description="bug flags point at defects; style at readability"
    )


class ScanResponse(BaseModel):
    flags: List[LineFlag] = []


class LineHintRequest(BaseModel):
    code: str = Field(default="", description="Full file content")
    line: int = Field(..., ge=1, description="1-based line the user is editing")
    language: str = Field(default="python", description="VS Code languageId of the code")


class LineHintResponse(BaseModel):
    hint: str
    concept: str = "general"


class MigrateRequest(BaseModel):
    old_id_token: Optional[str] = None
    legacy_user_id: Optional[str] = None
