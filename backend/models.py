from pydantic import BaseModel, Field
from typing import List, Literal, Optional


class ChatTurn(BaseModel):
    role: Literal["student", "tutor"]
    content: str


TutorMode = Literal[
    "hint", "reflect", "translate", "worked-example",
    "explain-error", "explain-concept", "predict-output", "review-exercise",
    "subgoal-label", "trace-check",
]

# Longest edit summary accepted from a client. Diffs are built client-side, so
# this is the server's own bound on how much of the prompt they can occupy.
MAX_EDIT_SUMMARY_CHARS = 2000

# Everything a client can push into a prompt is bounded, so one request cannot
# spend an unbounded share of the Groq budget. A 40k file is far past anything
# a novice is debugging; a 4k question is a very long paste of a stack trace.
MAX_CODE_CHARS = 40000
MAX_QUESTION_CHARS = 4000
MAX_GOAL_CHARS = 500
MAX_PROBLEM_KEY_CHARS = 512


class HintRequest(BaseModel):
    code: str = Field(default="", max_length=MAX_CODE_CHARS, description="The student's current code")
    question: str = Field(
        ...,
        max_length=MAX_QUESTION_CHARS,
        description="The student's question or described error",
    )
    hint_level: int = Field(default=1, ge=1, le=3)
    problem_key: str = Field(
        default="",
        max_length=MAX_PROBLEM_KEY_CHARS,
        description=(
            "Stable identifier for the problem being worked on (the client "
            "sends the document URI). The hint ladder is keyed on this, so "
            "editing the code advances the level instead of restarting it. "
            "Empty falls back to a fingerprint of the code."
        ),
    )
    language: str = Field(default="python", description="VS Code languageId of the code")
    mode: TutorMode = Field(
        default="hint",
        description="Tutor mode; only 'hint' advances the progressive hint level",
    )
    history: List[ChatTurn] = Field(
        default_factory=list,
        description="Prior conversation turns, oldest first",
    )
    escalate: bool = Field(
        default=True,
        description=(
            "When false the hint level is re-used instead of advanced. The "
            "client sends this after an ask with no intervening code edit."
        ),
    )
    edit_summary: str = Field(
        default="",
        max_length=MAX_EDIT_SUMMARY_CHARS,
        description="Compact diff of what the student changed since the last hint",
    )
    confidence: int = Field(
        default=0,
        ge=0,
        le=3,
        description="Self-rated confidence before the hint; 0 means not given",
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
    code: str = Field(default="", max_length=MAX_CODE_CHARS, description="Full file content")
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
    code: str = Field(default="", max_length=MAX_CODE_CHARS, description="Full file content")
    line: int = Field(..., ge=1, description="1-based line the user is editing")
    language: str = Field(default="python", description="VS Code languageId of the code")


class LineHintResponse(BaseModel):
    hint: str
    concept: str = "general"


class MigrateRequest(BaseModel):
    old_id_token: Optional[str] = None
    legacy_user_id: Optional[str] = None


class GoalRequest(BaseModel):
    text: str = Field(
        default="",
        max_length=MAX_GOAL_CHARS,
        description="Free-text learning goal; empty clears it",
    )
    language: str = Field(default="python", description="Language context for concept mapping")


class TraceRequest(BaseModel):
    code: str = Field(default="", max_length=MAX_CODE_CHARS, description="Full file content, for context")
    selection: str = Field(
        default="",
        max_length=MAX_CODE_CHARS,
        description="The snippet to trace; empty means the whole file",
    )
    language: str = Field(default="python", description="VS Code languageId of the code")


class TraceResponse(BaseModel):
    """A desk-check exercise: which variables to track over how many steps."""

    variables: List[str] = Field(default_factory=list, description="2-4 variable names")
    steps: int = Field(default=0, ge=0, le=8, description="Rows the student fills in; 0 means unavailable")
    prompt: str = Field(default="", description="One sentence telling the student what to trace")
