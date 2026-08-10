# EduPeer — System Reference

**STALE AS OF 2026-08-09 — branch `feat/focus-scope-and-auth-redesign`.** This
document was generated against `main` at the commit named in Section 1,
before this branch existed, and has not been refreshed for it. Known wrong,
not exhaustively:

1. **`extension/src/inlineTutor.ts`** and **`extension/src/sidebarProvider.ts`**
   — both cited throughout this document — were substantially reworked (the
   lens state machine, focus scoping, the signed-out sidebar invitation
   card). Their line-number citations no longer point at the code described.
2. **Three modules this document does not mention at all:**
   `extension/src/annotationStore.ts`, `extension/src/blockHeuristics.ts`,
   `extension/src/focusScope.ts`.
3. **Two commands this document does not mention at all:**
   `edupeer.deepenLine`, `edupeer.dismissLine`.
4. **One setting this document does not mention at all:** `edupeer.lensMode`.
5. **`backend/static/auth.html` was rewritten**, from the 131 lines this
   document's file-size table and file listing still report, to a much
   larger file. Every `auth.html:N` line citation below is wrong, and the
   manual-verification rows for "Sign-in success card" and "Invalid sign-in
   link" quote copy the new page no longer has — "You're signed in ✔ —
   Return to VS Code" and "Sign-in link is invalid" were both replaced
   during this branch's redesign.

Treat every line-number citation in this document as **UNVERIFIED** until it
is regenerated against this branch. This banner marks the damage; the
sections below it were not refreshed.

---

Generated for use as the sole source for Chapters 4, 5 and 6 of the Final Year
Project report. Every claim below was checked against the code at the commit
named in Section 1. Where a claim could not be checked from the repository it
is marked **UNVERIFIED** with the reason.

---

## 1. Snapshot

| Item | Value |
| --- | --- |
| Base commit SHA | `71142b44e859a8431ffa639dd06259a28df72cc5` |
| Branch | `main` |
| Document generated | 2026-08-05 |
| Working tree at generation | **Uncommitted changes present** — see "Changes since the base commit" below |

### Changes since the base commit

This document describes the working tree, not the base commit. Four pieces of
work were applied after `71142b4`:

1. **A failed hint no longer spends a hint level** (Section 12). The session
   store gained `peek_hint_level` / `commit_hint_level`, and `/hint` and
   `/hint/stream` now commit only after the LLM has actually produced a reply.
2. **Inaccurate documentation claims removed** (Section 18). `demo.py` moved
   into `demos/`, the unused `BACKEND_URL` was dropped from `.env.example`, and
   two README statements were corrected.
3. **Direct unit tests added for the five previously untested modules**
   (Section 16), together with a substantially expanded `vscode` mock,
   `jest-environment-jsdom`, and `pytest-cov`.
4. **An audit-and-fix pass over the whole system.** On the backend the hint
   ladder is now keyed on `problem_key`, `/reset`, `/goal` and `/review` gained
   rate-limit dependencies, request fields gained `max_length` caps, sessions
   lapse after 30 minutes idle (`SESSION_IDLE_SECONDS = 1800`), student text is
   wrapped in nonce-delimited untrusted blocks, and the level-derived counters
   only update for `mode == "hint"`. In the extension the sign-in callback is
   state-checked, HTTP requests carry timeouts and abort signals, stale streams
   are discarded by sequence number, and per-file inline state is released when
   a document closes. The pass added `backend/tests/test_audit_regressions.py`,
   `extension/src/__tests__/auditRegressions.test.ts` and
   `extension/src/__tests__/streamHint.test.ts`, and split the test-only pins
   out into `backend/requirements-dev.txt`.

### Line counts

Excludes `node_modules/`, `backend/.venv/`, `package-lock.json`, `__pycache__/`,
`coverage/` and build output (`extension/out/`).

| Area | Lines |
| --- | --- |
| Backend source (10 `.py` modules, excluding tests) | 2,545 |
| Backend tests (13 test files + `conftest.py`) | 3,833 |
| Backend static asset (`static/auth.html`) | 131 |
| **Backend total** | **6,509** |
| Extension source (16 `.ts` modules, excluding tests/mocks) | 3,843 |
| Extension tests (21 test files) | 5,307 |
| Extension test mock (`__mocks__/vscode.ts`) | 382 |
| Extension webview assets (`media/`: 2 JS, 1 CSS, 1 SVG) | 1,635 |
| **Extension total** | **11,167** |
| **Project total** | **17,676** |

Source-to-test ratio: backend 2,545 source vs 3,833 test lines (1.51:1);
extension 3,843 source vs 5,307 test lines (1.38:1).

### Measured coverage

Both figures were produced by running the tools, not estimated.

| Suite | Command | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- | --- |
| Backend source | `pytest --cov=auth --cov=cache --cov=firebase_service --cov=hinting_engine --cov=languages --cov=main --cov=models --cov=progress --cov=ratelimit --cov=session_store` | **93%** (1,102 / 1,181) | — | — | — |
| Extension source | `npm run test:coverage` | **89.45%** | 78.23% | 88.15% | **90.99%** |

`media/main.js` and `media/markdown.js` are excluded from the extension figure:
both are loaded through `new Function` in their tests, which istanbul cannot
instrument. They are behaviourally covered by 116 tests but contribute no
percentage.

---

## 2. Repository structure

### Directory tree (two levels)

```
ai-educative-peer/
├── backend/              FastAPI service: LLM calls, Firestore persistence, auth
│   ├── static/           auth.html, the browser sign-in page served by /auth/login
│   └── tests/            pytest suite for the backend
├── extension/            VS Code extension (TypeScript)
│   ├── media/            Webview assets: CSS, JS, icon, walkthrough markdown
│   ├── out/              esbuild bundle output (gitignored)
│   └── src/              Extension source, plus __tests__/ and __mocks__/
├── demos/                Deliberately buggy sample files, one per language
├── docs/                 Design specs and plans
│   └── superpowers/      specs/ and plans/ written during development
├── .vscode/              Tracked editor config: settings.json (codeLensFontSize 16), launch.json, tasks.json
├── .claude/              Local agent tool config (not part of the system)
└── .superpowers/         Development-process artefacts (diffs, progress notes)
```

### Backend source files

| File | Lines | Responsibility |
| --- | --- | --- |
| `backend/main.py` | 441 | FastAPI app: every HTTP route, CORS, rate-limit dependency, response caches, profile cache. |
| `backend/hinting_engine.py` | 622 | All prompt templates and every Groq call: hints, streaming, scan, line hints, trace design, session summary, goal mapping. |
| `backend/firebase_service.py` | 570 | Firestore reads/writes for the `users` and `interactions` collections; badge rules, streak, concept stats, calibration, account merge. |
| `backend/progress.py` | 218 | Pure functions over the user document: struggles/strengths, pacing summary, calibration, review scheduling, hint-level counts, activity strip. |
| `backend/session_store.py` | 230 | Code fingerprinting, hint-level state and idle session lapse, in two interchangeable implementations (Firestore-backed and in-memory). |
| `backend/languages.py` | 152 | Registry of the ten tutored languages, their concept tags, fence tags and aliases. |
| `backend/models.py` | 156 | Pydantic request/response schemas, the field length caps and the `TutorMode` literal. |
| `backend/ratelimit.py` | 80 | Per-user token-bucket limiter and a registry of named budgets. |
| `backend/cache.py` | 51 | Bounded TTL/LRU cache used for `/scan` and `/line-hint` responses. |
| `backend/auth.py` | 25 | Firebase ID-token verification and the `get_current_uid` FastAPI dependency. |
| `backend/static/auth.html` | 131 | Browser sign-in page (Google, GitHub, email/password) that validates the `state` parameter and POSTs tokens back to the extension. |

### Extension source files

| File | Lines | Responsibility |
| --- | --- | --- |
| `extension/src/sidebarProvider.ts` | 653 | The webview view provider: the whole tutoring conversation loop, attempt gating, request sequencing and disposal, the webview HTML and its CSP. |
| `extension/src/inlineTutor.ts` | 574 | In-editor surfaces: CodeLens, hover, diagnostics, gutter decorations, Quick Fix actions, auto-scan and line-hint scheduling. |
| `extension/src/apiClient.ts` | 456 | Typed HTTP client for every backend endpoint, SSE parsing, request and stream-idle timeouts, availability tracking, `RateLimitError`. |
| `extension/src/localTutor.ts` | 356 | Rule-based offline tutor: pattern-matched Socratic questions per language. |
| `extension/src/extension.ts` | 331 | `activate()`: wiring, all command registrations, health polling, status bar. |
| `extension/src/authManager.ts` | 333 | Anonymous bootstrap, token refresh, sign-in session storage, pending-migration retry. |
| `extension/src/progressPanel.ts` | 282 | Pure HTML/SVG builder for the progress dashboard webview. |
| `extension/src/attemptTracker.ts` | 177 | Line diff over normalised code and the attempt/cooldown decision that governs hint escalation. |
| `extension/src/pedagogy.ts` | 160 | Pure helpers: tutor-mode type, code fingerprint, error-text detection, question framing for each mode. |
| `extension/src/statusBar.ts` | 85 | Status bar item and the pure `renderStatus` formatter. |
| `extension/src/debugCompanion.ts` | 85 | Debug adapter tracker that offers help when a program stops on an exception. |
| `extension/src/testWatcher.ts` | 79 | Terminal shell-integration watcher that offers help when a test command exits non-zero. |
| `extension/src/signInFlow.ts` | 127 | One-shot localhost HTTP server that receives the sign-in callback, rejecting it unless the `state` parameter matches. |
| `extension/src/languages.ts` | 71 | Client-side language registry with the CodeLens detection regexes. |
| `extension/src/offlineQueue.ts` | 60 | Persists `reset`/`goal` mutations attempted while offline and replays them. |
| `extension/src/firebaseClient.ts` | 14 | Thin wrapper exposing `getBadges()` over `ApiClient`. |

### Webview assets

| File | Lines | Responsibility |
| --- | --- | --- |
| `extension/media/style.css` | 804 | Sidebar design system built entirely on VS Code theme tokens. |
| `extension/media/main.js` | 659 | Webview controller: message handling, chat rendering, trace grid, confidence chips, hint-depth stepper, loading lockout. |
| `extension/media/markdown.js` | 169 | Dependency-free Markdown renderer that builds DOM nodes and never assigns `innerHTML`. |
| `extension/media/icon.svg` | 3 | Activity bar icon. |
| `extension/media/walkthrough/*.md` | 4 files | Static markdown shown in the getting-started walkthrough. |

### Demo files

`demos/` contains ten files, one per supported language: `demo.c`, `demo.cpp`,
`Demo.cs`, `demo.go`, `Demo.java`, `demo.js`, `demo.py`, `demo.rs`,
`demo.sql`, `demo.ts`. `demo.py` was moved here from the repository root so the
README and walkthrough statements about `demos/` hold.

---

## 3. Runtime and dependencies

| Item | Value | Source |
| --- | --- | --- |
| Python (project venv) | 3.12.10 | `backend/.venv/Scripts/python.exe --version` |
| Node.js | v22.19.0 | `node --version` |
| npm | 11.7.0 | `npm --version` |
| Minimum VS Code engine | `^1.85.0` | `extension/package.json:8` |
| TypeScript target / module | ES2020 / CommonJS | `extension/tsconfig.json` |

Python and Node versions are those of the development machine at generation
time. The repository pins no Python version (no `.python-version`,
`pyproject.toml` or `setup.py`) and no Node version (no `engines.node` field in
`extension/package.json`). **UNVERIFIED**: the minimum Python and Node versions
the project actually requires — nothing in the repository declares them.

### Backend dependencies (`backend/requirements.txt`, `backend/requirements-dev.txt`)

`requirements.txt` now holds the six runtime dependencies only; the four
test-only pins live in `requirements-dev.txt`, which begins with
`-r requirements.txt` so a development install pulls both. All ten are pinned
with `==`.

| Package | Version | Runtime or dev | Used for |
| --- | --- | --- | --- |
| `fastapi` | 0.115.0 | Runtime | Web framework; routing, dependency injection, `HTTPException` (`backend/main.py:18`). |
| `uvicorn[standard]` | 0.30.6 | Runtime | ASGI server; the documented start command is `uvicorn main:app --reload`. |
| `groq` | 0.11.0 | Runtime | Groq SDK client for all LLM calls (`backend/hinting_engine.py:6`). |
| `python-dotenv` | 1.0.1 | Runtime | Loads `.env` at import time (`backend/main.py:8-14`). |
| `firebase-admin` | 6.5.0 | Runtime | Firestore client and ID-token verification (`backend/firebase_service.py:6-7`, `backend/auth.py:2`). |
| `pydantic` | 2.9.2 | Runtime | Request/response models and validation (`backend/models.py:1`). |
| `pytest` | 8.3.3 | Dev (`requirements-dev.txt`) | Test runner. |
| `pytest-asyncio` | 0.24.0 | Dev (`requirements-dev.txt`) | `@pytest.mark.asyncio` in `backend/tests/test_main.py`. |
| `pytest-cov` | 5.0.0 | Dev (`requirements-dev.txt`) | The `--cov` measurement reported in Section 1. |
| `httpx` | 0.27.2 | Dev (`requirements-dev.txt`) | `httpx.ASGITransport` in the event-loop test; also a transitive dependency of `fastapi.testclient`. |

### Extension dependencies (`extension/package.json:229-239`)

There are **no runtime dependencies**. Every entry is a devDependency, and the
extension is bundled with esbuild before packaging, so nothing is shipped from
`node_modules`. `vsce package --no-dependencies` (`extension/package.json:225`)
confirms this.

| Package | Version range | Used for |
| --- | --- | --- |
| `@types/jest` | ^29.5.0 | Type definitions for the test suite. |
| `@types/node` | ^20.11.0 | Node type definitions (`crypto`, `http` are used at runtime by the extension host). |
| `@types/vscode` | ^1.85.0 | VS Code API type definitions. |
| `@vscode/vsce` | ^3.9.2 | Packages the `.vsix`. |
| `esbuild` | ^0.28.1 | Bundles `src/extension.ts` into `out/extension.js`. |
| `jest` | ^29.7.0 | Test runner. |
| `jest-environment-jsdom` | ^29.7.0 | The jsdom environment selected by the `@jest-environment jsdom` docblock in `webviewMain.test.ts`. |
| `ts-jest` | ^29.2.0 | TypeScript transform for Jest. |
| `typescript` | ^5.4.0 | Type checking (`npm run compile`). |

Runtime APIs used by the extension that are supplied by the host rather than a
package: the global `fetch` (Node 18+, used throughout `apiClient.ts` and
`authManager.ts`), `node:crypto` (`sidebarProvider.ts:1`, `signInFlow.ts:1`) and
`node:http` (`signInFlow.ts:2`).

---

## 4. Configuration

### Environment variables (backend)

| Name | Read at | Required | Default | Secret? | What breaks if missing |
| --- | --- | --- | --- | --- | --- |
| `GROQ_API_KEY` | `backend/hinting_engine.py:619` | **Yes** | none | **Secret** | `build_engine()` raises `RuntimeError("GROQ_API_KEY is not set")` at `backend/hinting_engine.py:621`. This runs at import of `main.py` (`backend/main.py:56`), so the backend does not start at all. |
| `FIREBASE_PROJECT_ID` | `backend/firebase_service.py:216` | No (degrades) | none | Public identifier | `FirebaseService.__init__` raises internally, is caught at `backend/firebase_service.py:230-232`, prints `[firebase] initialization failed:` and leaves `self._client = None`. The backend still starts; all persistence becomes a no-op and `build_session_store` falls back to `InMemorySessionStore` (`backend/session_store.py:225-230`). |
| `FIREBASE_PRIVATE_KEY` | `backend/firebase_service.py:217` | No (degrades) | none | **Secret** | Same as above. Literal `\n` sequences are converted to real newlines at read time. |
| `FIREBASE_CLIENT_EMAIL` | `backend/firebase_service.py:218` | No (degrades) | none | Semi-public (service-account address) | Same as above. |
| `FIREBASE_WEB_API_KEY` | `backend/main.py:134`, `backend/main.py:143` | No | `""` | **Public** (Firebase web API keys are designed to be client-visible) | `GET /auth/config` returns an empty `apiKey`, so `AuthManager.getApiKey()` gets `""`; anonymous bootstrap and token refresh then fail against Google's endpoints. Sign-in and all authenticated calls stop working. |
| `FIREBASE_AUTH_DOMAIN` | `backend/main.py:135`, `backend/main.py:144` | No | `""` | **Public** | The served `auth.html` initialises Firebase with an empty `authDomain`; Google and GitHub popup sign-in fail. |

Notes:

- The three service-account variables are read with `os.environ[...]`
  (subscript), so a missing one raises `KeyError` — but that exception is
  inside the same `try` block and is caught, which is why the backend degrades
  rather than crashing.
- `.env` is loaded twice: from the current working directory
  (`backend/main.py:10`) and then from the project root with
  `override=False` (`backend/main.py:11-14`), so a `backend/.env` wins over a
  root `.env`.
- `.env` is gitignored (`.gitignore:2`).

### Previously declared but unused

`BACKEND_URL` used to appear in `.env.example` and in the README, but no code
ever read it. Both have been corrected: the variable is gone from
`.env.example`, and the README now states that the extension takes the backend
address from the `edupeer.backendUrl` VS Code setting. A repository-wide search
for `BACKEND_URL` now returns nothing.

### VS Code settings (`extension/package.json:193-218`)

| Setting | Type | Default | Constraint | Read at |
| --- | --- | --- | --- | --- |
| `edupeer.backendUrl` | string | `http://localhost:8000` | none | `extension/src/extension.ts:20`, re-read on change at `extension/src/extension.ts:318-328` |
| `edupeer.inlineHints` | boolean | `true` | none | `extension/src/inlineTutor.ts:209-211` |
| `edupeer.autoScan` | boolean | `true` | none | `extension/src/inlineTutor.ts:351-353` |
| `edupeer.debounceMs` | number | `1800` | minimum 600 | `extension/src/inlineTutor.ts:233-235`; additionally floored at 600 in code (`Math.max(600, debounceMs)`, `extension/src/inlineTutor.ts:250`) |

Changing `edupeer.backendUrl` at runtime updates both the API client and the
auth manager without a reload; the other three are read on each use.

`.vscode/settings.json` in this repository sets only
`"editor.codeLensFontSize": 16`, which affects how large the inline CodeLens
prompts render.

---

## 5. Backend module reference

### `backend/main.py`

**Responsibility.** Defines the FastAPI application and every route. Owns the
process-level caches and rate limiters.

**Module-level state (all lost on restart):**

| Name | Line | Contents | Effect of loss |
| --- | --- | --- | --- |
| `engine` | 56 | The single `HintingEngine` instance | Rebuilt on start; requires `GROQ_API_KEY`. |
| `firebase` | 57 | The single `FirebaseService` | Reconnects on start. |
| `store` | 58 | Session store (Firestore-backed or in-memory) | If in-memory, all hint levels reset to 1. |
| `_profile_cache` | 62 | `{uid: (monotonic_time, user_doc)}`, TTL 60 s, cleared wholesale above 5000 entries (`main.py:117-118`) | Next `/hint` re-reads Firestore. No data loss. |
| `SCAN_CACHE` | 67 | `TtlCache(ttl_seconds=300.0, max_entries=1000)` | Next `/scan` costs an LLM call. |
| `LINE_HINT_CACHE` | 68 | `TtlCache(ttl_seconds=300.0, max_entries=2000)` | Next `/line-hint` costs an LLM call. |
| `limiters` | 74-82 | `RateLimiterRegistry` with buckets `hint` (30/60s), `inline` (60/60s), `trace` (10/60s), `session` (10/60s, used by `/reset` and `/goal`), `review` (6/60s) | Every user's budget resets to full. |

**Public functions:**

| Signature | Line | Returns |
| --- | --- | --- |
| `rate_limited(bucket: str)` | 85 | A FastAPI dependency callable that verifies the bearer token then spends one rate-limit token; raises 429 with a `Retry-After` header when the bucket is empty. |
| `_utc_today() -> datetime.date` | 101 | Today's date in UTC. |
| `_cached_profile(uid: str) -> dict` | 105 | The user document, from the 60-second cache or Firestore. Reads through `firebase.try_get_user_profile_sync`, so a failed read (which returns `None`) is never cached: the last good value is served instead and the next request re-reads. |
| `_ladder_key(req: HintRequest) -> str` | 174 | What the hint ladder is keyed on: `req.problem_key.strip()` (the client sends the document URI), falling back to `code_fingerprint(req.code)` when it is empty. Editing the file therefore no longer restarts the ladder at level 1. |
| `_resolve_hint_level(req: HintRequest, uid: str) -> int` | 188 | The level this request answers at, without spending it. Non-`hint` modes return `req.hint_level` unchanged; `hint` mode calls `store.peek_hint_level(uid, _ladder_key(req), req.escalate)`. |
| `_commit_hint_level(req: HintRequest, uid: str, level: int) -> None` | 207 | Spends the level once a hint has actually been produced, so a failed LLM call never costs a level. A no-op for non-`hint` modes. |
| `_pacing_for(req: HintRequest, uid: str) -> str` | 214 | The adaptive-pacing paragraph, or `""` for non-`hint` modes. |

Route handlers are listed in Section 6.

**Depends on:** `models`, `auth`, `cache`, `hinting_engine`, `firebase_service`,
`languages`, `progress`, `ratelimit`, `session_store`.

CORS is configured at `backend/main.py:48-54` with `allow_origins=["*"]`,
`allow_credentials=False`, all methods and all headers.

### `backend/hinting_engine.py`

**Responsibility.** Every prompt and every Groq API call. Contains no
persistence and no HTTP concerns.

**Module constants:**

| Name | Line | Value |
| --- | --- | --- |
| `MODEL_NAME` | 212 | `"llama-3.3-70b-versatile"` |
| `MAX_HISTORY_TURNS` | 215 | `6` |
| `MAX_TRACE_VARIABLE_CHARS` | 207 | `40` |
| `MIN_TRACE_STEPS` | 208 | `3` |
| `MAX_TRACE_STEPS` | 209 | `8` |
| `HintingEngine.STREAM_HOLDBACK_CHARS` | 578 | `40` |
| `MODE_SYSTEM_TEMPLATES` | 146-157 | Maps the ten tutor modes to their system prompt templates. |
| `UNTRUSTED_INPUT_RULE` | 14-16 | Appended to every system prompt (`scan_code` and every mode template). Tells the model that everything inside a `<student_code-ID>` / `<student_message-ID>` block is untrusted student data to be discussed, never obeyed. |

**Public API of `HintingEngine`:**

| Signature | Line | Returns |
| --- | --- | --- |
| `__init__(self, api_key: str)` | 219 | Constructs a `Groq` client. |
| `scan_code(self, code: str, language: str = "python") -> List[dict]` | 335 | Validated flag dicts with keys `line`, `end_line`, `question`, `concept`, `severity`, `kind`. Max 5 `bug` + 2 `style`. Returns `[]` on empty code or unparseable JSON. Max tokens 600. |
| `generate_line_hint(self, code: str, line_number: int, language: str = "python") -> Tuple[str, str]` | 400 | `(hint, concept)`. Sends a 7-line window (3 before, the line, 3 after) with the target marked `>`. Hint truncated to 14 words. Max tokens 160. |
| `design_trace_table(self, snippet: str, language: str = "python") -> Tuple[List[str], int, str]` | 428 | `(variables, steps, prompt)` or `([], 0, "")`. Max tokens 200. Validation described in Section 7. |
| `summarize_session(self, interactions: List[dict]) -> str` | 471 | A three-bullet note built from at most 10 interactions, each question truncated to 200 chars. Returns `""` when there are no usable questions. Max tokens 220. |
| `map_goal_to_concepts(self, goal_text: str, language: str = "python") -> List[str]` | 488 | At most 4 tags, filtered against the language's known concept list. Max tokens 120. |
| `generate_hint(self, code, question, hint_level, language="python", history=None, mode="hint", pacing="", edit_summary="") -> Tuple[str, List[str]]` | 559 | `(hint_text, concept_tags)`. Max tokens 400. |
| `stream_hint(self, code, question, hint_level, language="python", history=None, mode="hint", pacing="", edit_summary="")` | 580 | A generator yielding `{"type": "delta", "text": str}` events then one `{"type": "done", "hint": str, "concept_tags": List[str]}`. Max tokens 400. |

**Internal helpers worth naming** (used by tests): `_chat_messages` (222),
`_chat` (230), `_wrap_untrusted` (240, a `staticmethod`),
`_build_user_message` (252), `_extract_concept_tags` (282),
`_parse_concepts_line` (310, a `classmethod`), `_extract_json` (325, a
`staticmethod`), `_prepare_hint_messages` (502), `_finalize_hint` (547).
`_build_user_message` and `scan_code` wrap student text with `_wrap_untrusted`,
which fences it in `<tag-NONCE>` blocks (fresh 16-hex nonce per request, and
the nonce is stripped out of the body) instead of the markdown fences they used
before.

**Module function:** `build_engine() -> HintingEngine` (618) reads
`GROQ_API_KEY` and raises `RuntimeError` if unset.

**Depends on:** `groq`, `languages`.

**In-process state:** none beyond the `Groq` client. Nothing to lose on restart.

### `backend/firebase_service.py`

**Responsibility.** All Firestore access, plus the pure rule functions that
compute badges, streaks, concept statistics, calibration counters and merges.

**Badge constants:** `backend/firebase_service.py:13-24` (exact display strings
in Section 11).

**Pure module functions:**

| Signature | Line | Returns |
| --- | --- | --- |
| `_apply_badge_rules(badges, total_interactions, sessions, solved_at_level_1, concept_tags_seen, streak_days=0, languages_used=()) -> list` | 27 | The badge list with newly earned badges appended (never removed, never duplicated). |
| `_today() -> date` | 73 | UTC date. |
| `_update_streak(last_active_date, streak_days, today) -> Tuple[str, int]` | 77 | `(new_last_active_iso, new_streak)`. |
| `_update_concept_stats(stats, concept_tags, hint_level, today, count_level=True) -> Dict` | 90 | A copy with one interaction folded in. `encounters` always rises; `rated_encounters`, `level_sum`, `max_level` and `last_struggled` only when `count_level` is true (i.e. `hint` mode), so a level-1 non-hint turn cannot look like a solved-first-try. |
| `_update_calibration(calibration, verdict) -> Dict` | 128 | A copy with one verdict counted. |
| `_update_hint_level_counts(counts, hint_level) -> Dict[str, int]` | 141 | A copy with the level (clamped 1–3) incremented. |
| `_update_activity(activity, today, keep_days=30) -> Dict[str, int]` | 150 | Today incremented, entries older than `keep_days` dropped. |
| `_merge_activity(a, b) -> Dict[str, int]` | 166 | Per-day sums of two maps. |
| `_merge_counters(a, b, keys) -> Dict[str, int]` | 179 | Per-key sums for the named keys. |
| `_merge_concept_stats(a, b) -> Dict` | 187 | Encounters and level sums added, `max_level` maxed, dates maxed. |

**`FirebaseService` methods:**

| Signature | Line | Returns |
| --- | --- | --- |
| `__init__(self)` | 209 | Initialises `firebase_admin` from three env vars; catches every exception and leaves `_client = None`. |
| `enabled` (property) | 235 | `True` when the Firestore client exists. |
| `client` (property) | 239 | The Firestore client or `None`. |
| `_log_interaction_sync(user_id, code_snippet, question, hint_level_used, concept_tags, language="python", confidence=0, mode="hint") -> None` | 242 | Adds one document to `interactions`, including the `mode` field. |
| `_update_user_and_award_badges_sync(user_id, hint_level_used, concept_tags, new_session, language="python", confidence=0, mode="hint") -> List[str]` | 271 | Read-modify-write of the `users` document; returns the badge list (`[]` on failure). Only `mode == "hint"` feeds the level-derived state: `solved_at_level_1`, `hint_level_counts`, `calibration` and the concept `level_sum` / `max_level` / `last_struggled` / `rated_encounters` fields. Interaction, session, streak, activity, language and concept-seen counters update for every mode. |
| `log_interaction_async(...)` | 353 | Schedules both writes on the default executor, passing `mode` through. |
| `fire_and_forget(...) -> None` | 390 | Creates an asyncio task for `log_interaction_async` and keeps a strong reference in `_pending_tasks`; silently returns if there is no running loop. |
| `get_user_profile_sync(user_id) -> Dict` | 421 | The whole user document, `{}` when unavailable. Thin wrapper over `try_get_user_profile_sync`. |
| `try_get_user_profile_sync(user_id) -> Optional[Dict]` | 426 | The whole user document, `{}` for a genuinely new user, `None` when the read failed. `_cached_profile` in `main.py` uses this so a transient Firestore error is never cached as an empty profile. |
| `set_goal_sync(user_id, text, concepts) -> None` | 442 | Writes `goal` (or `None` to clear). |
| `get_recent_interactions_sync(user_id, limit=10) -> List[Dict]` | 457 | Up to `limit` interactions; see Section 10 on the index fallback. |
| `append_session_summary_sync(user_id, summary) -> None` | 476 | Appends to `session_summaries`, keeping the last 20. |
| `get_user_badges_sync(user_id) -> List[str]` | 492 | The badge list, `[]` on failure. |
| `merge_user_sync(source_uid, target_uid) -> bool` | 504 | Merges one user document into another and deletes the source. `False` when disabled, when the uids match, or when the source does not exist. |

**In-process state:** `_pending_tasks` (line 214), a set of in-flight
fire-and-forget tasks. On restart, any task that had not completed is lost, so
the corresponding interaction log and badge update never happen.

`_init_error` (line 211) is assigned on failure but never read anywhere.

**Depends on:** `firebase_admin`, `languages`, `progress`.

### `backend/progress.py`

**Responsibility.** Pure computation over the user document. Imports nothing
from Firestore, which is why it is fully unit-tested.

**Thresholds:**

| Constant | Line | Value |
| --- | --- | --- |
| `STRUGGLE_MIN_ENCOUNTERS` | 12 | 2 |
| `STRUGGLE_MIN_AVG_LEVEL` | 13 | 2.0 |
| `STRENGTH_MIN_ENCOUNTERS` | 14 | 3 |
| `STRENGTH_MAX_AVG_LEVEL` | 15 | 1.3 |
| `REVIEW_MIN_DAYS` | 17 | 3 |
| `REVIEW_MAX_DAYS` | 18 | 7 |
| `CALIBRATION_MIN_SAMPLES` | 22 | 4 |
| `ACTIVITY_WINDOW_DAYS` | 162 | 14 |

**Public functions:**

| Signature | Line | Returns |
| --- | --- | --- |
| `_rated_encounters(entry) -> int` | 25 | How many of a concept's encounters carried a meaningful hint level: `rated_encounters` when present, else `encounters` for documents written before the field existed. |
| `_avg_level(entry) -> float` | 41 | `level_sum` divided by the **rated** encounter count (`0.0` when there are none), so turns from non-`hint` modes cannot drag the average down. |
| `concept_struggles(concept_stats, limit=5) -> List[dict]` | 48 | `{concept, encounters, avg_level}` where `encounters` is the rated count, gated on `rated >= STRUGGLE_MIN_ENCOUNTERS`, sorted by avg level descending then encounters descending. |
| `concept_strengths(concept_stats, limit=5) -> List[dict]` | 61 | Same shape and same rated-encounter gate, sorted by avg level ascending then encounters descending. |
| `pacing_summary(concept_stats, goal_text="") -> str` | 76 | The tutor-facing pacing paragraph, `""` when there is no signal. |
| `classify_calibration(confidence, hint_level) -> Optional[str]` | 100 | `"overconfident"`, `"underconfident"`, `"calibrated"` or `None`. |
| `calibration_summary(data) -> Dict` | 116 | `{samples, score, calibrated, overconfident, underconfident, enough_data}`. |
| `review_due_concepts(concept_stats, today, limit=3) -> List[str]` | 144 | Concept tags struggled with 3–7 days ago, most encounters first. |
| `hint_level_counts(data) -> Dict[str, int]` | 165 | `{"1": n, "2": n, "3": n}`, negatives and non-integers coerced to 0. |
| `activity_strip(data, today, days=14) -> List[dict]` | 178 | `{date, count}` per day, oldest first. |
| `build_progress(data, today) -> Dict` | 196 | The full `/progress` payload. |

**In-process state:** none.

### `backend/session_store.py`

**Responsibility.** Hint-level state, keyed by user and ladder key (the
client's `problem_key`, falling back to a code fingerprint), and
the "is a session already open" flag.

| Signature | Line | Returns |
| --- | --- | --- |
| `code_fingerprint(code: str) -> str` | 9 | SHA-1 hex digest of the code after stripping leading/trailing whitespace and right-stripping each line. |
| `raw_code_hash(code: str) -> str` | 14 | SHA-1 hex digest of the code byte for byte. Used to key `SCAN_CACHE` and `LINE_HINT_CACHE`, which store absolute line numbers that a whitespace-insensitive fingerprint would let go stale. |
| `SESSION_IDLE_SECONDS` | 29 | `1800.0`. How long an open session survives without activity before the next ask counts as a new session. |
| `resolve_level(current: int, escalate: bool) -> int` | 32 | The level an ask should answer at: `min(3, current + 1)` when escalating, otherwise `max(1, min(3, current))`. The single source of truth for the ladder, shared by both stores. |
| `InMemorySessionStore.__init__(max_entries=10000, idle_seconds=SESSION_IDLE_SECONDS)` | 48 | Bounded LRU of levels, plus a per-uid map of the last activity time used to lapse idle sessions. |
| `InMemorySessionStore.peek_hint_level(user_id, fingerprint, escalate=True) -> int` | 55 | The level the next ask should answer at, **without persisting anything**. |
| `InMemorySessionStore.commit_hint_level(user_id, fingerprint, level) -> None` | 63 | Records that `level` was actually delivered; clamps to 1–3 and applies LRU eviction. |
| `InMemorySessionStore.next_hint_level(user_id, fingerprint) -> int` | 71 | Peek + commit in one step. |
| `InMemorySessionStore.current_hint_level(user_id, fingerprint) -> int` | 78 | Peek + commit without escalating. |
| `InMemorySessionStore.begin_session(user_id) -> bool` | 88 | `True` the first time and again whenever the previous ask was more than `idle_seconds` (30 minutes) ago; `False` while the student keeps working. Every call refreshes the last-activity stamp. |
| `InMemorySessionStore.reset(user_id) -> None` | 100 | Drops every level for that user and clears the active flag. |
| `FirestoreSessionStore.SESSIONS` / `.META` / `.TIMEOUT` | 114/115/118 | `"sessions"`, `"sessions_meta"`, `5.0` seconds. |
| `FirestoreSessionStore.peek_hint_level` | 127 | Read-only; returns 1 on any Firestore error. |
| `FirestoreSessionStore.commit_hint_level` | 144 | Writes the level; swallows errors so a Firestore failure never reaches the request path. |
| `FirestoreSessionStore.next_hint_level` | 162 | Peek + commit. |
| `FirestoreSessionStore.current_hint_level` | 168 | Peek + commit without escalating. |
| `FirestoreSessionStore.begin_session` | 174 | Writes `last_active_at` as plain epoch seconds on every ask and treats the session as new when the stored value is missing or older than `idle_seconds`. Returns `False` on error (so the session is not double-counted). |
| `FirestoreSessionStore.reset` | 206 | Batch-deletes the user's session documents and clears the meta flag. |
| `build_session_store(firebase)` | 225 | `FirestoreSessionStore` when `firebase.enabled`, else `InMemorySessionStore`. |

**In-process state:** `InMemorySessionStore` holds everything in memory and is
selected only when Firestore is unavailable. In that configuration a restart
resets every hint level to 1 and clears every open-session flag.
`FirestoreSessionStore` holds no state in process.

### `backend/languages.py`

**Responsibility.** The language registry. Contents in Section 9.

| Signature | Line | Returns |
| --- | --- | --- |
| `normalize_language(raw: str) -> str` | 136 | A registry key; unknown or empty input returns `DEFAULT_LANGUAGE`. |
| `get_language(raw: str) -> dict` | 147 | The registry entry (`display_name`, `fence`, `concepts`). |
| `concepts_for(raw: str) -> List[str]` | 151 | `BASE_CONCEPTS` followed by the language's own concepts. |

**In-process state:** none (module-level constants only).

### `backend/models.py`

**Responsibility.** Pydantic schemas. `MAX_EDIT_SUMMARY_CHARS = 2000`
(`backend/models.py:18`). Every other client-supplied string is bounded too, as
a Pydantic `max_length`: `MAX_CODE_CHARS = 40000`, `MAX_QUESTION_CHARS = 4000`,
`MAX_GOAL_CHARS = 500` and `MAX_PROBLEM_KEY_CHARS = 512`
(`backend/models.py:23-26`); over-long input is rejected with a 422 rather than
spending Groq budget. `HintRequest` also carries `problem_key`
(`backend/models.py:37-46`), the stable ladder key. Schemas are given in full in
Section 6.

`UserBadges` (`backend/models.py:87-93`) is defined but never imported or used
by any route; only `backend/tests/test_models.py` references it.

**In-process state:** none.

### `backend/ratelimit.py`

**Responsibility.** Token-bucket rate limiting.

| Signature | Line | Returns |
| --- | --- | --- |
| `MAX_BUCKETS` | 17 | `5000`. |
| `RateLimiter.__init__(capacity: int, per_seconds: float)` | 23 | Raises `ValueError` if either is non-positive. |
| `RateLimiter.check(key: str) -> Tuple[bool, float]` | 34 | `(allowed, retry_after_seconds)`; `retry_after` is `0.0` when allowed, otherwise the wait for one whole token, rounded to 3 dp. |
| `RateLimiter.reset(key) -> None` | 57 | Forgets one user's bucket. |
| `RateLimiter.clear() -> None` | 60 | Forgets every bucket. |
| `RateLimiterRegistry.__init__(budgets: Dict[str, Tuple[int, float]])` | 67 | Builds one limiter per named budget. |
| `RateLimiterRegistry.check(name, key) -> Tuple[bool, float]` | 72 | Delegates; an unknown bucket name always allows. |
| `RateLimiterRegistry.clear() -> None` | 78 | Clears every limiter. |

The clock is `time.monotonic()` (`backend/ratelimit.py:31-32`), so wall-clock
changes cannot grant or deny budget.

**In-process state:** one `OrderedDict` of `(tokens, last_seen)` per limiter,
bounded at `MAX_BUCKETS` with LRU eviction. On restart every user starts with a
full budget. Evicting a bucket also gives that user a full budget, so eviction
can never deny a request.

### `backend/cache.py`

**Responsibility.** Bounded TTL cache with LRU eviction.

| Signature | Line | Returns |
| --- | --- | --- |
| `TtlCache.__init__(ttl_seconds=300.0, max_entries=1000)` | 20 | — |
| `TtlCache.get(key) -> Optional[Any]` | 29 | The value, or `None` when absent or expired. An expired entry is deleted on read (`backend/cache.py:35-37`). |
| `TtlCache.set(key, value) -> None` | 41 | Stores and evicts oldest entries past capacity. |
| `TtlCache.clear() -> None` | 47 | — |
| `TtlCache.__len__() -> int` | 50 | Current entry count. |

Clock is `time.monotonic()` (`backend/cache.py:25-27`).

**In-process state:** the whole cache. On restart the next `/scan` and
`/line-hint` for every user cost a fresh LLM call. No student data is lost.
Both caches are keyed on the uid plus `raw_code_hash(code)` (`main.py`), not the
whitespace-insensitive `code_fingerprint`, because their values embed absolute
line numbers.

### `backend/auth.py`

**Responsibility.** Bearer-token verification.

| Signature | Line | Returns |
| --- | --- | --- |
| `verify_token(id_token: str) -> str` | 5 | The Firebase uid. Raises `HTTPException(401, "invalid or expired token")` on any verification failure, or `HTTPException(401, "token has no uid")` when the decoded token lacks a uid. |
| `get_current_uid(authorization: str = Header(default="")) -> str` | 21 | The uid. Raises `HTTPException(401, "missing bearer token")` when the header does not start with `"Bearer "`. |

**In-process state:** none.

---

## 6. API reference

Base URL is whatever `edupeer.backendUrl` points at; the default is
`http://localhost:8000`.

### Endpoint summary

| Method | Path | Auth | Rate bucket | Purpose |
| --- | --- | --- | --- | --- |
| GET | `/health` | No | none | Liveness probe used by the extension's availability tracking. |
| GET | `/auth/config` | No | none | Returns the public Firebase web config so the extension can call Google's identity endpoints. |
| GET | `/auth/login` | No | none | Serves the browser sign-in page with the Firebase config interpolated. |
| POST | `/auth/migrate` | Yes | none | Merges a previous (anonymous or legacy) identity's progress into the caller's account. |
| POST | `/hint` | Yes | `hint` 30/min | The main tutoring call for every mode. |
| POST | `/hint/stream` | Yes | `hint` 30/min | Server-sent-events variant of `/hint`. |
| POST | `/reset` | Yes | `session` 10/min | Ends the session: writes a summary, clears hint levels. |
| GET | `/progress` | Yes | none | The full progress report behind the dashboard. |
| GET | `/review` | Yes | `review` 6/min | Whether a spaced review is due, and optionally the exercise. |
| POST | `/goal` | Yes | `session` 10/min | Sets or clears the learning goal. |
| GET | `/badges` | Yes | none | The caller's badge list. |
| POST | `/scan` | Yes | `inline` 60/min | Flags suspicious lines in a whole file. |
| POST | `/line-hint` | Yes | `inline` 60/min | One short nudge for one line. |
| POST | `/trace` | Yes | `trace` 10/min | Designs a desk-check exercise for a snippet. |

Authenticated endpoints expect `Authorization: Bearer <Firebase ID token>`.

### `GET /health`

**Request:** none.
**Response 200** (`HealthResponse`, `backend/models.py:82-84`):
`{"status": "ok", "service": "edupeer-backend"}` — both values are literals
(`backend/main.py:124`).
**Errors:** none.

### `GET /auth/config`

**Request:** none.
**Response 200** (`backend/main.py:133-136`):

| Field | Type | Source |
| --- | --- | --- |
| `apiKey` | string | `FIREBASE_WEB_API_KEY`, `""` if unset |
| `authDomain` | string | `FIREBASE_AUTH_DOMAIN`, `""` if unset |

**Errors:** none. Missing env vars produce empty strings, not an error.

### `GET /auth/login`

**Request:** query parameters `port` and `state` are read by the page's
JavaScript, not by the server. The server ignores all query parameters.
**Response 200:** `text/html`, the contents of `backend/static/auth.html` with
`__FIREBASE_API_KEY__` and `__FIREBASE_AUTH_DOMAIN__` substituted
(`backend/main.py:141-145`).
**Errors:** the file is opened without a guard (`backend/main.py:141`), so a
missing `static/auth.html` raises and FastAPI returns 500. **UNVERIFIED** as an
observed behaviour — inferred from the absence of a try/except; not reproduced.

### `POST /auth/migrate`

**Request body** (`MigrateRequest`, `backend/models.py:127-129`):

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `old_id_token` | string or null | `null` | none |
| `legacy_user_id` | string or null | `null` | Only acted on when it differs from the caller's uid **and** starts with `"user-"` (`backend/main.py:164`) |

**Response 200:** `{"status": "ok", "merged": <int>}` — `merged` counts the
source documents actually merged (`backend/main.py:167-171`).

**Errors:**

| Status | Condition |
| --- | --- |
| 401 | Caller's bearer token missing or invalid. |
| 401 | `old_id_token` is present but fails verification (`verify_token` at `backend/main.py:158` raises). |

### `POST /hint`

**Request body** (`HintRequest`, `backend/models.py:29-73`):

| Field | Type | Default | Constraints |
| --- | --- | --- | --- |
| `code` | string | `""` | `max_length = 40000` (`MAX_CODE_CHARS`) |
| `question` | string | **required** | Must be non-empty after `.strip()`, else 400; `max_length = 4000` (`MAX_QUESTION_CHARS`) |
| `hint_level` | int | `1` | `>= 1`, `<= 3`. Only used for non-`hint` modes |
| `problem_key` | string | `""` | `max_length = 512` (`MAX_PROBLEM_KEY_CHARS`). What the hint ladder is keyed on; empty falls back to `code_fingerprint(code)` (`_ladder_key`, `backend/main.py:174-185`) |
| `language` | string | `"python"` | Any string; normalised server-side |
| `mode` | enum | `"hint"` | One of the ten `TutorMode` values (`backend/models.py:10-14`) |
| `history` | array of `{role, content}` | `[]` | `role` must be `"student"` or `"tutor"` (`backend/models.py:5-7`) |
| `escalate` | bool | `true` | Only consulted in `hint` mode |
| `edit_summary` | string | `""` | `max_length = 2000` |
| `confidence` | int | `0` | `>= 0`, `<= 3`; 0 means "not given" |

**Response 200** (`HintResponse`, `backend/models.py:76-79`):

| Field | Type | Notes |
| --- | --- | --- |
| `hint` | string | The tutor reply with the `[concepts: ...]` line stripped |
| `hint_level` | int | The level actually used, 1–3 |
| `concept_tags` | array of string | 1–6 tags |

**Errors:**

| Status | Condition |
| --- | --- |
| 400 | `question` is empty or whitespace (`backend/main.py:227-228`), detail `"question must not be empty"` |
| 401 | Missing/invalid bearer token |
| 422 | Pydantic validation failure: unknown `mode`, `hint_level` out of range, `confidence` out of range, `edit_summary` over 2000 chars, `code` over 40000, `question` over 4000, `problem_key` over 512, invalid `history` role, missing `question` |
| 429 | `hint` bucket exhausted; includes `Retry-After` in whole seconds (`backend/main.py:91-95`) |
| 502 | Any exception from `engine.generate_hint`, detail `"LLM error: <exception>"` (`backend/main.py:243-244`) |

Side effects on success: the peeked hint level is committed, then
`store.begin_session(uid)` is called, then `firebase.fire_and_forget(...)`
schedules the interaction log and the user document update — passing `mode`, so
only `hint` turns move the level-derived counters (`backend/main.py:246-259`).

### `POST /hint/stream`

Same request body, same validation, same 400/401/422/429 behaviour. The
response is `text/event-stream` (`backend/main.py:308`).

**Event sequence.** Each event is one `data: <json>\n\n` block
(`backend/main.py:275-276`).

1. **Always first** — `{"type": "meta", "hint_level": <int>}`
   (`backend/main.py:279`).
2. **Zero or more** — `{"type": "delta", "text": "<partial text>"}`
   (`backend/hinting_engine.py:612`). The generator withholds the trailing
   `STREAM_HOLDBACK_CHARS = 40` characters so the `[concepts: ...]` footer
   never appears mid-stream (`backend/hinting_engine.py:578`, `610-613`).
3. **Terminal, one of:**
   - `{"type": "done", "hint": "<full cleaned text>", "concept_tags": [...]}`
     (`backend/hinting_engine.py:615`); or
   - `{"type": "error", "message": "LLM error: <exception>"}`
     (`backend/main.py:290`), after which the generator returns.

Because the LLM call happens inside the streaming generator, an LLM failure is
reported as an `error` **event inside a 200 response**, not as a 502. See
Section 17.

Side effects on `done`: the generator runs on a worker thread with no event
loop, so it commits the hint level and then calls `store.begin_session`,
`firebase._log_interaction_sync` and
`firebase._update_user_and_award_badges_sync` synchronously, both with `mode`
(`backend/main.py:292-306`).

### `POST /reset`

**Request:** no body.
**Response 200** (`backend/main.py:325`):

| Field | Type | Notes |
| --- | --- | --- |
| `status` | string | Always `"reset"` |
| `user_id` | string | The caller's uid |
| `summary` | string | The three-bullet session note, or `""` |

Behaviour: reads up to 10 recent interactions; if any exist, calls
`engine.summarize_session`; a failure there is caught, printed and turned into
`summary = ""` (`backend/main.py:318-320`). Then `store.reset(uid)` and the
profile cache entry is dropped.

**Errors:** 401; 429 (`session` bucket). An LLM failure during summarisation
does **not** fail the request.

### `GET /progress`

**Request:** no parameters.
**Response 200** — the output of `build_progress` (`backend/progress.py:196-218`):

| Field | Type | Notes |
| --- | --- | --- |
| `badges` | array of string | |
| `total_interactions` | int | |
| `sessions` | int | |
| `streak_days` | int | |
| `languages_used` | array of string | Registry keys, sorted |
| `goal` | `{text, concepts, set_at}` or null | Null when absent or when `text` is blank |
| `concept_struggles` | array of `{concept, encounters, avg_level}` | Max 5; `encounters` is the *rated* (hint-mode) encounter count, and `avg_level` divides by it (`backend/progress.py:25-45`) |
| `concept_strengths` | array of `{concept, encounters, avg_level}` | Max 5; same rated-encounter gate |
| `session_summaries` | array of `{text, date}` | Last 5 |
| `review_due` | bool | |
| `calibration` | `{samples, score, calibrated, overconfident, underconfident, enough_data}` | |
| `hint_level_counts` | `{"1": int, "2": int, "3": int}` | |
| `activity` | array of `{date, count}` | Exactly 14 entries, oldest first |

**Errors:** 401 only. An unreadable Firestore returns `{}` from
`get_user_profile_sync`, which `build_progress` turns into a zeroed report.

### `GET /review`

**Query parameters** (`backend/main.py:335-339`):

| Name | Type | Default |
| --- | --- | --- |
| `language` | string | `"python"` |
| `exercise` | bool | `true` |

**Response 200:** `{"due": bool, "concepts": [string], "exercise": string}`.
When nothing is due, all three are falsy (`backend/main.py:343`). When
`exercise=false`, `exercise` is `""` even if a review is due.

**Errors:** 401; 429 (`review` bucket, 6/min); 502 when `exercise=true` and the
LLM call fails (`backend/main.py:354-355`).

### `POST /goal`

**Request body** (`GoalRequest`, `backend/models.py:132-138`):

| Field | Type | Default |
| --- | --- | --- |
| `text` | string | `""` (empty clears the goal); `max_length = 500` (`MAX_GOAL_CHARS`) |
| `language` | string | `"python"` |

**Response 200:** `{"status": "ok", "goal": <trimmed text>, "concepts": [...]}`.

**Errors:** 401; 429 (`session` bucket); 422 when `text` exceeds 500 characters.
A failure in `map_goal_to_concepts` is caught and printed
(`backend/main.py:368-369`), and the goal is still saved with an empty concept
list.

### `GET /badges`

**Response 200:** a bare JSON array of badge name strings.
**Errors:** 401 only; a Firestore failure yields `[]`.

### `POST /scan`

**Request body** (`ScanRequest`, `backend/models.py:96-98`):

| Field | Type | Default |
| --- | --- | --- |
| `code` | string | `""` (`max_length = 40000`) |
| `language` | string | `"python"` |

**Response 200** (`ScanResponse`, `backend/models.py:112-113`):
`{"flags": [LineFlag]}` where each `LineFlag` (`backend/models.py:101-109`) is:

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `line` | int | required | `>= 1` |
| `end_line` | int | required | `>= 1` |
| `question` | string | required | At most 14 words (enforced in the engine) |
| `concept` | string | `"general"` | |
| `severity` | string | `"info"` | `"info"` or `"warning"` (coerced in the engine) |
| `kind` | enum | `"bug"` | `"bug"` or `"style"` |

Empty or whitespace `code` short-circuits to `{"flags": []}` with no LLM call
(`backend/main.py:382-383`). Results are cached for 300 s under
`(uid, language, raw_code_hash(code))` — the exact hash, not the
whitespace-insensitive `code_fingerprint`, because cached flags carry absolute
line numbers (`backend/main.py:386-398`).

**Errors:** 401; 429 (`inline` bucket); 502 on LLM failure.

### `POST /line-hint`

**Request body** (`LineHintRequest`, `backend/models.py:116-119`):

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `code` | string | `""` | `max_length = 40000` |
| `line` | int | required | `>= 1`, 1-based |
| `language` | string | `"python"` | |

**Response 200** (`LineHintResponse`, `backend/models.py:122-124`):
`{"hint": string, "concept": string}`. Empty or whitespace `code`
short-circuits to `{"hint": "", "concept": "general"}` with no LLM call
(`backend/main.py:406-407`), and `hint` is `""` when the line number is out of
range for the supplied code (`backend/hinting_engine.py:403-404`).
Cached for 300 s under `(uid, language, line, raw_code_hash(code))`
(`backend/main.py:411`).

**Errors:** 401; 429 (`inline` bucket); 502 on LLM failure.

### `POST /trace`

**Request body** (`TraceRequest`, `backend/models.py:141-148`):

| Field | Type | Default |
| --- | --- | --- |
| `code` | string | `""` (`max_length = 40000`) |
| `selection` | string | `""` (empty means trace the whole file); `max_length = 40000` |
| `language` | string | `"python"` |

The snippet actually used is `selection.strip() or code.strip()`
(`backend/main.py:432`).

**Response 200** (`TraceResponse`, `backend/models.py:151-156`):

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `variables` | array of string | `[]` | 2–4 entries when `steps > 0` |
| `steps` | int | `0` | `>= 0`, `<= 8`; 0 means "no exercise available" |
| `prompt` | string | `""` | At most 200 chars |

An empty snippet returns the default (all-empty) response with no LLM call
(`backend/main.py:433-434`).

**Errors:** 401; 429 (`trace` bucket); 502 on LLM failure.

---

## 7. Tutoring modes

Ten modes are accepted by the API (`backend/models.py:10-14`) and mapped to
prompt templates (`backend/hinting_engine.py:146-157`). The client mirrors the
list in `extension/src/pedagogy.ts:6-16`.

**Only `hint` advances the hint level.** Every other mode passes
`req.hint_level` straight through (`backend/main.py:200-201`).

| Mode | Trigger | Pedagogical purpose | Advances level? | Prohibitions in its prompt |
| --- | --- | --- | --- | --- |
| `hint` | Typing in the composer and pressing **Ask** (`extension/media/main.js:367-373`); also the default for external asks | The progressive 1→2→3 Socratic ladder | **Yes**, subject to the attempt gate | "NEVER write working code or complete a function for the student"; "NEVER give the direct answer"; at level 3, "provide pseudocode only, never real {language} syntax" |
| `reflect` | The **I fixed it** button (`extension/media/main.js:387-391`); the `edupeer.reflectQuiz` command; the toast shown when a previously flagged file scans clean (`extension/src/inlineTutor.ts:400-419`) | Checks understanding of *why* a fix works, not that it works | No | "NEVER write working code" |
| `translate` | The **Submit my translation** action row, offered only after a level-3 reply (`extension/media/main.js:428-434`) | Marks the student's own translation of pseudocode into real code | No | "Point out each mismatch as a question, never as corrected code"; "NEVER write working code or fix their code for them" |
| `worked-example` | The **Show a worked example** action row, offered after a level-3 reply (`extension/media/main.js:435-444`) | A fully worked solution to a *different* problem exercising the same concept | No | "The example must NOT solve the student's actual problem or reuse their variable names"; "Do NOT label what each step accomplishes - the student will do that" |
| `subgoal-label` | The **Label the steps** action row, offered after any worked example (`extension/media/main.js:448-456`) | The student names the purpose of each step; sub-goal labelling is what makes worked examples transfer | No | "Do NOT supply the correct labels yourself, and do NOT restate the example" |
| `explain-error` | The `edupeer.explainError` command; the debugger companion on an exception stop; **automatic detection** when the composer text matches an error-shaped pattern (`extension/src/sidebarProvider.ts:316-318`) | Teaches how to read the error, not how to fix it | No | "Do NOT reveal the fix"; "NEVER write working code" |
| `explain-concept` | The `edupeer.explainSelection` command and the Quick Fix "explain this line" | Plain-language explanation of a selected construct | No | "Do NOT judge or fix their code" |
| `predict-output` | The `edupeer.predictOutput` command; also the fallback when `/trace` returns `steps: 0` (`extension/src/sidebarProvider.ts:265-267`) | The student predicts behaviour before running | No | "If it is wrong, do NOT reveal the actual output"; "NEVER write working code" |
| `trace-check` | Submitting the filled desk-check grid (`extension/media/main.js:326-331`) | Marks a hand-trace and names the first diverging row | No | "NEVER give the corrected table, and never write working code" |
| `review-exercise` | The **Review** button, shown when `/review` reports a due concept (`extension/media/main.js:411-416`); also the student's written answer to that exercise (`extension/media/main.js:366-372`) | Spaced retrieval of a concept struggled with 3–7 days ago | No | "never provide {language} code to copy" |

### Answering a review exercise

The review prompt asks the student to "write the code themselves and predict its
behaviour" (`backend/hinting_engine.py:142`), so the exercise needs an answer
path. Clicking **Review** sets `expectReviewAnswer`
(`extension/media/main.js:414`); when the exercise arrives, `handleHint` puts
the composer into `review` mode (`extension/media/main.js:477-479`) and the next
submission posts `reviewAnswer` instead of a fresh question. The provider marks
it against the exercise text it stashed in `pendingReview`
(`extension/src/sidebarProvider.ts:305-318`) via `frameReviewAnswer`
(`extension/src/pedagogy.ts:82-87`), so the answer is judged against the review
and not against whatever file happens to be open in the editor.

### Client-side pseudo-modes

Three further mode strings exist only in the webview and never reach the
backend. They label locally generated messages (`extension/media/main.js:30-46`):

| Pseudo-mode | Meaning | Produced at |
| --- | --- | --- |
| `attempt-gate` | "Same depth" — the student asked again without editing | `extension/src/sidebarProvider.ts:396-403`; also used to refuse a second ask while one is still in flight (`376-384`) |
| `rate-limited` | "Slow down" — a 429 came back | `extension/src/sidebarProvider.ts:475-485` |
| `offline` | "Offline nudge" — a local rule replaced the tutor | `extension/src/sidebarProvider.ts:487-495` |

All three are styled as the tutor withholding rather than teaching
(`FLAGGED_MODES`, `extension/media/main.js:46`).

### The explain-first gate

Before the *first* `hint`-mode question about a given code fingerprint, the
sidebar interposes a prompt asking the student to explain the code in their own
words (`extension/src/sidebarProvider.ts:320-329`). The prompt text is
`EXPLAIN_FIRST_PROMPT` (`extension/src/pedagogy.ts:18-20`):

> "Before I give you a hint — in your own words, what do you think this code is
> doing? Explaining first helps it stick. (You can skip this.)"

Skipping sends the original question unchanged
(`extension/src/sidebarProvider.ts:354-362`). Answering prefixes the
explanation via `frameExplainedQuestion` (`extension/src/pedagogy.ts:37-39`).
External asks (context menu, toasts) bypass the gate by pre-seeding the
fingerprint set (`extension/src/sidebarProvider.ts:188`).

### Canned questions

When a mode is triggered by a button rather than typed text,
`questionForMode` (`extension/src/pedagogy.ts:131-143`) supplies the question:

| Mode | Canned text |
| --- | --- |
| `reflect` | "I think I fixed it. Quiz me on why the fix works." |
| `worked-example` | "I'm still stuck. Please show me a worked example of this concept on a different problem." |
| `translate` | No canned text; returns `""` when the student typed nothing, which `handleAsk` then discards (`extension/src/sidebarProvider.ts:370-372`) |
| `subgoal-label` | Same as `translate` |

---

## 8. Prompt design

Every prompt lives in `backend/hinting_engine.py`. All are Python format
strings whose only substitution is `{language}`, replaced with the registry's
`display_name` (`backend/hinting_engine.py:517-521`).

### 8.1 The progressive hint prompt

`SYSTEM_PROMPT_TEMPLATE` (`backend/hinting_engine.py:19-47`), quoted verbatim:

```
You are EduPeer, a Socratic programming tutor for beginner {language} students.
Your job is to guide students to the answer themselves - and to recognise the moment they get there.

WHEN THE STUDENT'S LATEST MESSAGE IS RIGHT:
- Your FIRST words must tell them plainly that they got it. Short. Direct. No hedging, no
  "indeed", no restating their answer back at them as if it were still in question.
- Then one sentence on why it is right.
- Then take them forward: deeper into WHY it works, or on to the next thing worth noticing.
- Never re-ask what they just answered. Never write the corrected line for them.

WHEN THEY ARE NOT YET RIGHT:
- NEVER write working code or complete a function for the student
- NEVER give the direct answer
- Respond with a question or a conceptual nudge
- Never re-ask a question this conversation already contains, even reworded. When they are
  stuck on one - "I don't know" included - narrow it instead: a smaller sub-question, one
  value traced by hand, or what they expect a single line to do. Repeating yourself teaches
  them nothing and reads as if you were not listening.
- When their message asks YOU something, engage with what they asked before anything else.
  A question about a concept or a built-in gets a real answer; only the answer to their own
  bug stays withheld.
- hint_level 1: one guiding question only
- hint_level 2: name the specific line or concept, explain the concept briefly
- hint_level 3: pseudocode only, never real {language} syntax

ALWAYS:
- Keep responses under 150 words
- Sound like a person, not a form. Close with a question only when you are actually waiting on
  them, and word it freshly every time. Never end with a stock sentence.
```

Two branches, chosen by the model from the student's latest message. The
`WHEN THEY ARE NOT YET RIGHT` branch carries the constraining lines (the two
`NEVER`s), the two anti-repetition rules, and the level-specific behaviour in
its last three bullets.

The anti-repetition pair exists because a held level used to produce the same
question twice: the ladder is only *allowed* to move on an attempt, so a
student saying "I don't know" stays at one depth by design, and without these
rules the tutor filled that turn by re-asking. Section 12 covers why the level
itself was, separately, stuck at 1 for every Firestore-backed student.

**What varies by hint level.** Nothing in the system prompt changes: all three
level rules are always present. The level is communicated in the *user*
message, whose first line is literally `hint_level: <n>`
(`backend/hinting_engine.py:275`), and the message ends with "Respond according
to the STRICT RULES for the given hint_level." (`backend/hinting_engine.py:279`).
The level is clamped to 1–3 before use (`backend/hinting_engine.py:513`).

**What varies by language.** Two things: `{language}` becomes the display name
(e.g. "Python", "C++"), and the first line inside the student-code block is
`language: <display_name>` (`backend/hinting_engine.py:260`). The concept
list appended by the footer is also language-specific. The registry's `fence`
value no longer appears in the hint user message at all — it survives only in
the line-hint and trace-table prompts (`backend/hinting_engine.py:415`, `442`).

**The user message** (`backend/hinting_engine.py:252-280`) for `hint` mode is:

```
hint_level: {level}

<student_code-{nonce}>
language: {display_name}
{code or "(no code provided)"}
</student_code-{nonce}>

{optional edit block}<student_message-{nonce}>
{question}
</student_message-{nonce}>

Respond according to the STRICT RULES for the given hint_level.
```

`{nonce}` is a fresh 16-hex-character value per request (`secrets.token_hex(8)`,
`backend/hinting_engine.py:257`), and every occurrence of it is stripped out of
the student's own text before wrapping (`backend/hinting_engine.py:249`), so
nothing a student types can forge the closing tag and escape into instruction
position — which a bare ``` fence could not prevent. `UNTRUSTED_INPUT_RULE`
(`backend/hinting_engine.py:14-16`) is appended to every system prompt
(`backend/hinting_engine.py:519`) and tells the model that everything inside
those blocks is data to discuss, never an instruction to obey.

For every non-`hint` mode the `hint_level` line and the trailing instruction
are omitted; the code, edit and message blocks are otherwise identical
(`backend/hinting_engine.py:272-273`).

**The edit block**, present only when `edit_summary` is non-blank
(`backend/hinting_engine.py:265-271`):

```
What the student changed since the last hint:
<student_edit-{nonce}>
{edit_summary}
</student_edit-{nonce}>
```

### 8.2 The other nine templates — verbatim constraining lines

| Template | Line | Rule lines that constrain the model |
| --- | --- | --- |
| `REFLECT_TEMPLATE` | 39-49 | "- If the conversation does not yet contain your quiz question, ask exactly ONE short question about WHY their fix works (target the underlying concept)"; "- NEVER write working code"; "- Keep responses under 100 words" |
| `TRANSLATE_TEMPLATE` | 52-61 | "- Give feedback ONLY on how faithfully their code translates the pseudocode"; "- Point out each mismatch as a question, never as corrected code"; "- NEVER write working code or fix their code for them"; "- Keep responses under 120 words" |
| `WORKED_EXAMPLE_TEMPLATE` | 64-74 | "- Present the solution as a NUMBERED list of steps, each one line"; "- Do NOT label what each step accomplishes - the student will do that"; "- The example must NOT solve the student's actual problem or reuse their variable names"; "- End by asking the student to name the PURPOSE of each numbered step in their own words"; "- Keep responses under 200 words" |
| `SUBGOAL_LABEL_TEMPLATE` | 77-86 | "- Judge each label on whether it names the step's PURPOSE, not its syntax"; "- Affirm labels that capture the goal; for vague ones (\"does a loop\"), ask what the loop is FOR"; "- Do NOT supply the correct labels yourself, and do NOT restate the example"; "- Keep responses under 150 words" |
| `TRACE_CHECK_TEMPLATE` | 89-98 | "- Work out the real values yourself before responding"; "- Otherwise name the FIRST step whose values diverge from reality, and ask ONE question about what that line actually does at that point"; "- NEVER give the corrected table, and never write working code"; "- Keep responses under 150 words" |
| `EXPLAIN_ERROR_TEMPLATE` | 101-110 | "- Teach how to read this KIND of error so they can decode the next one on their own"; "- Do NOT reveal the fix; end with ONE question pointing them at the line or concept to inspect"; "- NEVER write working code"; "- Keep responses under 150 words" |
| `EXPLAIN_CONCEPT_TEMPLATE` | 113-121 | "- Explain what the construct does in plain language, in the context of their snippet"; "- Do NOT judge or fix their code"; "- End by offering ONE short comprehension question they can try to answer"; "- Keep responses under 150 words" |
| `PREDICT_OUTPUT_TEMPLATE` | 124-133 | "- Reason carefully about what the code actually does before responding"; "- If it is wrong, do NOT reveal the actual output; ask a question that walks them to the first point where their mental trace diverges from the code"; "- NEVER write working code"; "- Keep responses under 150 words" |
| `REVIEW_EXERCISE_TEMPLATE` | 136-143 | "- Pose ONE small exercise (a 3-8 line scenario) exercising that concept"; "- Describe the task in words or pseudocode only - never provide {language} code to copy"; "- Keep responses under 120 words" |

### 8.3 The JSON-output prompts

Four prompts ask for strict JSON rather than prose.

`SCAN_SYSTEM_PROMPT_TEMPLATE` (`backend/hinting_engine.py:160-174`) constrains:

```
- If nothing is suspicious, output {{"flags":[]}}
- Never include code, {language} syntax, or the answer in the question
- Never use more than 14 words per question
- Prefer "warning" only for likely bugs; "style" flags are always "info"
- No markdown, no prose, JSON only
```

`LINE_HINT_SYSTEM_PROMPT_TEMPLATE` (`backend/hinting_engine.py:177-180`):
"respond with ONE Socratic nudge of at most 12 words. No code. No direct
answer."

`TRACE_TABLE_PROMPT` (`backend/hinting_engine.py:193-202`):

```
- Pick 2-4 variables whose values actually change, using the student's own names
- steps = how many iterations or statements are worth tracing, between 3 and 8
- prompt = ONE sentence telling them what to trace. No answers, no values, no code
- If the snippet has no changing state to trace, output {{"variables": [], "steps": 0, "prompt": ""}}
```

`GOAL_MAPPING_PROMPT` (`backend/hinting_engine.py:188-190`) is the fourth: it
caps the answer at 4 tags chosen from the supplied list and demands
`{{"concepts": ["tag-1", "tag-2"]}}`. The one prompt with no JSON requirement is
`SESSION_SUMMARY_PROMPT` (`backend/hinting_engine.py:182-185`, "write EXACTLY 3
short bullet lines … No code. Nothing except the 3 bullets.").

### 8.4 Conversation history

History is supplied by the client as an ordered array of
`{role: "student"|"tutor", content: string}`.

**Truncation happens twice.** The extension slices the last
`MAX_HISTORY_TURNS = 6` turns before sending
(`extension/src/sidebarProvider.ts:23`, `420`); the backend independently
slices the last `MAX_HISTORY_TURNS = 6` again
(`backend/hinting_engine.py:215`, `526`). A turn is one message, not one
exchange, so six turns is roughly three question/answer pairs.

**Inclusion** (`backend/hinting_engine.py:525-544`): the system prompt is
message 0; each history turn becomes a message with role `"assistant"` when
the stored role is `"tutor"` and `"user"` otherwise; turns whose content is
blank after stripping are skipped entirely; the current question is appended
last. Nothing else from the conversation is sent — the code, question and edit
summary all live in that final user message.

**Adaptive pacing** is appended to the system prompt, separated by a blank
line, only when non-empty (`backend/hinting_engine.py:522-523`). Its content is
described in Section 11.

### 8.5 The concept-tag mechanism

**How tags are requested.** `CONCEPTS_FOOTER_TEMPLATE`
(`backend/hinting_engine.py:32-36`) is appended to *every* mode's system prompt,
after `UNTRUSTED_INPUT_RULE` (`backend/hinting_engine.py:517-521`), verbatim:

```

After your response, on its own final line, write [concepts: tag-1, tag-2] with 1-3 tags
chosen ONLY from this list (the line is stripped before the student sees it):
{concepts}
```

`{concepts}` is the comma-joined output of `concepts_for(language)`, i.e. the
24 base concepts plus that language's own list.

**How tags are parsed out.** `_parse_concepts_line`
(`backend/hinting_engine.py:309-322`) applies the case-insensitive regex
`\[\s*concepts\s*:\s*([^\]]*)\]` (`backend/hinting_engine.py:307`) using
`re.sub` with a capturing replacement function. Every match is removed from the
text and its comma-separated contents are lowercased, stripped and collected.
Because `re.sub` replaces all occurrences, more than one `[concepts: ...]` line
is handled. The cleaned text is then right-stripped.

**Validation and fallback** (`backend/hinting_engine.py:547-557`):

1. Tags are filtered against `set(concepts_for(language))` and capped at 6.
2. If nothing survives — no tag line, or every tag invented — the engine falls
   back to `_extract_concept_tags` (`backend/hinting_engine.py:282-305`), a
   keyword search. It lowercases `code + question` only — the tutor's own reply
   is still passed in but is no longer searched, because ordinary English words
   in it tagged every Rust session with `result`/`match`/`option`. For every
   known concept it tests three spellings: the tag itself (`off-by-one`), the
   tag with hyphens as spaces (`off by one`) and the tag with hyphens removed
   (`offbyone`), each matched on a word boundary
   (`(?<!\w)…(?!\w)`, `backend/hinting_engine.py:300`) so `nil` no longer fires
   inside "nilpotent".
3. If the keyword search also finds nothing, the single tag `"general"` is used
   (`backend/hinting_engine.py:303-304`).

So `concept_tags` is never empty.

**One further step for `hint` mode only** (`backend/hinting_engine.py:551-552`):
if the cleaned text does not already contain the exact string
`"What do you think should happen next?"`, it is appended after a blank line.
Non-`hint` modes never get this.

**Streaming interaction.** The footer would otherwise flash in the UI, so
`stream_hint` withholds the last 40 characters of the accumulated text from
delta events (`backend/hinting_engine.py:578`, `610-612`) and only the `done`
event carries the cleaned text.

---

## 9. Language support

Registry: `backend/languages.py:18-115` (backend) and
`extension/src/languages.ts:16-57` (client). Both list the same ten keys.

`BASE_CONCEPTS` (`backend/languages.py:10-16`) applies to every language, 24
tags:

`variables`, `loops`, `for-loop`, `while-loop`, `conditionals`, `if-statement`,
`functions`, `recursion`, `strings`, `arrays`, `indexing`, `classes`,
`objects`, `inheritance`, `scope`, `booleans`, `operators`, `input-output`,
`syntax-error`, `off-by-one`, `type-error`, `return-value`, `nesting`,
`comparison`.

| languageId | Display name | Fence | Language-specific concept tags | Backend line |
| --- | --- | --- | --- | --- |
| `python` | Python | `python` | lists, dictionaries, tuples, sets, slicing, exceptions, file-io, imports, mutability, iterators, comprehensions, lambdas, decorators, generators, typing, indentation, name-error, index-error, key-error, attribute-error (20) | 19-29 |
| `javascript` | JavaScript | `javascript` | let-const-var, closures, callbacks, promises, async-await, arrow-functions, equality, undefined, null, hoisting, template-literals, json, semicolons, array-methods (14) | 30-39 |
| `java` | Java | `java` | interfaces, packages, static, access-modifiers, null-pointer, arraylist, generics, casting, main-method, semicolons, braces, string-comparison, integer-division (13) | 40-49 |
| `c` | C | `c` | pointers, memory-allocation, segfault, header-files, printf-scanf, format-specifiers, null-terminator, semicolons, braces, integer-division, uninitialized-variable (11) | 50-58 |
| `cpp` | C++ | `cpp` | pointers, references, memory-allocation, segfault, header-files, iostream, vectors, templates, semicolons, braces, integer-division, pass-by-reference (12) | 59-67 |
| `csharp` | C# | `csharp` | namespaces, properties, interfaces, static, access-modifiers, null-reference, generics, linq, console-io, semicolons, braces, string-comparison (12) | 68-76 |
| `typescript` | TypeScript | `typescript` | type-annotations, interfaces, generics, unions, enums, let-const-var, closures, promises, async-await, arrow-functions, equality, undefined, null, any-vs-unknown, array-methods, json (16) | 77-86 |
| `go` | Go | `go` | goroutines, channels, slices, maps, structs, interfaces, pointers, error-handling, nil, packages, range, defer, zero-values (13) | 87-95 |
| `rust` | Rust | `rust` | ownership, borrowing, lifetimes, mutability, match, option, result, traits, structs, enums, vectors, string-vs-str, error-handling, iterators (14) | 96-104 |
| `sql` | SQL | `sql` | select, joins, where-clause, group-by, aggregate-functions, null-handling, subqueries, order-by, insert-update-delete, primary-keys, foreign-keys, distinct (12) | 105-114 |

### Aliases

`_ALIASES` (`backend/languages.py:119-133`), applied after lowercasing and
stripping (`backend/languages.py:142-143`):

| Alias | Resolves to |
| --- | --- |
| `py` | `python` |
| `js` | `javascript` |
| `node` | `javascript` |
| `javascriptreact` | `javascript` |
| `ts` | `typescript` |
| `typescriptreact` | `typescript` |
| `c++` | `cpp` |
| `cs` | `csharp` |
| `c#` | `csharp` |
| `golang` | `go` |
| `rs` | `rust` |
| `mysql` | `sql` |
| `postgres` | `sql` |

### Unknown or empty language

`normalize_language` (`backend/languages.py:136-144`) lowercases and strips the
input, applies the alias map, and returns the result only if it is a registry
key; otherwise it returns `DEFAULT_LANGUAGE = "python"`
(`backend/languages.py:117`, `144`). `(raw or "")` means `None` and `""` both
normalise to `python`. Nothing errors and nothing is logged — an unknown
language is silently tutored as Python.

This is what makes the API backwards compatible with clients that send no
`language` field at all; the Pydantic default is also `"python"`
(`backend/models.py:47`).

### Client-side detection regexes

`extension/src/languages.ts` adds a `lensRegex` per language, used to decide
which lines get a standing "💡 Get a hint" CodeLens. These exist only on the
client and are not mirrored in the backend registry.

| languageId | What `lensRegex` matches | Line |
| --- | --- | --- |
| `python` | `def` or `class` declarations | 19 |
| `javascript` | function/class declarations and `const/let/var` arrow assignments, with optional `export`/`async` | 23 |
| `java` | lines starting with an access or type modifier and ending in `{` or `)` | 27 |
| `c` | C-style function definitions (not calls or prototypes) | 31 |
| `cpp` | `class`/`struct` declarations and function definitions, allowing `&`, `::`, templates | 35 |
| `csharp` | access modifiers, `class`, `interface`, `struct`, `enum` | 39 |
| `typescript` | as JavaScript, plus `interface` | 43 |
| `go` | `func` declarations including methods with receivers | 47 |
| `rust` | `fn`, `struct`, `enum`, `impl`, `trait`, with optional `pub`/`async` | 51 |
| `sql` | lines starting `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE` or `WITH`, case-insensitive | 55 |

The `when` clauses in `extension/package.json` hard-code the same ten ids as a
regex alternation (e.g. `extension/package.json:103`), so adding a language
requires editing three places: `backend/languages.py`,
`extension/src/languages.ts` and every `when` clause in
`extension/package.json`.

---

## 10. Data model

Firestore is the only server-side data store. There is no relational database,
no Redis, no file-based persistence. Confirmed by inspection: the only storage
imports in the backend are `firebase_admin.firestore`
(`backend/firebase_service.py:7`, `backend/session_store.py:6`), and the two
in-process caches (`backend/cache.py`, `backend/ratelimit.py`) are
deliberately volatile.

Client-side, the extension uses two VS Code stores — `context.secrets`
(SecretStorage) and `context.globalState` (a key/value Memento) — detailed at
the end of this section.

### Collection: `users`

**Document ID:** the Firebase uid, used directly
(`backend/firebase_service.py:290`).

| Field | Type | Written by | Read by | Purpose |
| --- | --- | --- | --- | --- |
| `badges` | array of string | `_update_user_and_award_badges_sync:332`, `merge_user_sync:550` | `get_user_badges_sync:499`, `build_progress:205` | Earned badge display names. |
| `total_interactions` | int | same | `build_progress:206` | Lifetime count of logged interactions, in every mode. |
| `sessions` | int | same | `build_progress:207` | Count of distinct sessions. |
| `concept_tags_seen` | array of string | same | badge rules | Union of every concept tag ever tagged. |
| `solved_at_level_1` | int | same | badge rules | How many `hint`-mode replies landed at level 1; other modes never touch it. |
| `concept_stats` | map of tag → `{encounters, rated_encounters, level_sum, max_level, last_seen, last_struggled}` | same | `concept_struggles`, `concept_strengths`, `review_due_concepts`, `pacing_summary` | Per-concept mastery record. |
| `languages_used` | array of string, sorted | same | `build_progress:209`, badge rules | Registry keys practised. |
| `last_active_date` | ISO date string | same | `_update_streak:78` | Streak anchor. |
| `streak_days` | int | same | `build_progress:208`, badge rules | Consecutive-day count. |
| `calibration` | `{calibrated, overconfident, underconfident}` (ints) | same | `calibration_summary:116` | Confidence-vs-outcome counters; only `hint` mode contributes a verdict (`firebase_service.py:314-317`). |
| `hint_level_counts` | `{"1","2","3"}` → int | same | `hint_level_counts:165` | Depth distribution for the dashboard; only `hint` mode increments it (`firebase_service.py:318-322`). |
| `activity` | map of ISO date → int | same, trimmed to 30 days | `activity_strip:178` | Per-day question counts. |
| `goal` | `{text, concepts, set_at}` or `null` | `set_goal_sync:451` | `build_progress:200`, `_pacing_for:218` | Free-text learning goal and its mapped tags. |
| `session_summaries` | array of `{text, date}`, last 20 kept | `append_session_summary_sync:485` | `build_progress:213` (last 5) | Three-bullet session notes. |
| `updated_at` | server timestamp | every write | nothing | Audit only. |

**All `users` writes are merges.** Every call passes `merge=True`
(`backend/firebase_service.py:346`, `452`, `487`, `564`), so a write only
replaces the named fields.

However, several *fields* are overwritten wholesale rather than incremented
server-side: `_update_user_and_award_badges_sync` reads the document, computes
new values in Python and writes the complete new `concept_stats`, `activity`,
`calibration` and `badges` objects. This is a read-modify-write with no
transaction, so two concurrent requests for the same user can lose one
update's contribution. The code notes this trade-off for the session store
(`backend/session_store.py:108-112`) but the same applies here.

### Collection: `interactions`

**Document ID:** auto-generated — the code calls `.add(doc)`
(`backend/firebase_service.py:267`), which lets Firestore assign the ID.

| Field | Type | Written by | Read by | Purpose |
| --- | --- | --- | --- | --- |
| `user_id` | string | `_log_interaction_sync:257` | `get_recent_interactions_sync:461` | Owner. |
| `timestamp` | server timestamp | same | ordering (when the index exists) | When the hint was given. |
| `code_snippet` | string | same | nothing currently | The student's full file at the time. |
| `question` | string | same | `summarize_session:477` | What was asked. |
| `hint_level_used` | int | same | `summarize_session:482` | Depth. |
| `concept_tags` | array of string | same | `summarize_session:480` | Tags for that reply. |
| `language` | string | same | nothing currently | Registry key. |
| `confidence` | int | same | nothing currently | Pre-hint self-rating, 0–3. |
| `mode` | string | same | nothing currently | Which tutor mode produced the reply (`firebase_service.py:265`). |

This write is a create, not a merge. Nothing ever updates or deletes an
interaction document; the collection grows without bound.

### Collection: `sessions`

**Document ID:** `sha1(f"{user_id}\x00{ladder_key}")`, hex
(`backend/session_store.py:124-144`) — an opaque digest of the uid and the
ladder key chosen by `_ladder_key` (`backend/main.py:174-185`): the
client-supplied `problem_key` (the document URI) when one is sent, otherwise
the SHA-1 hex fingerprint of the code.

The ID is hashed rather than interpolated because the usual ladder key *is* a
document URI — `file:///c%3A/.../demo.py#average` — and Firestore reads `/` as
a path separator. The former `f"{user_id}__{ladder_key}"` produced a resource
name with an odd number of segments, so the server rejected every read and
write with `400 ... lacks a collection id`. Both call sites swallow their
exceptions, so this surfaced only as behaviour: `peek_hint_level` fell through
to its hardcoded `return 1` and `commit_hint_level` stored nothing, leaving
every Firestore-backed student pinned at hint level 1 forever. The in-memory
store keys on a tuple and was never affected, which is why the whole test
suite passed.

| Field | Type | Written by | Read by | Purpose |
| --- | --- | --- | --- | --- |
| `user_id` | string | `commit_hint_level:171` | `reset` query | Owner, and the field the reset query filters on. |
| `fingerprint` | string | same | nothing programmatic | The ladder key this level belongs to. The document ID is now a digest, so this field is the only legible record of which problem a row belongs to. |
| `hint_level` | int, 1–3 | same | `peek_hint_level:157` | The progressive level. |
| `updated_at` | server timestamp | same | nothing | Audit only. |

These writes are **overwrites**, not merges — `ref.set(...)` is called without
`merge=True` (`backend/session_store.py:169-177`). Since all four
fields are supplied every time, nothing is lost.

Changing the ID scheme orphaned every document written under the old one.
Nothing needed migrating: those rows were unreachable by construction, and a
student whose ladder restarts at 1 is starting from where the bug had them
stuck anyway.

### Collection: `sessions_meta`

**Document ID:** the uid (`backend/session_store.py:183`).

| Field | Type | Written by | Read by | Purpose |
| --- | --- | --- | --- | --- |
| `active` | bool | `begin_session:192-200` (merge), `reset:218-220` (merge) | `begin_session:186` | Whether a session is currently open, so `sessions` is not incremented per question. |
| `last_active_at` | float (epoch seconds) | same | `begin_session:188` | When the open session was last touched. A gap of `SESSION_IDLE_SECONDS` (1800.0, `backend/session_store.py:29`) makes the next ask count as a new session even if `active` is still true. |
| `updated_at` | server timestamp | `begin_session` only | nothing | Audit only. |

Both writes pass `merge=True`.

### Queries performed

| Query | Location | Composite index needed? |
| --- | --- | --- |
| `users.document(uid).get()` | `firebase_service.py:291`, `436`, `481`, `496`, `511`, `516` | No — document lookup by ID. |
| `users.document(uid).set(..., merge=True)` | `firebase_service.py:330`, `451`, `485`, `548` | No. |
| `users.document(source_uid).delete()` | `firebase_service.py:566` | No. |
| `interactions.add(doc)` | `firebase_service.py:267` | No. |
| `interactions.where("user_id","==",uid).order_by("timestamp", DESCENDING).limit(10)` | `firebase_service.py:461-467` | **Yes** — equality filter plus order-by on a different field requires a composite index on `(user_id ASC, timestamp DESC)`. |
| `interactions.where("user_id","==",uid).limit(10)` | `firebase_service.py:470` | No — single-field index suffices. |
| `sessions.document(sha1(uid + key)).get()/.set()` | `session_store.py:152-156`, `165-177` | No. |
| `sessions.where("user_id","==",uid).stream()` | `session_store.py:227-229` | No — single equality filter. |
| `sessions_meta.document(uid).get()/.set()` | `session_store.py:202-219`, `237-239` | No. |

**What happens when the composite index is absent.** The ordered query is
wrapped in its own `try` (`backend/firebase_service.py:462-470`). Firestore
raises `FailedPrecondition`, the except branch runs the *unordered* query
instead, and the comment at `backend/firebase_service.py:469` states the
reason. The consequence is behavioural, not fatal: the ten interactions used
for the session summary are then in whatever order Firestore returns, so the
"what you learned this session" note may summarise arbitrary past
interactions rather than the most recent ten. No index is defined in the
repository (there is no `firestore.indexes.json`), so this fallback is the
expected path unless the index was created by hand in the Firebase console —
**UNVERIFIED**, since console state is not in the repository.

### Client-side storage

| Store | Key | Contents | Written at | Purpose |
| --- | --- | --- | --- | --- |
| SecretStorage | `edupeer.authSession` | JSON `{uid, refreshToken, email?, displayName?, isAnonymous}` | `authManager.ts:331` | The persistent identity, including the long-lived refresh token. |
| SecretStorage | `edupeer.pendingMigration` | JSON `{oldRefreshTokens: string[], legacyUserId?: string, capturedForUid?: string}` | `authManager.ts:128`, `227` | Migrations still owed after a sign-in. Deleted when complete (`authManager.ts:231`) or when queued for a different uid (`authManager.ts:155`). |
| globalState | `edupeer.userId` | A legacy pre-auth random id | Read only (`authManager.ts:122`); cleared at `authManager.ts:218` | Backwards compatibility with builds that predate Firebase auth. |
| globalState | `edupeer.chatHistory` | Array of rendered chat turns, capped at 50 (`sidebarProvider.ts:28`, `104-107`) | On every webview render | Restores the visible conversation after a window reload. |
| globalState | `edupeer.offlineQueue` | Array of `{kind: "reset"\|"goal", text?, language?}` | `offlineQueue.ts:36` | Mutations attempted while the backend was unreachable. |
| Webview state | `{turns: [...]}` | Same turns as `edupeer.chatHistory` | `main.js:68` | Survives hiding the panel; lost on reload, which is why the globalState copy exists. |

---

## 11. Gamification and progress

### Badges

Awarded by `_apply_badge_rules` (`backend/firebase_service.py:27-70`). Badges
are only ever appended, never revoked (`award` at
`backend/firebase_service.py:39-41` checks membership first). The rules are
re-run on every interaction and again on account merge.

| Display name | Exact condition | Line |
| --- | --- | --- |
| `First Question` | `total_interactions >= 1` | 43-44 |
| `Persistent Learner` | `sessions >= 5` | 45-46 |
| `Marathon Learner` | `sessions >= 15` | 47-48 |
| `Scholar` | `sessions >= 50` | 49-50 |
| `Hint Minimiser` | `solved_at_level_1 >= 3` | 51-52 |
| `Hint Minimiser II` | `solved_at_level_1 >= 10` | 53-54 |
| `Hint Minimiser III` | `solved_at_level_1 >= 25` | 55-56 |
| `Concept Explorer` | `len(concept_tags_seen) >= 5` | 57-58 |
| `3-Day Streak` | `streak_days >= 3` | 59-60 |
| `Week Streak` | `streak_days >= 7` | 61-62 |
| `Month Streak` | `streak_days >= 30` | 63-64 |
| `Python Learner`, `JavaScript Learner`, `Java Learner`, `C Learner`, `C++ Learner`, `C# Learner`, `TypeScript Learner`, `Go Learner`, `Rust Learner`, `SQL Learner` | One per language present in `languages_used` that is a registry key; the name is `f"{display_name} Learner"` | 65-67 |
| `Polyglot` | At least 3 *known* languages in `languages_used` | 68-69 |

Note that `solved_at_level_1` counts `hint`-mode replies that were *answered*
at level 1 (`backend/firebase_service.py:300-302`; every other mode is sent at
level 1 and is deliberately excluded), which is not the same as the student
having solved the problem — the name is aspirational.

Languages not in the registry are filtered out before the language badges and
the `Polyglot` count (`backend/firebase_service.py:65`), so a request with an
unknown language cannot mint a badge. In practice `normalize_language` has
already coerced it to `python` by then.

### Streak rule

`_update_streak(last_active_date, streak_days, today)`
(`backend/firebase_service.py:77-87`), evaluated on every interaction:

| Stored `last_active_date` | Result |
| --- | --- |
| Equals today's ISO date | Date unchanged; streak becomes `max(1, streak_days)` — a same-day second question never increments |
| Equals yesterday's ISO date | Date becomes today; streak increments by 1 |
| Anything else (including `None`) | Date becomes today; **streak resets to 1** |

So a single missed day resets the count to 1, not to 0 — the day of return
counts as day one of a new streak. Dates are UTC (`backend/firebase_service.py:73-74`),
so a student's streak boundary is midnight UTC regardless of local time.

### Per-concept statistics

`_update_concept_stats` (`backend/firebase_service.py:90-125`) folds one
interaction into the map, once per tag on that reply. Only `hint`-mode turns
count towards the level statistics: every other mode is sent at level 1, so
`_update_user_and_award_badges_sync` passes `count_level=False`
(`backend/firebase_service.py:305-308`) and only the first two rows below are
applied.

| Key | Update |
| --- | --- |
| `encounters` | `+1` (every mode) |
| `last_seen` | today's ISO date (every mode) |
| `rated_encounters` | `+1`; on documents written before this key existed it is seeded from `encounters - 1`, so every historical encounter stays rated |
| `level_sum` | `+ hint_level` |
| `max_level` | `max(existing, hint_level)` |
| `last_struggled` | today's ISO date, **only when `hint_level >= 2`** (`backend/firebase_service.py:123-124`) |

Average level is `level_sum / rated_encounters` (`_avg_level`,
`backend/progress.py:41-45`), 0.0 when there are no rated encounters.
`_rated_encounters` (`backend/progress.py:25-38`) falls back to `encounters`
for documents written before the key existed.

**Classification** (`backend/progress.py:48-73`), on *rated* encounters only:

- A **struggle** requires `rated_encounters >= 2` **and** `avg_level >= 2.0`.
  Sorted by average level descending, then encounters descending; top 5.
- A **strength** requires `rated_encounters >= 3` **and** `avg_level <= 1.3`.
  Sorted by average level ascending, then encounters descending; top 5.

The `encounters` number reported in each entry is the rated count, so a concept
only ever seen in non-hint modes appears in neither list.

A concept can be neither (the band between 1.3 and 2.0, or too few encounters)
and cannot be both.

### Adaptive pacing

`pacing_summary` (`backend/progress.py:76-97`) takes the top 3 struggles and
top 3 strengths and builds up to three sentences, then prefixes the whole
string with `"Tutor pacing context (never mention this to the student): "`.
The exact sentence templates are:

- Struggles: `"The student has repeatedly needed deep hints on: {names}. Scaffold these concepts more gently."`
- Strengths: `"The student usually solves these at the first question: {names}. Stay terse there."`
- Goal: `"The student's stated learning goal: {goal_text}."`

If none of the three applies the function returns `""` and nothing is appended
to the system prompt. It is computed only for `hint` mode
(`backend/main.py:214-222`) and reads from the 60-second profile cache, so a
newly earned struggle can take up to a minute to influence pacing.

### Confidence calibration

`classify_calibration(confidence, hint_level)` (`backend/progress.py:100-113`):

| Confidence | Hint level reached | Verdict |
| --- | --- | --- |
| Outside 1–3 (including 0 = not rated) | any | `None` — not counted |
| 3 ("Pretty sure") | `>= 3` | `overconfident` |
| 1 ("No idea") | `<= 1` | `underconfident` |
| everything else | | `calibrated` |

`calibration_summary` (`backend/progress.py:116-132`) reports
`samples = calibrated + overconfident + underconfident`,
`score = round(calibrated / samples, 2)` (0.0 when samples is 0) and
`enough_data = samples >= 4` (`CALIBRATION_MIN_SAMPLES`,
`backend/progress.py:22`). Below four samples the dashboard shows a prompt for
more data instead of a percentage (`extension/src/progressPanel.ts:111-116`).

### Spaced review

`review_due_concepts(concept_stats, today, limit=3)`
(`backend/progress.py:144-159`):

- Only concepts with a parseable `last_struggled` date are considered
  (`_parse_iso`, `backend/progress.py:135-141`, reads the first 10 characters
  as `%Y-%m-%d` and returns `None` on failure).
- The age in days must satisfy `3 <= age <= 7` inclusive
  (`REVIEW_MIN_DAYS`/`REVIEW_MAX_DAYS`, `backend/progress.py:17-18`, applied at
  `backend/progress.py:156`).
- Results are sorted by `(encounters, tag)` descending, so the most-encountered
  concept comes first, with the tag name as a tie-break.
- **Item cap: 3** (the `limit` default, `backend/progress.py:145`).

`build_progress` reports `review_due` as the boolean of that list
(`backend/progress.py:214`). The sidebar checks once per webview load
(`extension/src/sidebarProvider.ts:221-226`) with `exercise=false` so no LLM
call is made until the student presses **Review**.

---

## 12. Session and hint-level state machine

### Choosing a level

Choosing a level is split into two steps so a hint the student never saw cannot
cost them a rung of the ladder.

**Step 1 — peek.** `_resolve_hint_level` (`backend/main.py:188-204`) runs
before the LLM call and persists nothing:

1. If `mode != "hint"`, return `req.hint_level` unchanged — no state is
   touched. Non-hint modes never advance anything.
2. Otherwise call `store.peek_hint_level(uid, _ladder_key(req), req.escalate)`,
   which applies `resolve_level`: `min(3, current + 1)` when escalating,
   `max(1, min(3, current))` when not.

`_ladder_key` (`backend/main.py:174-185`) decides what the ladder is keyed on:
`req.problem_key` (the document URI the extension sends), falling back to
`code_fingerprint(req.code)` only for older clients that send no key. The ladder
follows the problem, not the bytes — editing the file no longer restarts it at
level 1.

**Step 2 — commit.** `_commit_hint_level` (`backend/main.py:207-211`) writes
the level, and runs only after a reply exists:

- `/hint` calls it immediately after `engine.generate_hint` returns
  (`backend/main.py:246`). The 502 path above it commits nothing.
- `/hint/stream` calls it inside the `done` branch of the generator
  (`backend/main.py:297`). A stream that yields an `error` event returns
  early, so it commits nothing either.

The practical consequence: a Groq outage can be retried at the same depth, and
the extension's stream-then-`/hint` fallback costs one level rather than two.
Eight tests pin this in `backend/tests/test_main.py::TestFailedHintDoesNotSpendALevel`.

A first-ever non-escalating ask still consumes level 1: the next escalating ask
goes to 2, not back to 1. Tested at
`backend/tests/test_session_store.py::TestInMemoryCurrentHintLevel::test_first_current_call_consumes_level_one`.

**Level ceiling: 3.** Enforced in three places — `resolve_level`
(`backend/session_store.py:32-41`), the clamp inside `commit_hint_level`
(`backend/session_store.py:66`, `154`), and
`max(1, min(3, int(hint_level)))` in the engine before prompt assembly
(`backend/hinting_engine.py:513`).

### The client-side attempt gate

Before sending, the sidebar consults `AttemptTracker.evaluate`
(`extension/src/sidebarProvider.ts:392-395`, implementation
`extension/src/attemptTracker.ts:129-152`), keyed by the active document's URI
string (`extension/src/sidebarProvider.ts:509`):

| Stored state | Condition | Signal | `escalate` sent | Extra UI |
| --- | --- | --- | --- | --- |
| none | first hint for this document | `first` | `true` | — |
| normalised code differs | any | `changed` | `true` | `edit_summary` populated |
| normalised code identical | elapsed < 45,000 ms | `unchanged` | `false` | A local "Same depth" message is shown first (`sidebarProvider.ts:396-404`) |
| normalised code identical | elapsed >= 45,000 ms | `stalled` | `true` | — |

`HINT_COOLDOWN_MS = 45_000` (`extension/src/attemptTracker.ts:13`). Sameness is
decided by `normalizeCode` (`extension/src/attemptTracker.ts:107-113`), which
strips trailing whitespace per line and trims the document the way the server's
`code_fingerprint` does, so a stray blank line no longer counts as an attempt.
The tracker is only updated *after* a successful hint
(`extension/src/sidebarProvider.ts:444-447`), so a failed request does not
consume the student's attempt record.

This is a client-side courtesy: a caller that always sends `escalate: true`
gets escalation. The backend's only guarantee is that it honours what it is
told.

### The code fingerprint

Two different fingerprints exist and they are not interchangeable.

**Server-side** — `code_fingerprint` (`backend/session_store.py:9-11`):

```python
normalized = "\n".join(line.rstrip() for line in code.strip().splitlines())
return hashlib.sha1(normalized.encode("utf-8")).hexdigest()
```

It normalises away: leading and trailing whitespace of the whole document, and
trailing whitespace on every individual line. It does **not** normalise
indentation, blank lines within the file, comments, or line endings beyond what
`splitlines()` handles. Since the ladder is now keyed on `problem_key`, this
only picks the ladder key for older clients that send none. `raw_code_hash`
(`backend/session_store.py:14-23`) is the exact, unnormalised hash used instead
by the `/scan` and `/line-hint` caches, whose entries carry absolute line
numbers that whitespace can shift.

**Client-side** — `codeFingerprint` (`extension/src/pedagogy.ts:29-35`): a
non-cryptographic 32-bit rolling hash rendered as `"{length}:{hash}"`. It
normalises nothing. It decides whether the explain-first gate has already been
shown for this code (`extension/src/sidebarProvider.ts:321-323`), whether a
file's current content has already been scanned
(`extension/src/inlineTutor.ts:368-376`), and deduplicates reflection-quiz
offers (`extension/src/inlineTutor.ts:406-408`). It never reaches the backend.

### What resets a level to 1

| Trigger | Mechanism |
| --- | --- |
| Asking about a different document (or, for an older client that sends no `problem_key`, editing the code so the server fingerprint changes) | A different ladder key means a different `sessions` document, which starts at 0 and so returns 1 |
| `POST /reset` | `store.reset(uid)` deletes every `sessions` document for that user (`backend/session_store.py:206-222`) |
| Backend restart, **only when Firestore is unconfigured** | `InMemorySessionStore` starts empty |
| LRU eviction in `InMemorySessionStore` past 10,000 entries | `backend/session_store.py:68-69` |
| Any Firestore error in `peek_hint_level` | The except branch returns 1 (`backend/session_store.py:140-142`) |

### What a session reset does

`POST /reset` (`backend/main.py:311-325`), in order:

1. Read up to 10 recent interactions.
2. If any exist, generate a three-bullet summary; on failure the summary is
   `""` and the request continues.
3. If the summary is non-empty, append it to `session_summaries` (last 20 kept).
4. `store.reset(uid)` — delete all `sessions` documents for the user and set
   `sessions_meta.active = false`.
5. Drop the user's profile-cache entry.

Client-side, `resetSession` (`extension/src/sidebarProvider.ts:192-211`) also
clears: the conversation `history` array, `seenFingerprints` (so the
explain-first gate fires again), any pending explain/predict/trace exercise,
the whole `AttemptTracker`, the status bar level, and the persisted
`edupeer.chatHistory`. It also bumps `sessionGeneration`
(`extension/src/sidebarProvider.ts:194`), so an ask still in flight when the
student resets is dropped instead of re-seeding the history they just cleared.
If the HTTP call fails the reset is queued for replay
(`extension/src/sidebarProvider.ts:206-209`).

### What survives a backend restart

| State | Survives? | Where it lives |
| --- | --- | --- |
| Hint levels | **Yes**, when Firestore is configured | `sessions` collection |
| Open-session flag | **Yes**, when Firestore is configured | `sessions_meta` collection |
| Badges, streaks, concept stats, calibration, activity, goal, session notes | **Yes** | `users` collection |
| Interaction log | **Yes** | `interactions` collection |
| Hint levels and session flags with Firestore unconfigured | No | `InMemorySessionStore` |
| Scan and line-hint caches | No | `TtlCache` instances |
| Rate-limit buckets | No | `RateLimiterRegistry` |
| Profile cache | No | `_profile_cache` dict |
| In-flight fire-and-forget writes | No | `_pending_tasks` set — an interrupted task never completes |

### What survives an extension reload

| State | Survives? | Where it lives |
| --- | --- | --- |
| Identity and refresh token | **Yes** | SecretStorage |
| Rendered chat turns (last 50) | **Yes** | `globalState["edupeer.chatHistory"]` |
| Offline queue | **Yes** | `globalState["edupeer.offlineQueue"]` |
| Conversation `history` sent to the model | **No** — see Section 17 | In-memory field on the provider |
| `AttemptTracker` records | No | In-memory `Map` |
| `seenFingerprints` (explain-first gate) | No | In-memory `Set` |
| Per-file scan flags and line hints | No | In-memory `Map` in `InlineTutor` |

---

## 13. Authentication

### The sign-in flow, step by step

1. The student runs `EduPeer: Sign In` or clicks the header button, which
   invokes `edupeer.signIn` (`extension/src/extension.ts:295-309`).
2. `signInViaBrowser(baseUrl, timeoutMs = 5 * 60 * 1000)`
   (`extension/src/signInFlow.ts:54-57`) mints a fresh 128-bit state nonce via
   `newSignInState()` (`extension/src/signInFlow.ts:11-13`) and starts an HTTP
   server bound to `127.0.0.1` on port `0` — the OS assigns a free port
   (`extension/src/signInFlow.ts:118`).
3. Once listening, the real port is read from `server.address()` and the
   browser is opened at
   `{backendUrl}/auth/login?port={port}&state={32 hex chars}`
   (`extension/src/signInFlow.ts:118-125`).
4. The backend serves `auth.html` with the Firebase web config interpolated
   (`backend/main.py:139-145`).
5. The page validates `port` against `/^\d{1,5}$/` and `state` against
   `/^[a-f0-9]{32}$/` before doing anything; a missing or malformed value shows
   an "invalid link" card and the sign-in handlers are never wired up
   (`backend/static/auth.html:117-128`).
6. The student picks Google, GitHub, or email/password. Email mode can toggle
   between sign-in and account creation (`backend/static/auth.html:88-115`).
7. On success, `deliver(user)` POSTs a JSON payload — including the `state`
   the page was opened with — to `http://127.0.0.1:{port}/callback` with
   `Content-Type: text/plain`, chosen deliberately to avoid a CORS preflight
   against the one-shot server (`backend/static/auth.html:59-79`).
8. The extension's server accepts only `POST /callback`
   (`extension/src/signInFlow.ts:61-69`), refuses a body over 64 KB
   (`extension/src/signInFlow.ts:74-82`), parses it with
   `parseCallbackPayload`, which requires `idToken`, `refreshToken` and `uid`
   (`extension/src/signInFlow.ts:28-41`), and compares the returned `state`
   against the one it generated in constant time (`stateMatches`,
   `extension/src/signInFlow.ts:21-26`). Only then does it respond `ok`, close
   the server and resolve.
9. A payload whose `state` does not match returns 403
   (`extension/src/signInFlow.ts:87-91`); a malformed payload returns 400
   (`extension/src/signInFlow.ts:96-99`). Both leave the server listening for
   another attempt.
10. `auth.applySignIn(payload)` stores the session and triggers migration.

**Timeout: 5 minutes** (`DEFAULT_TIMEOUT_MS`, `extension/src/signInFlow.ts:6`).
On expiry the server closes and the promise rejects with "Sign-in timed out —
no response from the browser." (`extension/src/signInFlow.ts:103-106`).

The one-shot server sends no `Access-Control-Allow-Origin` header at all: the
auth page never reads the callback response, so the delivery path needs no
CORS, and a readable cross-origin 404 would turn the server into a port scanner
that finds the one loopback port worth attacking
(`extension/src/signInFlow.ts:61-71`). What makes the callback unforgeable is
the state nonce, not the port — the port is guessable in ~16k tries.

### Token types, storage and lifetime

| Token | Stored where | Lifetime | Notes |
| --- | --- | --- | --- |
| Firebase **ID token** | In memory only — `AuthManager.idToken` (`extension/src/authManager.ts:53`) | Anonymous bootstrap: `expiresIn` from Google, converted to ms (`extension/src/authManager.ts:285`). Named sign-in: hard-coded to 55 minutes (`extension/src/authManager.ts:139`). Refresh: `expires_in` from Google (`extension/src/authManager.ts:311`, `324`) | Never persisted. Lost on reload and re-derived from the refresh token. |
| Firebase **refresh token** | SecretStorage under `edupeer.authSession` (`extension/src/authManager.ts:330-331`) | Long-lived; rotated on every refresh and re-persisted (`extension/src/authManager.ts:325-326`) | The durable credential. |
| Old anonymous **refresh tokens** | SecretStorage under `edupeer.pendingMigration` | Until migration succeeds or a 4xx proves the account is gone | Used once to mint an ID token for the merge call. |

An ID token is reused while `Date.now() < idTokenExpiresAt - EXPIRY_MARGIN_MS`,
where `EXPIRY_MARGIN_MS = 60_000` (`extension/src/authManager.ts:34`, `95`), so
it is refreshed a minute before it actually expires.

Two in-flight guards prevent duplicate network work: `bootstrapPromise`
(`extension/src/authManager.ts:90-92`) and `refreshPromise`
(`extension/src/authManager.ts:316-318`). Without them, concurrent callers
would each create an anonymous account or each burn the rotated refresh token.

### The anonymous account path

There is no "logged out" state. `getIdToken()` with no session calls
`bootstrapAnonymous()` (`extension/src/authManager.ts:89-93`), which:

1. Fetches the web API key from `GET /auth/config`
   (`extension/src/authManager.ts:258-267`, cached in memory and invalidated
   when the backend URL changes, `extension/src/authManager.ts:71-74`).
2. POSTs `{"returnSecureToken": true}` to
   `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={apiKey}`
   (`extension/src/authManager.ts:271-278`).
3. Stores `{uid: localId, refreshToken, isAnonymous: true}` and fires the change
   event (`extension/src/authManager.ts:283-287`).

`signOut()` (`extension/src/authManager.ts:251-256`) deletes the stored session
and immediately bootstraps a *new* anonymous account, so the student always has
a working identity. Progress earned under the old named account stays with that
account; the new anonymous account starts empty.

Refresh uses `https://securetoken.googleapis.com/v1/token?key={apiKey}` with
`grant_type=refresh_token` (`extension/src/authManager.ts:293-298`). A non-OK
response throws an error carrying the HTTP `status`
(`extension/src/authManager.ts:299-305`), which the migration logic uses to
distinguish permanent from transient failures.

### Migration after a first named sign-in

`applySignIn` (`extension/src/authManager.ts:101-143`) records what needs
migrating *before* replacing the session:

- If the current session is anonymous, its refresh token is pushed onto
  `pending.oldRefreshTokens` (`extension/src/authManager.ts:118-120`).
- Any legacy `edupeer.userId` from globalState is recorded once
  (`extension/src/authManager.ts:121-126`).
- The record is merged with any existing pending record rather than replacing
  it, so repeated sign-in cycles accumulate rather than clobber
  (`extension/src/authManager.ts:104-110`).
- Every record is stamped with `capturedForUid`
  (`extension/src/authManager.ts:111-117`). A record captured for a different
  account is thrown away instead of replayed — the merge is destructive on the
  backend, so replaying user A's queue after user B signs in on the same
  machine would hand A's progress to B and delete A's document.
  `runPendingMigration` re-checks the stamp and deletes a mismatched record
  (`extension/src/authManager.ts:151-157`).

`runPendingMigration` (`extension/src/authManager.ts:145-233`) then, for each
queued old refresh token:

1. Exchanges it for an ID token. On a 4xx the account is treated as permanently
   gone and the token is **dropped** (`extension/src/authManager.ts:177-184`).
   On a network error or 5xx it stays queued.
2. POSTs to `/auth/migrate` with `old_id_token` and, until one call carrying it
   succeeds, `legacy_user_id` (`extension/src/authManager.ts:189-201`).
3. A legacy-only migration runs when no refresh tokens remain
   (`extension/src/authManager.ts:207-215`).
4. Anything left is re-persisted and retried on the next activation
   (`extension/src/authManager.ts:221-232`); the retry is kicked off at
   `extension/src/extension.ts:81`.

**What the server-side merge does** (`merge_user_sync`,
`backend/firebase_service.py:504-570`):

| Field | Operation |
| --- | --- |
| `total_interactions`, `sessions`, `solved_at_level_1` | **Added** |
| `calibration` (all three counters), `hint_level_counts` (all three levels) | **Added** per key (`_merge_counters`) |
| `activity` | **Added** per date (`_merge_activity`) |
| `concept_tags_seen`, `badges` | **Unioned** via `set()` |
| `languages_used` | **Unioned** and sorted |
| `concept_stats` | Per tag: `encounters` and `level_sum` added, `max_level` maxed, `last_seen` and `last_struggled` take the later date |
| `streak_days` | **Max** of the two |
| `last_active_date` | The later of the two ISO strings |
| `badges` (again) | Recomputed by `_apply_badge_rules` over the merged totals, so tier badges the combined account now qualifies for are granted |

**What is deleted:** the entire source `users` document
(`backend/firebase_service.py:566`). The source account's `interactions`
documents are **not** deleted and **not** reattributed — they keep the old
`user_id` and become orphaned. Session state in `sessions`/`sessions_meta` for
the old uid is also left in place.

The merge returns `False` without touching anything when Firestore is disabled,
when the uids match, or when the source document does not exist
(`backend/firebase_service.py:507-513`).

### Server-side authorisation of the merge

`POST /auth/migrate` (`backend/main.py:148-171`) builds its source list
defensively:

- `old_id_token` is verified with `verify_token`, which raises 401 on failure
  (`backend/main.py:157-160`). Ownership of the old account must therefore be
  proven cryptographically.
- `legacy_user_id` cannot be verified — those ids predate Firebase auth — so
  it is accepted only when it differs from the caller's uid **and** starts with
  `"user-"` (`backend/main.py:164`). The comment at
  `backend/main.py:161-163` states the reason: without the prefix check a
  caller could name another user's Firebase uid and have their document merged
  away.

### How the backend verifies a token

`get_current_uid` (`backend/auth.py:21-25`) reads the `Authorization` header
(default `""`), requires the literal prefix `"Bearer "`, and passes the
remainder to `verify_token`.

`verify_token` (`backend/auth.py:5-18`) calls
`firebase_admin.auth.verify_id_token`. Any exception becomes
`HTTPException(401, "invalid or expired token")`. A successfully decoded token
with no `uid` claim becomes `HTTPException(401, "token has no uid")`.

**On the client, a 401 is retried once.** `authedFetch`
(`extension/src/apiClient.ts:248-276`) makes the request, and if the status is
401 it calls `getIdToken(force = true)` to mint a fresh token and repeats the
request. A network-level throw marks the backend unavailable, and so does an
abort once `REQUEST_TIMEOUT_MS` elapses (rethrown as `TimeoutError`,
`extension/src/apiClient.ts:264-274`); a 401 does not.

---

## 14. Extension reference

### Activation

`"activationEvents": ["onStartupFinished"]` (`extension/package.json:14-16`).
The extension activates once VS Code has finished starting, regardless of what
files are open. `activate()` is `async`
(`extension/src/extension.ts:18`) and awaits `auth.initialize()`
(`extension/src/extension.ts:23`) before it registers anything. The `/health`
probe is deliberately *not* awaited (`extension/src/extension.ts:103`), so a
hung backend cannot delay command registration; the "not reachable" warning it
can raise fires at most once per window, and only while a supported file is
open (`extension/src/extension.ts:86-102`).

`deactivate()` is empty (`extension/src/extension.ts:331`); cleanup is handled
by `context.subscriptions`.

Entry point: `./out/extension.js` (`extension/package.json:17`), produced by
esbuild from `src/extension.ts`.

### Contributed commands

All fifteen are declared in `extension/package.json:37-98`. Registration sites
are in `extension.ts` unless noted.

| Command id | Title | Registered at | Context menu `when` | Keybinding |
| --- | --- | --- | --- | --- |
| `edupeer.activate` | EduPeer: Open Tutor Panel | `extension.ts:113` | — | — |
| `edupeer.analyseSelection` | EduPeer: Analyse Selection | `extension.ts:120` | `editorHasSelection && resourceLangId =~ /^(python\|javascript\|typescript\|java\|c\|cpp\|csharp\|go\|rust\|sql)$/` | — |
| `edupeer.resetSession` | EduPeer: Reset Session | `extension.ts:242` | — | — |
| `edupeer.nudgeLine` | EduPeer: Nudge Current Line | `inlineTutor.ts:144` | `resourceLangId =~ /^(…ten ids…)$/` | `ctrl+alt+h` / `cmd+alt+h` when `editorTextFocus && resourceLangId =~ /^(…ten ids…)$/` (`package.json:144-151`) |
| `edupeer.scanFile` | EduPeer: Scan File for Issues | `inlineTutor.ts:171` | `resourceLangId =~ /^(…ten ids…)$/` | — |
| `edupeer.reflectQuiz` | EduPeer: Reflection Quiz on My Fix | `extension.ts:147` | — | — |
| `edupeer.explainError` | EduPeer: Explain This Error | `extension.ts:153` | `resourceLangId =~ /^(…ten ids…)$/` | — |
| `edupeer.explainSelection` | EduPeer: Explain This Construct | `extension.ts:169` | `editorHasSelection && resourceLangId =~ /^(…ten ids…)$/` | — |
| `edupeer.predictOutput` | EduPeer: Predict the Output | `extension.ts:187` | `editorHasSelection && resourceLangId =~ /^(…ten ids…)$/` | — |
| `edupeer.traceCode` | EduPeer: Trace This Code | `extension.ts:202` | `resourceLangId =~ /^(…ten ids…)$/` | — |
| `edupeer.discussLines` | EduPeer: Discuss Flagged Lines | `extension.ts:222` | Hidden from the palette via `commandPalette` `when: "false"` (`package.json:137-142`) | — |
| `edupeer.showProgress` | EduPeer: Show My Progress | `extension.ts:249` | — | — |
| `edupeer.setGoal` | EduPeer: Set Learning Goal | `extension.ts:268` | — | — |
| `edupeer.signIn` | EduPeer: Sign In | `extension.ts:296` | — | — |
| `edupeer.signOut` | EduPeer: Sign Out | `extension.ts:312` | — | — |

`edupeer.discussLines` takes arguments `(uri, startLine, endLine, question?)`
and is only ever invoked programmatically by a Quick Fix
(`extension/src/inlineTutor.ts:534-538`).

### Other contributions

| Contribution | Value | Location |
| --- | --- | --- |
| Activity bar container | id `edupeer-sidebar`, title "EduPeer", icon `media/icon.svg` | `package.json:19-27` |
| Webview view | id `edupeer.sidebar`, name "EduPeer Tutor" | `package.json:28-36` |
| Walkthrough | id `edupeer.gettingStarted`, four steps | `package.json:152-192` |
| Configuration | four settings, see Section 4 | `package.json:193-218` |

The webview view is registered with `retainContextWhenHidden: true`
(`extension/src/extension.ts:72`), so the panel keeps its DOM when hidden.

### Messages: extension → webview

Sent via `this.post(...)` (`extension/src/sidebarProvider.ts:533-535`),
handled in the `switch` at `extension/media/main.js:466`.

| `type` | Payload fields | Sent at | Effect in the webview |
| --- | --- | --- | --- |
| `restoreChat` | `messages: turn[]` | `sidebarProvider.ts:90-93` | Rebuilds the whole transcript from globalState; shows the empty state if the array is empty (`main.js:467-477`) |
| `activeCode` | `code`, `fileName`, `language` | `sidebarProvider.ts:510-515` | Repaints the code preview, filename and language chip (`main.js:479-487`) |
| `userMessage` | `text` | multiple, e.g. `sidebarProvider.ts:339` | Appends a student turn (`main.js:489-491`) |
| `streamStart` | `seq` | `sidebarProvider.ts:427` | Creates an empty tutor bubble with a blinking caret, marked `aria-hidden` so the live log does not re-announce every token (`main.js:493-514`) |
| `streamDelta` | `text`, `seq` | `sidebarProvider.ts:430` | Appends text to the streaming bubble, but only while `seq` matches the bubble's, and only auto-scrolls when the student is already at the bottom (`main.js:516-529`) |
| `streamAbort` | `seq` | `sidebarProvider.ts:434` | Removes the streaming bubble (`main.js:531-535`) |
| `hint` | `hint`, `hint_level`, `concept_tags`, `mode`, plus `seq` on the success path | `sidebarProvider.ts:450-457` and the failure paths | Renders the final tutor turn, sets or holds the depth stepper, adds mode-specific action rows (`main.js:409-462`, `537-539`) |
| `traceTable` | `snippet`, `variables`, `steps`, `prompt` | `sidebarProvider.ts:270-276` | Renders the desk-check grid (`main.js:266-336`) |
| `predictFirst` | `snippet` | `sidebarProvider.ts:252` | Shows the prediction prompt and switches the composer to `predict` mode (`main.js:545-555`) |
| `explainFirst` | `prompt` | `sidebarProvider.ts:326` | Shows the explain-first gate with a "Skip and get my hint" action (`main.js:557-569`) |
| `error` | `message` | `sidebarProvider.ts:498` | Renders an error-styled turn (`main.js:571-574`) |
| `loading` | `value: boolean` | `sidebarProvider.ts:409`, `465` | Sets the webview's `isLoading` flag: toggles the thinking indicator and disables **Ask**, **I fixed it**, **Reset** and **Review** (`main.js:576-583`) |
| `offline` | `value: boolean` | `sidebarProvider.ts:75-77` | Toggles the offline banner (`main.js:585-587`) |
| `badges` | `badges: string[]` | `sidebarProvider.ts:520` | Repaints the badge disclosure and its count (`main.js:589-591`) |
| `authState` | `signedIn`, `label` | `sidebarProvider.ts:526-530` | Updates the account label and Sign in/out button (`main.js:593-598`) |
| `reviewDue` | `concepts` | `sidebarProvider.ts:217` | Reveals the Review button (`main.js:600-602`) |
| `resetDone` | `summary` | `sidebarProvider.ts:210` | Clears the transcript, resets composer/confidence/stepper, shows the summary if present (`main.js:604-619`) |
| `externalAsk` | `question`, `code` | `sidebarProvider.ts:186` | Repaints the code preview for a context-menu ask (`main.js:621-624`) |

### Messages: webview → extension

Sent via `vscode.postMessage(...)`, handled in the `switch` at
`extension/src/sidebarProvider.ts:88`.

| `type` | Payload fields | Sent at | Handler |
| --- | --- | --- | --- |
| `ready` | — | `main.js:658` | Restores chat, sends code/badges/auth/offline state, checks whether a review is due (`sidebarProvider.ts:92-102`) |
| `persistChat` | `messages: turn[]` | `main.js:69` | Writes the last 50 turns to globalState (`sidebarProvider.ts:103-108`) |
| `askHint` | `question`, `code`, `mode`, `confidence` | `main.js:378-384`, `400`, `450-455` | `handleAskFromWebview` (`sidebarProvider.ts:112-119`) |
| `explainAnswer` | `explanation` | `main.js:355` | `handleExplainAnswer` (`sidebarProvider.ts:120-122`) |
| `explainSkip` | — | `main.js:583` | `handleExplainSkip` (`sidebarProvider.ts:123-125`) |
| `predictAnswer` | `prediction` | `main.js:362` | `handlePredictAnswer` (`sidebarProvider.ts:126-128`) |
| `traceAnswer` | `rows: string[][]` | `main.js:333` | `handleTraceAnswer` (`sidebarProvider.ts:129-131`) |
| `reviewAnswer` | `answer` | `main.js:369` | `handleReviewAnswer` (`sidebarProvider.ts:132-134`) — marks the answer against the review exercise rather than the open file |
| `startReview` | — | `main.js:415` | `startReview` (`sidebarProvider.ts:109-111`) |
| `reset` | — | `main.js:405` | `resetSession` (`sidebarProvider.ts:135-137`) |
| `refreshCode` | — | `main.js:407` | `sendActiveCode` (`sidebarProvider.ts:138-140`) |
| `signIn` | — | `main.js:399` | Executes `edupeer.signIn` (`sidebarProvider.ts:135-137`) |
| `signOut` | — | `main.js:399` | Executes `edupeer.signOut` (`sidebarProvider.ts:138-140`) |

### CodeLens provider

`provideCodeLenses` (`extension/src/inlineTutor.ts:452-491`) runs for the ten
registered languages and returns nothing at all when
`edupeer.inlineHints` is false (`extension/src/inlineTutor.ts:453`, via
`isSupported`).

It emits two kinds of lens, in this order:

1. **One lens per scan flag.** For each flag in the file's cached state, a lens
   is placed at `flag.line - 1` clamped into the document, titled
   `{emoji} {flag.question}` where the emoji is 🎨 for `kind === "style"` and 🤔
   otherwise (`flagEmoji`, `extension/src/inlineTutor.ts:30-32`). Lines already
   used are tracked in `seenLines` so a second flag on the same line is skipped
   (`extension/src/inlineTutor.ts:458-470`).
2. **One "💡 Get a hint" lens per definition-like line.** Every remaining line
   is tested against that language's `lensRegex`; matches get a lens
   (`extension/src/inlineTutor.ts:472-488`). Languages with no regex return
   only the flag lenses (`extension/src/inlineTutor.ts:473`).

**How many are shown.** There is no cap in the provider. The flag count is
bounded upstream by the scan engine at 5 `bug` + 2 `style` = **at most 7 flag
lenses**. The definition lenses are **unbounded**: every line in the file
matching the regex gets one, so a 40-function file produces 40 lenses. Both
kinds invoke `edupeer.nudgeLine` with `[doc.uri, line]`.

Refresh is driven by an `EventEmitter` fired after each successful scan
(`extension/src/inlineTutor.ts:382`, wired at
`extension/src/inlineTutor.ts:94`).

### Other in-editor surfaces

| Surface | Behaviour | Location |
| --- | --- | --- |
| Hover | Shows the cached line hint (or the local rule fallback) and any scan flag with its concept, plus two command links. `isTrusted` is restricted to `edupeer.nudgeLine` and `edupeer.explainSelection` | `inlineTutor.ts:545-573` |
| Diagnostics | One `Diagnostic` per flag in the collection named `"edupeer"`, severity `Warning` for `severity === "warning"` else `Information`, `source = "EduPeer"`, `code = flag.concept` | `inlineTutor.ts:422-450` |
| Gutter / overview ruler | Whole-line decorations, two types: info (hover-highlight background) and warning | `inlineTutor.ts:66-78`, applied at `444-449` |
| Inline ghost text | An `after` decoration on the active line only, 2rem margin, italic, themed with `editorCodeLens.foreground`; the ghost is cleared from every other visible editor first, so a split view cannot keep a stale one. Precedence: real line hint, then scan flag, then local rule | `inlineTutor.ts:57-64`, `298-348` |
| Quick Fix | Always two actions ("nudge me on this line", "explain this line"); a third ("talk through …") when the line carries a flag | `inlineTutor.ts:498-543` |

### Automatic triggers

| Trigger | Condition | Delay / throttle | Location |
| --- | --- | --- | --- |
| Line hint | Cursor moves or the document changes | Debounced by `edupeer.debounceMs` (default 1800 ms, floored at 600); skipped entirely while `quietUntil` is in the future | `inlineTutor.ts:114-120`, `230-251` |
| File scan | Document changes, or the active editor changes to a supported file; also once on activation | Fixed 3500 ms timer; skipped when `edupeer.autoScan` is false or while `quietUntil` is in the future; skipped when the last *successful* scan's fingerprint is unchanged, or when a scan of the same content is already in flight (`inFlightFingerprint`) | `inlineTutor.ts:122-141`, `195-198`, `350-375` |
| Reflection-quiz offer | A file that previously had ≥1 flag scans clean | Once per code fingerprint, tracked in `reflectOffered` | `inlineTutor.ts:400-420` |
| Debugger companion | A debug adapter sends a `stopped` event with `reason === "exception"` | Once per debug session id | `debugCompanion.ts:14-31` |
| Test-run companion | A terminal shell execution whose command line matches `TEST_COMMAND_RE` exits with a non-zero, non-undefined code | 30-second cooldown between offers (`OFFER_COOLDOWN_MS`) | `testWatcher.ts:4`, `57-78` |
| Backend health retry | `api.isAvailable` is false | Every 30,000 ms (`HEALTH_RETRY_MS`) | `extension.ts:16`, `63-67` |

The test watcher feature-detects `onDidStartTerminalShellExecution` and
`onDidEndTerminalShellExecution` and returns immediately if the host does not
provide them (`extension/src/testWatcher.ts:32-35`), so it silently no-ops on
VS Code older than 1.93. It buffers at most 8,000 characters of output
(`MAX_BUFFER_CHARS`) and sends only the last 40 non-blank lines
(`TAIL_LINES`) when the student accepts.

The debug companion collects the exception description, the top stack frame and
the first scope's variables, capping the variable list at 15 entries
(`extension/src/pedagogy.ts:129`).

### Status bar

`StatusBar` (`extension/src/statusBar.ts:48-85`) creates a left-aligned item
with priority 100 whose command is `edupeer.activate`. It is hidden unless the
active editor's language is one of the ten
(`extension/src/extension.ts:31-33`).

`renderStatus` (`extension/src/statusBar.ts:19-46`) is a pure function; its
text is `$(mortar-board) EduPeer` plus, in order: `offline` **or**
`hint {n}/3` when a hint has been given, `{n}d` for a non-zero streak, and
`$(history)` when a review is due. The background turns
`statusBarItem.warningBackground` while offline
(`extension/src/statusBar.ts:76-78`).

Level updates arrive through an event the sidebar fires after each hint
(`extension/src/sidebarProvider.ts:62-63`, `446`); streak and review-due are
refreshed from `/progress` on startup and whenever the backend comes back
(`extension/src/extension.ts:51-62`).

---

## 15. Resilience behaviour

### Streaming fallback path

`handleAsk` (`extension/src/sidebarProvider.ts:425-438`) attempts
`api.streamHint` first. On any throw it posts `streamAbort` to remove the
partial bubble, then:

- If the error is a `RateLimitError`, it is **re-thrown** rather than retried
  (`extension/src/sidebarProvider.ts:435`) — falling back to `/hint` would
  spend the same exhausted budget.
- Otherwise it calls `api.getHint(request)` with the identical request body.

`streamHint` throws in five situations: a 429 (`apiClient.ts:332-336`), a
non-OK status or missing body (`apiClient.ts:337-339`), an `error` event inside
the stream (`apiClient.ts:355-357`), a gap between chunks longer than
`STREAM_IDLE_TIMEOUT_MS` (30 s — `withIdleDeadline` at `apiClient.ts:172-184`,
applied at `347-350`), and a stream that ends without a `done`
event (`apiClient.ts:376-378`). Only the first is exempt from the fallback.
The reader is cancelled in a `finally` on every exit path (`apiClient.ts:367-375`).

The hint level is resolved before the LLM call but only *committed* after a
reply exists (Section 12), so this two-call path costs exactly one level: the
failed stream commits nothing, and the fallback `/hint` commits the level it
was peeked at. Pinned by
`test_a_failed_stream_then_a_hint_fallback_spends_only_one_level`.

### When the backend is unreachable

`ApiClient.setAvailable(false)` fires on a network-level throw from `fetch`, and
on a request aborted for outliving `REQUEST_TIMEOUT_MS` (20 s) — never on an
HTTP error status (`extension/src/apiClient.ts:264-275`, comment at 272).
Listeners then run (`extension/src/extension.ts:42-49`):

1. The sidebar shows the offline banner: "Backend unreachable — retrying.
   Nudges are local for now." (`extension/src/sidebarProvider.ts:551-554`).
2. The status bar switches to "offline" with a warning background.
3. A 30-second timer polls `/health` until it succeeds
   (`extension/src/extension.ts:63-67`).
4. On recovery the offline queue is flushed and `/progress` is re-read
   (`extension/src/extension.ts:45-48`).

A hint asked while offline is answered locally: `postFailure`
(`extension/src/sidebarProvider.ts:487-496`) calls `offlineTutorReply`, which
scans the file for the first matching rule and otherwise returns one of four
generic metacognitive prompts, rotated by a counter
(`extension/src/localTutor.ts:346-356`). The reply always opens with "EduPeer
is offline, so here is a general nudge rather than a real hint."
(`extension/src/localTutor.ts:330`) and closes with the standard Socratic
question. It never advances the hint level — the message is posted with
`hint_level: 0`.

Inline hints fall back the same way, but only when the client already believes
the backend is down or the error was a 429
(`extension/src/inlineTutor.ts:277-288`). Local hints are stored in a separate
`localHints` map so a real hint always wins once the backend answers again
(`extension/src/inlineTutor.ts:321-334`).

**Local rule counts** (`extension/src/localTutor.ts`): 5 shared rules plus
Python 8, JavaScript 6, C 5, SQL 5, TypeScript 4, Java 4, C++ 4, Go 4, Rust 4,
C# 3 — so 8 to 13 rules apply to any given language.

### Queued operations

`OfflineQueue` (`extension/src/offlineQueue.ts`) persists only two kinds:
`reset` and `goal` (`extension/src/offlineQueue.ts:8`). Hints are interactive
and are never queued (comment at `extension/src/offlineQueue.ts:3-4`).

- Enqueueing a kind replaces any older item of the same kind
  (`extension/src/offlineQueue.ts:34`), so only the newest goal survives.
- `flush` replays each item and keeps the failures queued
  (`extension/src/offlineQueue.ts:40-59`).
- A reset is queued when `api.resetSession()` throws
  (`extension/src/sidebarProvider.ts:206-209`); a goal is queued only when
  `api.isAvailable` is false at the time of failure
  (`extension/src/extension.ts:282-287`).

### When the backend is throttling (429)

| Surface | Behaviour |
| --- | --- |
| Sidebar | A "Slow down" message with the wait explanation and a suggestion to re-read the uncertain line (`sidebarProvider.ts:475-486`) |
| Scan | `quietUntil` is set to now + `Retry-After` seconds, which suppresses **both** scans and line hints until it passes (`inlineTutor.ts:388-391`, checked at `231` and `357`) |
| Line hint | Falls back to a local rule for that line |
| Trace | `getTrace` swallows everything and returns `steps: 0`, so the student silently gets a prediction exercise instead (`apiClient.ts:308-317`) |
| Availability | Unchanged — a 429 does not mark the backend down (`apiClient.ts:262`) |

`Retry-After` is read from the response header and defaults to 30 seconds when
absent or unparseable (`extension/src/apiClient.ts:39-42`).

### When Firestore is unavailable or unconfigured

`FirebaseService.__init__` catches every exception, prints
`[firebase] initialization failed: …` and leaves `_client = None`
(`backend/firebase_service.py:230-232`). Then:

- `enabled` is `False`, so every read returns an empty value and every write
  returns immediately without doing anything.
- `build_session_store` selects `InMemorySessionStore`
  (`backend/session_store.py:225-230`), so hint levels work but do not survive
  a restart.
- `/progress` returns a zeroed report, `/badges` returns `[]`, `/reset` returns
  an empty summary.
- Tutoring itself is unaffected: the LLM path never touches Firestore.

A Firestore that initialises but then fails at query time is handled
per-method: every Firestore call in `firebase_service.py` and
`session_store.py` sits inside its own `try/except` that prints and returns a
safe default.

`FirestoreSessionStore` additionally bounds every call at
`TIMEOUT = 5.0` seconds (`backend/session_store.py:118`, passed to `get`, `set`,
`stream` and `commit`), so a hung Firestore degrades in five seconds rather
than hanging the request.

### Deliberately swallowed exceptions

Every site below catches an exception so the student's request still completes.

| Location | What is swallowed | Consequence |
| --- | --- | --- |
| `backend/firebase_service.py:230-232` | Firebase initialisation | Backend starts with persistence disabled |
| `backend/firebase_service.py:268-269` | Interaction write | That interaction is not logged |
| `backend/firebase_service.py:349-351` | User document update | Badges/stats not updated for that hint |
| `backend/firebase_service.py:438-440` | Profile read | `try_get_user_profile_sync` returns `None` rather than `{}`, so `_cached_profile` serves the last good value instead of caching the failure as an empty profile |
| `backend/firebase_service.py:454-455` | Goal write | Goal silently not saved |
| `backend/firebase_service.py:468-470` | Ordered interactions query | Falls back to an unordered query |
| `backend/firebase_service.py:472-474` | Interactions read | Session summary is skipped |
| `backend/firebase_service.py:489-490` | Summary append | Note not stored |
| `backend/firebase_service.py:500-502` | Badge read | Returns `[]` |
| `backend/firebase_service.py:568-570` | Account merge | Returns `False`; the migration stays queued client-side |
| `backend/firebase_service.py:418-419` | `RuntimeError` from `asyncio.create_task` when no loop is running | Logging is skipped entirely |
| `backend/session_store.py:140-142`, `159-160`, `202-204`, `221-222` | Every Firestore session operation | Safe defaults: level 1, `begin_session` false, reset no-op |
| `backend/main.py:318-320` | Session summary generation | `summary = ""`, reset still succeeds |
| `backend/main.py:368-369` | Goal→concept mapping | Goal saved with no concepts |
| `backend/hinting_engine.py:332-333` | JSON decode of a model reply | Returns `{}`, so scan/line-hint/trace produce empty results |
| `backend/hinting_engine.py:607-608` | Malformed streaming chunk | That chunk is skipped |
| `extension/src/apiClient.ts:225-227` | A throwing availability listener | Other listeners still run |
| `extension/src/apiClient.ts:137-139` | Malformed SSE event JSON | That event is dropped |
| `extension/src/apiClient.ts:314-316` | Any `/trace` failure | Falls back to a prediction exercise |
| `extension/src/apiClient.ts:409-411` | Any `/review` failure | Treated as "no review due" |
| `extension/src/apiClient.ts:452-454` | Any `/badges` failure | Returns `[]` |
| `extension/src/apiClient.ts:370-374` | Failure to cancel the stream reader | The stream is already gone; the original error still propagates |
| `extension/src/inlineTutor.ts:247-249`, `360-362` | Scheduled line-hint and scan rejections | Silent |
| `extension/src/inlineTutor.ts:388-392` | Scan failure | Only a 429 is acted on; everything else is silent |
| `extension/src/extension.ts:59-61` | `/progress` failure during a status-bar refresh | Status bar keeps its old values |
| `extension/src/authManager.ts:165-169` | Failure to mint an ID token during migration | Migration deferred to the next activation |
| `extension/src/authManager.ts:177-188`, `199-201` | Refresh-token exchange and migration POST failures | A 4xx drops that old account for good; anything else stays queued |
| `extension/src/debugCompanion.ts:50-52`, `71-73` | `exceptionInfo` and `variables` requests | The question is asked with less context |
| `extension/src/testWatcher.ts:51-53` | Terminal output stream read | The offer still fires with whatever was captured |
| `extension/src/signInFlow.ts:96-99` | Malformed callback payload | Responds 400 and keeps listening |

---

## 16. Test inventory

### Observed results

Both suites were executed against the commit in Section 1 at document
generation time. These are the real observed figures, not estimates.

| Suite | Command | Files | Tests | Passed | Failed | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| Backend | `backend/.venv/Scripts/python.exe -m pytest -q` | 13 | 438 | **438** | **0** | 28.38 s |
| Extension | `npx jest` (from `extension/`) | 21 | 524 | **524** | **0** | 6.59 s |
| **Total** | | **34** | **962** | **962** | **0** | |

TypeScript type-checking (`npx tsc -p ./ --noEmit`) also passes with no errors.

Seven warnings are emitted by the backend run, all the same
`UserWarning: Detected filter using positional arguments` from
`google/cloud/firestore_v1/base_collection.py:317`, caused by the
`.where("user_id", "==", uid)` calls in `firebase_service.py:461` and
`session_store.py:208-210`.

### Coverage

Coverage tooling is installed and the figures below were measured, not
estimated. `pytest-cov==5.0.0` is pinned in `backend/requirements-dev.txt`
(test-only dependencies now live there; `backend/requirements.txt` holds runtime
deps alone); `jest --coverage` is exposed as `npm run test:coverage`.

**Backend — 93% of source statements (1,102 of 1,181).**

| Module | Statements | Missed | Cover |
| --- | --- | --- | --- |
| `auth.py` | 15 | 0 | 100% |
| `cache.py` | 29 | 0 | 100% |
| `languages.py` | 13 | 0 | 100% |
| `models.py` | 69 | 0 | 100% |
| `ratelimit.py` | 43 | 0 | 100% |
| `session_store.py` | 113 | 4 | 96% |
| `progress.py` | 128 | 8 | 94% |
| `main.py` | 230 | 14 | 94% |
| `hinting_engine.py` | 257 | 20 | 92% |
| `firebase_service.py` | 284 | 33 | 88% |
| **Total** | **1,181** | **79** | **93%** |

The two lowest modules are lowest for the same reason: most of their uncovered
lines are the `except` branches that swallow Firestore and Groq failures
(Section 15), which require provoking a live-service error to reach.

**Extension — 88.04% of statements, 89.57% of lines.**

| Module | % Stmts | % Branch | % Funcs | % Lines |
| --- | --- | --- | --- | --- |
| `firebaseClient.ts` | 100 | 100 | 100 | 100 |
| `languages.ts` | 100 | 50 | 100 | 100 |
| `localTutor.ts` | 100 | 84.61 | 100 | 100 |
| `offlineQueue.ts` | 100 | 80 | 100 | 100 |
| `progressPanel.ts` | 100 | 96.96 | 100 | 100 |
| `debugCompanion.ts` | 100 | 78.94 | 100 | 100 |
| `attemptTracker.ts` | 98.07 | 96 | 100 | 100 |
| `statusBar.ts` | 97.14 | 100 | 80 | 96.96 |
| `pedagogy.ts` | 93.33 | 100 | 81.25 | 93.02 |
| `authManager.ts` | 92.06 | 90 | 100 | 92.06 |
| `inlineTutor.ts` | 90.65 | 81.08 | 91.89 | 94.48 |
| `signInFlow.ts` | 88.13 | 87.5 | 91.66 | 89.65 |
| `sidebarProvider.ts` | 87.71 | 67.54 | 81.25 | 88.69 |
| `apiClient.ts` | 87.01 | 64.81 | 92.85 | 88.88 |
| `extension.ts` | 78.03 | 61.11 | 63.33 | 79.51 |
| `testWatcher.ts` | 40.47 | 22.22 | 57.14 | 42.1 |
| **All files** | **88.04** | **76.81** | **86.84** | **89.57** |

Three caveats worth stating in the report rather than hiding:

- `testWatcher.ts` at 40% is the honest floor. Its uncovered span
  (lines 37–74) is the terminal shell-integration flow, which needs a VS Code
  1.93+ host to exercise; only its three pure helpers are directly tested.
- `apiClient.ts` is now at 87%: the SSE reading loop is covered by
  `streamHint.test.ts`, and what remains uncovered is the thin `/progress`,
  `/review`, `/goal`, `/scan` and `/line-hint` error paths (lines 398, 404–410,
  417, 429, 440, 449) plus the manual `AbortSignal.timeout` fallback
  (lines 196–198).
- `media/main.js` (659 lines) and `media/markdown.js` (169 lines) contribute
  **no** percentage: both are loaded via `new Function` in their tests, which
  istanbul cannot instrument. They are behaviourally covered by 116 tests
  (79 + 37) but appear in no coverage report. Do not claim a whole-project
  percentage that implies they are measured.

### Frameworks and configuration

| Suite | Framework | Config | Notes |
| --- | --- | --- | --- |
| Backend | pytest 8.3.3, with pytest-asyncio 0.24.0 for one async test and pytest-cov 5.0.0 for coverage | `backend/tests/conftest.py` | `conftest.py:7` inserts the `backend/` directory on `sys.path`. An autouse fixture (`conftest.py:31-41`) clears `main.limiters`, `main.SCAN_CACHE`, `main.LINE_HINT_CACHE`, `main._profile_cache` and the in-memory store's `_levels`/`_active` maps before and after every test, because those are process-global and every test authenticates as the same uid. It only touches `main` if a test module has already imported it (`conftest.py:13-15`). |
| Extension | Jest 29 with ts-jest. Default `testEnvironment: "node"`; `webviewMain.test.ts` opts into jsdom with an `@jest-environment jsdom` docblock | `extension/jest.config.js` | `roots: ["<rootDir>/src"]`, `testMatch: ["**/__tests__/**/*.test.ts"]`, `collectCoverageFrom` excludes tests and mocks. The `vscode` module is mapped to a hand-written mock (`src/__mocks__/vscode.ts`). ts-jest is configured under the deprecated `globals` key, which emits a warning on every run. |

`npm test` runs `jest --passWithNoTests`; `npm run test:coverage` runs
`jest --coverage`.

### The `vscode` mock

`src/__mocks__/vscode.ts` (382 lines) is a working subset of the VS Code API
rather than a set of stubs, which is what made the five new test files
possible. Where behaviour matters it is implemented for real:
`EventEmitter` actually notifies listeners, `Range`/`Position`/`Selection` do
real arithmetic, and every `register*` call records what was registered.

Three helpers drive the tests:

| Helper | Purpose |
| --- | --- |
| `__reset()` | Clears every recorder and mock between tests. The module is cached per test file, so without it, registered handlers and recorded calls leak. |
| `__makeDocument(text, languageId, path)` / `__makeEditor(doc, line, char)` | Build `TextDocument` and `TextEditor` stand-ins from source text. |
| `__runCommand(id, ...args)` | Invokes a registered command the way VS Code would, and throws if it was never registered. |

`__state` exposes the recorders: `commands`, `codeLensProviders`,
`hoverProviders`, `codeActionProviders`, `diagnosticCollections`,
`statusBarItems`, `webviewPanels`, `webviewViewProviders`,
`debugTrackerFactories`, `decorationTypes`, and `listeners` (the recorded
`onDidChangeActiveTextEditor`, `onDidChangeTextDocument`,
`onDidCloseTextDocument`, `onDidChangeTextEditorSelection` and
`onDidChangeConfiguration` callbacks, which tests fire by hand), plus queues for
`showInformationMessage` and `showInputBox` answers and a `configuration` map
that overrides settings.

Note for anyone editing it: the internal classes are named `MockRange`,
`MockSelection` and `mockWindow` and re-exported under their real names. They
must not be declared as `Range`, `Selection` or `window`, because
`@types/jsdom` (pulled in by `jest-environment-jsdom`) puts those names in the
global type scope and `tsc -p ./` then reports duplicate identifiers.

### Backend test files

#### `backend/tests/test_main.py` — 75 tests, 831 lines

FastAPI `TestClient` against the real app with Groq and firebase_admin stubbed.
Auth is overridden with `dependency_overrides` to a fixed uid.

| Class | Tests | What they assert |
| --- | --- | --- |
| `TestHealth` | `test_returns_ok` | `/health` returns 200 with the literal status and service strings. |
| `TestHintEndpoint` (13) | `test_valid_request_returns_200`, `test_response_has_required_fields`, `test_hint_level_starts_at_1`, `test_hint_level_increments_on_repeat`, `test_hint_level_caps_at_3`, `test_empty_question_returns_400`, `test_whitespace_question_returns_400`, `test_missing_question_returns_422`, `test_different_code_resets_counter`, `test_different_user_independent_counter`, `test_hint_contains_socratic_question`, `test_concept_tags_is_list`, `test_empty_code_accepted` | The `/hint` contract: response shape, the 1→2→3 progression and its ceiling, per-user and per-fingerprint isolation, and the two validation failures. |
| `TestTutorModesEndpoint` (4) | `test_mode_defaults_to_hint_and_advances_level`, `test_non_hint_mode_does_not_advance_level`, `test_reflect_mode_uses_reflect_prompt`, `test_invalid_mode_rejected` | Only `hint` mode is progressive; an unknown mode is a 422. |
| `TestHintStream` (4) | `test_stream_emits_meta_deltas_and_done`, `test_stream_advances_hint_level`, `test_stream_llm_failure_yields_error_event`, `test_stream_empty_question_400` | The SSE event order, that streaming advances the level, and that an LLM failure appears as an `error` event. |
| `TestProgressEndpoints` (6) | `test_progress_returns_shape_for_new_user`, `test_review_not_due_returns_no_exercise`, `test_review_due_generates_exercise`, `test_goal_round_trip`, `test_reset_returns_summary_field`, `test_reset_summarizes_recent_interactions` | `/progress`, `/review`, `/goal` and `/reset` payload shapes and the summary path. |
| `TestHintLanguageAndHistory` (5) | `test_language_field_accepted`, `test_unknown_language_falls_back_to_python`, `test_missing_language_defaults_to_python`, `test_history_forwarded_to_engine`, `test_invalid_history_role_returns_422` | Language normalisation at the API boundary and history forwarding. |
| `TestResetEndpoint` (3) | `test_reset_clears_hint_level`, `test_reset_returns_confirmation`, `test_reset_unknown_user_returns_200` | Reset clears levels and never errors for an unknown user. |
| `TestBadgesEndpoint` (1) | `test_returns_list` | `/badges` returns a JSON array. |
| `TestEventLoopNotBlocked` (1) | `test_hint_offloads_blocking_work_off_event_loop` | Uses `httpx.ASGITransport` and thread-id recording to prove `peek_hint_level`, `commit_hint_level` and `begin_session` all run off the event-loop thread. |
| `TestFailedHintDoesNotSpendALevel` (8) | `test_llm_failure_leaves_the_level_untouched`, `test_repeated_failures_do_not_walk_down_the_ladder`, `test_failure_after_a_success_keeps_the_earned_level`, `test_successful_hint_still_spends_the_level`, `test_non_hint_mode_failure_touches_nothing`, `test_stream_failure_leaves_the_level_untouched`, `test_stream_success_spends_the_level`, `test_a_failed_stream_then_a_hint_fallback_spends_only_one_level` | The peek/commit split: three consecutive 502s still leave the student at level 1, a success still advances, and the extension's stream-then-`/hint` fallback costs exactly one level. |
| `TestEscalationControl` (6) | `test_escalate_defaults_to_true_for_old_clients`, `test_non_escalating_ask_reuses_the_level`, `test_escalation_resumes_after_a_non_escalating_ask`, `test_first_ever_ask_without_escalation_is_level_1`, `test_escalate_ignored_outside_hint_mode`, `test_stream_honours_escalate_false` | The attempt gate's server half, including backwards compatibility with clients that omit `escalate`. |
| `TestEditSummaryAndConfidence` (5) | `test_edit_summary_forwarded_to_the_engine`, `test_oversized_edit_summary_rejected`, `test_confidence_accepted_in_range`, `test_confidence_out_of_range_rejected`, `test_confidence_reaches_the_logger` | The 2000-char cap, the 0–3 confidence range, and that confidence reaches the Firestore logger. |
| `TestTraceEndpoint` (8) | `test_returns_the_designed_table`, `test_empty_body_returns_empty_exercise`, `test_selection_wins_over_full_file`, `test_falls_back_to_full_file_without_a_selection`, `test_llm_failure_returns_502`, `test_unknown_language_is_normalised`, `test_trace_check_mode_accepted_by_hint`, `test_subgoal_label_mode_accepted_by_hint` | `/trace` precedence rules and error status, plus that the two new modes are accepted by `/hint`. |
| `TestResponseCaching` (5) | `test_identical_scan_is_served_from_cache`, `test_changed_code_bypasses_the_cache`, `test_different_language_is_a_different_cache_entry`, `test_line_hint_is_cached_per_line`, `test_cached_scan_is_not_shared_between_users` | Cache hits and every dimension of the cache key, including that a cached scan never crosses users. |
| `TestRateLimiting` (5) | `test_exceeding_the_hint_budget_returns_429`, `test_429_carries_a_retry_after_header`, `test_inline_budget_is_separate_from_hint_budget`, `test_budgets_are_per_user`, `test_health_is_never_rate_limited` | Exact budget boundary (30 pass, the 31st is 429), header presence, bucket independence and per-user isolation. |

#### `backend/tests/test_audit_regressions.py` — 57 tests, 674 lines

Organised by defect rather than by module: each class pins one behaviour the
2026-08-06 audit found wrong and that is now fixed. It reuses `test_main.py`'s
fixtures, because the firebase/Groq stubbing has to happen before `main` is
imported.

| Class | Tests | What they assert |
| --- | --- | --- |
| `TestHintLadderKeyedOnProblem` (7) | `test_editing_code_advances_the_level`, `test_ladder_stops_at_three`, `test_asking_again_without_editing_holds_the_level`, `test_different_problems_have_independent_ladders`, `test_client_without_problem_key_still_works`, `test_failed_llm_call_does_not_spend_a_level`, `test_non_hint_modes_never_touch_the_ladder` | The ladder is keyed on `problem_key`, so editing the file advances the level instead of resetting it; a client that omits the key still falls back to the code fingerprint. |
| `TestModeIsRecordedWithTheInteraction` (5) | `test_hint_mode_is_logged_as_hint`, `test_reflect_mode_is_logged_as_reflect`, `test_stream_passes_mode_through`, `test_stream_logs_language_confidence_and_session`, `test_stream_error_logs_nothing_and_spends_no_level` | `mode` now reaches the Firestore logger on both the blocking and the streaming path. |
| `TestLineNumberCachesUseAnExactHash` (3) | `test_leading_blank_line_is_not_served_the_old_scan`, `test_identical_code_is_still_cached`, `test_line_hint_cache_is_whitespace_sensitive` | `SCAN_CACHE` and `LINE_HINT_CACHE` key on `raw_code_hash`, so a whitespace edit that shifts line numbers is not served the old flags. |
| `TestEveryLlmEndpointIsRateLimited` (4) | `test_reset_is_rate_limited`, `test_goal_is_rate_limited`, `test_review_is_rate_limited`, `test_session_budget_is_separate_from_hint` | `/reset` and `/goal` spend the `session` bucket and `/review` the `review` bucket, independently of `hint`. |
| `TestPromptPayloadsAreBounded` (5) | `test_oversized_goal_is_rejected`, `test_oversized_code_is_rejected`, `test_oversized_question_is_rejected`, `test_oversized_scan_is_rejected`, `test_a_realistic_file_is_still_accepted` | The `max_length` caps on code, question, goal and scan bodies return 422 while a realistic file still passes. |
| `TestProfileCacheDoesNotCacheFailures` (3) | `test_failed_read_is_retried_on_the_next_request`, `test_successful_read_is_cached`, `test_failed_read_serves_the_last_good_profile` | A failed profile read is retried next request rather than cached as an empty profile. |
| `TestAdaptivePacingReachesTheModel` (2) | `test_pacing_paragraph_is_in_the_system_prompt`, `test_non_hint_modes_get_no_pacing` | The pacing paragraph is in the system prompt for `hint` and absent elsewhere. |
| `TestStudentInputIsDelimitedFromInstructions` (8) | `test_system_prompt_declares_student_content_untrusted`, `test_code_and_question_are_wrapped_in_tagged_blocks`, `test_backticks_in_code_cannot_escape_the_block`, `test_a_forged_closing_tag_cannot_escape`, `test_a_guessed_nonce_is_stripped_from_the_body`, `test_the_nonce_changes_every_request`, `test_edit_summary_is_wrapped_too`, `test_scan_wraps_the_file_too` | Student code, question and edit summary are wrapped in nonce-tagged blocks, the nonce changes per request, and neither backticks nor a forged closing tag escape. |
| `TestNonHintModesDoNotDistortProgress` (7) | `test_non_hint_modes_do_not_count_as_solved_at_level_1`, `test_hint_mode_still_counts`, `test_non_hint_modes_do_not_dilute_the_concept_average`, `test_non_hint_modes_do_not_move_the_hint_depth_chart`, `test_non_hint_modes_do_not_score_calibration`, `test_non_hint_modes_still_record_the_encounter`, `test_legacy_docs_without_rated_encounters_are_read_as_fully_rated` | Level-derived counters only move for `mode == "hint"`; the encounter is still recorded, and legacy docs without `rated_encounters` read as fully rated. |
| `TestSessionsLapseWhenIdle` (5) | `test_a_second_ask_in_the_same_session_is_not_a_new_session`, `test_a_long_gap_starts_a_new_session`, `test_reset_still_starts_a_new_session`, `test_firestore_store_lapses_too`, `test_firestore_store_holds_an_active_session` | `SESSION_IDLE_SECONDS` lapses an idle session in both stores. |
| `TestRawCodeHash` (2) | `test_whitespace_changes_the_raw_hash`, `test_identical_code_hashes_identically` | `raw_code_hash` is whitespace-sensitive where `code_fingerprint` is not. |
| `TestConceptFallbackDoesNotInventTags` (6) | `test_tutor_prose_no_longer_tags_rust_concepts`, `test_tutor_prose_no_longer_tags_go_concepts`, `test_word_boundaries_are_respected`, `test_a_real_mention_in_the_question_still_tags`, `test_a_real_mention_in_the_code_still_tags`, `test_hyphenated_concepts_match_their_spaced_form` | `_extract_concept_tags` no longer searches the tutor's own hint text and matches on word boundaries. |

#### `backend/tests/test_hinting_engine.py` — 68 tests, 584 lines

The `Groq` client is replaced with a `MagicMock` returning a canned string.

| Class | Tests | What they assert |
| --- | --- | --- |
| `TestHintingEngine` (9) | `test_returns_hint_and_tags`, `test_appends_socratic_question_if_missing`, `test_does_not_double_append_socratic_question`, `test_level_clamped_to_3`, `test_concept_tag_extraction_variables`, `test_concept_tag_extraction_loops`, `test_concept_tag_fallback_general`, `test_empty_code_accepted`, `test_api_error_propagates` | Core hint contract: the closing question is appended exactly once, the level is clamped, and keyword tagging works with a `general` fallback. |
| `TestLLMConceptTags` (7) | `test_concepts_line_parsed_and_stripped`, `test_invalid_tags_filtered`, `test_all_invalid_tags_fall_back_to_keywords`, `test_missing_concepts_line_falls_back_to_keywords`, `test_closing_question_appended_after_strip`, `test_system_prompt_instructs_concepts_line`, `test_language_specific_tags_accepted` | The `[concepts: …]` mechanism end to end, including both fallback paths. |
| `TestMultiLanguage` (6) | `test_default_language_is_python`, `test_java_prompt_uses_java`, `test_alias_language_normalized`, `test_language_specific_concept_tags`, `test_scan_prompt_uses_language`, `test_line_hint_prompt_uses_language` | Language substitution reaches every prompt template. |
| `TestScanKinds` (4) | `test_kind_parsed_and_defaults_to_bug`, `test_invalid_kind_coerced_to_bug`, `test_style_flags_capped_at_two`, `test_scan_prompt_mentions_style` | The `bug`/`style` distinction and the 2-style cap. |
| `TestTutorModes` (9) | `test_default_mode_is_socratic_hint`, `test_reflect_mode_prompt`, `test_translate_mode_prompt`, `test_worked_example_mode_prompt`, `test_explain_error_mode_prompt`, `test_non_hint_mode_skips_closing_question`, `test_all_modes_emit_concepts_footer`, `test_unknown_mode_falls_back_to_hint`, `test_concept_tags_still_parsed_in_modes` | Each mode selects its own template; only `hint` gets the closing question; every mode carries the concepts footer. |
| `TestStreamHint` (3) | `test_deltas_then_done`, `test_stream_requests_streaming`, `test_done_hint_matches_generate_hint_contract` | Event order, that `stream=True` is passed, and that the streamed final text matches the non-streamed contract. |
| `TestConversationHistory` (4) | `test_history_turns_included_in_order`, `test_history_capped_to_last_six_turns`, `test_empty_history_turns_skipped`, `test_no_history_behaves_as_before` | Role mapping, the 6-turn cap and blank-turn skipping. |
| `TestEditSummary` (5) | `test_edit_summary_reaches_the_prompt`, `test_no_edit_summary_adds_no_section`, `test_whitespace_only_summary_is_ignored`, `test_edit_summary_included_for_non_hint_modes`, `test_streaming_passes_edit_summary_through` | The edit block appears only when there is a real diff, in every mode and in both call paths. |
| `TestSubgoalAndTraceModes` (5) | `test_subgoal_label_mode_uses_its_own_prompt`, `test_trace_check_mode_uses_its_own_prompt`, `test_worked_example_asks_for_unlabelled_numbered_steps`, `test_non_hint_modes_do_not_append_the_socratic_closer`, `test_unknown_mode_falls_back_to_hint` | The two new modes and the sub-goal change to the worked-example prompt. |
| `TestDesignTraceTable` (16) | `test_parses_a_well_formed_reply`, `test_empty_snippet_makes_no_llm_call`, `test_model_declining_yields_nothing_to_trace`, `test_unparseable_reply_yields_nothing`, `test_single_variable_is_rejected`, `test_variables_capped_at_four`, `test_duplicate_variables_dropped`, `test_prose_masquerading_as_a_variable_is_dropped`, `test_indexed_and_dotted_names_are_allowed`, `test_overlong_variable_name_dropped`, `test_steps_clamped_up_to_the_minimum`, `test_steps_clamped_down_to_the_maximum`, `test_non_numeric_steps_yields_nothing`, `test_missing_prompt_yields_nothing`, `test_prompt_is_collapsed_and_truncated`, `test_variables_of_wrong_type_yields_nothing` | Every validation rule applied to the model's trace-table JSON. |

#### `backend/tests/test_firebase_service.py` — 50 tests, 452 lines

| Class | Tests | What they assert |
| --- | --- | --- |
| `TestBadgeLogic` (12) | `test_first_question_awarded_on_first_interaction`, `test_first_question_not_duplicated`, `test_persistent_learner_awarded_at_5_sessions`, `test_hint_minimiser_awarded_at_3_level1_solves`, `test_hint_minimiser_not_awarded_below_threshold`, `test_concept_explorer_awarded_at_5_unique_concepts`, `test_concept_explorer_not_awarded_below_threshold`, `test_new_session_increments_session_count`, `test_enabled_false_when_client_none`, `test_get_user_badges_sync_returns_empty_when_disabled`, `test_get_user_badges_sync_returns_empty_when_doc_missing`, `test_get_user_badges_sync_returns_badges_list` | Threshold boundaries for the original badges and the disabled-service behaviour. |
| `TestExpandedBadgeRules` (7) | `test_streak_badges`, `test_per_language_badges`, `test_polyglot_at_three_languages`, `test_hint_minimiser_tiers`, `test_session_tiers`, `test_unknown_language_ignored`, `test_legacy_call_without_new_args_still_works` | Streak, language and tiered badges; unknown languages cannot mint badges. |
| `TestConceptStatsHelpers` (5) | `test_new_concept_creates_entry`, `test_level_2_marks_struggle`, `test_existing_concept_accumulates`, `test_input_dict_not_mutated`, `test_merge_concept_stats_sums_and_maxes` | The per-concept fold, that `last_struggled` is set only at level ≥ 2, and that the helper copies rather than mutates. |
| `TestStreakHelper` (4) | `test_first_activity_starts_streak`, `test_same_day_keeps_streak`, `test_consecutive_day_increments`, `test_gap_resets_to_one` | All four branches of the streak rule. |
| `TestUserDocEnrichment` (3) | `test_concept_stats_written_to_user_doc`, `test_language_recorded`, `test_streak_fields_written` | The fields actually written to Firestore. |
| `TestMergeUser` (5) | `test_counters_added_lists_unioned_badges_recomputed`, `test_concept_stats_and_languages_merged`, `test_missing_source_doc_returns_false`, `test_same_uid_is_noop`, `test_disabled_service_returns_false` | Add-vs-union semantics of the account merge and its three refusal cases. |
| `TestCalibrationCounters` (5) | `test_verdict_increments_its_bucket`, `test_accumulates_onto_existing_counts`, `test_no_verdict_leaves_counts_untouched`, `test_unknown_verdict_is_ignored`, `test_does_not_mutate_the_input` | Calibration counter folding. |
| `TestHintLevelAndActivityCounters` (9) | `test_level_counted_into_its_bucket`, `test_out_of_range_level_is_clamped`, `test_activity_increments_today`, `test_activity_creates_todays_entry`, `test_activity_trims_old_days`, `test_activity_ignores_corrupt_values`, `test_merge_counters_sums_both_sides`, `test_merge_activity_sums_per_day`, `test_merge_activity_skips_corrupt_entries` | Level distribution and the 30-day activity window, including corrupt-data tolerance. |

#### `backend/tests/test_progress.py` — 41 tests, 239 lines

| Class | Tests | What they assert |
| --- | --- | --- |
| `TestStrugglesAndStrengths` (6) | `test_high_avg_level_is_struggle`, `test_single_encounter_not_a_struggle`, `test_low_avg_with_enough_encounters_is_strength`, `test_strength_needs_three_encounters`, `test_struggles_sorted_by_depth`, `test_empty_stats` | Both threshold pairs and the sort order. |
| `TestPacingSummary` (3) | `test_empty_when_no_signal`, `test_mentions_struggles`, `test_includes_goal` | The pacing paragraph is empty without signal and names struggles and the goal when present. |
| `TestReviewDue` (6) | `test_struggle_four_days_ago_is_due`, `test_struggle_yesterday_not_due`, `test_struggle_ten_days_ago_not_due`, `test_boundaries_inclusive`, `test_capped_and_sorted_by_encounters`, `test_never_struggled_ignored` | The 3–7 day window is inclusive at both ends; the cap is 3. |
| `TestBuildProgress` (3) | `test_empty_doc`, `test_shapes_fields`, `test_blank_goal_treated_as_none` | Report shape, the last-5 summary slice and blank-goal handling. |
| `TestClassifyCalibration` (7) | `test_no_rating_returns_none`, `test_out_of_range_rating_returns_none`, `test_sure_but_needed_pseudocode_is_overconfident`, `test_no_idea_but_solved_at_level_1_is_underconfident`, `test_sure_and_solved_at_level_1_is_calibrated`, `test_no_idea_and_needed_level_3_is_calibrated`, `test_middling_confidence_is_always_calibrated` | Every branch of the calibration classifier. |
| `TestCalibrationSummary` (6) | `test_no_data_is_zeroed_and_not_enough`, `test_score_is_calibrated_over_total`, `test_enough_data_at_the_threshold`, `test_one_below_threshold_is_not_enough`, `test_non_dict_calibration_is_ignored`, `test_none_data_is_safe` | The score formula and the 4-sample threshold, exactly at and below the boundary. |
| `TestHintLevelCounts` (3) | `test_missing_counts_are_zero`, `test_reads_stored_counts`, `test_garbage_values_fall_back_to_zero` | Level counts tolerate corrupt stored values. |
| `TestActivityStrip` (5) | `test_length_matches_window`, `test_oldest_first_ending_today`, `test_counts_are_picked_up_by_date`, `test_days_outside_the_window_are_dropped`, `test_garbage_counts_become_zero` | The 14-entry strip, its ordering and its window. |
| `TestBuildProgressNewFields` (2) | `test_includes_calibration_levels_and_activity`, `test_empty_profile_still_produces_the_new_keys` | The v2 fields are always present. |

#### `backend/tests/test_session_store.py` — 64 tests, 583 lines

| Class | Tests | What they assert |
| --- | --- | --- |
| `TestCodeFingerprint` (3) | `test_same_code_same_fingerprint`, `test_trailing_whitespace_ignored`, `test_different_code_different_fingerprint` | Determinism and the exact normalisation. |
| `TestInMemorySessionStore` (11) | `test_level_starts_at_1`, `test_level_increments`, `test_level_caps_at_3`, `test_different_fingerprint_independent`, `test_different_user_independent`, `test_begin_session_returns_true_first_time`, `test_begin_session_returns_false_when_active`, `test_reset_clears_levels`, `test_reset_clears_session_flag`, `test_reset_only_affects_target_user`, `test_eviction_drops_oldest` | The level machine, session flag and LRU eviction. |
| `TestFirestoreSessionStore` (9) | `test_level_starts_at_1`, `test_level_increments_and_persists`, `test_level_caps_at_3`, `test_different_fingerprint_independent`, `test_begin_session_first_time_true`, `test_begin_session_active_false`, `test_reset_clears_levels`, `test_reset_clears_session_flag`, `test_reset_only_affects_target_user` | The same contract against a stubbed Firestore client. |
| `TestBuildSessionStore` (2) | `test_returns_firestore_when_enabled`, `test_returns_in_memory_when_disabled` | The store-selection rule. |
| `TestFirestoreTimeout` (3) | `test_get_is_called_with_timeout`, `test_set_is_called_with_timeout`, `test_returns_default_when_firestore_times_out` | The 5-second timeout is passed and a timeout degrades to level 1. |
| `TestInMemoryCurrentHintLevel` (7) | `test_first_call_is_level_one`, `test_does_not_advance_the_level`, `test_next_call_still_advances_afterwards`, `test_first_current_call_consumes_level_one`, `test_is_scoped_per_user_and_fingerprint`, `test_reset_clears_it`, `test_respects_the_entry_bound` | The non-advancing read used by the attempt gate. |
| `TestResolveLevel` (6) | `test_escalating_from_nothing_is_level_one`, `test_escalating_advances_by_one`, `test_escalating_stops_at_three`, `test_not_escalating_reuses_the_level`, `test_not_escalating_from_nothing_floors_at_one`, `test_a_corrupt_high_level_is_clamped` | The pure ladder function shared by both stores. |
| `TestPeekAndCommit` (8) | `test_peek_does_not_persist_anything`, `test_commit_makes_the_next_peek_advance`, `test_peek_without_escalating_reuses_the_committed_level`, `test_commit_clamps_out_of_range_levels`, `test_peek_is_scoped_per_user_and_fingerprint`, `test_commit_respects_the_entry_bound`, `test_next_hint_level_is_peek_plus_commit`, `test_reset_clears_committed_levels` | Peek is read-only; only commit spends a level. |
| `TestFirestorePeekAndCommit` (7) | `test_peek_writes_nothing`, `test_peek_on_a_missing_document_is_level_one`, `test_peek_without_escalating_writes_nothing`, `test_commit_writes_the_level`, `test_commit_clamps_before_writing`, `test_peek_degrades_to_one_on_error`, `test_commit_swallows_errors` | The same contract against a stubbed Firestore client, asserting on the actual writes performed. |
| `TestFirestoreDocumentIds` (8) | `test_a_uri_key_yields_an_id_firestore_will_accept`, `test_the_ladder_advances_for_a_uri_key`, `test_a_held_level_persists_for_a_uri_key`, `test_two_symbols_in_one_file_are_independent`, `test_reset_still_clears_a_uri_keyed_ladder`, `test_a_slash_in_the_user_id_is_contained_too`, `test_the_user_and_problem_halves_cannot_bleed_into_each_other`, `test_the_readable_key_is_still_stored_as_a_field` | That the real ladder key — a `file:///…#symbol` URI — survives a Firestore round trip. The fake client enforces the server's document-ID rules (`_assert_valid_document_id`); the version that did not let a permanently broken ladder pass every test. |

#### `backend/tests/test_languages.py` — 38 tests, 69 lines

Heavily parameterised. `TestNormalizeLanguage` (25): `test_registry_keys_pass_through` runs once per language (10 cases); `test_aliases` runs for `js`, `ts`, `typescriptreact`, `c++`, `c#`, `cs`, `py`, `golang`, `rs` (9 cases); plus `test_typescript_is_first_class`, `test_case_and_whitespace_insensitive`, and `test_unknown_falls_back_to_default` for `""`, `None`, `ruby`, `brainfuck` (4 cases). `TestRegistry` (13): `test_supports_at_least_ten_languages`, `test_entries_are_complete` per language (10 cases), `test_concepts_for_includes_base_and_language_specific`, `test_get_language_display_names`.

#### `backend/tests/test_api_auth.py` — 14 tests, 121 lines

`test_hint_requires_auth`, `test_reset_requires_auth`, `test_badges_requires_auth`, `test_scan_requires_auth`, `test_line_hint_requires_auth` each assert 401 without a token. `test_health_stays_public` and `test_auth_config_stays_public` assert the two unauthenticated routes. `test_reset_uses_uid_from_token` and `test_badges_returns_list_for_token_uid` assert the uid comes from the token, not the body. `test_migrate_merges_old_token_and_legacy_id`, `test_migrate_rejects_invalid_old_token`, `test_migrate_requires_auth`, `test_migrate_with_no_sources_merges_nothing` and `test_migrate_ignores_legacy_id_not_shaped_like_a_legacy_id` cover the migration authorisation rules, including the `"user-"` prefix guard.

#### `backend/tests/test_auth.py` — 5 tests, 38 lines

`test_missing_header_raises_401`, `test_non_bearer_scheme_raises_401`,
`test_valid_token_returns_uid`, `test_invalid_token_raises_401`,
`test_token_without_uid_raises_401` — the five branches of `auth.py`.

#### `backend/tests/test_auth_page.py` — 2 tests, 29 lines

`test_auth_config_returns_public_firebase_config` asserts the two public
values; `test_auth_login_serves_html_with_injected_config` asserts the
placeholders in `auth.html` are substituted.

#### `backend/tests/test_cache.py` — 10 tests, 88 lines

`TestTtlCache`: `test_miss_returns_none`, `test_set_then_get`,
`test_entry_expires_after_ttl`, `test_expired_entry_is_evicted_not_just_hidden`,
`test_evicts_least_recently_used_past_capacity`,
`test_never_exceeds_capacity`, `test_overwrite_replaces_value_and_resets_age`,
`test_tuple_keys_are_distinct`, `test_falsy_values_round_trip`,
`test_clear_empties_the_cache`. A `FakeClock` replaces `_now` so no test
sleeps. `test_tuple_keys_are_distinct` is the cross-user isolation case.

#### `backend/tests/test_ratelimit.py` — 13 tests, 99 lines

`TestRateLimiter` (10): `test_rejects_nonsense_budgets`,
`test_allows_up_to_capacity`, `test_denies_past_capacity`,
`test_retry_after_matches_refill_rate` (asserts 20.0 s for a 3-per-60 s
bucket), `test_refills_over_time`, `test_refill_is_capped_at_capacity`,
`test_buckets_are_per_user`, `test_reset_restores_a_users_budget`,
`test_bucket_map_stays_bounded`, `test_evicted_bucket_starts_full_again`.
`TestRateLimiterRegistry` (3): `test_named_budgets_are_independent`,
`test_unknown_bucket_allows_through`, `test_clear_resets_every_limiter`.

#### `backend/tests/test_models.py` — 9 tests, 55 lines

`TestHintRequest` (5): `test_valid_full`, `test_defaults`,
`test_missing_question_raises`, `test_hint_level_below_min_raises`,
`test_hint_level_above_max_raises`. `TestHintResponse` (2): `test_valid`,
`test_empty_tags`. `TestHealthResponse` (1): `test_valid`. `TestUserBadges`
(1): `test_defaults` — the only reference anywhere to the unused `UserBadges`
model.

### Extension test files

#### `extension/src/__tests__/apiClient.test.ts` — 31 tests, 316 lines

`ApiClient.health` (2): `returns true when /health responds 200`,
`returns false when fetch throws (backend down)`.
`authenticated requests` (9): `attaches the Bearer token to /hint`,
`passes the tutor mode through to /hint`,
`retries once with a forced refresh on 401`,
`throws with backend detail on persistent failure`,
`sends POST /reset with no body fields`,
`fetches GET /badges with the Bearer token`,
`getBadges returns [] on error`,
`scanCode posts code and language only`,
`getLineHint posts code, line and language only`.
`parseSseChunk` (3): `parses complete events and keeps the remainder`,
`joins a previous partial buffer with the new chunk`,
`skips malformed json events`.
`availability tracking` (3): `flips to unavailable on network failure and notifies once`,
`recovers when a request succeeds`, `health() updates availability`.
`rate limiting` (7): `throws a RateLimitError from /hint`,
`carries the Retry-After value` (asserts 12), `falls back to a sane wait when the header is missing` (asserts 30),
`throws rather than silently degrading on /scan`,
`throws rather than silently degrading on /line-hint`,
`does not treat a 429 stream as a fallback-to-/hint case`,
`leaves the backend marked available — throttled is not down`.
`ApiClient.getTrace` (5): `returns the designed exercise`,
`sends the selection and language`, `degrades to an empty exercise on a backend error`,
`degrades to an empty exercise when the backend is unreachable`,
`degrades rather than throwing when throttled`.
`hint request fields` (2): `forwards escalate, edit_summary and confidence`,
`omits the new fields entirely when unset` — the backwards-compatibility case.

#### `extension/src/__tests__/streamHint.test.ts` — 15 tests, 215 lines

The SSE read loop in `ApiClient.streamHint`, which had no test before the
2026-08-06 audit: `fetch` is stubbed with a body whose reader yields scripted
chunks, so the tests can assert on the reader as well as on the result.

`streamHint` (15): `resolves with the hint and tags from the done event`,
`reports the level from meta, not the level the client asked with`,
`forwards every event to the callback in order`,
`reassembles an event split across two chunks`,
`handles several events arriving in one chunk`,
`skips a malformed frame rather than failing the stream`,
`throws the backend's message on an error event`,
`throws when the stream ends without a done event`,
`releases the reader on the happy path`,
`releases the reader when an error event throws`,
`throws a RateLimitError on 429 without opening a reader`,
`throws when the response carries no body`,
`abandons a stream that goes silent instead of hanging forever`,
`does not time out a slow stream that keeps producing`,
`sends problem_key so the ladder survives an edit`.

#### `extension/src/__tests__/pedagogy.test.ts` — 32 tests, 174 lines

`codeFingerprint` (2): `is stable for the same input`, `differs for different input`.
`frameExplainedQuestion` (1): `combines explanation and question`.
`questionForMode` (6): `frames translate input`, `returns empty for translate without input`,
`supplies canned question for reflect`, `supplies canned question for worked-example`,
`passes through student text unchanged for reflect answers`,
`returns empty for hint mode without input`.
`looksLikeErrorText` (8): six parameterised positive cases (Python traceback, a
Node stack trace, a Java `Exception in thread`, a C compiler error, a C# `error
CS1002`, `Segmentation fault`) plus `does not flag ordinary questions` and
`does not flag ordinary code`.
`framePrediction` (1): `includes snippet and prediction`.
`formatExceptionQuestion` (2): `includes description, frame and variables`,
`caps variables at 15`.
`frameTraceTable` (8): `renders a header row from the variable names`,
`numbers the rows from 1`, `marks blank cells so the tutor can see what they skipped`,
`marks whitespace-only cells as unanswered too`,
`fills in a short row rather than losing a column`, `survives a missing row`,
`includes the snippet being traced`, `ends by asking where the trace diverges`.
`frameSubgoalLabels` (2): `presents the labels as the student's own`,
`trims surrounding whitespace`.
`questionForMode with the new modes` (2): `frames subgoal labels`,
`returns nothing for empty subgoal labels`.

#### `extension/src/__tests__/markdown.test.ts` — 37 tests, 282 lines

Runs `media/markdown.js` through `new Function("window","document", src)`
against a hand-written DOM shim that implements only the six methods the
renderer touches, so these tests do not depend on the jsdom environment.

`paragraphs` (6): `wraps plain text in a paragraph`, `splits on a blank line`,
`keeps a soft line break inside a paragraph`, `renders nothing for empty input`,
`renders nothing for whitespace only`, `clears the container before rendering again`.
`emphasis` (12): `renders bold`, `renders underscore bold`, `renders italic`,
`leaves an underscore inside a name alone` (the `snake_case_name` case),
`leaves a lone asterisk alone` (`2 * 3 = 6`),
`leaves paired multiplication asterisks alone`,
`leaves an arithmetic sentence intact`,
`leaves paired standalone underscores alone`,
`does not open emphasis on a trailing asterisk`,
`still renders emphasis that hugs its content`,
`renders single-character emphasis`, `nests emphasis inside bold` — the six new
cases pin the flanking-delimiter rule the audit added.
`code` (6): `renders inline code`, `keeps markup inside inline code literal`,
`renders a fenced block`, `ignores the language tag on a fence`,
`closes an unterminated fence at the end of the text`,
`keeps prose around a fence in separate paragraphs`.
`lists` (6): `renders a bullet list`, `accepts asterisk bullets`,
`renders a numbered list`, `accepts the 1) form`,
`renders emphasis inside list items`, `separates a list from following prose`.
`links` (2): `keeps the label and drops the destination`, `leaves a bare url as text`.
`safety` (5): `never assigns markup as a string` (source-level regex check for
`.innerHTML =`, `insertAdjacentHTML`, `document.write`),
`renders markup in the model's output as literal text`,
`renders an img tag as literal text`,
`drops a javascript: destination and keeps only the label`,
`terminates on adversarial emphasis nesting` (2,000 asterisks under 2 s).

#### `extension/src/__tests__/attemptTracker.test.ts` — 25 tests, 167 lines

`summarizeEdit` (12): `returns nothing when the code is identical`,
`reports a changed line as a removal and an addition`, `numbers lines from 1`,
`reports a pure insertion with no removal line`,
`reports a pure deletion with no addition line`,
`ignores untouched surrounding lines`, `caps the number of reported lines`,
`truncates very long lines`, `never exceeds the size the backend accepts`
(asserts ≤ 2000 chars), `handles an empty starting file`,
`handles everything being deleted`,
`ignores trailing whitespace changes in the rendered text`.
`AttemptTracker` (10): `treats the first ask as a fresh start`,
`holds the level when nothing changed and no time passed`,
`escalates once the cooldown has elapsed`,
`escalates immediately when the code changed`, `keeps documents independent`,
`does not record on evaluate alone`, `forgets one document on clear(key)`,
`forgets everything on clear()`, `honours a custom cooldown`
(asserts the exact 4,999 / 5,000 ms boundary),
`re-records after each hint so the diff is always since the last one`.
`nudgeForUnchangedCode` (3): `tells the student what unlocks a deeper hint`,
`never counts down below one second`, `rounds part-seconds up`.

#### `extension/src/__tests__/localTutor.test.ts` — 22 tests, 128 lines

`matchLocalRule` (12): `catches assignment where a comparison belongs in Python`,
`catches a mutable default argument`, `catches loose equality in JavaScript`,
`catches unfreed memory in C`, `catches a comparison against NULL in SQL`,
`catches unwrap in Rust`, `falls back to shared rules for an unknown language`,
`ignores blank lines`, `returns undefined when nothing matches`,
`prefers the language rule over a shared one`, `never gives away a fix`
(every matched question ends in `?`),
`keeps questions short enough for an inline decoration` (≤ 14 words).
`localLineHint` (2): `returns the matching question and concept`,
`returns an empty hint when no rule fits`.
`localRuleCount` (1): `gives every supported language its own rules on top of the shared ones`.
`offlineTutorReply` (7): `says plainly that it is not the real tutor`,
`uses a matching rule from anywhere in the file`,
`falls back to a metacognitive prompt when nothing matches`,
`rotates the generic prompt so it does not repeat verbatim`,
`wraps a negative seed back into range`,
`always ends with the tutor's closing question`, `handles empty code`.

#### `extension/src/__tests__/progressPanel.test.ts` — 20 tests, 194 lines

`buildProgressHtml` (9): `renders stat tiles`, `renders badges`,
`renders struggle bars at the right width` (asserts `width="100"`),
`scales a partial struggle bar` (asserts `width="50"`),
`shows the review banner only when due`,
`escapes html in user-controlled fields`,
`escapes html in concept names and badges`,
`escapes quotes so attributes cannot be broken out of`,
`shows newest session summary first`.
`hint level distribution` (4): `says so when there are no hints yet`,
`renders one segment per level with percentages`,
`labels every level in text, not only by colour`,
`survives an all-zero distribution`.
`activity strip` (4): `prompts when there is no activity data`,
`draws one bar per day and counts the active ones`,
`marks empty days as idle`, `escapes dates coming back from the backend`.
`calibration` (3): `asks for more samples below the threshold`,
`reports the score once there is enough data`,
`handles an older backend that sends no calibration at all`.

#### `extension/src/__tests__/testWatcher.test.ts` — 17 tests, 49 lines

`TEST_COMMAND_RE` (13): nine positive cases (`pytest tests/`, `npm test`,
`npm run test`, `yarn test`, `python -m unittest discover`, `go test ./...`,
`cargo test`, `dotnet test`, `npx jest --watch`) and four negatives
(`npm install`, `git status`, `python main.py`, `ls -la`).
`appendBounded` (2): `keeps only the newest characters when over the cap`,
`appends normally under the cap`.
`failureTail` (2): `returns the last non-empty lines`, `drops blank lines`.

#### `extension/src/__tests__/statusBar.test.ts` — 12 tests, 60 lines

`renderStatus`: `names the extension even when there is nothing to report`,
`shows the hint depth once a hint has been given`,
`hides the depth before the first hint`, `clamps a depth beyond level 3`,
`shows a streak in days`, `omits a zero streak`,
`flags a due review with an icon`, `reports offline instead of a stale depth`,
`explains each part in the tooltip`, `uses the singular for a one-day streak`,
`invites the student to start a streak when there is none`,
`says why hints are local when offline`.

#### `extension/src/__tests__/securityInvariants.test.ts` — 10 tests, 112 lines

Source-level assertions, used because the hover and webview paths need more of
the VS Code API than the mock provides.
`hover markdown trust` (3): `never blanket-trusts a MarkdownString`,
`allow-lists only EduPeer's own commands`,
`does not expose the document-opening command to hover markdown`.
`sidebar webview policy` (4): `sets a content security policy with a script nonce`,
`does not allow inline styles`, `draws the nonce from a cryptographic source`,
`restricts webview resources to the media directory`.
`webview scripts` (1): `never assign markup as a string`.
`progress dashboard` (2): `blocks scripts outright in its content security policy`,
`escapes every interpolation of backend-supplied text`.

#### `extension/src/__tests__/languages.test.ts` — 10 tests, 79 lines

`language registry` (4): `supports the ten tutoring languages`,
`recognises supported languageIds`, `maps ids to display labels`,
`lists all labels for user-facing messages`.
`lensRegex definition detection` (6): one case each for Python, JavaScript,
Java, C (`function definitions but not calls or prototypes`), C++ and C#.
Go, Rust and SQL regexes are **not** covered by a detection test.

#### `extension/src/__tests__/authManager.test.ts` — 10 tests, 262 lines

`anonymous bootstrap` (3): `creates an anonymous account on first getIdToken and persists it`,
`reuses the cached idToken without another fetch`,
`refreshes via securetoken when force=true`.
`concurrent bootstrap` (1): `dedupes concurrent getIdToken calls into a single anonymous bootstrap`.
`applySignIn and migration` (4): `replaces the anonymous session and migrates its progress`,
`keeps the pending migration when the migrate call fails`,
`accumulates pending migrations across sign-in cycles for the same account`,
`does not replay a failed migration into a different account`.
`runPendingMigration token pruning` (1): `drops a permanently invalid old refresh token (4xx) and still runs the legacy-only migrate in the same pass`.
`signOut` (1): `clears the session and bootstraps a fresh anonymous account`.

#### `extension/src/__tests__/signInFlow.test.ts` — 15 tests, 153 lines

`parseCallbackPayload` (4): `parses a valid payload`,
`carries the state nonce through`,
`treats empty email/displayName as undefined`,
`throws on a payload missing required fields`.
`signInViaBrowser` (6): `opens the browser and resolves with the payload POSTed to /callback`,
`puts a 32-hex state nonce on the login url`,
`rejects a callback with no state`, `rejects a callback with the wrong state`,
`does not make non-callback responses cross-origin readable`,
`rejects after the timeout when no callback arrives`.
`stateMatches` (5): `accepts the exact nonce`,
`rejects a different nonce of the same length`,
`rejects a different length without throwing`, `rejects non-strings`,
`mints a fresh nonce each time`.

#### `extension/src/__tests__/offlineQueue.test.ts` — 4 tests, 56 lines

`enqueues and flushes a reset`, `newer goal replaces older queued goal`,
`failed items stay queued`, `flush with empty queue is a no-op`.

#### `extension/src/__tests__/firebaseClient.test.ts` — 3 tests, 38 lines

`delegates to ApiClient.getBadges`,
`returns empty array when ApiClient.getBadges returns empty`,
`propagates errors from ApiClient`.

#### `extension/src/__tests__/webviewMain.test.ts` — 79 tests, 683 lines

The webview controller (`media/main.js`), run under jsdom. The markup is **not**
duplicated in the test: it is extracted from the provider's own `getHtml()`
output, so if the HTML and the script drift apart these tests fail rather than
passing against a stale copy. `markdown.js` and `main.js` are then loaded with
`new Function`, and messages are delivered with a real `MessageEvent`.

`startup` (4): `tells the extension it is ready`,
`shows an invitation rather than a blank panel`,
`renders a placeholder when no file is open`,
`hides the hint stepper until a hint arrives`.
`restoring a transcript` (3): `rebuilds every stored turn`,
`falls back to the empty state when there is nothing stored`,
`drops the empty state once a turn arrives`.
`the code preview` (6): `renders one numbered row per line`,
`shows the file name without its directory`, `shows the language chip`,
`hides the chip for an unsupported language`,
`caps the preview and says how much it dropped` (201 rows at 260 lines),
`collapses and restores on the toggle`.
`rendering a hint` (8): `labels the depth in the eyebrow`,
`fills the stepper up to the current depth`, `renders concept tags`,
`renders markdown rather than raw text`,
`names the tutor move for a non-hint mode`,
`offers translation and worked-example actions at depth three`,
`offers step labelling after a worked example`,
`asks for a worked example when that action is clicked`.
`modes that withhold` (3): `flags the attempt gate and pulses the stepper instead of advancing`,
`flags a rate-limited reply`, `flags an offline nudge`.
`streaming` (4): `opens a bubble with a caret`, `appends each delta`,
`replaces the streaming bubble with the final hint`,
`removes the bubble when the stream is abandoned`.
`the composer` (7): `sends the typed question`, `clears the box after sending`,
`ignores an empty question`, `sends on ctrl+enter`,
`does not send on a bare enter`, `asks for a reflection quiz`,
`requests a reset`.
`confidence` (5): `marks the selected chip`,
`deselects when the same chip is clicked again`,
`rides along with the question`, `resets after sending`,
`is not sent for a non-hint mode`.
`guided exercises` (8): `shows the explain-first gate with a skip action`,
`sends the explanation rather than a new question`, `skips the gate on request`,
`sends a prediction rather than a question`,
`builds a trace grid of the requested size`,
`labels each cell for screen readers`, `submits the filled grid as rows`,
`removes the grid once submitted`.
`panel chrome` (9): `toggles the offline banner`,
`shows the thinking indicator and disables Ask while loading`,
`counts badges and lists them`, `uses the singular for one badge`,
`hides the disclosure when there are no badges`,
`switches the auth button between sign in and sign out`,
`asks to sign in when signed out`,
`reveals the review button and starts a review`,
`refreshes the active file on request`.
`errors and reset` (3): `renders an error turn`,
`clears the transcript and shows the session summary`,
`resets the stepper and the confidence chips`.
`persistence` (2): `mirrors every turn to the extension`,
`saves to webview state as well`.
`safety` (4): `renders a student turn as text, never as markup`,
`renders model output as text, never as markup`,
`renders a concept tag as text`, `renders a trace variable name as text`.
`the loading guard covers every entry point` (6): `disables the ask, quiz, reset and review buttons together`,
`re-enables them when the ask finishes`,
`ignores Ctrl+Enter while an ask is in flight`,
`ignores the reflection quiz button while an ask is in flight`,
`ignores reset while an ask is in flight`,
`still sends once the ask has finished`.
`stream sequencing` (7): `appends deltas that match the current stream`,
`ignores a delta from a superseded stream`,
`ignores an abort from a superseded stream`,
`removes the bubble on an abort of the current stream`,
`hides the streaming bubble from the live region`,
`marks the streaming body so raw text keeps its line breaks`,
`announces the finished turn normally`.

#### `extension/src/__tests__/sidebarProvider.test.ts` — 63 tests, 782 lines

Drives the provider through a fake `WebviewView`, recording everything it posts
and delivering webview messages back into it.

`startup` (3): `restores the persisted transcript, the file, badges, auth and offline state`,
`labels an anonymous session as not signed in`,
`surfaces the review button only when one is due`.
`the explain-first gate` (6): `intercepts the first question about a file`,
`proceeds when the student skips it`,
`folds the student's explanation into the question`,
`treats a blank explanation as a skip`, `does not fire twice for the same code`,
`does not gate non-hint modes`.
`the attempt gate` (9): `escalates the first ask`,
`refuses to escalate when nothing changed`,
`tells the student why they got the same depth`,
`escalates again once the code changes`, `sends a diff of what changed`,
`sends no diff when nothing changed`, `never gates a non-hint mode`,
`forgets the attempt record on reset`,
`re-arms the explain-first gate after any edit`.
`confidence` (5): `forwards the rating`, `survives the explain-first gate`,
`defaults to zero when not given`,
`clamps a value the webview should never send`, `clamps a negative value`.
`mode routing` (5): `detects a pasted stack trace and switches to explain-error`,
`does not gate a detected error, since it is no longer hint mode`,
`sends the language of the active file`, `caps the history it forwards`,
`ignores an empty question`.
`failure handling` (8): `falls back to the plain hint call when streaming breaks`,
`does not retry through an exhausted budget`,
`explains a 429 instead of showing an error`,
`answers locally when the backend is unreachable`,
`shows a real error when the backend is up but failing`,
`clears the streaming bubble before reporting a failure`,
`always stops the loading indicator`,
`does not advance the local hint level on failure`.
`streaming` (3): `forwards delta events to the webview`,
`opens a streaming bubble before the first delta`,
`publishes the hint level for the status bar`.
`the trace exercise` (5): `renders a grid when the backend designs one`,
`falls back to a prediction when there is nothing to trace`,
`falls back when the backend names too few variables`,
`submits the filled grid as a trace-check`,
`ignores a trace answer with no exercise pending`.
`prediction` (2): `frames the snippet and the prediction together`,
`ignores a blank prediction`.
`session reset` (5): `posts the summary the backend returned`,
`clears the persisted transcript`, `re-arms the explain-first gate`,
`resets the status-bar level`,
`queues the reset when the backend is unreachable`.
`persistence and plumbing` (7): `stores the transcript the webview sends`,
`keeps only the newest fifty turns`, `tolerates a persist message with no payload`,
`routes sign-in and sign-out to the commands`,
`re-reads the active file on request`, `ignores an unknown message type`,
`reports an unsupported language as no language`.
`the webview document` (5): `sets a content security policy with a per-load nonce`,
`does not permit inline styles`, `uses a different nonce each time it is built`,
`tags both scripts with the nonce`,
`restricts webview resources to the media directory`.

#### `extension/src/__tests__/inlineTutor.test.ts` — 39 tests, 451 lines

Exercises the providers through the registration recorder, the way VS Code
would call them, with fake timers driving the debounced scan.

`activation` (6): `registers a CodeLens, hover and code-action provider`,
`offers only Quick Fix code actions`, `registers its two commands`,
`creates a diagnostic collection named edupeer`,
`registers the providers for all ten languages`,
`disposes everything it created`.
`provideCodeLenses` (8): `puts a hint lens on every definition line`,
`passes the uri and line as command arguments`,
`returns nothing when inline hints are switched off`,
`returns nothing for an unsupported language`,
`shows a scan flag as its own lens`, `uses the palette emoji for a style flag`,
`never puts two lenses on the same line`,
`clamps a flag line past the end of the document`.
`provideCodeActions` (5): `always offers a nudge and an explanation`,
`offers a third action on a flagged line`,
`passes the flag range and question to discussLines`,
`never returns an action that edits the code`,
`returns nothing for an unsupported language`.
`provideHover` (5): `returns nothing when there is no hint and no flag`,
`shows the flag question and its concept`,
`allow-lists only EduPeer's own two commands`,
`never blanket-trusts the markdown`,
`returns nothing for an unsupported language`.
`scanning and diagnostics` (10): `publishes one diagnostic per flag`,
`maps warning flags to Warning and info flags to Information`,
`labels the diagnostic source and carries the concept as its code`,
`does not rescan unchanged code`, `rescans when the command forces it`,
`skips the automatic scan when autoScan is off`,
`survives a scan failure without throwing`,
`goes quiet for the Retry-After window after a 429`,
`tells the student when a flagged file becomes clean`,
`does not offer a quiz for a file that was never flagged`.
`line hints` (5): `asks the backend for the cursor line and renders it`,
`falls back to a local rule when the backend is unreachable`,
`falls back to a local rule when throttled`,
`shows nothing when the backend errors but is still reachable`,
`tells the student to open a supported file first`.

#### `extension/src/__tests__/extension.test.ts` — 34 tests, 444 lines

Calls `activate()` against a fake `ExtensionContext` with `global.fetch`
stubbed, then invokes each command through `__runCommand`.

`activate` (15): `registers every contributed command`,
`registers no commands beyond the expected set` (an exact-set assertion, so a
forgotten registration or a stray one both fail),
`registers the sidebar webview provider`, `keeps the webview alive when hidden`,
`creates a status bar item bound to the panel command`,
`puts everything it creates into the subscriptions`,
`warns when the backend cannot be reached and a tutored file is open`,
`names the configured backend url in the warning`,
`stays quiet in a window with no tutored file open`,
`warns later, once the student opens a tutored file`,
`warns at most once per session`,
`does not warn when the backend answers`,
`hides the status bar when no supported file is open`,
`shows the status bar for a supported file`, `deactivate is a no-op`.
`commands` (15): `opens the sidebar container`,
`tells the student to open a file before analysing a selection`,
`tells the student to select something before analysing`,
`tells the student to select code before predicting output`,
`tells the student to open a file before tracing`,
`says there is nothing to trace in an empty file`,
`asks for the error text when nothing is selected`,
`does nothing when the error prompt is dismissed`,
`prompts for a goal and reports the mapped concepts`,
`does nothing when the goal prompt is dismissed`,
`queues the goal when the backend is unreachable`,
`opens a webview panel for the progress dashboard`,
`creates the progress panel with scripts disabled`,
`reports a failure to load progress`,
`pulls the flagged lines into the panel for discussLines`.
`configuration changes` (4): `subscribes to configuration changes`,
`re-reads the backend url when it changes`,
`ignores changes to other settings`,
`retries the health check on a timer while offline`.

#### `extension/src/__tests__/debugCompanion.test.ts` — 15 tests, 208 lines

`registerDebugCompanion` (8): `registers a tracker factory for every debug type`,
`adds the tracker to the context subscriptions`,
`offers help when the program stops on an exception`,
`ignores a stop for any other reason`, `ignores non-stopped events`,
`ignores a malformed message without throwing`,
`offers only once per debug session`, `offers again for a different session`.
`accepting the offer` (7): `asks nothing when the student declines`,
`asks nothing when the notification is dismissed`,
`builds the question from the exception, frame and variables`,
`still asks when exceptionInfo is unsupported`,
`still asks when variables cannot be read`,
`reports an unknown location when there is no stack frame`,
`warns rather than throwing when the stack trace request fails`.

#### `extension/src/__tests__/auditRegressions.test.ts` — 26 tests, 454 lines

The extension-side companion to `backend/tests/test_audit_regressions.py`.
The suites next to it are organised by module; this one is organised by defect,
one describe block per behaviour the 2026-08-06 audit pinned shut.

`the attempt gate ignores whitespace-only edits` (5): `treats a trailing blank line as no attempt`,
`reports no edit summary for a whitespace-only change`,
`treats trailing spaces on an existing line as no attempt`,
`still counts a real edit as an attempt`,
`still escalates after the cooldown on unchanged code`.
`normalizeCode` (2): `matches the backend's notion of the same code`,
`is stable for identical input`.
`the hint ladder is keyed on the problem` (1): `sends the document uri as problem_key`.
`overlapping asks` (3): `refuses a second ask while one is in flight`,
`tags each stream with a sequence number`,
`accepts a new ask once the first finishes`.
`reset during an in-flight ask` (3): `drops the late response instead of re-seeding the cleared chat`,
`does not surface an error from an ask the student already reset`,
`still clears the loading state after a dropped response`.
`the webview view releases its listeners` (1): `disposes the editor listeners when the view goes away`.
`a failed scan is retried` (3): `does not suppress the next scan of the same content`,
`still de-dupes after a scan that succeeded`,
`retries after a 429 once the quiet window has passed`.
`per-file state is released when a document closes` (1): `forgets the file's scan state and diagnostics`.
`ghost hints do not linger in a split view` (1): `clears the decoration on every other visible editor`.
`a spaced-review exercise can be answered` (6): `marks the answer against the exercise, not the open file`,
`echoes the student's answer into the chat`, `ignores an empty answer`,
`ignores an answer with no exercise pending`,
`consumes the exercise so it cannot be answered twice`,
`does not advance the hint ladder`.

### Modules with no direct unit tests

| Module | Why | Indirect coverage |
| --- | --- | --- |
| `extension/media/style.css` | Not executable | Its class names are asserted throughout `webviewMain.test.ts`, so a rename that breaks the script is caught |
| `extension/src/firebaseClient.ts` | Has direct tests (100% covered) | — |

Every other module in `extension/src/` and `backend/` now has a dedicated test
file. `testWatcher.ts` is the weakest at 40% statement coverage: only its three
pure helpers are directly tested, because the shell-integration flow needs a
VS Code 1.93+ host.

---

## 17. Known issues and limitations

### TODO / FIXME / HACK comments

A repository-wide search of `backend/*.py`, `extension/src/*.ts`,
`extension/media/*.js` and `extension/media/*.css` for `TODO`, `FIXME`, `HACK`
and `XXX` returns exactly one hit, and it is not a marker:

- `extension/src/localTutor.ts:39` — the pattern `/\bTODO\b|\bFIXME\b/` inside a
  rule that flags such comments in *student* code.

There are no outstanding developer markers in the source.

### Defects

**1. `/hint/stream` reports LLM failures as HTTP 200.**
The generator is already streaming when the LLM call runs, so an exception
becomes an `error` event inside a 200 response (`backend/main.py:289-291`)
rather than the 502 that `/hint` returns. Any client that only inspects the
status code sees success. The extension does handle it
(`extension/src/apiClient.ts:355-357`).

**2. Conversation memory is not restored after a window reload.**
The rendered transcript is persisted to `globalState`
(`extension/src/sidebarProvider.ts:103-107`) and restored on `ready`
(`extension/src/sidebarProvider.ts:92-96`), but the `history` array that is
actually sent to the model (`extension/src/sidebarProvider.ts:34`, `445`) is a
plain in-memory field and is never persisted. After a reload the student sees
their previous conversation on screen while the tutor has no memory of it. A
follow-up like "I tried that" is answered blind.

**3. Session summaries may summarise the wrong interactions.**
No `firestore.indexes.json` exists, so the composite index for
`where("user_id","==") + order_by("timestamp", DESC)` is almost certainly
absent. The query then falls back to an unordered `limit(10)`
(`backend/firebase_service.py:469-470`), meaning the "what you learned this
session" note is built from ten arbitrary interactions rather than the ten most
recent. **UNVERIFIED** whether the index exists in the live Firebase project —
console state is not in the repository.

**4. The explain-first gate returns after every edit, not once per file.**
`seenFingerprints` is keyed on the code fingerprint
(`extension/src/sidebarProvider.ts:346-348`), not on the document, so any edit
produces a fingerprint the set has not seen and the gate fires again. Combined
with the attempt gate — which *requires* an edit before the level will advance
— the intended loop is: ask, explain, hint 1, edit, ask, **explain again**,
hint 2. The student meets the gate before every single hint.

Surfaced by
`sidebarProvider.test.ts::the attempt gate::re-arms the explain-first gate after any edit`,
which documents the behaviour rather than asserting it is correct. The README
previously described it as firing "the first time you ask about a file"; that
sentence has been corrected to describe what the code does. Changing the
behaviour (keying the set on the document URI instead) would be a one-line
change but is a pedagogical decision, not a bug fix, so it has been left alone.

**5. Account merge orphans data.**
`merge_user_sync` deletes the source `users` document
(`backend/firebase_service.py:566`) but leaves that uid's `interactions`
documents, `sessions` documents and `sessions_meta` document in place. They are
never read again and never cleaned up.

**6. Concurrent writes to the same user document can lose an update.**
`_update_user_and_award_badges_sync` is a read-modify-write with no transaction
(`backend/firebase_service.py:291`, `330`). Two hints answered at the same
moment can each read the same `total_interactions` and write the same
incremented value. The session store documents the same trade-off explicitly
(`backend/session_store.py:110-112`); the user document does not.

**7. Unbounded growth in three places.**
The `interactions` collection is append-only with no retention policy.
`concept_stats` and `concept_tags_seen` in the user document grow with the
number of distinct concepts and are never pruned; the whole `concept_stats` map
is rewritten on every interaction, so the write size grows over time.

**8. `UserBadges` is dead code.**
Defined at `backend/models.py:87-93`, imported by nothing except its own test.

**9. `_init_error` is written but never read.**
`backend/firebase_service.py:211`, `231`. Diagnostic information is captured
and then discarded.

**10. Three different code hashes now exist.**
The server has two: `code_fingerprint`, SHA-1 over whitespace-normalised code,
used as the hint ladder's fallback key (`backend/session_store.py:9-11`), and
`raw_code_hash`, an exact SHA-1 used by the two line-number caches
(`backend/session_store.py:14-23`). The client uses a 32-bit rolling hash with
no normalisation (`extension/src/pedagogy.ts:29-35`), plus `normalizeCode`
(`extension/src/attemptTracker.ts:107-113`), which reproduces the server's
normalisation without hashing. They serve different purposes and are never
compared, but the shared vocabulary invites confusion.

**11. The attempt gate is advisory.**
`escalate` is supplied by the client. A caller that always sends `true` gets
unrestricted escalation. This is by design — it is a pedagogical control, not a
security boundary — but it should not be described as enforced.

### Partially implemented features

| Feature | What works | What is missing |
| --- | --- | --- |
| Interaction logging | Every hint writes `code_snippet`, `language` and `confidence` to `interactions` | Nothing reads `code_snippet`, `language` or `confidence` back. There is no export, no analytics view and no instructor report. The data is collected but unused. |
| `edupeer.discussLines` | Registered, works, and is wired to a Quick Fix | Hidden from the palette (`extension/package.json:137-142`) and reachable only when a scan flag exists on the line. |
| Walkthrough media | Four markdown files render | They are hand-written ASCII/code samples, not screenshots. |
| Offline queue | `reset` and `goal` replay correctly | Hints, scans and line hints are never queued; work done offline beyond a local nudge is lost. |
| Local fallback tutor | 8–13 rules per language | Rules are regex-per-line only. No multi-line analysis, no awareness of the rest of the file, and coverage is thin for TypeScript (4), Java (4), C++ (4), Go (4), Rust (4) and C# (3). |
| Language support | Ten languages tutored | `lensRegex` detection is only unit-tested for six of the ten; TypeScript, Go, Rust and SQL regexes have no test. |

### Hard limits

| Limit | Value | Location |
| --- | --- | --- |
| Hint level ceiling | 3 | `backend/session_store.py:40`, `hinting_engine.py:513` |
| Conversation history sent | 6 turns (client and server, applied twice) | `sidebarProvider.ts:24`, `hinting_engine.py:215` |
| `edit_summary` size | 2,000 characters (422 above) | `backend/models.py:18`, `65` |
| Other request field sizes | 40,000 chars of code, 4,000 question, 512 `problem_key`, 500 goal (422 above) | `backend/models.py:23-26` |
| Edit-diff lines reported | 8, then a "… and N more" line | `attemptTracker.ts:19` |
| Edit-diff line length | 120 characters, then `…` | `attemptTracker.ts:18` |
| Hint cooldown | 45,000 ms | `attemptTracker.ts:13` |
| `/hint` and `/hint/stream` rate | 30 per 60 s per user | `backend/main.py:76` |
| `/scan` and `/line-hint` rate | 60 per 60 s per user | `backend/main.py:77` |
| `/trace` rate | 10 per 60 s per user | `backend/main.py:78` |
| `/reset` and `/goal` rate | 10 per 60 s per user (one shared `session` bucket) | `backend/main.py:79` |
| `/review` rate | 6 per 60 s per user | `backend/main.py:80` |
| Rate-limit bucket map | 5,000 users, LRU | `backend/ratelimit.py:17` |
| Scan cache | 300 s TTL, 1,000 entries | `backend/main.py:67` |
| Line-hint cache | 300 s TTL, 2,000 entries | `backend/main.py:68` |
| Profile cache | 60 s TTL, cleared wholesale above 5,000 entries | `backend/main.py:61`, `117-118` |
| In-memory session store | 10,000 entries, LRU | `backend/session_store.py:48` |
| Session idle lapse | 1,800 s, after which the next ask counts as a new session | `backend/session_store.py:29` |
| Firestore call timeout | 5.0 s | `backend/session_store.py:118` |
| Scan flags | 5 `bug` + 2 `style` | `hinting_engine.py:385`, `380` |
| Scan question length | 14 words | `hinting_engine.py:371` |
| Line-hint length | 14 words (despite the prompt asking for 12) | `hinting_engine.py:423` vs `178` |
| Trace variables | 2–4 | `hinting_engine.py:458`, `466` |
| Trace steps | 3–8 | `hinting_engine.py:208-209`, `468` |
| Trace variable name | 40 characters | `hinting_engine.py:207` |
| Trace prompt | 200 characters | `hinting_engine.py:465` |
| Goal concepts | 4 | `hinting_engine.py:500` |
| Concept tags per reply | 6 | `hinting_engine.py:554`, `305` |
| LLM max tokens | 400 hint/stream, 600 scan, 220 summary, 200 trace, 160 line-hint, 120 goal | `hinting_engine.py:573`, `598`, `348`, `485`, `445`, `418`, `494` |
| Stream holdback | 40 characters | `hinting_engine.py:578` |
| Session summaries stored | 20 (last 5 returned) | `firebase_service.py:486`, `progress.py:213` |
| Activity retention | 30 days stored, 14 shown | `firebase_service.py:151`, `progress.py:162` |
| Review window / cap | 3–7 days, 3 concepts | `progress.py:17-18`, `145` |
| Struggles / strengths shown | 5 each | `progress.py:48`, `61` |
| Calibration minimum | 4 samples | `progress.py:22` |
| Persisted chat turns | 50 | `sidebarProvider.ts:28` |
| Code preview lines | 200 | `main.js:27` |
| Debugger variables sent | 15 | `pedagogy.ts:129` |
| Test output buffered | 8,000 chars, last 40 non-blank lines sent | `testWatcher.ts:5-6` |
| Test-failure offer cooldown | 30,000 ms | `testWatcher.ts:4` |
| Sign-in timeout | 300,000 ms | `signInFlow.ts:6` |
| Health retry interval | 30,000 ms | `extension.ts:16` |
| Scan debounce | 3,500 ms fixed | `inlineTutor.ts:363` |
| Line-hint debounce | `edupeer.debounceMs`, floored at 600 ms | `inlineTutor.ts:250` |
| Markdown inline-parse guard | 500 iterations | `markdown.js:39` |

### Local-development-only concerns

| Concern | Detail |
| --- | --- |
| Default backend address | `http://localhost:8000` (`extension/package.json:198`). Nothing is deployed; the student must run uvicorn themselves. |
| CORS | `allow_origins=["*"]` (`backend/main.py:50`). Acceptable for localhost, too permissive for a public deployment. |
| Plain HTTP | The sign-in page POSTs Firebase tokens to `http://127.0.0.1:{port}/callback` (`backend/static/auth.html:72`). Loopback so nothing crosses the network, but the pattern assumes VS Code and the browser share a machine. Remote/SSH/Codespaces sessions would break the callback. **UNVERIFIED** — not tested in a remote configuration. |
| Single process | The rate limiter, both response caches and the profile cache are per-process (`backend/ratelimit.py:7-8`, `backend/cache.py:8-9`). Running uvicorn with `--workers > 1` would give each worker its own, multiplying the effective rate limit by the worker count and reducing cache hit rate. |
| Service-account credentials | Loaded from `.env` into the process. There is no secret manager integration. |
| `vsce` warnings | Packaging warns that `package.json` has no `repository` field and that no LICENSE file is present in `extension/`. Neither blocks packaging. |
| Publisher id | `"publisher": "edupeer"` (`extension/package.json:6`) is a placeholder; no publisher account is configured. |

### Model and cost constraints

The system depends on the Groq free tier for `llama-3.3-70b-versatile`. The
caches and rate limits exist specifically to stay inside it
(comments at `backend/main.py:64-66`, `70-73`, `backend/ratelimit.py:3-5`). There
is no retry, no backoff and no secondary model: a Groq outage means every
tutoring call returns 502 or an `error` event, and the extension falls back to
its local rules only when it believes the backend is unreachable — an HTTP 502
does **not** trigger the local tutor (`extension/src/sidebarProvider.ts:512`
checks `api.isAvailable`, which a 502 leaves `true`). A Groq outage therefore
surfaces to the student as a raw error message.

---

## 18. Discrepancies against the original proposal

Each claim from the Investigation Report was checked against the code.

### Claim 1 — "The system uses GPT-4o for feedback generation, with Llama 3 as a secondary model."

**Status: does not hold. Changed.**

Evidence: `MODEL_NAME = "llama-3.3-70b-versatile"`
(`backend/hinting_engine.py:212`) is the only model identifier in the
repository and is used for every call (`backend/hinting_engine.py:224`, `597`).
A case-insensitive search for `openai`, `gpt-`, `gpt4` and `anthropic` across
`backend/*.py`, `extension/src/*.ts`, `backend/requirements.txt` and
`extension/package.json` returns no matches. There is no OpenAI SDK in
`requirements.txt` and no API key for one in `.env.example`.

The built system uses **one** model, Llama 3.3 70B, served by Groq
(`groq==0.11.0`, `backend/requirements.txt:3`). There is no primary/secondary
arrangement and no fallback model of any kind. The report should describe a
single-provider design and, if the proposal is quoted, explain the change: Groq
is free at the tier used, which is what made the rate limits and caches
worthwhile rather than a paid-API cost-control problem.

### Claim 2 — "The system supports Python only."

**Status: does not hold. Scope expanded.**

Evidence: ten languages are registered (`backend/languages.py:18-115` and
`extension/src/languages.ts:16-57`): Python, JavaScript, TypeScript, Java, C,
C++, C#, Go, Rust and SQL. Each has its own display name, code-fence tag and
concept list. Thirteen aliases normalise to them (`backend/languages.py:119-133`).
Language reaches the model in three places: the system prompt's `{language}`
substitution, the code fence, and the concept list offered for tagging.

Python remains the **default and the fallback**: `DEFAULT_LANGUAGE = "python"`
(`backend/languages.py:117`) and any unknown or empty value silently normalises
to it (`backend/languages.py:136-144`).

### Claim 3 — "The prototype achieves 80% unit test coverage."

**Status: holds, and is now measurable.**

Coverage tooling was absent when this document was first written, so the claim
could not be checked. It has since been installed and run:

| Suite | Measured | Against the 80% claim |
| --- | --- | --- |
| Backend source statements | **93%** (1,102 / 1,181) | Exceeds |
| Extension source statements | **89.45%** | Exceeds |
| Extension source lines | **90.99%** | Exceeds |
| Extension source branches | 78.23% | Below, if the claim is read as branch coverage |

Both figures exceed 80% on the statement and line measures that "unit test
coverage" normally denotes. Branch coverage on the extension is 78.23%, so if
the report wants a single defensible number, quote statements or lines and say
which.

Reproduce with:

```
cd backend && .venv/Scripts/python.exe -m pytest --cov=auth --cov=cache \
  --cov=firebase_service --cov=hinting_engine --cov=languages --cov=main \
  --cov=models --cov=progress --cov=ratelimit --cov=session_store
cd extension && npm run test:coverage
```

Two honest caveats: `media/main.js` and `media/markdown.js` contribute no
percentage because istanbul cannot instrument code loaded through
`new Function`, and `testWatcher.ts` sits at 40% because its shell-integration
path needs a VS Code 1.93+ host.

Test totals: **962 tests across 34 files, all passing** (438 backend,
524 extension).

### Claim 4 — "Feedback relevance is evaluated at 90% accuracy against expert review."

**Status: never implemented.**

Evidence: there is no evaluation harness, no rubric, no rating scale, no
annotated corpus and no results file anywhere in the repository. A search for
files matching `*eval*`, `*participant*` and `*stud*` outside `node_modules`,
`.venv` and `.git` returns nothing. The `interactions` collection stores the
raw material an evaluation would need (`question`, `hint_level_used`,
`concept_tags`, `code_snippet`, `confidence`) but nothing reads it back.

If Chapter 5 needs an evaluation, it has to be run separately; this repository
provides the data model for one, not the study.

### Claim 5 — "The system is evaluated with 30 to 50 novice participants."

**Status: never implemented.**

Evidence: no participant data, consent material, questionnaire, study protocol
or results exist in the repository. The system is single-user by construction:
every query is scoped to one uid, there is no cohort concept, no instructor
view and no aggregate reporting across users. **UNVERIFIED** whether a study
was run outside the repository — nothing in the codebase would record it.

### Claim 6 — "The extension is published to the VS Code Marketplace."

**Status: does not hold.**

Evidence: `extension/package.json:6` sets `"publisher": "edupeer"`, which is a
placeholder rather than a registered publisher id. There is no `repository`
field, which `vsce` warns about at package time. The only packaging script is
`"package": "vsce package --no-dependencies"` (`extension/package.json:225`) —
`vsce publish` appears nowhere, and there is no CI workflow, no
`.vscodeignore` exclusion suggesting a release pipeline, and no PAT
configuration. The build produces a local `.vsix` (gitignored via
`.gitignore:28`) intended for "Install from VSIX…".

**UNVERIFIED**: whether an extension named EduPeer exists on the Marketplace —
that cannot be checked from the repository. Nothing in the code supports a
publication claim.

### Claim 7 — "Firebase is used for session management."

**Status: holds.**

Evidence: `FirestoreSessionStore` (`backend/session_store.py:107-241`) stores
hint levels in a `sessions` collection keyed on `sha1(uid + ladder_key)` and
the open-session flag in `sessions_meta` keyed by uid. `build_session_store`
selects it whenever Firestore initialised successfully
(`backend/session_store.py:244-249`). Session state therefore survives a
backend restart, which is the stated reason for the design
(`backend/session_store.py:60`).

Firebase also does more than the proposal claimed: authentication
(`backend/auth.py`, anonymous and federated sign-in) and all progress
persistence (`users`, `interactions`).

The one qualification: when Firestore is unconfigured the system silently falls
back to `InMemorySessionStore`, so "Firebase is used for session management" is
true of the intended configuration, not guaranteed of every run.

### Other divergences a proposal reader would not expect

| Divergence | Detail |
| --- | --- |
| Hints are gated on attempting | The proposal describes a progressive hint ladder. The built system refuses to escalate when the student has not edited the code within 45 s (Section 12), which materially changes the interaction. |
| Ten tutor modes, not one | Beyond progressive hints there are nine further modes (Section 7), including a desk-check trace exercise and sub-goal labelling of worked examples. |
| Confidence calibration | Students optionally self-rate before each hint and the dashboard reports how well that matched the help they needed. Not in the proposal. |
| Streaming | Hints stream over SSE with a plain-POST fallback. Not in the proposal. |
| An offline tutor exists | 52 hand-written rules (5 shared plus 47 language-specific) answer when the backend is unreachable (Section 15). |
| Anonymous-first accounts | The proposal implies sign-in; the built system creates an anonymous Firebase account silently on first use and only merges into a named account if the student signs in. |
| No deployment | Everything runs locally. There is no hosted backend, no container definition, no CI and no deployment configuration in the repository. |
| The extension carries zero runtime dependencies | Everything is bundled by esbuild; the packaged `.vsix` is around 35 KB. |

---

## 19. Sample code candidates

Eight extracts, each quoted exactly as it appears in the file.

### 19.1 The line diff — `extension/src/attemptTracker.ts:60-86`

**Why it is interesting.** This is the piece that lets the tutor answer "I
tried that and it still fails" against the real edit. The difficulty is that a
proper diff algorithm (Myers) is far more code than the pedagogy needs, so this
trades exactness for a dependency-free implementation: trim the common prefix,
trim the common suffix, and report whatever span is left.

**What a reader needs to know.** `start` walks forward while both files agree;
`endA`/`endB` walk backward while they agree. Whatever lies between is reported
as removals then additions. Line numbers are 1-based and taken from each file's
own indexing, so a removal and its replacement can carry the same number.

```typescript
  if (before === after) return "";

  // An empty document is zero lines, not one blank one — otherwise creating a
  // file from scratch reports a phantom "1 - " deletion.
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const entries: string[] = [];
  for (let i = start; i <= endA; i++) {
    entries.push(`${i + 1} - ${clip(a[i])}`);
  }
  for (let i = start; i <= endB; i++) {
    entries.push(`${i + 1} + ${clip(b[i])}`);
  }
  if (entries.length === 0) return "";
```

### 19.2 The attempt gate — `extension/src/attemptTracker.ts:129-152`

**Why it is interesting.** This is the pedagogical centre of the project: the
decision to *withhold* escalation. It encodes the distinction between a student
who has tried something, a student who is sitting and thinking, and a student
bottoming out the hint ladder.

**What a reader needs to know.** `evaluate` is deliberately read-only; `record`
is called separately, and only after a hint actually arrives
(`extension/src/sidebarProvider.ts:469-472`), so a failed request never
consumes the student's attempt. The four return shapes drive both the
`escalate` flag sent to the server and the message shown locally. The comparison
runs through `normalizeCode`, so a stray blank line or trailing space is not an
attempt — the same normalisation the server's `code_fingerprint` applies.

```typescript
  evaluate(key: string, code: string, now: number = Date.now()): AttemptEvaluation {
    const previous = this.attempts.get(key);
    if (!previous) {
      return { signal: "first", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
    }
    if (normalizeCode(previous.code) !== normalizeCode(code)) {
      return {
        signal: "changed",
        escalate: true,
        editSummary: summarizeEdit(previous.code, code),
        cooldownRemainingMs: 0,
      };
    }
    const elapsed = now - previous.at;
    if (elapsed < this.cooldownMs) {
      return {
        signal: "unchanged",
        escalate: false,
        editSummary: "",
        cooldownRemainingMs: this.cooldownMs - elapsed,
      };
    }
    return { signal: "stalled", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
  }
```

### 19.3 Concept-tag extraction — `backend/hinting_engine.py:307-322`

**Why it is interesting.** Getting structured metadata out of a free-text model
reply without a second API call. The model is asked to append
`[concepts: a, b]`; this strips it before the student sees it and captures the
tags in the same pass.

**What a reader needs to know.** `re.sub` with a *function* replacement does
two jobs at once — the return value `""` deletes the match, and the side effect
collects the tags. It handles more than one tag line because `re.sub` replaces
every occurrence. The tags returned here are unvalidated; filtering happens in
`_finalize_hint`.

```python
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
```

### 19.4 Streaming without leaking the footer — `backend/hinting_engine.py:602-615`

**Why it is interesting.** The concept-tag footer is appended by the model at
the *end* of its reply, but streaming shows text as it arrives — so a naive
implementation flashes `[concepts: loops, off-by-one]` in the student's face
before deleting it. The fix is a holdback window.

**What a reader needs to know.** `full` accumulates everything; `emitted`
tracks how much has been sent. Only text older than the last 40 characters is
ever emitted, so the footer (which is shorter than 40 characters in practice)
never escapes. The complete, cleaned text is delivered once in the `done` event.

```python
        full = ""
        emitted = 0
        for chunk in stream:
            try:
                delta = chunk.choices[0].delta.content or ""
            except (AttributeError, IndexError):
                continue
            full += delta
            safe_len = max(0, len(full) - self.STREAM_HOLDBACK_CHARS)
            if safe_len > emitted:
                yield {"type": "delta", "text": full[emitted:safe_len]}
                emitted = safe_len
        hint_text, tags = self._finalize_hint(full, code, question, language, mode)
        yield {"type": "done", "hint": hint_text, "concept_tags": tags}
```

### 19.5 Validating model-designed exercises — `backend/hinting_engine.py:449-469`

**Why it is interesting.** The model is asked to design a desk-check exercise
and return JSON. Everything it says has to be treated as untrusted: variable
names go into the UI, the step count sizes a grid. This is the whole trust
boundary in one function.

**What a reader needs to know.** `_TRACE_VAR_RE` is
`^[A-Za-z_][A-Za-z0-9_\[\]\.]*$` — it accepts `arr[0]` and `obj.count` but
rejects prose. The final guard is the important one: fewer than two usable
variables, or no prompt, means the exercise is abandoned entirely and the
caller silently falls back to a free-text prediction.

```python
        raw_vars = data.get("variables")
        variables: List[str] = []
        for name in raw_vars if isinstance(raw_vars, list) else []:
            text = str(name).strip()
            if not text or len(text) > MAX_TRACE_VARIABLE_CHARS:
                continue
            if not self._TRACE_VAR_RE.match(text) or text in variables:
                continue
            variables.append(text)
        variables = variables[:4]

        try:
            steps = int(data.get("steps", 0))
        except (TypeError, ValueError):
            steps = 0

        prompt = " ".join(str(data.get("prompt", "")).split())[:200]
        if len(variables) < 2 or steps <= 0 or not prompt:
            return [], 0, ""
        steps = max(MIN_TRACE_STEPS, min(MAX_TRACE_STEPS, steps))
        return variables, steps, prompt
```

### 19.6 The token bucket — `backend/ratelimit.py:34-55`

**Why it is interesting.** The whole quota-protection mechanism in twenty
lines, with no background timer and no scheduled refill. Tokens are computed
lazily from elapsed time at the moment of the request.

**What a reader needs to know.** A bucket that has never been seen starts full
(`self.capacity`). `retry_after` is the wait for *one whole* token, not for a
full bucket. The clock is `time.monotonic()`, so a system clock change cannot
grant or deny budget. LRU eviction past `MAX_BUCKETS` is safe because an
evicted user simply starts full again — eviction can never deny a request.

```python
    def check(self, key: str) -> Tuple[bool, float]:
        """Try to spend one token.

        Returns (allowed, retry_after_seconds). retry_after is 0.0 when
        allowed, and otherwise the wait until one whole token is available.
        """
        now = self._now()
        tokens, last_seen = self._buckets.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last_seen) * self._refill_rate)

        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, now)
            allowed, retry_after = True, 0.0
        else:
            self._buckets[key] = (tokens, now)
            allowed = False
            retry_after = round((1.0 - tokens) / self._refill_rate, 3)

        self._buckets.move_to_end(key)
        while len(self._buckets) > MAX_BUCKETS:
            self._buckets.popitem(last=False)
        return allowed, retry_after
```

### 19.7 Safe Markdown rendering — `extension/media/markdown.js:39-66`

**Why it is interesting.** Model output is rendered into a webview. Using
`innerHTML` would let a model that had been steered by a hostile file inject
markup. This renderer never produces an HTML string at all — it builds DOM
nodes, so anything that looks like a tag lands as text.

**What a reader needs to know.** The loop finds the *earliest* match across all
inline rules, which is what makes precedence work: code before emphasis, bold
before italic on a tie. `guard` bounds the loop against adversarial input. The
recursion on `inner` is what allows `**very *very* bold**` to nest.

```javascript
    while (rest && guard++ < 500) {
      let best = null;
      for (const rule of INLINE) {
        const match = rule.re.exec(rest);
        if (match && (best === null || match.index < best.match.index)) {
          best = { rule, match };
        }
      }
      if (!best) break;

      const { rule, match } = best;
      if (match.index > 0) {
        parent.appendChild(document.createTextNode(rest.slice(0, match.index)));
      }
      const inner = match[1];
      if (rule.tag === null) {
        appendInline(parent, inner);
      } else {
        const el = document.createElement(rule.tag);
        if (rule.recurse) {
          appendInline(el, inner);
        } else {
          el.textContent = inner;
        }
        parent.appendChild(el);
      }
      rest = rest.slice(match.index + match[0].length);
    }
```

### 19.8 The streak rule — `backend/firebase_service.py:77-87`

**Why it is interesting.** Small, but it is the gamification rule most likely
to be questioned in a viva, and it has a non-obvious branch: a same-day repeat
must not increment, and a gap must reset to 1 rather than 0.

**What a reader needs to know.** Dates are ISO strings compared for equality,
not parsed. `max(1, ...)` on the same-day branch protects against a stored
`streak_days` of 0. All dates are UTC, so the streak boundary is midnight UTC
regardless of the student's timezone.

```python
def _update_streak(
    last_active_date: Optional[str], streak_days: int, today: date
) -> Tuple[str, int]:
    """Return (new last_active_date, new streak_days) for an activity today."""
    today_iso = today.isoformat()
    if last_active_date == today_iso:
        return today_iso, max(1, int(streak_days or 0))
    yesterday_iso = (today - timedelta(days=1)).isoformat()
    if last_active_date == yesterday_iso:
        return today_iso, int(streak_days or 0) + 1
    return today_iso, 1
```

---

## 20. Screenshot checklist

Setup assumed for every entry below: backend running
(`cd backend && uvicorn main:app --reload`), extension launched with **F5** from
the repository root — the tracked `.vscode/launch.json` resolves
`${workspaceFolder}/extension`, so opening `extension/` directly will not find
it — to open an Extension Development Host, and a demo file open. `demos/` holds one deliberately buggy sample per supported language,
including `demos/demo.py`.

### Interface design — core states

| # | What to capture | How to reproduce |
| --- | --- | --- |
| 1 | **Empty sidebar / first-run state** | Fresh profile. Click the EduPeer icon in the Activity Bar with no prior conversation. Shows the "Stuck on something?" invitation, the code preview, the confidence chips and the composer. Hint-depth stepper is hidden. |
| 2 | **Code preview with line numbers** | Open `demos/demo.py`. The file card shows the filename, the language chip ("Python"), Hide/Refresh buttons, and up to 200 numbered lines. |
| 3 | **Collapsed code preview** | Click **Hide** in the file card. Button text becomes "Show". Useful for showing how the panel adapts once a conversation is under way. |
| 4 | **Explain-first gate** | With `demos/demo.py` open and no prior question about it, type a question and press **Ask**. Before any hint, the panel shows the "Explain first" turn with a "Skip and get my hint" action row and the composer placeholder changes to "Type what you think the code does…". |
| 5 | **Confidence chips selected** | Click **Some idea** before asking. The chip fills with the button colour and `aria-pressed` becomes true. Capture before pressing Ask, since the selection resets on send. |
| 6 | **Level 1 hint with concept tags** | Answer or skip the gate. The tutor turn shows the eyebrow "Hint 1", the rendered reply, and `#`-prefixed concept tags underneath. The stepper shows segment 1 filled. |
| 7 | **Level 2 hint** | Edit any line of `demos/demo.py`, then ask again. Eyebrow reads "Hint 2"; two stepper segments are filled and the second is a blend toward the warning colour. |
| 8 | **Level 3 hint with pseudocode and action rows** | Edit again and ask a third time. Eyebrow "Hint 3", all three segments filled with the third in the warning colour, pseudocode rendered in a fenced code block, and an action row offering "Submit my translation" and "Show a worked example". This is the best single screenshot for the Markdown rendering work. |
| 9 | **Streaming in progress** | Ask any question and capture within the first second: the tutor bubble is being filled and a blinking caret follows the text. Timing-sensitive; a screen recording is easier than a still. |
| 10 | **Badge disclosure expanded** | Ask at least one question (awards "First Question"), then click the badge summary in the header to expand the list. |

### Tutoring modes

| # | What to capture | How to reproduce |
| --- | --- | --- |
| 11 | **Worked example with unlabelled numbered steps** | Reach level 3, then click "Show a worked example". Follow with the "Label the steps" action row that appears beneath it. |
| 12 | **Sub-goal labelling feedback** | Click "Label the steps", type labels such as "1. sets up the counter, 2. adds each item", press Ask. Eyebrow reads "Step labels". |
| 13 | **Desk-check trace grid, empty** | Select a loop in `demos/demo.py` (for example the `for` loop in `average`), right-click → **EduPeer: Trace This Code**. Capture the grid with its column headers and blank inputs before filling anything in. |
| 14 | **Desk-check trace grid, filled** | Fill in a few cells, leave one blank deliberately, and capture before clicking "Check my trace" — the blank cell demonstrates the `?` handling. |
| 15 | **Trace marked** | Click "Check my trace". Eyebrow reads "Trace check" and the reply names the first diverging row. |
| 16 | **Predict-the-output exercise** | Select a small expression and run **EduPeer: Predict the Output**. The composer placeholder becomes "Type your prediction…". |
| 17 | **Reading an error** | Run **EduPeer: Explain This Error** and paste a Python traceback into the input box; or simply paste a traceback into the composer, which auto-detects it. Eyebrow reads "Reading the error". |
| 18 | **Reflection quiz** | Click **I fixed it**. Eyebrow reads "Reflection" and the composer placeholder becomes "Type your answer to the quiz question…". |
| 19 | **Spaced review available** | Requires a `users` document whose `concept_stats` contains a concept with `last_struggled` 3–7 days ago. Either wait, or edit the field directly in the Firebase console. The **Review** button appears in the file card; clicking it produces a "Review" turn. |

### In-editor surfaces

| # | What to capture | How to reproduce |
| --- | --- | --- |
| 20 | **CodeLens above a definition** | Open `demos/demo.py` and wait. A "💡 Get a hint" lens appears above each `def`/`class`. Set `editor.codeLensFontSize` to 16 (already in `.vscode/settings.json`) for legibility. |
| 21 | **Scan flags as CodeLens questions** | Wait ~3.5 s after opening a demo file. Flagged lines get a "🤔 <question>" lens instead of the generic one; style flags use 🎨. |
| 22 | **Problems panel** | With flags present, open the Problems panel (Ctrl+Shift+M). Entries show source "EduPeer", the question, and the concept as the diagnostic code. |
| 23 | **Inline ghost text on the active line** | Click into a line and wait for the debounce (1.8 s default). Italic grey text appears at the end of the line, prefixed 💡. |
| 24 | **Hover card** | Hover a flagged line. Shows "EduPeer", the line hint, the flag question, the concept, and the two command links. |
| 25 | **Quick Fix lightbulb** | Put the cursor on a flagged line and press Ctrl+. — three actions: "nudge me on this line", "explain this line", and "talk through …". |
| 26 | **Gutter / overview ruler marks** | Capture the right-hand overview ruler with both an info and a warning flag present. |
| 27 | **Status bar item** | Bottom-left, after at least one hint: `EduPeer hint 2/3 6d` with the history icon if a review is due. Hover for the tooltip. |
| 28 | **Getting-started walkthrough** | Command palette → "Welcome: Open Walkthrough" → "Get started with EduPeer". Capture the four steps. |

### Dashboard

| # | What to capture | How to reproduce |
| --- | --- | --- |
| 29 | **Progress dashboard, populated** | Run **EduPeer: Show My Progress** after several sessions. Shows stat tiles, the hint-depth stacked bar with its text legend, the 14-day activity strip, calibration, concept bars, goal, badges and session notes. |
| 30 | **Dashboard in a light theme** | Same, with a light colour theme active — evidence that the VS Code token approach works in both. |
| 31 | **Dashboard in a high-contrast theme** | Same again under "Dark High Contrast". |
| 32 | **Calibration with enough data** | Requires ≥ 4 rated hints. Rate confidence before at least four questions, then open the dashboard. |
| 33 | **Session summary note** | Ask several questions, then run **EduPeer: Reset Session**. The three-bullet note appears both in the panel and afterwards under "Session notes" on the dashboard. |

### Failure, empty and edge states

These matter for Chapter 6 and are easy to forget.

| # | What to capture | How to reproduce |
| --- | --- | --- |
| 34 | **Offline banner** | Stop the uvicorn process, then type in a supported file or ask a question: the first failed call flips the client offline and the banner appears — "Backend unreachable — retrying. Nudges are local for now." The 30 s health timer only probes once the client already believes it is down (`extension.ts:63-67`), so nothing happens until a real call fails. |
| 35 | **Offline local nudge** | With the backend stopped, ask a question. The reply carries the eyebrow "Offline nudge", is styled with the warning rule, and begins "EduPeer is offline, so here is a general nudge rather than a real hint." |
| 36 | **Offline warning notification** | Start the Extension Development Host with the backend already stopped **and a supported file open** — the toast is suppressed when no tutored file is active, and fires at most once per session (`extension.ts:86-102`). It names the unreachable URL and the uvicorn command. |
| 37 | **Status bar offline** | Same conditions as 34: the status bar item reads "offline" on a warning background. |
| 38 | **Attempt gate — "Same depth"** | Ask a question, then immediately ask again without editing anything. A warning-styled turn with eyebrow "Same depth" explains that editing (or waiting 45 s) unlocks a deeper hint, and the stepper pulses instead of advancing. |
| 39 | **Rate limited** | Send 31 hint requests inside a minute. The 31st produces a turn with eyebrow "Slow down". Practical approach: temporarily lower the `hint` budget in `backend/main.py:76` for the screenshot, or script the requests. |
| 40 | **A scan that finds nothing** | Open a small, correct file (write a three-line clean function). After the scan there are no flags, no Problems entries and only the generic "💡 Get a hint" lenses. |
| 41 | **Reflection offer after a clean scan** | Fix every flagged issue in a demo file and wait for the rescan. A notification asks "your file scans clean now. Want a quick reflection quiz on the fix?" with "Quiz me" / "Not now". |
| 42 | **Empty dashboard for a new user** | Sign out (which creates a fresh anonymous account), then open the dashboard immediately. Every section shows its empty-state copy, including "No hints yet, so there's no depth to report" and the calibration prompt showing "(0 so far)". |
| 43 | **Not-signed-in header** | Fresh anonymous profile: the header reads "Not signed in" with a "Sign in" button. |
| 44 | **Signed-in header** | After completing sign-in: the header shows the display name or email, and the button reads "Sign out". |
| 45 | **Browser sign-in page** | Run **EduPeer: Sign In**. Capture the served page with its Google, GitHub and email options, and the "New here? Create an account" toggle. |
| 46 | **Sign-in success card** | Complete a sign-in. The page swaps to "You're signed in ✔ — Return to VS Code". |
| 47 | **Invalid sign-in link** | Open `http://localhost:8000/auth/login` directly with no `port` query parameter. The page shows "Sign-in link is invalid". |
| 48 | **Sign-in timeout** | Run **EduPeer: Sign In** and leave the browser untouched for five minutes. An error notification reads "Sign-in timed out — no response from the browser." Slow to capture; consider lowering `DEFAULT_TIMEOUT_MS` temporarily. |
| 49 | **Goal set confirmation** | Run **EduPeer: Set Learning Goal**, type "get comfortable with recursion". The notification names the mapped concepts. |
| 50 | **Goal queued while offline** | Stop the backend, then set a goal. The notification reads "backend unreachable — goal saved locally and will sync later." |
| 51 | **Unsupported file** | Open a `.md` or `.txt` file. The language chip disappears, the status bar item hides, and no CodeLens or diagnostics appear. |
| 52 | **Debugger companion offer** | `demos/demo.py` as shipped never raises, so add a call that does (`print(average([]))` gives a `ZeroDivisionError`), start debugging with "Python: Current File" and uncaught exceptions enabled, and let it stop. The companion only reacts to a `stopped` event whose reason is `exception` (`debugCompanion.ts:18-26`). A notification offers "Talk it through". |
| 53 | **Test-run companion offer** | Requires VS Code 1.93+ with shell integration. Run `pytest` in the integrated terminal on a failing test. A notification offers to talk through the failure. |
| 54 | **Chat restored after reload** | Hold a conversation, then run "Developer: Reload Window". The transcript reappears. Worth pairing with a note that the model's own memory does not survive (Section 17, defect 2). |

---

## UNVERIFIED items

Everything below could not be established from the repository and needs
checking before it appears in the report.

1. **Minimum required Python and Node versions.** Nothing in the repository
   declares them. Only the development machine's versions are known
   (Python 3.12.10, Node v22.19.0).
2. **`GET /auth/login` behaviour when `static/auth.html` is missing.** Inferred
   to be a 500 from the unguarded `open()` at `backend/main.py:141`; not
   reproduced.
3. **Whether the Firestore composite index for
   `(user_id ASC, timestamp DESC)` exists.** No `firestore.indexes.json` is in
   the repository and console state cannot be inspected from it. If absent, the
   session summary is built from ten arbitrary interactions rather than the ten
   most recent.
4. **Whether a participant evaluation was ever run.** Nothing in the repository
   would record it, and no study artefacts exist.
5. **Whether an extension named EduPeer exists on the VS Code Marketplace.**
   Not checkable from the repository; nothing in the code supports a
   publication claim.
6. **Whether the sign-in callback works in remote/SSH/Codespaces
   configurations.** The loopback POST assumes VS Code and the browser share a
   machine; not tested.

**Resolved since the first version of this document:** test coverage is no
longer unverified — `pytest-cov` and `jest --coverage` are installed and the
measured figures are in Section 1 and Section 16. The `pytest-mock` question is
moot: the pin was dropped when the test-only dependencies moved to
`backend/requirements-dev.txt`, and no `mocker` fixture is used anywhere.
