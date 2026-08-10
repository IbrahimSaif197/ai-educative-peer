# EduPeer: a fourth rung, and an answer when you ask for one

## The problem

A student who reaches hint 3 and keeps asking gets hint 3 again, forever.
`resolve_level` caps at three (`backend/session_store.py:32-41`), so every ask
past that point returns another level-3 pseudocode hint. In a real session that
produced fifteen consecutive cards, each opening with "Pseudocode:", circling
between the empty check, the loop and the initialisation without converging.

There is already an escape: at level 3 the panel offers a **Show a worked
example** button (`extension/media/main.js:505-523`), and the
`worked-example` mode behind it is good. But it is a button the student has to
notice, in a panel they are reading rather than scanning, at the exact moment
they are most stuck. Pressing it once and then continuing to ask drops them
straight back into the level-3 loop.

Separately, there is no floor. A student who has understood that they are
beaten and says so plainly — "just tell me the answer" — gets a Socratic
question back. Worse, those exact words are in the `GIVE_UP` set
(`extension/src/attemptTracker.ts:246-257`), so asking for the answer is scored
as giving up and *holds them at the same depth*. The one clear signal a student
can send is the one the system punishes.

## Decisions

### The worked example becomes a rung, not a button

The ladder grows a fourth level, and **level 4 *is* the worked example** — not
a fourth flavour of hint. Reaching level 3 and asking again returns a worked
example on a different problem, automatically.

The alternative was to keep levels 1-3 and carry a separate "exhausted" flag,
which avoids touching the schema. It was rejected because the panel shows the
depth back to the student: with a flag they would sit on "hint 3" while the
content silently changed under them, and they would have no way to tell they
had reached the end of the ladder. A fourth dot is honest about where they are.

Asking again at 4 stays at 4 and produces a *fresh* worked example on a
different problem each time. That is the one repetition worth having — unlike
repeated pseudocode, a second worked example is new material.

### The button goes

With the ladder driving it, the **Show a worked example** button is removed.
The panel keeps **Submit my translation** at level 3 (unrelated — it belongs to
the pseudocode rung) and **Label the steps** after a worked example.

This closes off reaching the worked example early. That is the accepted cost of
a ladder that means what it says.

### The answer is a mode, and asking is enough

A new `answer` tutor mode. It is reached by asking for it plainly, at any
depth — no requirement to have exhausted the ladder first.

This is a real change to what EduPeer is: the ladder becomes opt-in rather than
enforced, and a student can type "just tell me the answer" on their very first
ask and get one. That is a deliberate product decision, made on the grounds
that a student who has decided they want the answer will get it from somewhere,
and getting it *here* — with the bug named and the reasoning attached — beats
getting it from a search engine with neither.

Detection is client-side, in `attemptTracker.ts`, reusing the clause-splitting
and padding-stripping machinery `isAttempt` already has. The matched set is
narrow and deliberately excludes the bare `tell me`, which is too vague to mean
"solve this for me".

Because the message is routed to `answer` mode *before* the attempt gate, the
existing `GIVE_UP` list needs no change. Those phrases stop reaching the gate
at all, so the inversion the problem statement describes resolves itself rather
than needing to be unpicked.

### The answer contains the fix, not the file

Per the shape agreed: name the bug in one sentence citing the real line, show
**only the lines that change**, then one short paragraph on why the original
was wrong and why the fix works. Never the whole function, never the whole
file. The student still types it themselves.

## 1. The ladder gets a fourth rung

`resolve_level` caps at 4 instead of 3. The `3`-clamps that shadow it move
too:

| Location | Now |
| --- | --- |
| `session_store.py:32-41` | `resolve_level` — `min(3, …)` → `min(4, …)` |
| `session_store.py` (both stores) | `commit_hint_level` — `max(1, min(3, …))` → `max(1, min(4, …))` |
| `models.py:98` | `hint_level: Field(ge=1, le=3)` → `le=4` |
| `hinting_engine.py` | `_prepare_hint_messages` — `level = max(1, min(3, …))` → `min(4, …)` |

In `_prepare_hint_messages`, when `mode == "hint"` and the resolved level is 4,
`WORKED_EXAMPLE_TEMPLATE` is selected instead of `SYSTEM_PROMPT_TEMPLATE`, and
the returned effective mode becomes `worked-example`. No new prompt is written
— that template already exists and is already good; it just stops being
reachable only by button.

## 2. `answer` mode

`isAnswerRequest(message)` in `attemptTracker.ts`, beside `isAttempt` and
sharing `clausesOf` and `GIVE_UP_PADDING`. It matches a stripped clause in
full against a narrow set: `tell me the answer`, `give me the answer`,
`show me the answer`, `what is the answer`, `whats the answer`,
`show me the solution`, `give me the solution`, `whats the fix`,
`just fix it`, `show me the code`.

`handleAskFromWebview` routes it the way it already routes pasted stack traces:

```ts
if (mode === "hint" && looksLikeErrorText(question)) mode = "explain-error";
if (mode === "hint" && isAnswerRequest(question)) mode = "answer";
```

Because `mode !== "hint"`, three things fall out with no extra code: the
attempt gate is skipped, `_resolve_hint_level` returns `req.hint_level`
unchanged, and nothing is committed to the ladder. Asking for the answer
neither advances nor spends a rung.

`ANSWER_TEMPLATE` joins `MODE_SYSTEM_TEMPLATES`; `"answer"` joins the mode
literal in `models.py` and `TutorMode` in `pedagogy.ts`.

## 3. The response carries its real mode

`HintResponse` (`models.py:142`) gains `mode: str`, set to the effective mode
`_prepare_hint_messages` returned. The panel currently labels each card from
its own request variable, so without this a worked example arrives labelled
"hint 4". With it, the card gets its `WORKED EXAMPLE` header the same way
`SAME DEPTH` already gets one.

## 4. Panel

- Remove the **Show a worked example** action (`main.js:513-521`).
- Keep **Submit my translation** at level 3 and **Label the steps** after a
  worked example.
- The depth indicator goes from three dots to four.
- `MODE_LABELS` (`main.js:34`) gains `answer: "Answer"`.

## Testing

Backend:

- `resolve_level` — escalating 3 → 4, capping at 4, non-escalating reuse at 4.
- Both stores commit and read back level 4 without clamping it to 3.
- `_prepare_hint_messages` selects `WORKED_EXAMPLE_TEMPLATE` at level 4 in
  `hint` mode and reports `worked-example` as the effective mode.
- `/hint` at level 3 with `escalate` returns 4 and a worked example.
- `answer` mode does not touch the ladder: level before equals level after.
- `HintResponse.mode` reflects the effective mode, not the requested one.

Extension:

- `isAnswerRequest` — matches the set with padding ("i really just want the
  answer please"), rejects the bare "tell me", rejects "i dont know".
- A message matching it routes to `answer` mode and skips the explain-first
  gate.
- The webview renders four dots and labels an `answer` card.

## Out of scope

- Rate-limiting or logging how often students ask for the answer. Worth
  knowing, not worth blocking this on.
- Badge or streak consequences for taking the answer.
- Any change to `GIVE_UP` or the attempt gate itself — the routing change makes
  it unnecessary.
- The line-hint and line-numbering work merged in `5090468`, which is separate.
