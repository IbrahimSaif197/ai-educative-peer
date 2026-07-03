# EduPeer Feature Roadmap — Design

**Date:** 2026-07-04
**Scope:** 20 approved features, phased into 5 sub-projects. Classroom/instructor features and anything requiring paid infrastructure are out of scope. Packaging is local-only (VSIX via esbuild + vsce); no hosted backend.

## Constraints

- No new paid services. Groq + Firestore (existing) only.
- All LLM behavior stays Socratic: never real code in the student's language.
- Every backend failure degrades gracefully (existing pattern: log + safe default).
- New endpoints require the existing Firebase Bearer auth (`get_current_uid`).

## Phase 1 — Concept intelligence (feature #4)

The foundation for adaptive pacing, dashboard, review, and badges.

**LLM concept tagging.** `generate_hint` currently keyword-matches concepts. Change: the hint system prompt instructs the model to end its reply with a final line `[concepts: tag-a, tag-b]` drawn from the language's known concept list. The engine strips that line from the hint text and parses tags, validating against `concepts_for(language)`; on parse failure it falls back to the existing keyword extractor. Same single LLM call — no extra cost.

**Per-user concept stats.** `FirebaseService._update_user_and_award_badges_sync` additionally maintains a `concept_stats` map on the `users` doc:

```
concept_stats: {
  "<concept>": {
    encounters: int,          # hint interactions touching this concept
    level_sum: int,           # sum of hint levels used (depth proxy)
    max_level: int,           # deepest hint level reached
    last_seen: iso-date,
    last_struggled: iso-date  # set when hint level >= 2
  }
}
```

Also track `languages_used: [languageId]` and `last_active_date` / `streak_days` (consumed by Phase 4). Merge logic in `merge_user_sync` sums the maps.

## Phase 2 — Pedagogy loop (features #1, #2, #5, #7)

**Tutor modes.** `HintRequest` gains `mode: str = "hint"`. The engine keeps one entry point but selects a per-mode system prompt. Modes added in this phase:

- `hint` — unchanged Socratic 3-level flow. Only this mode advances the hint level or triggers explain-first.
- `reflect` — one short "why did that fix work?" question about corrected code, then feedback on the student's answer via history.
- `translate` — student submits their code translation of a level-3 pseudocode hint; feedback addresses the translation only (still no corrected code).
- `worked-example` — a fully worked example of the same concept on *different* code, so the student still writes their own fix.

Non-`hint` modes log interactions with the mode recorded but do not advance `next_hint_level`.

**Explain-first gate (#1, skippable).** Client-side in the sidebar: when the student asks about code whose fingerprint hasn't been seen this session, the webview first renders a local tutor bubble — "Before I hint: what do you think this code is doing?" — with a **Skip** button. If the student types an answer, it is prepended to the question sent to `/hint` ("My understanding: ... My question: ..."). Skip sends the original question unchanged. No backend state.

**Contextual buttons.** After a level-3 hint the sidebar shows "Submit my translation" (`translate`) and "Show a worked example" (`worked-example`). After the inline tutor observes a file's scan flags drop from >0 to 0, it offers a toast → opens sidebar in `reflect` mode ("I fixed it — quiz me" button is always available in the sidebar too).

## Phase 3 — Error tutoring & editor integration (features #6, #9–13)

- **`explain-error` mode (#6).** New command `edupeer.explainError`: uses the selection, else prompts for a paste. The mode teaches *how to read* the message (anatomy of the traceback/compiler error), Socratically, without the fix. The sidebar also auto-detects pasted tracebacks (regex for `Traceback`, `error:`, `Exception in thread`, etc.) and switches to this mode.
- **Debugger companion (#9).** A `DebugAdapterTrackerFactory` watches for `stopped` events with reason `exception`. A notification offers "Talk it through with EduPeer"; on accept, the extension pulls the top stack frame and local variables via DAP requests and starts an `explain-error` conversation seeded with that state.
- **Test-failure tutoring (#10).** Subscribe to `vscode.tests.onDidChangeTestResults`; when a run contains failures, offer a notification. On accept, send the failing test's message + the active file to `hint` mode with the failure as the question.
- **Explain construct (#11).** Command `edupeer.explainSelection` (+ context menu + link in the existing hover): `explain-concept` mode returns a plain-language explanation of the selected construct and ends by offering a comprehension question.
- **Predict the output (#12).** Command `edupeer.predictOutput` on a selection: sidebar asks for the student's prediction first (same gate UI as explain-first, not skippable — the prediction *is* the exercise), then `predict-output` mode compares prediction to actual behavior Socratically.
- **Style notes (#13).** The scan schema gains `kind: "bug" | "style"`. The scan prompt may add up to 2 gentle readability/naming observations (`kind: style`, severity info, 🎨 prefix in CodeLens/diagnostics) alongside the existing max-5 bug flags.

## Phase 4 — Progress & motivation (features #3, #14–18)

- **Richer badges (#14).** New rules from data added in Phase 1: streaks (3/7/30 days), per-language badges (first interaction in each language), tiers for `solved_at_level_1` (10/25) and sessions (15/50). Badge rules stay in `_apply_badge_rules` (pure, tested).
- **Adaptive pacing (#3).** `/hint` loads the user's `concept_stats` (one Firestore read, 60 s in-process cache). A pacing summary — "student repeatedly needed deep hints on: X, Y" or "student usually solves at level 1" — is appended to the system prompt so the tutor scaffolds more or stays terse.
- **Progress dashboard (#15).** `GET /progress` returns badges, totals, streak, `languages_used`, top concept struggles/strengths, goal, and recent session summaries. New command `edupeer.showProgress` opens a `WebviewPanel` rendering pure-HTML/CSS bar charts (CSP-safe, no libraries).
- **Spaced review (#16).** `GET /review` picks up to 3 concepts with `last_struggled` 3–7 days ago; `review-exercise` mode generates a micro-exercise (question/pseudocode only). Sidebar shows a "Review" button with a dot when review is due (checked once per activation).
- **Session summary (#17).** `/reset` queries the user's recent `interactions` (this session), asks the LLM for a 3-bullet "what you learned" summary, stores it in `session_summaries` on the user doc (keep last 20), and returns it so the sidebar can show it before clearing.
- **Goals (#18).** `POST /goal {text}` stores a free-text goal; hint prompts mention it ("student's stated goal: ..."); dashboard shows the goal and encounters of related concepts (LLM maps goal → concept tags once at set time).

## Phase 5 — Platform (features #23, #24, #27, #28)

- **Streaming (#23).** `POST /hint/stream` returns `text/event-stream`; Groq called with `stream=True`. Events: `meta` (level), repeated `delta`, final `done` (full text + tags). The sidebar renders deltas into the current bubble; falls back to `/hint` when streaming fails.
- **Offline resilience (#24).** ApiClient exposes an `onAvailabilityChange` signal fed by request failures + periodic health retry (30 s backoff). Sidebar shows an offline banner and disables Ask; `reset` and `goal` mutations queue in `globalState` and flush when the backend returns.
- **New languages (#27).** TypeScript (promoted from alias to first-class), Go, Rust, SQL added to both registries, demos, and `package.json` `when` clauses/keybindings.
- **Packaging (#28).** esbuild bundle to a single `out/extension.js`, `.vscodeignore`, `npm run package` producing a `.vsix` via `@vscode/vsce` (free, local). No publishing infrastructure.

## Testing

Backend: pytest per phase — engine tag parsing, mode prompt selection, badge/streak rules, concept-stat merges, new endpoints via the existing `client` fixture. Extension: jest for pure logic (ApiClient additions, offline queue, traceback detection); UI glue is exercised manually via F5.

## Error handling

All new Firestore writes follow the existing swallow-and-log pattern. All new LLM calls raise 502 like `/hint`. Streaming failures fall back to non-streaming. Review/progress endpoints return empty structures when Firestore is disabled.
