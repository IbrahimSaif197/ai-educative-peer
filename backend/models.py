import re

from pydantic import BaseModel, Field, field_validator
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

# The top of the hint ladder. Rungs 1-3 are the Socratic ladder; rung 4 *is*
# the worked example - see `effective_mode` in hinting_engine.py. Kept here
# because both session_store (which walks the ladder) and hinting_engine
# (which picks a prompt for it) need the same number, and models.py is the
# only module both already depend on.
MAX_HINT_LEVEL = 4


MAX_FOCUS_LABEL_CHARS = 120

# What a symbol name is allowed to look like. The label is the one client-
# supplied string that reaches the prompt OUTSIDE the <student_code-NONCE>
# wrapper, so it is checked against a shape rather than merely tidied:
# collapsing whitespace never stopped an instruction, it only put it on one
# line. Identifier characters plus the punctuation real symbol names carry
# (`Stats.average`, `impl<T>`, `arr[0]`, `ns::fn`, `$scope`, `read-file`).
#
# No space, deliberately. A real label is one token — `selection`,
# `calculate_average` — and excluding the space is what rejects prose, which
# is the whole shape of an injected instruction. The only label that loses is
# the window fallback's `lines 4-19`, and that costs nothing: focus_instruction
# already prints the same range itself, from start_line/end_line.
_SAFE_FOCUS_LABEL_RE = re.compile(rf"^[\w.$:<>\[\]-]{{0,{MAX_FOCUS_LABEL_CHARS}}}$")


class FocusRange(BaseModel):
    """The block of code the student is actually working on.

    `code` still carries the whole file, because a hint about a function is
    usually wrong without its imports and callers. This narrows the model's
    attention inside that file rather than replacing it.

    Deliberately permissive: `focus` is an optional enrichment, not a
    contract the client must satisfy exactly. An inverted or out-of-range
    span is nonsensical, not invalid — rejecting it here would turn a
    degradable failure into a 422 that silences the tutor entirely.
    `focus_instruction` and `generate_line_hint`'s window guard are the
    single gate that decides whether a span is usable.
    """

    start_line: int = Field(..., description="1-based first line of the block")
    end_line: int = Field(..., description="1-based last line, inclusive")
    label: str = Field(
        default="",
        description="Symbol name for the block, for the tutor to refer to",
    )

    @field_validator("label", mode="before")
    @classmethod
    def _null_is_empty(cls, value: object) -> object:
        # An explicit JSON null is a client spelling "no label", not a reason to
        # refuse the student's hint. This has to run before the str type check.
        return "" if value is None else value

    @field_validator("label")
    @classmethod
    def _single_line(cls, value: str) -> str:
        # Anything that is not shaped like a symbol name is dropped outright
        # rather than truncated: a truncated instruction is still an
        # instruction, and the label travels outside the untrusted-input
        # wrapper. Dropping it costs nothing — `focus_instruction` then names
        # the lines without a name, and the student still gets their hint.
        #
        # `fullmatch`, not `match`: Python's `$` also matches just before a
        # trailing newline, which is exactly the character this must reject.
        return value if _SAFE_FOCUS_LABEL_RE.fullmatch(value) else ""


class HintRequest(BaseModel):
    code: str = Field(default="", max_length=MAX_CODE_CHARS, description="The student's current code")
    question: str = Field(
        ...,
        max_length=MAX_QUESTION_CHARS,
        description="The student's question or described error",
    )
    hint_level: int = Field(default=1, ge=1, le=MAX_HINT_LEVEL)
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
    focus: Optional[FocusRange] = Field(
        default=None,
        description="The block inside `code` the student is working on",
    )


class HintResponse(BaseModel):
    hint: str
    hint_level: int
    concept_tags: List[str]
    # The mode the backend actually ran, which is not always `req.mode`: a
    # level-4 hint runs the worked example. The panel labels each card from
    # this, so without it a worked example arrives titled "hint 4".
    mode: str = "hint"


class HealthResponse(BaseModel):
    status: str
    service: str
    # "ok" or "unavailable". FirebaseService swallows a failed init, so without
    # this the service looks perfectly healthy while nothing persists.
    firestore: str = "unknown"


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
    focus: Optional[FocusRange] = Field(
        default=None,
        description="The block inside `code` the student is working on",
    )


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
