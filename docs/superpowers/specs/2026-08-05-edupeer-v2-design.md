# EduPeer v2 — pedagogy, resilience and UI design

Date: 2026-08-05

## Goal

Close the gaps between EduPeer and what the CS-education literature says a
novice programming tutor should do, without adding any paid service. Every
feature here runs on what the project already pays for: the Groq free tier,
the Firestore free tier, VS Code's own APIs, and local computation.

Four feature packs plus a visual overhaul of the sidebar and the progress
dashboard.

## Constraints

- **Zero marginal cost.** No new SDKs that bill, no hosted services, no
  telemetry backends. Where a feature needs the LLM it must either reuse an
  existing call or add at most one, and the cache/rate limiter must pay that
  back.
- **Backwards compatible.** Existing clients send no new fields; every new
  request field has a default and every new response field is additive. Old
  extension builds keep working against the new backend and vice versa.
- **Degrade, never break.** Anything that depends on the network has a local
  fallback or a silent no-op.
- **Test parity.** Every pure function added gets unit tests in the suite that
  already covers its module.

---

## Pack 1 — Pedagogy

### 1.1 Attempt gate and hint cooldown

**Problem.** A student can press *Ask* three times without touching the code
and walk to a level-3 pseudocode hint. That is textbook hint abuse (Aleven &
Koedinger; Baker's "gaming the system"), and the current design rewards it.

**Design.** The extension owns an `AttemptTracker` (pure module,
`extension/src/attemptTracker.ts`). It records, per code fingerprint:

- the code text at the moment of the last hint,
- the timestamp of the last hint.

On the next `hint`-mode ask it computes an `AttemptSignal`:

| Condition | Signal | Behaviour |
|---|---|---|
| Code unchanged **and** < 45 s since last hint | `unchanged` | Client does not escalate; sends `escalate: false` and a nudge asking what they tried |
| Code unchanged and ≥ 45 s | `stalled` | Escalates, but the prompt is told the student did not edit |
| Code changed | `changed` | Escalates, and the prompt receives a compact diff |

The 45 s cooldown is a client-side courtesy, not a security control — the
backend independently refuses to escalate when it is told not to.

**Backend.** `HintRequest` gains `escalate: bool = True`. When `escalate` is
false, `/hint` and `/hint/stream` call a new
`store.current_hint_level(uid, fingerprint)` (returns the level without
incrementing, minimum 1) instead of `next_hint_level`.

### 1.2 Edit awareness

**Problem.** "I tried that and it still fails" is answered blind — the tutor
never sees what changed.

**Design.** `extension/src/attemptTracker.ts` exports
`summarizeEdit(before, after, maxLines)`: a line-level diff producing at most
8 changed lines rendered as `- old` / `+ new` with 1-based line numbers, or
`""` when nothing changed. That string travels in a new `HintRequest.edit_summary`
field (default `""`, capped at 2000 chars server-side) and is appended to the
user message as a "What the student changed since the last hint" block. Roughly
50 extra tokens; no extra call.

The diff is deliberately naive (common-prefix / common-suffix trim, then the
changed span) — it does not need to be a proper Myers diff to give the model
useful grounding, and a dependency-free implementation keeps the bundle small.

### 1.3 Confidence rating and calibration

**Problem.** Novices are systematically overconfident and have no feedback
loop on that (Dunlosky & Rawson on judgments of learning).

**Design.** After the explain-first gate and before the hint is requested, the
sidebar shows a 3-way confidence chip row: *No idea* (1) / *Some idea* (2) /
*Pretty sure* (3). Choosing one is optional — a *Skip* option sends no rating.

The rating rides along on `HintRequest.confidence: int = 0` (0 = not given).
The backend stores it per interaction and folds it into the user document as
`calibration: {samples, sum_confidence, sum_level, well_calibrated,
overconfident, underconfident}`.

`backend/progress.py` gains `calibration_summary(data)` returning
`{samples, score, label}` where a sample is:

- **overconfident** — confidence 3 but the student needed level 3,
- **underconfident** — confidence 1 but solved at level 1,
- **well calibrated** — anything else.

`score` is `well_calibrated / samples` rounded to 2 dp; the dashboard shows it
as a percentage with the two failure counts. Under 4 samples the dashboard says
"not enough data yet" rather than showing a noisy number.

### 1.4 Subgoal-labelled worked examples

**Problem.** Worked examples transfer far better when the learner labels the
sub-goals themselves (Margulieux & Catrambone).

**Design.** `WORKED_EXAMPLE_TEMPLATE` is amended to end with an explicit
instruction: present the worked steps as a numbered list with the labels left
blank, then ask the student to name what each step accomplishes. A new
`subgoal-label` mode grades the student's labels: it affirms correct labels,
questions vague ones, and never restates the example. The sidebar surfaces
"🏷️ Label the steps" as an action row under any worked-example reply.

---

## Pack 2 — Practice: the trace table

**Problem.** Students who cannot trace code cannot write it (Lister et al.;
du Boulay's notional machine). `predict-output` asks for a single free-text
guess; it does not exercise step-by-step state tracking.

**Design.** New backend endpoint `POST /trace`:

- **Request** `{code, language, selection}` — `selection` is the snippet the
  student highlighted (falls back to the whole file when empty).
- **Response** `{variables: [...], steps: int, prompt: str}` — the model picks
  the 2–4 variables worth tracking and how many steps (iterations or
  statements, capped 3–8) the student should fill in, plus one sentence of
  instruction. The engine validates and clamps everything; an unparseable
  reply yields an empty response and the extension silently falls back to
  `predict-output`.

The extension renders a grid in the sidebar (steps × variables) of plain
inputs. On submit, the filled table is serialized as a compact text table and
sent through the existing `/hint` pipeline under a new `trace-check` mode whose
prompt grades the trace: it names the first row that diverges from reality and
asks a question about it, without giving the correct table.

Two LLM calls per exercise (generate, grade), both short. Triggered manually
from `EduPeer: Trace This Code` or the editor context menu — never automatic,
so it cannot run away with quota.

---

## Pack 3 — Resilience and quota

### 3.1 Response cache

`backend/cache.py`: a `TtlCache` with a bounded `OrderedDict`, per-entry TTL
and LRU eviction. Applied to the two endpoints the extension fires
automatically:

- `/scan` — key `(uid, language, code fingerprint)`, TTL 300 s,
- `/line-hint` — key `(uid, language, line, code fingerprint)`, TTL 300 s.

`/hint` is **not** cached: the same question at the same level should still
produce a fresh reply, and hint level advances per call anyway.

Cache is per-process and per-user (the uid is in the key, so one student can
never read another's cached hint).

### 3.2 Rate limiting

`backend/ratelimit.py`: a monotonic-clock token bucket, per uid, per bucket
name. Applied as a FastAPI dependency:

| Endpoint | Budget |
|---|---|
| `/hint`, `/hint/stream` | 30 / minute |
| `/scan`, `/line-hint` | 60 / minute |
| `/trace` | 10 / minute |

Exceeding it returns `429` with a `Retry-After` header. The extension treats
429 as a soft failure: inline features go quiet, the sidebar shows a friendly
"slow down a moment" bubble rather than an error.

Buckets live in memory and are pruned when the map exceeds 5000 entries, the
same bound the profile cache already uses.

### 3.3 Local fallback tutor

`extension/src/localTutor.ts`: a dependency-free rule table keyed by language
that pattern-matches the current line and returns a generic Socratic nudge —
e.g. Python `if x = 1` → "Is that comparing, or assigning?", C `malloc` with no
matching `free` → "Who releases this memory, and when?". Roughly 8–12 rules per
language, drawn from the concept lists already in `languages.ts`.

Used in exactly two places: the inline decoration when `/line-hint` fails, and
the sidebar when the backend is unreachable (prefixed "EduPeer is offline —
here's a general nudge"). It never claims to be the real tutor and never
escalates hint level.

---

## Pack 4 — Native VS Code polish

- **Status bar item** — `EduPeer: L2 · 🔥6` on the left, tooltip listing hint
  level, streak and review-due state, click opens the panel. Hidden when no
  supported file is open.
- **Quick Fix actions** — a `CodeActionProvider` over EduPeer diagnostics
  offering "🤔 Ask EduPeer about this" and "💡 Explain this line", so the
  lightbulb students already reach for reaches the tutor.
- **Walkthrough** — `contributes.walkthroughs` with four steps (open a file,
  ask your first question, read the inline nudges, check your progress). Pure
  manifest, zero code.
- **Chat persistence** — the sidebar currently keeps chat in webview state,
  which dies on reload. Persist the last 50 turns to `globalState` and restore
  on `ready`; `Reset Session` clears it.

---

## UI upgrade — refined VS Code native

The webview stays theme-token-driven so it is correct in every light, dark and
high-contrast theme. What changes:

**Design system** (`media/style.css` rewritten around CSS custom properties):
a 4 px spacing scale, a 5-step type scale anchored to `--vscode-font-size`, one
radius scale, and a small set of semantic surface tokens derived from VS Code
tokens with sensible fallbacks.

**Chat**
- Markdown rendering (`media/markdown.js`, ~120 lines, no dependency):
  fenced code blocks, inline code, bold, italic, links stripped to plain text,
  ordered and unordered lists. This is the biggest single fix — level-3
  pseudocode currently renders as raw text with literal asterisks.
- Tutor vs student identity: tutor replies get a left rule and a mode label;
  student turns stay right-aligned and filled.
- A hint-level stepper (① ─ ② ─ ③) pinned above the composer, showing where the
  student is on the current problem.
- A typing caret during streaming instead of text that silently appears.
- `aria-live="polite"` on the chat region and real focus rings on every
  control, so the panel is usable by keyboard and screen reader.

**Header** — collapses to one line: identity, streak, badge count. Badges move
behind a disclosure so they stop pushing the chat down.

**Code preview** — line numbers, and it collapses to a single summary row once
a conversation is under way.

**Progress dashboard** (`progressPanel.ts`) — inline SVG, no chart library:
a hint-level distribution bar, a concept mastery list with real bars, a
14-day activity strip, and the calibration readout. Colours come from VS Code
chart tokens (`--vscode-charts-*`) with fallbacks, so it stays legible in every
theme and for colour-vision deficiency (shape and label carry the meaning, not
hue alone).

---

## Data flow

```
editor edit ──► AttemptTracker (local)
                     │ edit_summary, escalate
                     ▼
sidebar ask ──► confidence chip ──► ApiClient ──► /hint/stream
                                                      │
                                        rate limit ───┤
                                                      ▼
                                          hinting_engine (Groq)
                                                      │
                                        concept tags, calibration
                                                      ▼
                                              Firestore user doc
                                                      │
                                                      ▼
                                     /progress ──► dashboard SVG
```

## Error handling

| Failure | Behaviour |
|---|---|
| Backend down | Offline banner, local fallback nudges, mutations queued |
| 429 | Friendly "slow down" bubble; inline features silently skip |
| LLM returns junk JSON (`/trace`, `/scan`, `/line-hint`) | Empty result, feature silently unavailable, no error shown |
| Firestore unavailable | Already handled — all writes are best-effort |
| Markdown renderer sees hostile input | Renderer builds DOM nodes via `textContent`; it never assigns `innerHTML` |

## Testing

- **Backend (pytest):** `cache.py` and `ratelimit.py` get dedicated test
  modules; `progress.py` gains calibration tests; `hinting_engine.py` gains
  trace generation/validation tests; `main.py` gains endpoint tests for
  `/trace`, the `escalate` flag and 429 behaviour.
- **Extension (jest):** `attemptTracker.ts`, `localTutor.ts`, the markdown
  renderer and the dashboard builder are all pure and get unit tests.
- **Manual:** F5 into the Extension Development Host with `demos/demo.py`.

## Explicitly out of scope

Cohort/instructor dashboards (needs multi-tenancy), running student code
(sandboxing risk), any model change, and any hosted deployment.
