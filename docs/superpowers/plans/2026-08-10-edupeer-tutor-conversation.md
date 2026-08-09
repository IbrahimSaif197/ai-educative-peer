# EduPeer Tutor Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tutor recognise a correct answer, let reasoning advance the hint ladder, stop the gates interrupting mid-conversation, scope the transcript per function, and strip the composer down.

**Architecture:** Five independent changes against an existing VS Code extension (TypeScript) and FastAPI backend (Python). The backend change is prompt text plus deleting a forced string append. The extension changes are a new pure predicate, a new signal in an existing pure tracker, and three edits to the sidebar provider and its webview. No new dependencies, no new services.

**Tech Stack:** TypeScript + Jest (`extension/`), Python + pytest (`backend/`), plain-JS webview (`extension/media/main.js`).

**Spec:** `docs/superpowers/specs/2026-08-10-edupeer-tutor-conversation-design.md`

## Global Constraints

- Never add a `Co-Authored-By` trailer to any commit.
- The tutor must never write working code or the corrected line for the student. Hint level 3 stays pseudocode-only.
- Line numbers sent to and from the backend are 1-based; everything inside the extension is 0-based. Do not change either convention.
- Run extension tests with `cd extension && npx jest`. Run the type check with `cd extension && npx tsc --noEmit -p .`.
- Run backend tests with `backend/.venv/Scripts/python.exe -m pytest backend/tests -q` from the repo root. A bare `uvicorn`/`pytest` on PATH resolves to a different venv without `firebase-admin`.
- Both suites must be green before any commit. Extension baseline is **717 passing**; backend baseline is **472 passing**.
- Do not touch `demos/demo.py`; it has an uncommitted edit belonging to the user.

---

### Task 1: The tutor confirms a correct answer

**Files:**
- Modify: `backend/hinting_engine.py:21-30` (`SYSTEM_PROMPT_TEMPLATE`)
- Modify: `backend/hinting_engine.py:622-632` (`_finalize_hint`)
- Modify: `extension/src/localTutor.ts:351,355`
- Test: `backend/tests/test_hinting_engine.py:33-42` (replace two tests)
- Test: `extension/src/__tests__/localTutor.test.ts:118-122` (replace one test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. `_finalize_hint(self, raw_text, code, question, language, mode) -> Tuple[str, List[str]]` keeps its signature.

**Context:** the stock sentence "What do you think should happen next?" is requested in the prompt *and* force-appended in code. Changing only the prompt has no visible effect, because the append puts it back. Two existing backend tests assert the append happens; they encode the old behaviour and must be replaced, not deleted.

- [ ] **Step 1: Replace the two backend tests that assert the forced append**

In `backend/tests/test_hinting_engine.py`, delete `test_appends_socratic_question_if_missing` and `test_does_not_double_append_socratic_question` (lines 33-42) and put these in their place:

```python
    def test_does_not_append_a_stock_closing_sentence(self):
        engine = self._engine("Look at your loop carefully.")
        hint, _ = engine.generate_hint("for i in range(10):", "help", 1)
        assert hint == "Look at your loop carefully."

    def test_leaves_the_models_own_closing_question_alone(self):
        # Only the append is going. Text the model chose to write is untouched.
        text = "Consider the index. What do you think should happen next?"
        engine = self._engine(text)
        hint, _ = engine.generate_hint("x[5]", "help", 2)
        assert hint == text
```

- [ ] **Step 2: Run them to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_hinting_engine.py -q -k "stock_closing or models_own_closing"`

Expected: `test_does_not_append_a_stock_closing_sentence` FAILS — the hint comes back as `"Look at your loop carefully.\n\nWhat do you think should happen next?"`.

- [ ] **Step 3: Delete the forced append**

In `backend/hinting_engine.py`, `_finalize_hint` currently reads:

```python
        hint_text, raw_tags = self._parse_concepts_line(raw_text.strip())
        if mode == "hint" and "What do you think should happen next?" not in hint_text:
            hint_text = hint_text.rstrip() + "\n\nWhat do you think should happen next?"
        known = set(concepts_for(language))
```

Remove the two-line `if`, leaving:

```python
        hint_text, raw_tags = self._parse_concepts_line(raw_text.strip())
        known = set(concepts_for(language))
```

- [ ] **Step 4: Run the backend tests to verify they pass**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests/test_hinting_engine.py -q`

Expected: PASS.

- [ ] **Step 5: Replace `SYSTEM_PROMPT_TEMPLATE`**

In `backend/hinting_engine.py`, replace the whole of `SYSTEM_PROMPT_TEMPLATE` (currently lines 21-30) with this. The wording was tuned against the live model over three iterations; earlier drafts produced hedged confirmations that did not read as a yes. Do not paraphrase it.

```python
SYSTEM_PROMPT_TEMPLATE = """You are EduPeer, a Socratic programming tutor for beginner {language} students.
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
  them, and word it freshly every time. Never end with a stock sentence."""
```

- [ ] **Step 6: Run the whole backend suite**

Run: `backend/.venv/Scripts/python.exe -m pytest backend/tests -q`

Expected: 472 passing. If `test_audit_regressions.py` fails, read the failure before changing anything — it feeds the engine text that already contains the closing sentence and only asserts `hint_level`, so it should be unaffected.

- [ ] **Step 7: Replace the offline test**

In `extension/src/__tests__/localTutor.test.ts`, replace the test at lines 118-122:

```ts
  it("closes on its own question rather than a stock sentence", () => {
    const reply = offlineTutorReply("x = 1", "python").trim();
    expect(reply).not.toContain("What do you think should happen next?");
    expect(reply.endsWith("?")).toBe(true);
  });
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd extension && npx jest src/__tests__/localTutor.test.ts -t "stock sentence"`

Expected: FAIL on the `not.toContain` assertion.

- [ ] **Step 9: Drop the stock sentence from the offline replies**

In `extension/src/localTutor.ts`, `offlineTutorReply` currently ends each branch with the stock sentence. Both `rule.question` and every entry in `OFFLINE_GENERIC` already end in a question mark, so nothing is lost:

```ts
    if (rule) {
      return `${OFFLINE_PREFIX}\n\n${rule.question}`;
    }
  }
  const generic = OFFLINE_GENERIC[Math.abs(seed) % OFFLINE_GENERIC.length];
  return `${OFFLINE_PREFIX}\n\n${generic}`;
```

- [ ] **Step 10: Run the extension suite**

Run: `cd extension && npx jest && npx tsc --noEmit -p .`

Expected: 717 passing, tsc clean.

- [ ] **Step 11: Commit**

```bash
git add backend/hinting_engine.py backend/tests/test_hinting_engine.py extension/src/localTutor.ts extension/src/__tests__/localTutor.test.ts
git commit -m "Let the tutor say yes, and stop forcing the same closing line

The hint prompt had no branch for a correct answer, so a student who
solved it was asked the same question again. It has one now.

The stock closing sentence was both requested in the prompt and appended
in code when the model left it out, which is why every reply read the
same. Both are gone; a reply closes on a question only when the tutor is
actually waiting. The offline tutor stops appending it too."
```

---

### Task 2: `isAttempt`

**Files:**
- Modify: `extension/src/attemptTracker.ts` (append to the module)
- Test: `extension/src/__tests__/attemptTracker.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isAttempt(message: string): boolean` — Task 3 and the sidebar call it.

**Context:** the spec rejected having the model emit an `[attempt: yes|no]` verdict. Measured against the live model it scored 7/10 on this probe set — it called "i dont know" and "no idea" real attempts and once omitted the verdict entirely. The list below scored 12/12. Do not reintroduce a model verdict.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/attemptTracker.test.ts`:

```ts
describe("isAttempt", () => {
  it("counts anything that engages with the problem", () => {
    const engaged = [
      "oh it should be a plus",
      "maybe because minus takes away instead of combining",
      "wait is it because - subtracts?",
      "i tried changing it to += but it broke",
      "whats an operator",
      "hmm",
      "code wont run",
    ];
    for (const message of engaged) {
      expect(isAttempt(message)).toBe(true);
    }
  });

  it("does not count giving up", () => {
    const giveUps = [
      "i dont know",
      "i don't know",
      "idk",
      "IDK",
      "  no idea  ",
      "just tell me the answer",
      "I really have no idea at all, can you just show me the answer",
    ];
    for (const message of giveUps) {
      expect(isAttempt(message)).toBe(false);
    }
  });

  it("does not count an empty message", () => {
    expect(isAttempt("")).toBe(false);
    expect(isAttempt("   \n  ")).toBe(false);
  });
});
```

Add `isAttempt` to the existing import at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npx jest src/__tests__/attemptTracker.test.ts -t "isAttempt"`

Expected: FAIL — `isAttempt is not a function`.

- [ ] **Step 3: Implement it**

Append to `extension/src/attemptTracker.ts`:

```ts
/**
 * Phrases that mean "I have not tried", however they are padded.
 *
 * Deliberately a list and not a model call. Having the tutor judge this was
 * built and measured: it scored 7/10 against this list's 12/12, and it erred
 * in both directions - waving through students who gave up and, worse,
 * stonewalling students who had reasoned their way to the answer. A
 * misjudgement here withholds help from someone who earned it, so the
 * judgement is deterministic.
 */
const GIVE_UP = [
  "i dont know",
  "i don't know",
  "idk",
  "dunno",
  "no idea",
  "not sure",
  "just tell me",
  "tell me the answer",
  "give me the answer",
  "show me the answer",
  "no clue",
  "i give up",
];

/**
 * Did this message engage with the problem at all?
 *
 * A guess, a wrong-but-considered idea, a question about the concept and a
 * report of what they tried all count. Only an outright give-up does not.
 * Gameable by typing nonsense, which is accepted: the gate exists to stop
 * repeated clicking on untouched code, and typing nonsense repeatedly is more
 * effort than the behaviour it guards against.
 */
export function isAttempt(message: string): boolean {
  const text = (message ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!text) return false;
  return !GIVE_UP.some((phrase) => text.includes(phrase));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && npx jest src/__tests__/attemptTracker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/attemptTracker.ts extension/src/__tests__/attemptTracker.test.ts
git commit -m "Add isAttempt: did the student engage, or give up

A deterministic phrase list rather than a model verdict. Having the tutor
judge this was built and measured first: 7/10 against this list's 12/12,
wrong in both directions. Being wrongly judged as not trying withholds
help from a student who earned it, so nothing about it is left to chance."
```

---

### Task 3: Answering advances the ladder

**Files:**
- Modify: `extension/src/attemptTracker.ts` (`AttemptSignal`, `AttemptTracker.evaluate`)
- Modify: `extension/src/sidebarProvider.ts:496-499` (the `attempts.evaluate` call in `handleAsk`)
- Test: `extension/src/__tests__/attemptTracker.test.ts`
- Test: `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Consumes: `isAttempt(message: string): boolean` from Task 2.
- Produces: `AttemptTracker.evaluate(key: string, code: string, now?: number, answered?: boolean): AttemptEvaluation`, and the new `AttemptSignal` member `"answered"`. `now` stays the third positional parameter — 13 existing test call sites pass it positionally.

**The signal table this implements:**

| Code changed | Message is an attempt | Within cooldown | Signal | Escalates |
|---|---|---|---|---|
| yes | — | — | `changed` | yes |
| no | yes | — | `answered` | yes |
| no | no | yes | `unchanged` | no |
| no | no | no | `stalled` | yes |

Every `answered` escalates with no cooldown between them, so three non-give-up messages reach level 3. That is deliberate: level 3 is pseudocode only, so the worst case for someone typing nonsense is pseudocode, never a written fix.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/attemptTracker.test.ts`:

```ts
describe("AttemptTracker — answering counts as trying", () => {
  const CODE = "x = 1";

  it("escalates on an answer even though the code is untouched", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);

    const result = tracker.evaluate("file", CODE, 1100, true);

    expect(result.signal).toBe("answered");
    expect(result.escalate).toBe(true);
    expect(result.editSummary).toBe("");
    expect(result.cooldownRemainingMs).toBe(0);
  });

  it("still holds when they did not answer and did not edit", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);

    expect(tracker.evaluate("file", CODE, 1100, false).signal).toBe("unchanged");
  });

  it("prefers the real edit over the answer, so the diff survives", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);

    const result = tracker.evaluate("file", "x = 2", 1100, true);

    expect(result.signal).toBe("changed");
    expect(result.editSummary).toBe("1 - x = 1\n1 + x = 2");
  });

  it("lets three answers reach the top of the ladder", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);

    for (const at of [1100, 1200, 1300]) {
      expect(tracker.evaluate("file", CODE, at, true).escalate).toBe(true);
      tracker.record("file", CODE, at);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npx jest src/__tests__/attemptTracker.test.ts -t "answering counts"`

Expected: FAIL — the first test gets `"unchanged"`.

- [ ] **Step 3: Add the signal**

In `extension/src/attemptTracker.ts`, extend the `AttemptSignal` union — put the new member after `"changed"` and keep the existing comments:

```ts
export type AttemptSignal =
  /** No hint has been given for this file yet. */
  | "first"
  /** The student edited the code since the last hint. */
  | "changed"
  /** The code is untouched, but they reasoned about it in the chat. */
  | "answered"
  /** Nothing changed, but they have been sitting with it a while. */
  | "stalled"
  /** Nothing changed and they asked again immediately. */
  | "unchanged";
```

- [ ] **Step 4: Teach `evaluate` about it**

Replace `AttemptTracker.evaluate` with:

```ts
  /**
   * Decide how to treat the next hint request for `key` (one document).
   * Read-only: call `record` once the hint is actually delivered.
   *
   * `answered` is the student having reasoned in the chat since the last hint.
   * It escalates like an edit does, because a student working out a concept
   * out loud is trying - the old rule pinned them at hint 1 for talking.
   */
  evaluate(
    key: string,
    code: string,
    now: number = Date.now(),
    answered = false
  ): AttemptEvaluation {
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
    // Checked after the edit case on purpose: a real edit carries a diff the
    // tutor answers follow-ups against, and an answer has none to offer.
    if (answered) {
      return { signal: "answered", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
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

- [ ] **Step 5: Run to verify it passes**

Run: `cd extension && npx jest src/__tests__/attemptTracker.test.ts`

Expected: PASS.

- [ ] **Step 6: Write the failing sidebar test**

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
describe("answering in chat deepens the hint", () => {
  beforeEach(() => mock.__reset());

  it("does not show the same-depth block after a real answer", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;

    await h.send({ type: "askHint", question: "oh it should be a plus", code: CODE, mode: "hint" });

    const gate = h.posted.find((m: any) => m.mode === "attempt-gate");
    expect(gate).toBeUndefined();
    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("still shows it when they gave up instead", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;

    await h.send({ type: "askHint", question: "i dont know", code: CODE, mode: "hint" });

    const gate = h.posted.find((m: any) => m.mode === "attempt-gate");
    expect(gate).toBeDefined();
    expect(hintRequest(h.api).escalate).toBe(false);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `cd extension && npx jest src/__tests__/sidebarProvider.test.ts -t "deepens the hint"`

Expected: FAIL — the first test finds an `attempt-gate` post.

- [ ] **Step 8: Wire it into `handleAsk`**

In `extension/src/sidebarProvider.ts`, `handleAsk` currently reads:

```ts
    const attempt =
      mode === "hint"
        ? this.attempts.evaluate(this.lastDocumentKey, attemptCode)
        : undefined;
```

Replace with:

```ts
    const attempt =
      mode === "hint"
        ? this.attempts.evaluate(
            this.lastDocumentKey,
            attemptCode,
            Date.now(),
            isAttempt(question)
          )
        : undefined;
```

Add `isAttempt` to the existing `./attemptTracker` import:

```ts
import { AttemptTracker, isAttempt, nudgeForUnchangedCode } from "./attemptTracker";
```

- [ ] **Step 9: Run the full extension suite**

Run: `cd extension && npx jest && npx tsc --noEmit -p .`

Expected: all passing, tsc clean.

- [ ] **Step 10: Commit**

```bash
git add extension/src/attemptTracker.ts extension/src/sidebarProvider.ts extension/src/__tests__/attemptTracker.test.ts extension/src/__tests__/sidebarProvider.test.ts
git commit -m "Let reasoning out loud deepen the hint, not just editing

The ladder only moved when the code changed, so a student working through
a concept in the chat sat on hint 1 however well they answered. An answer
now escalates the way an edit does. Giving up still does not, and a real
edit still wins, because only an edit carries a diff worth sending."
```

---

### Task 4: Explain-first fires once per file

**Files:**
- Modify: `extension/src/sidebarProvider.ts:52` (the field), `:257`, `:265`, `:408-416`
- Test: `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. The private field `seenFingerprints: Set<string>` becomes `explainedFiles: Set<string>`.

**Context:** the gate keys on a fingerprint of the code, so every edit makes the file look new and re-fires the gate mid-conversation. It should key on the document instead. `this.lastDocumentKey` is `uri#label` for a named block, which would re-fire per function; use the document URI so it is genuinely once per file.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
describe("explain-first fires once per file", () => {
  beforeEach(() => mock.__reset());

  it("does not come back after the student edits the code", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "why is this wrong?", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeDefined();
    await h.send({ type: "explainSkip" });
    h.posted.length = 0;

    // The student edits, then asks again. The gate has already had its turn.
    await h.send({
      type: "askHint",
      question: "still stuck",
      code: CODE + "\n# tried something\n",
      mode: "hint",
    });

    expect(latest(h.posted, "explainFirst")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && npx jest src/__tests__/sidebarProvider.test.ts -t "once per file"`

Expected: FAIL — an `explainFirst` message is posted the second time.

- [ ] **Step 3: Rename the field**

In `extension/src/sidebarProvider.ts` line 52, replace:

```ts
  private seenFingerprints = new Set<string>();
```

with:

```ts
  /**
   * Files that have already been through the explain-first gate.
   *
   * Keyed on the document, not on a fingerprint of its contents: keyed on
   * contents, every edit made the file look new and the gate interrupted the
   * conversation again.
   */
  private explainedFiles = new Set<string>();
```

- [ ] **Step 4: Update the three call sites**

At line 257 in `askExternal`, replace:

```ts
    this.seenFingerprints.add(codeFingerprint(code ?? ""));
```

with:

```ts
    this.explainedFiles.add(this.lastFileKey);
```

At line 265 in `resetSession`, replace `this.seenFingerprints.clear();` with `this.explainedFiles.clear();`.

In `handleAskFromWebview`, replace:

```ts
    if (mode === "hint") {
      const fp = codeFingerprint(code ?? "");
      if (!this.seenFingerprints.has(fp)) {
        this.seenFingerprints.add(fp);
```

with:

```ts
    if (mode === "hint") {
      const fileKey = this.lastFileKey;
      if (!this.explainedFiles.has(fileKey)) {
        this.explainedFiles.add(fileKey);
```

- [ ] **Step 5: Add the file key**

`lastDocumentKey` is `uri#label`, which would re-fire the gate for each function in a file. Add a plain document key beside it. Put this getter next to `lastDocumentKey`'s declaration:

```ts
  /** The open document, ignoring which block the cursor is in. */
  private get lastFileKey(): string {
    return this.lastDocumentKey.split("#")[0];
  }
```

- [ ] **Step 6: Remove the now-unused import if it is unused**

Run `cd extension && npx tsc --noEmit -p .`. If `codeFingerprint` is no longer referenced in `sidebarProvider.ts`, remove it from the `./pedagogy` import list. If it is still used elsewhere in the file, leave the import alone.

- [ ] **Step 7: Run the full extension suite**

Run: `cd extension && npx jest && npx tsc --noEmit -p .`

Expected: all passing, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidebarProvider.ts extension/src/__tests__/sidebarProvider.test.ts
git commit -m "Ask the student to explain once per file, not once per edit

The gate keyed on a fingerprint of the code, so every edit made the file
look new and it interrupted the conversation again. It keys on the
document now."
```

---

### Task 5: One thread per function

**Files:**
- Modify: `extension/src/sidebarProvider.ts` — `:29-30`, `:36`, `:144-160`, `:264`, `:272`, `:305`, `:533`, `:570-571`, `sendFocus`
- Test: `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

**Context:** the hint ladder is already keyed per function via `lastDocumentKey`, but the transcript is one global list persisted in `globalState`. So the transcript being read and the hint level shown describe different things, and old conversations survive across days. Both the model-facing `history` and the rendered `bubbles` move into one in-memory map keyed the same way as the ladder.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
describe("one chat thread per function", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("swaps the transcript when the cursor moves to another function", async () => {
    const { provider, posted, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/threads/a.py");
    await provider["sendFocus"]();
    provider["threads"].set(provider["lastDocumentKey"], {
      history: [],
      bubbles: [{ role: "tutor", text: "about first" }],
    });
    posted.length = 0;

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    const restored = latest(posted, "restoreChat");
    expect(restored).toBeDefined();
    expect(restored.messages).toEqual([]);
  });

  it("brings the first thread back when the cursor returns", async () => {
    const { provider, posted, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/threads/b.py");
    await provider["sendFocus"]();
    const firstKey = provider["lastDocumentKey"];
    provider["threads"].set(firstKey, {
      history: [],
      bubbles: [{ role: "tutor", text: "about first" }],
    });

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();
    mock.window.activeTextEditor = mock.__makeEditor(doc, 1);
    posted.length = 0;
    await provider["sendFocus"]();

    expect(latest(posted, "restoreChat").messages).toEqual([
      { role: "tutor", text: "about first" },
    ]);
  });

  it("keeps nothing in globalState", async () => {
    const h = await build();
    await askPastTheGate(h);

    expect(h.state.get("edupeer.chatHistory")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd extension && npx jest src/__tests__/sidebarProvider.test.ts -t "one chat thread"`

Expected: FAIL — `provider["threads"]` is undefined.

- [ ] **Step 3: Add the thread store**

In `extension/src/sidebarProvider.ts`, delete the `CHAT_STATE_KEY` constant (line 29) and replace the `history` field (line 36) with:

```ts
  /**
   * One conversation per problem, keyed exactly as the hint ladder is.
   *
   * The ladder was already per function while the transcript was one global
   * list, so the transcript on screen and the level beside it described
   * different things. In memory rather than `globalState` because a
   * conversation belongs to the session that had it.
   */
  private threads = new Map<string, { history: ChatTurn[]; bubbles: unknown[] }>();
```

Add the accessor below it:

```ts
  /** The thread for the block the cursor is in, created on first use. */
  private get thread(): { history: ChatTurn[]; bubbles: unknown[] } {
    let thread = this.threads.get(this.lastDocumentKey);
    if (!thread) {
      thread = { history: [], bubbles: [] };
      this.threads.set(this.lastDocumentKey, thread);
    }
    return thread;
  }
```

Keep `MAX_PERSISTED_BUBBLES` (line 30) and re-comment it:

```ts
/** Cap on one thread's rendered bubbles, so a long session cannot grow forever. */
const MAX_PERSISTED_BUBBLES = 50;
```

- [ ] **Step 4: Replace every `this.history` use**

Four sites, all become `this.thread.history`:

- `:305` — `this.thread.history.push({ role: "tutor", content: res.exercise });`
- `:533` — `history: this.thread.history.slice(-MAX_HISTORY_TURNS),`
- `:570` — `this.thread.history.push({ role: "student", content: question });`
- `:571` — `this.thread.history.push({ role: "tutor", content: res.hint });`

At `:264` in `resetSession`, `this.history = [];` becomes a clear of the current thread only:

```ts
    this.threads.delete(this.lastDocumentKey);
```

- [ ] **Step 5: Point the webview messages at the thread**

In `resolveWebviewView`, the `ready` case currently reads from `globalState`:

```ts
          this.post({
            type: "restoreChat",
            messages: this.context.globalState.get<unknown[]>(CHAT_STATE_KEY, []),
          });
```

Replace with:

```ts
          this.post({ type: "restoreChat", messages: this.thread.bubbles });
```

Replace the whole `persistChat` case with:

```ts
        case "persistChat":
          this.thread.bubbles =
            (msg.messages as unknown[] | undefined)?.slice(-MAX_PERSISTED_BUBBLES) ?? [];
          return;
```

At `:272` in `resetSession`, delete the `globalState.update(CHAT_STATE_KEY, [])` line entirely — Step 4 already dropped the thread.

- [ ] **Step 6: Post the thread when the block changes**

In `sendFocus`, `this.lastDocumentKey` is assigned near the end. Capture the previous value before the assignment and post the new thread after it. Find:

```ts
    this.lastDocumentKey =
      focus.kind === "symbol" || focus.kind === "heuristic"
        ? `${doc.uri.toString()}#${focus.label}`
        : doc.uri.toString();
```

and replace with:

```ts
    const previousKey = this.lastDocumentKey;
    this.lastDocumentKey =
      focus.kind === "symbol" || focus.kind === "heuristic"
        ? `${doc.uri.toString()}#${focus.label}`
        : doc.uri.toString();
    // A different block is a different conversation. Swap the transcript so
    // the student is never reading one function's thread beside another
    // function's hint level.
    if (this.lastDocumentKey !== previousKey) {
      this.post({ type: "restoreChat", messages: this.thread.bubbles });
    }
```

- [ ] **Step 7: Run to verify they pass**

Run: `cd extension && npx jest src/__tests__/sidebarProvider.test.ts`

Expected: PASS.

- [ ] **Step 8: Run the full extension suite**

Run: `cd extension && npx jest && npx tsc --noEmit -p .`

Expected: all passing, tsc clean. Tests that assumed a persisted transcript across a reload will fail here — that behaviour is being removed on purpose, so update those tests to assert the new scoping rather than restoring the old field.

- [ ] **Step 9: Commit**

```bash
git add extension/src/sidebarProvider.ts extension/src/__tests__/sidebarProvider.test.ts
git commit -m "Give each function its own chat thread, gone when the window closes

The hint ladder was already keyed per function while the transcript was
one global list in globalState, so the conversation on screen and the
level beside it described different things - and old chats outlived the
session that had them. Both now live in one in-memory map keyed the way
the ladder already was. Reset clears the thread you are in, not all of
them."
```

---

### Task 6: The composer

**Files:**
- Modify: `extension/src/sidebarProvider.ts:794-808` (webview HTML), `:164-171` (the `askHint` case), `handleAskFromWebview`, `handleAsk`, `handleExplainAnswer`, `handleExplainSkip`
- Modify: `extension/media/main.js:26`, `:58`, `:243-258`, `:457`, `:465-471`
- Modify: `extension/media/style.css:751-800`
- Modify: `extension/src/progressPanel.ts:109-130`, `:264`
- Test: `extension/src/__tests__/webviewMain.test.ts`, `extension/src/__tests__/sidebarProvider.test.ts`, `extension/src/__tests__/progressPanel.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on.

**Context:** `confidence` is the only input to the dashboard's calibration score. The backend field keeps its `0` default, so `models.py`, `progress.py` and the endpoints are untouched — only the UI and the extension's sending of it go.

- [ ] **Step 1: Replace the webview tests that encode the old composer**

`webviewMain.test.ts` builds its DOM from the provider's own `getHtml()`, so the HTML change in Step 3 will break these on its own. Three existing places must change, and one must not:

- **Keep** `"sends on ctrl+enter"` (line 404) — Ctrl+Enter still sends.
- **Replace** `"does not send on a bare enter"` (line 413) — that behaviour reverses.
- **Delete** the whole `describe("confidence", …)` block (line 429).
- **Edit** `"resets the ladder and the confidence chips"` (line 621) — drop the two `.conf` lines and rename it `"resets the ladder"`.

Replace the test at line 413 with these three, using the file's existing `el` / `lastSent` helpers:

```ts
  it("sends on a bare enter", () => {
    (el("input") as HTMLTextAreaElement).value = "q";
    el("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(lastSent("askHint")).toBeDefined();
  });

  it("does not send on shift+enter, so the newline lands", () => {
    (el("input") as HTMLTextAreaElement).value = "q";
    el("input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })
    );
    expect(lastSent("askHint")).toBeUndefined();
  });

  it("has no confidence control", () => {
    expect(document.getElementById("confidence")).toBeNull();
    expect($$(".conf")).toHaveLength(0);
  });
```

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
it("offers a quiz, not a claim that you fixed it", async () => {
  const h = await build();
  expect(h.html).toContain(">Quiz me<");
  expect(h.html).not.toContain("I fixed it");
  expect(h.html).not.toContain("How sure are you?");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd extension && npx jest src/__tests__/webviewMain.test.ts -t "bare enter"` and `cd extension && npx jest src/__tests__/sidebarProvider.test.ts -t "Quiz me"`

Expected: both FAIL — a bare Enter does not send yet, and the HTML still says "I fixed it".

- [ ] **Step 3: Strip the HTML**

In `extension/src/sidebarProvider.ts`, delete the whole `<fieldset class="confidence" id="confidence"> … </fieldset>` block, and change the two buttons:

```html
      <button id="send" class="btn btn--primary">Ask<span class="btn__hint">↵</span></button>
      <button id="quiz" class="btn btn--ghost" title="Answer one question about why your fix works">Quiz me</button>
```

- [ ] **Step 4: Strip the webview script**

In `extension/media/main.js`:

- Delete `const confidenceEl = el("confidence");` (line 26).
- Delete `let confidence = 0;` (line 58).
- Delete the whole `// --- confidence` section (lines 243-258): `setConfidence` and its listener loop.
- In the `askHint` post (line 457), delete the `confidence:` property.
- Delete the `setConfidence(0);` call at the end of `send()`.
- Replace the keydown handler:

```js
  inputEl.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter is how you get a newline. Ctrl/Cmd+Enter still
    // works for anyone who learned it that way.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
```

- [ ] **Step 5: Strip the styles**

In `extension/media/style.css`, delete the `.confidence`, `.confidence__legend`, `.conf`, `.conf:hover` and `.conf[aria-pressed="true"]` rules (lines 751-800). Delete only those rules; leave everything around them.

- [ ] **Step 6: Stop sending and threading `confidence`**

In `extension/src/sidebarProvider.ts`:

- In the `askHint` case, drop the fourth argument: `await this.handleAskFromWebview(msg.question as string, msg.code as string, (msg.mode as TutorMode) ?? "hint");`
- Remove the `confidence: number` parameter from `handleAskFromWebview` and the `confidence` field from `pendingAsk`, and remove it from the `handleAsk` calls in `handleAskFromWebview`, `handleExplainAnswer` and `handleExplainSkip`.
- Remove `confidence?: number` from the `handleAsk` opts type and the `confidence:` line from the request object. The backend field defaults to `0`.

- [ ] **Step 7: Remove the calibration card**

In `extension/src/progressPanel.ts`, delete the `calibration` function (lines 109-130), its call at line 264, and the `.calibration*` CSS rules (lines 227-230). Leave `report.calibration` on the type — the backend still sends it.

- [ ] **Step 8: Run the full extension suite**

Run: `cd extension && npx jest && npx tsc --noEmit -p .`

Expected: all passing, tsc clean. Existing tests asserting a confidence value on the request, or the calibration card's markup, are testing removed behaviour — delete those tests rather than working around them.

- [ ] **Step 9: Commit**

```bash
git add extension/src/sidebarProvider.ts extension/src/progressPanel.ts extension/media/main.js extension/media/style.css extension/src/__tests__/
git commit -m "Clear the composer: Enter sends, no confidence, Quiz me

'How sure are you?' sat between the student and asking anything, and it
was the only input to the calibration score, so that card goes with it.
The backend field keeps its 0 default and is untouched.

Enter sends and Shift+Enter makes a newline, which is what everyone
expects. 'I fixed it' claimed something it did not do - it starts a quiz
about why the fix works, so it says that now."
```

---

### Task 7: Release 1.4.0

**Files:**
- Modify: `extension/package.json:5`
- Modify: `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: every previous task.
- Produces: `extension/edupeer-1.4.0.vsix`.

- [ ] **Step 1: Bump the version**

In `extension/package.json`, `"version": "1.3.1"` becomes `"version": "1.4.0"`. Minor, not patch: behaviour changes rather than fixes.

- [ ] **Step 2: Write the changelog entry**

At the top of `extension/CHANGELOG.md`, under `# Changelog`:

```markdown
## 1.4.0

- EduPeer answers you now. Tell it the right answer and it says so, explains
  why in a sentence, and moves you on, instead of asking the question you
  just answered. Every reply used to end with the same sentence, which is
  what made it feel like a loop; it closes on a question only when it is
  actually waiting on you.
- Working something out in the chat now counts as trying, so hints get
  deeper as you reason rather than only when you edit code. Saying "i dont
  know" still doesn't.
- The "explain it in your own words" prompt appears once per file instead of
  returning every time you change a line.
- Each function gets its own conversation, and conversations no longer
  outlive the window. The chat you are reading and the hint level beside it
  finally describe the same thing.
- Enter sends your message; Shift+Enter starts a new line.
- "How sure are you?" is gone, and with it the calibration score on the
  progress dashboard.
- The "I fixed it" button is called "Quiz me", which is what it does.
```

- [ ] **Step 3: Verify everything**

Run, from the repo root:

```bash
cd extension && npx jest && npx tsc --noEmit -p . && cd ..
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
```

Expected: both suites green.

- [ ] **Step 4: Package**

Run: `cd extension && npm run package`

Expected: `edupeer-1.4.0.vsix`.

- [ ] **Step 5: Verify the package contains the build**

Unzip the `.vsix` to a temp directory and confirm `extension/package.json` reads `1.4.0` and that `extension/out/extension.js` contains no `"How sure are you?"` string. A stale `.vsix` has shipped from this repo before; do not skip this.

- [ ] **Step 6: Commit**

```bash
git add extension/package.json extension/CHANGELOG.md
git commit -m "Release 1.4.0"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Tutor confirms a correct answer | 1 |
| 1. Delete forced closing line (both places) | 1 |
| 2. `isAttempt` phrase list | 2 |
| 2. `answered` signal and the signal table | 3 |
| 2. Same-depth only for `unchanged` | 3 (falls out of the table) |
| 3. Explain-first once per file | 4 |
| 4. One thread per function, in memory | 5 |
| 4. Reset clears the current thread only | 5 |
| 5. Composer, confidence, calibration, Quiz me, Enter | 6 |
| Testing section | folded into each task |

**Type consistency:** `isAttempt(message: string): boolean` is defined in Task 2 and consumed in Task 3 under that exact name. `AttemptTracker.evaluate` keeps `now` third so the 13 existing positional call sites still compile. `this.thread` is a getter returning `{ history: ChatTurn[]; bubbles: unknown[] }` in Task 5 and every consumer uses `.history` or `.bubbles`. `lastFileKey` is added in Task 4 and used only there.

**Existing tests that encode behaviour being reversed.** Each is named in the task that reverses it, with its replacement written out. An implementer who deletes one instead of replacing it loses the coverage:

| Test | File | Task |
|---|---|---|
| `test_appends_socratic_question_if_missing` | `backend/tests/test_hinting_engine.py:33` | 1 |
| `test_does_not_double_append_socratic_question` | `backend/tests/test_hinting_engine.py:38` | 1 |
| `"always ends with the tutor's closing question"` | `extension/src/__tests__/localTutor.test.ts:118` | 1 |
| `"does not send on a bare enter"` | `extension/src/__tests__/webviewMain.test.ts:413` | 6 |
| `describe("confidence", …)` | `extension/src/__tests__/webviewMain.test.ts:429` | 6 |
| `"resets the ladder and the confidence chips"` | `extension/src/__tests__/webviewMain.test.ts:621` | 6 |

`webviewMain.test.ts` builds its DOM from the provider's own `getHtml()` rather than a copy, so the composer change in Task 6 will fail these tests loudly rather than silently passing against stale markup. That is the design of that file and it is working as intended.
