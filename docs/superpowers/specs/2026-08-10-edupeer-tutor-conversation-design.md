# EduPeer: a tutor that answers you

**Date:** 2026-08-10
**Status:** approved

## The problem

A student fixed a bug, told the tutor the right answer, and was asked the same
question again. The transcript below is not a reconstruction — it was produced
by running `HintingEngine.generate_hint` against the live model.

```
STUDENT > why is this wrong
  You've defined a function add(a, b) that's supposed to add two numbers, but
  it's currently returning a - b. What operation do you think should be used
  instead of subtraction?
  What do you think should happen next?

STUDENT > oh it should be a plus          <- correct
  Are you sure the only change needed is replacing the subtraction operator
  with an addition operator in the return statement?
  What do you think should happen next?
```

Four separate causes, each verified in the code:

1. **The hint prompt has no success path.** `SYSTEM_PROMPT_TEMPLATE`
   (`backend/hinting_engine.py:21`) says "NEVER give the direct answer / ALWAYS
   respond with a question" and says nothing about what to do when the student
   is right. `PREDICT_OUTPUT_TEMPLATE` has that branch; hint mode does not.
2. **Every reply is forced to end with the same sentence.** The prompt asks for
   it, and `hinting_engine.py:626` appends it in code when the model leaves it
   out. `localTutor.ts:351` and `:355` do the same offline. This is what makes
   distinct replies read as a loop.
3. **The hint ladder only advances on code edits** (`attemptTracker.ts:134`).
   Reasoning out loud can never move it, so a student learning a concept is
   pinned at hint 1 no matter how well they answer.
4. **The explain-first gate re-fires on every code change.** It keys on a code
   fingerprint (`sidebarProvider.ts:409`), so each edit makes the file "new"
   and interrupts the conversation again.

Two smaller complaints, both confirmed: the transcript persists across sessions
in `globalState` while the hint ladder is keyed per function, so the transcript
and the level describe different things; and the composer leads with a
confidence selector the student does not want.

## Decisions

| Question | Decision |
|---|---|
| What should the tutor do when you are right? | Confirm it, say why in one sentence, move on. Never write the fix. |
| Should talking advance the ladder? | Yes. |
| Who judges whether a message was a real attempt? | A deterministic phrase list in the extension. **Not the model.** |
| Explain-first | Once per file, per window. |
| Same-depth block | Only when there was genuinely no attempt. |
| Chat scope | One thread per function, cleared when the window closes. |
| Confidence selector | Removed, along with the calibration card. |
| Send key | Enter sends, Shift+Enter inserts a newline. |
| "I fixed it" button | Renamed "Quiz me". |

### Why the model does not judge attempts

The original design had the tutor emit `[attempt: yes|no]`, mirroring the
existing `[concepts: ...]` footer. It was built and measured against the plain
alternative. On the same probe set:

| Approach | Correct |
|---|---|
| Model emits `[attempt: yes\|no]` | 7/10 |
| Give-up phrase list, no model | 12/12 |

The model called "i dont know" and "no idea" real attempts, and on one probe
omitted the verdict line entirely. It errs in both directions, which is the
worst case: it stonewalls students who tried and waves through students who did
not. A misjudgement here is not cosmetic — it withholds help from someone who
earned it.

The phrase list is deterministic, unit-testable, works offline, costs no
tokens, and cannot misjudge. It is gameable by typing nonsense, which is
accepted: the gate exists to stop repeated clicking on untouched code, and
typing nonsense repeatedly is more effort than the behaviour it guards against.
The cooldown remains as a backstop.

## 1. The tutor confirms a correct answer

Replace `SYSTEM_PROMPT_TEMPLATE` (`backend/hinting_engine.py:21`) with a
version carrying an explicit success branch. The wording below was arrived at
over three iterations against the live model; earlier drafts produced hedged
confirmations ("Your function should indeed return the sum...") that did not
read as a yes.

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
- hint_level 1: one guiding question only
- hint_level 2: name the specific line or concept, explain the concept briefly
- hint_level 3: pseudocode only, never real {language} syntax

ALWAYS:
- Keep responses under 150 words
- Sound like a person, not a form. Close with a question only when you are actually waiting on
  them, and word it freshly every time. Never end with a stock sentence.
```

Observed output from this prompt, on three different seeded bugs:

- "You got it. …"
- "That's right. The range starting at 1 skips the first item. What would happen if range started at 0 instead?"
- "You're right, if all numbers are negative, it returns 0. What initial value should `biggest` have to avoid this issue?"

**Delete the forced closing line in two places**, or the prompt change has no
effect:

- `backend/hinting_engine.py:626-627` — the `if ... not in hint_text` append in
  `_finalize_hint`.
- `extension/src/localTutor.ts:351,355` — the same sentence on the offline path.

The hint-level rules are unchanged. The tutor still never writes the fix.

## 2. Talking advances the ladder

New pure function in `extension/src/attemptTracker.ts`:

```ts
/** Phrases that mean "I have not tried", however they are padded. */
const GIVE_UP = [
  "i dont know", "i don't know", "idk", "dunno", "no idea", "not sure",
  "just tell me", "tell me the answer", "give me the answer",
  "show me the answer", "no clue", "i give up",
];

export function isAttempt(message: string): boolean;
```

Whitespace-normalised, lower-cased, substring match. Empty message is not an
attempt. Verified 12/12 against the probe set, including the padded case
"I really have no idea at all, can you just show me the answer".

`AttemptTracker.evaluate` gains an `answered` input. The signal table becomes:

| Code changed | Message is an attempt | Within cooldown | Signal | Escalates |
|---|---|---|---|---|
| yes | — | — | `changed` | yes |
| no | yes | — | `answered` | yes |
| no | no | yes | `unchanged` | no |
| no | no | no | `stalled` | yes |

`answered` carries an empty `editSummary`, since nothing was edited. `record`
is unchanged: it still stores the code and timestamp the hint was given
against, so a later real edit diffs against the right baseline.

`nudgeForUnchangedCode` — the "SAME DEPTH" card — is shown only for
`unchanged`, which now requires that the student neither edited nor engaged.

**Rate.** Every `answered` escalates, with no cooldown between them, so three
non-give-up messages reach hint level 3. This is deliberate and is the point of
the change: a student reasoning through a concept should be able to get to the
deepest hint by reasoning. The floor is that level 3 is pseudocode only, never
real syntax, so the worst case for a student typing nonsense three times is
pseudocode — not a written fix. The ladder is capped at 3 either way.

`handleAsk` (`sidebarProvider.ts:496`) computes `isAttempt(question)` and passes
it to `evaluate`.

## 3. Explain-first fires once per file

`seenFingerprints` (`sidebarProvider.ts:409`) becomes `explainedFiles`, a
`Set<string>` of document URIs. The gate fires the first time a file is asked
about and never again for that file in that window. `reset` clears the set.

## 4. One thread per function

The provider holds threads in memory, keyed by the same `lastDocumentKey` the
hint ladder already uses (`uri#label` for a named block, `uri` otherwise):

```ts
private threads = new Map<string, { history: ChatTurn[]; bubbles: unknown[] }>();
```

- `sendFocus` posts `restoreChat` with the new key's bubbles whenever the key
  changes.
- The extension host is authoritative; the webview's `setState` copy is a
  render cache only, so hide/show does not resurrect another function's thread.
- `Reset` clears the current thread and its ladder, not every thread.
- `CHAT_STATE_KEY`, the `persistChat` message and its `globalState` writes are
  removed. Nothing survives window close.

`MAX_PERSISTED_BUBBLES` becomes a per-thread in-memory cap, so a long session
cannot grow without bound.

## 5. The composer

- Remove the `confidence` fieldset from the webview HTML
  (`sidebarProvider.ts:794`), its CSS, and its handlers in `main.js`.
- Stop sending `confidence`. The backend field keeps its `0` default, so
  `models.py` and the endpoints are untouched.
- Remove the calibration card from `progressPanel.ts`. `classify_calibration`
  stays in the backend, unfed and harmless.
- `#quiz` label "I fixed it" becomes "Quiz me"; the tooltip explains it asks
  one question about why the fix works.
- Enter sends. Shift+Enter inserts a newline. The button hint reads `↵`.

## Testing

- `isAttempt` — the full probe set, both directions, padded give-ups.
- `AttemptTracker.evaluate` — every row of the signal table.
- Explain-first fires once per file and survives edits to that file.
- Threads: switching function swaps the transcript; switching back restores it;
  reset clears only the current one; nothing reaches `globalState`.
- Webview: Enter sends, Shift+Enter does not, no confidence element exists.
- Backend: no reply carries the stock closing sentence, on both the streaming
  and non-streaming paths, and offline in `localTutor`.

Prompt wording cannot be asserted against a live model in CI. The three
observed confirmations above are the record; a change to that prompt should be
re-run against the model by hand.

## Out of scope

- Per-bug removal of `# bug:` markers (still whole-file; tracked separately).
- The attempt gate's interaction with EduPeer's own marker-removal edit, which
  currently reads as a student edit.
- Any change to hint levels 1-3 themselves.
