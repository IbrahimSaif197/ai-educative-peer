import os
import json
import re
from typing import List, Optional, Tuple
from groq import Groq

from languages import concepts_for, get_language

SYSTEM_PROMPT_TEMPLATE = """You are EduPeer, a Socratic programming tutor for beginner {language} students.
Your ONLY job is to guide students to find the answer themselves.

STRICT RULES:
- NEVER write working code or complete a function for the student
- NEVER give the direct answer
- ALWAYS respond with a question or a conceptual nudge
- If hint_level is 1: ask one guiding question only
- If hint_level is 2: identify the specific line or concept that needs attention, explain the concept briefly
- If hint_level is 3: provide pseudocode only, never real {language} syntax
- Keep responses under 150 words
- End every response with "What do you think should happen next?\""""

# Appended to every mode's system prompt so all replies carry concept tags.
CONCEPTS_FOOTER_TEMPLATE = """

After your response, on its own final line, write [concepts: tag-1, tag-2] with 1-3 tags
chosen ONLY from this list (the line is stripped before the student sees it):
{concepts}"""


REFLECT_TEMPLATE = """You are EduPeer, a Socratic programming tutor for beginner {language} students.
The student believes they have just FIXED a bug in their code. Your job is to verify
understanding, not correctness.

RULES:
- If the conversation does not yet contain your quiz question, ask exactly ONE short
  question about WHY their fix works (target the underlying concept)
- If the student has answered your quiz question, evaluate their reasoning: affirm what
  is right, question what is shaky
- NEVER write working code
- Keep responses under 100 words"""


TRANSLATE_TEMPLATE = """You are EduPeer, a Socratic programming tutor for beginner {language} students.
Earlier you gave the student a pseudocode hint (see conversation history). The student now
submits their own {language} translation of that pseudocode.

RULES:
- Give feedback ONLY on how faithfully their code translates the pseudocode
- Point out each mismatch as a question, never as corrected code
- If the translation is faithful, say so and ask them to run it
- NEVER write working code or fix their code for them
- Keep responses under 120 words"""


WORKED_EXAMPLE_TEMPLATE = """You are EduPeer, a programming tutor for beginner {language} students.
The student is stuck even after pseudocode hints. Show a fully WORKED EXAMPLE of the same
underlying concept applied to a CLEARLY DIFFERENT problem.

RULES:
- Invent a small, different problem that exercises the same concept
- Walk through the worked solution step by step, explaining the reasoning at each step
- The example must NOT solve the student's actual problem or reuse their variable names
- End by asking the student to apply the same idea to their own code
- Keep responses under 200 words"""


EXPLAIN_ERROR_TEMPLATE = """You are EduPeer, a tutor teaching beginner {language} students to READ error messages.
The student gives you an error message or stack trace (possibly with code).

RULES:
- Break the message into parts: what the runtime/compiler was doing, where it stopped,
  and what each part of the wording means
- Teach how to read this KIND of error so they can decode the next one on their own
- Do NOT reveal the fix; end with ONE question pointing them at the line or concept to inspect
- NEVER write working code
- Keep responses under 150 words"""


EXPLAIN_CONCEPT_TEMPLATE = """You are EduPeer, a tutor for beginner {language} students.
The student selected a construct in their code and wants it explained.

RULES:
- Explain what the construct does in plain language, in the context of their snippet
- Use an analogy if it helps
- Do NOT judge or fix their code
- End by offering ONE short comprehension question they can try to answer
- Keep responses under 150 words"""


PREDICT_OUTPUT_TEMPLATE = """You are EduPeer, a tutor for beginner {language} students practising output prediction.
The student gives a code snippet and their PREDICTION of what it does or prints.

RULES:
- Reason carefully about what the code actually does before responding
- If the prediction is right, confirm it and ask one deeper follow-up ("what if...?")
- If it is wrong, do NOT reveal the actual output; ask a question that walks them to the
  first point where their mental trace diverges from the code
- NEVER write working code
- Keep responses under 150 words"""


REVIEW_EXERCISE_TEMPLATE = """You are EduPeer, generating a spaced-review micro-exercise for a beginner {language} student.
The student previously struggled with the concept(s) named in the request.

RULES:
- Pose ONE small exercise (a 3-8 line scenario) exercising that concept
- Describe the task in words or pseudocode only - never provide {language} code to copy
- Ask them to write the code themselves and predict its behaviour
- Keep responses under 120 words"""


MODE_SYSTEM_TEMPLATES = {
    "hint": SYSTEM_PROMPT_TEMPLATE,
    "reflect": REFLECT_TEMPLATE,
    "translate": TRANSLATE_TEMPLATE,
    "worked-example": WORKED_EXAMPLE_TEMPLATE,
    "explain-error": EXPLAIN_ERROR_TEMPLATE,
    "explain-concept": EXPLAIN_CONCEPT_TEMPLATE,
    "predict-output": PREDICT_OUTPUT_TEMPLATE,
    "review-exercise": REVIEW_EXERCISE_TEMPLATE,
}


SCAN_SYSTEM_PROMPT_TEMPLATE = """You are EduPeer's static reviewer for beginner {language} code.
Identify up to 5 lines that look suspicious, buggy, or conceptually confused.
For each, craft ONE Socratic question (<=14 words) pointing the student toward the issue WITHOUT revealing the fix.

Output STRICT JSON only. Schema:
{{"flags":[{{"line":<int,1-based>,"end_line":<int,1-based>,"question":"<string>","concept":"<one-of-known-concepts-or-general>","severity":"info"|"warning"}}]}}

Rules:
- If nothing is suspicious, output {{"flags":[]}}
- Never include code, {language} syntax, or the answer in the question
- Never use more than 14 words per question
- Prefer "warning" only for likely bugs; everything else is "info"
- No markdown, no prose, JSON only"""


LINE_HINT_SYSTEM_PROMPT_TEMPLATE = """You are EduPeer. The student is writing {language}. Given the line the student is currently editing and surrounding context,
respond with ONE Socratic nudge of at most 12 words. No code. No direct answer. No trailing question mark required.
Also output the primary concept tag. Output STRICT JSON only:
{{"hint":"<<=12 words>>","concept":"<tag>"}}"""

MODEL_NAME = "llama-3.3-70b-versatile"

# How many prior conversation turns are replayed to the model.
MAX_HISTORY_TURNS = 6


class HintingEngine:
    def __init__(self, api_key: str):
        self.client = Groq(api_key=api_key)

    def _chat_messages(self, messages: List[dict], max_tokens: int) -> str:
        response = self.client.chat.completions.create(
            model=MODEL_NAME,
            max_tokens=max_tokens,
            messages=messages,
        )
        return response.choices[0].message.content or ""

    def _chat(self, system: str, user: str, max_tokens: int) -> str:
        return self._chat_messages(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens,
        )

    def _build_user_message(
        self, code: str, question: str, hint_level: int, language: str,
        mode: str = "hint",
    ) -> str:
        lang = get_language(language)
        code_block = code.strip() if code.strip() else "(no code provided)"
        if mode != "hint":
            return (
                f"Student's code:\n```{lang['fence']}\n{code_block}\n```\n\n"
                f"Student's message: {question}"
            )
        return (
            f"hint_level: {hint_level}\n\n"
            f"Student's code:\n```{lang['fence']}\n{code_block}\n```\n\n"
            f"Student's question: {question}\n\n"
            "Respond according to the STRICT RULES for the given hint_level."
        )

    def _extract_concept_tags(
        self, code: str, question: str, hint_text: str, language: str
    ) -> List[str]:
        haystack = f"{code}\n{question}\n{hint_text}".lower()
        tags = []
        for concept in concepts_for(language):
            needle = concept.replace("-", " ")
            alt = concept.replace("-", "")
            if needle in haystack or alt in haystack or concept in haystack:
                tags.append(concept)
        if not tags:
            tags.append("general")
        return tags[:6]

    _CONCEPTS_LINE_RE = re.compile(r"\[\s*concepts\s*:\s*([^\]]*)\]", re.IGNORECASE)

    @classmethod
    def _parse_concepts_line(cls, text: str) -> Tuple[str, List[str]]:
        """Strip the model-emitted "[concepts: a, b]" line, returning the
        cleaned text and the raw (unvalidated) tags."""
        tags: List[str] = []

        def capture(match: "re.Match[str]") -> str:
            tags.extend(
                t.strip().lower() for t in match.group(1).split(",") if t.strip()
            )
            return ""

        cleaned = cls._CONCEPTS_LINE_RE.sub(capture, text).rstrip()
        return cleaned, tags

    @staticmethod
    def _extract_json(text: str) -> dict:
        if not text:
            return {}
        match = re.search(r"\{.*\}", text, re.DOTALL)
        blob = match.group(0) if match else text
        try:
            return json.loads(blob)
        except json.JSONDecodeError:
            return {}

    def scan_code(self, code: str, language: str = "python") -> List[dict]:
        stripped = code.strip()
        if not stripped:
            return []
        lang = get_language(language)
        numbered = "\n".join(f"{i+1}: {ln}" for i, ln in enumerate(code.splitlines()))
        user_msg = (
            f"Review this beginner's {lang['display_name']} file. Flag at most 5 suspicious lines.\n\n"
            f"```{lang['fence']}\n{numbered}\n```\n\nRespond with JSON only."
        )
        system = SCAN_SYSTEM_PROMPT_TEMPLATE.format(language=lang["display_name"])
        text = self._chat(system, user_msg, 600)
        data = self._extract_json(text)
        flags = data.get("flags") if isinstance(data, dict) else None
        if not isinstance(flags, list):
            return []
        total_lines = max(1, len(code.splitlines()))
        cleaned: List[dict] = []
        for f in flags[:5]:
            if not isinstance(f, dict):
                continue
            try:
                line = int(f.get("line", 0))
                end_line = int(f.get("end_line", line))
            except (TypeError, ValueError):
                continue
            if line < 1 or line > total_lines:
                continue
            end_line = max(line, min(end_line, total_lines))
            question = str(f.get("question", "")).strip()
            if not question:
                continue
            question = " ".join(question.split()[:14])
            concept = str(f.get("concept", "general")).strip() or "general"
            severity = str(f.get("severity", "info")).strip().lower()
            if severity not in ("info", "warning"):
                severity = "info"
            cleaned.append(
                {
                    "line": line,
                    "end_line": end_line,
                    "question": question,
                    "concept": concept,
                    "severity": severity,
                }
            )
        return cleaned

    def generate_line_hint(
        self, code: str, line_number: int, language: str = "python"
    ) -> Tuple[str, str]:
        lines = code.splitlines()
        if not lines or line_number < 1 or line_number > len(lines):
            return "", "general"
        lang = get_language(language)
        idx = line_number - 1
        start = max(0, idx - 3)
        end = min(len(lines), idx + 4)
        window = "\n".join(
            f"{i+1}{'>' if i == idx else ':'} {lines[i]}" for i in range(start, end)
        )
        user_msg = (
            f"The student's cursor is on line {line_number} (marked with '>').\n"
            f"Context:\n```{lang['fence']}\n{window}\n```\n\nRespond with JSON only."
        )
        system = LINE_HINT_SYSTEM_PROMPT_TEMPLATE.format(language=lang["display_name"])
        text = self._chat(system, user_msg, 160)
        data = self._extract_json(text)
        hint = str(data.get("hint", "")).strip() if isinstance(data, dict) else ""
        concept = str(data.get("concept", "general")).strip() if isinstance(data, dict) else "general"
        if hint:
            hint = " ".join(hint.split()[:14])
        return hint, concept or "general"

    def generate_hint(
        self,
        code: str,
        question: str,
        hint_level: int,
        language: str = "python",
        history: Optional[List[dict]] = None,
        mode: str = "hint",
    ) -> Tuple[str, List[str]]:
        level = max(1, min(3, int(hint_level)))
        if mode not in MODE_SYSTEM_TEMPLATES:
            mode = "hint"
        lang = get_language(language)
        system = MODE_SYSTEM_TEMPLATES[mode].format(
            language=lang["display_name"]
        ) + CONCEPTS_FOOTER_TEMPLATE.format(concepts=", ".join(concepts_for(language)))

        messages: List[dict] = [{"role": "system", "content": system}]
        for turn in (history or [])[-MAX_HISTORY_TURNS:]:
            role = turn.get("role") if isinstance(turn, dict) else None
            content = str(turn.get("content", "")).strip() if isinstance(turn, dict) else ""
            if not content:
                continue
            messages.append(
                {
                    "role": "assistant" if role == "tutor" else "user",
                    "content": content,
                }
            )
        messages.append(
            {
                "role": "user",
                "content": self._build_user_message(code, question, level, language, mode),
            }
        )

        raw_text = self._chat_messages(messages, 400).strip()
        hint_text, raw_tags = self._parse_concepts_line(raw_text)
        if mode == "hint" and "What do you think should happen next?" not in hint_text:
            hint_text = hint_text.rstrip() + "\n\nWhat do you think should happen next?"
        known = set(concepts_for(language))
        tags = [t for t in raw_tags if t in known][:6]
        if not tags:
            tags = self._extract_concept_tags(code, question, hint_text, language)
        return hint_text, tags


def build_engine() -> HintingEngine:
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY is not set")
    return HintingEngine(api_key=key)
