import os
import json
import re
from typing import List, Tuple
from groq import Groq

SYSTEM_PROMPT = """You are EduPeer, a Socratic programming tutor for beginner Python students.
Your ONLY job is to guide students to find the answer themselves.

STRICT RULES:
- NEVER write working code or complete a function for the student
- NEVER give the direct answer
- ALWAYS respond with a question or a conceptual nudge
- If hint_level is 1: ask one guiding question only
- If hint_level is 2: identify the specific line or concept that needs attention, explain the concept briefly
- If hint_level is 3: provide pseudocode only, never real Python syntax
- Keep responses under 150 words
- End every response with "What do you think should happen next?\""""


SCAN_SYSTEM_PROMPT = """You are EduPeer's static reviewer for beginner Python code.
Identify up to 5 lines that look suspicious, buggy, or conceptually confused.
For each, craft ONE Socratic question (<=14 words) pointing the student toward the issue WITHOUT revealing the fix.

Output STRICT JSON only. Schema:
{"flags":[{"line":<int,1-based>,"end_line":<int,1-based>,"question":"<string>","concept":"<one-of-known-concepts-or-general>","severity":"info"|"warning"}]}

Rules:
- If nothing is suspicious, output {"flags":[]}
- Never include code, Python syntax, or the answer in the question
- Never use more than 14 words per question
- Prefer "warning" only for likely bugs; everything else is "info"
- No markdown, no prose, JSON only"""


LINE_HINT_SYSTEM_PROMPT = """You are EduPeer. Given the line the student is currently editing and surrounding context,
respond with ONE Socratic nudge of at most 12 words. No code. No direct answer. No trailing question mark required.
Also output the primary concept tag. Output STRICT JSON only:
{"hint":"<<=12 words>>","concept":"<tag>"}"""

MODEL_NAME = "llama-3.3-70b-versatile"

KNOWN_CONCEPTS = [
    "variables", "loops", "for-loop", "while-loop", "conditionals", "if-statement",
    "functions", "recursion", "lists", "dictionaries", "tuples", "sets", "strings",
    "indexing", "slicing", "classes", "objects", "inheritance", "exceptions",
    "file-io", "imports", "scope", "mutability", "iterators", "comprehensions",
    "lambdas", "decorators", "generators", "typing", "booleans", "operators",
    "input-output", "indentation", "syntax-error", "off-by-one", "type-error",
    "name-error", "index-error", "key-error", "attribute-error", "return-value",
]


class HintingEngine:
    def __init__(self, api_key: str):
        self.client = Groq(api_key=api_key)

    def _chat(self, system: str, user: str, max_tokens: int) -> str:
        response = self.client.chat.completions.create(
            model=MODEL_NAME,
            max_tokens=max_tokens,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return response.choices[0].message.content or ""

    def _build_user_message(self, code: str, question: str, hint_level: int) -> str:
        code_block = code.strip() if code.strip() else "(no code provided)"
        return (
            f"hint_level: {hint_level}\n\n"
            f"Student's code:\n```python\n{code_block}\n```\n\n"
            f"Student's question: {question}\n\n"
            "Respond according to the STRICT RULES for the given hint_level."
        )

    def _extract_concept_tags(self, code: str, question: str, hint_text: str) -> List[str]:
        haystack = f"{code}\n{question}\n{hint_text}".lower()
        tags = []
        for concept in KNOWN_CONCEPTS:
            needle = concept.replace("-", " ")
            alt = concept.replace("-", "")
            if needle in haystack or alt in haystack or concept in haystack:
                tags.append(concept)
        if not tags:
            tags.append("general")
        return tags[:6]

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

    def scan_code(self, code: str) -> List[dict]:
        stripped = code.strip()
        if not stripped:
            return []
        numbered = "\n".join(f"{i+1}: {ln}" for i, ln in enumerate(code.splitlines()))
        user_msg = (
            "Review this beginner's Python file. Flag at most 5 suspicious lines.\n\n"
            f"```python\n{numbered}\n```\n\nRespond with JSON only."
        )
        text = self._chat(SCAN_SYSTEM_PROMPT, user_msg, 600)
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

    def generate_line_hint(self, code: str, line_number: int) -> Tuple[str, str]:
        lines = code.splitlines()
        if not lines or line_number < 1 or line_number > len(lines):
            return "", "general"
        idx = line_number - 1
        start = max(0, idx - 3)
        end = min(len(lines), idx + 4)
        window = "\n".join(
            f"{i+1}{'>' if i == idx else ':'} {lines[i]}" for i in range(start, end)
        )
        user_msg = (
            f"The student's cursor is on line {line_number} (marked with '>').\n"
            f"Context:\n```python\n{window}\n```\n\nRespond with JSON only."
        )
        text = self._chat(LINE_HINT_SYSTEM_PROMPT, user_msg, 160)
        data = self._extract_json(text)
        hint = str(data.get("hint", "")).strip() if isinstance(data, dict) else ""
        concept = str(data.get("concept", "general")).strip() if isinstance(data, dict) else "general"
        if hint:
            hint = " ".join(hint.split()[:14])
        return hint, concept or "general"

    def generate_hint(self, code: str, question: str, hint_level: int) -> Tuple[str, List[str]]:
        level = max(1, min(3, int(hint_level)))
        hint_text = self._chat(SYSTEM_PROMPT, self._build_user_message(code, question, level), 400)
        hint_text = hint_text.strip()
        if "What do you think should happen next?" not in hint_text:
            hint_text = hint_text.rstrip() + "\n\nWhat do you think should happen next?"
        tags = self._extract_concept_tags(code, question, hint_text)
        return hint_text, tags


def build_engine() -> HintingEngine:
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY is not set")
    return HintingEngine(api_key=key)
