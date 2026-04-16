import os
import json
import re
from typing import List, Tuple
from anthropic import Anthropic

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

MODEL_NAME = "claude-sonnet-4-6"

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
        self.client = Anthropic(api_key=api_key)

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

    def generate_hint(self, code: str, question: str, hint_level: int) -> Tuple[str, List[str]]:
        level = max(1, min(3, int(hint_level)))
        message = self.client.messages.create(
            model=MODEL_NAME,
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": self._build_user_message(code, question, level)}],
        )
        parts = []
        for block in message.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        hint_text = "\n".join(parts).strip()
        if "What do you think should happen next?" not in hint_text:
            hint_text = hint_text.rstrip() + "\n\nWhat do you think should happen next?"
        tags = self._extract_concept_tags(code, question, hint_text)
        return hint_text, tags


def build_engine() -> HintingEngine:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return HintingEngine(api_key=key)
