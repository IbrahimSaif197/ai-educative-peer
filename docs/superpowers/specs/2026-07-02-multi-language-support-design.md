# Multi-language support + conversation history — design

Date: 2026-07-02
Status: approved for implementation

## Goal

1. Extend EduPeer from Python-only to six beginner languages: **Python,
   JavaScript, Java, C, C++, C#**.
2. Give the Socratic tutor conversational memory: `/hint` currently treats
   every question as the first one, so follow-up questions ("I tried that,
   now it prints twice") get answered with no context.

## Non-goals

- No new languages beyond the six (the registry makes adding more a
  one-entry change).
- No per-language static analysis or compilers; the LLM remains the only
  analyser.
- No changes to badge rules or Firestore schema (interactions gain a
  `language` field, which Firestore absorbs without migration).

## Approaches considered

**A. Language-specific prompt files per language.** Six copies of each of
the three prompts. Rejected: 18 prompts to keep in sync; the Socratic rules
are language-independent.

**B. Single parametrized prompt + small language registry (chosen).** One
registry entry per language: display name, markdown fence tag, and extra
concept tags (e.g. `pointers`, `segfault` for C/C++). Prompts interpolate
the display name; level-3 "pseudocode only" rule stays universal.

**C. Client-side only (extension translates languageId, backend stays
"python").** Rejected: prompts would still say "Python students" and the
level-3 rule "never real Python syntax" would let the model emit real Java.

## Design

### Backend

- `languages.py` (new): `LANGUAGES` dict keyed by VS Code `languageId`
  (`python`, `javascript`, `java`, `c`, `cpp`, `csharp`) with
  `{display_name, fence, concepts}`. `normalize_language(raw)` maps aliases
  (`js`→`javascript`, `c++`→`cpp`, `c#`→`csharp`, `typescript`→`javascript`)
  and falls back to `python` for unknown/empty values so old clients are
  unaffected.
- `models.py`: `language: str = "python"` on `HintRequest`, `ScanRequest`,
  `LineHintRequest`. New `ChatTurn {role: "student"|"tutor", content: str}`
  and `history: List[ChatTurn] = []` on `HintRequest`.
- `hinting_engine.py`:
  - The three prompts become templates taking the display name; code fences
    use the registry fence tag.
  - `KNOWN_CONCEPTS` splits into a shared base list + per-language extras
    from the registry; `_extract_concept_tags` uses base + active language's
    extras.
  - `generate_hint(code, question, hint_level, language, history)` builds
    the messages array as system → prior turns (student→user, tutor→
    assistant, capped to the last 6 turns) → current user message.
  - `scan_code(code, language)` and `generate_line_hint(code, line,
    language)` gain the language parameter.
- `main.py`: pass `req.language` (normalized) and `req.history` through;
  no endpoint shape changes otherwise.

### Extension

- `languages.ts` (new): `SUPPORTED_LANGUAGES` map languageId →
  `{label, lensRegex}` where `lensRegex` finds "definition-like" lines for
  the 💡 Get-a-hint CodeLens (Python `def|class`; JS `function`/arrow/
  `class`; Java/C# method or class headers; C/C++ function-definition
  heuristic).
- `inlineTutor.ts`: gate on the registry; register CodeLens/Hover providers
  for all six languages; send `doc.languageId` with scan and line-hint
  requests; user-facing messages say "supported file" and list languages.
- `apiClient.ts`: `language` parameter on `getHint`, `scanCode`,
  `getLineHint`.
- `sidebarProvider.ts`: include `languageId` in `activeCode` messages and
  hint requests; keep a transcript (student/tutor turns) that is sent as
  `history` with each ask and cleared on reset.
- `media/main.js` + `style.css`: language chip next to the file name.
- `package.json`: menu/keybinding `when` clauses use
  `resourceLangId =~ /^(python|javascript|java|c|cpp|csharp)$/`; settings
  descriptions updated.

### Error handling

- Unknown `language` values never fail a request — they normalize to
  `python` (backend) or are simply unsupported (extension gate).
- `history` is optional; malformed roles are rejected by pydantic
  validation (422), same as other fields.

### Testing

- Backend: registry normalization tests; engine tests asserting the prompt
  contains the right display name/fence and that history turns land in the
  messages array in order; endpoint tests for default language and history
  cap.
- Extension: jest tests for `apiClient` sending `language`, and for the
  per-language `lensRegex` behaviour.
