# EduPeer: a fourth rung, and an answer on request — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the hint ladder looping at level 3 by making level 4 the worked example, and give the student a direct answer when they ask for one plainly.

**Architecture:** The ladder's cap moves from 3 to 4, and level 4 selects the existing `WORKED_EXAMPLE_TEMPLATE` instead of the Socratic one — no new prompt for that half. A new `answer` tutor mode is routed client-side, before the attempt gate, so it neither advances nor spends a rung. The response gains a `mode` field so the panel can label a card by what the backend actually ran rather than what the client asked for.

**Tech Stack:** FastAPI + Pydantic + pytest (backend), TypeScript + Jest (extension), plain JS in the webview.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-edupeer-fourth-rung-and-answer-on-request-design.md`.
- Python: run everything through the project venv — `backend/.venv/Scripts/python.exe -m pytest`. A bare `pytest` or `uvicorn` hits a different venv without `firebase-admin`.
- Extension tests: `npm test` from `extension/`.
- Commit messages: no `Co-Authored-By` trailer.
- `MAX_HINT_LEVEL` is the single source of truth for the ladder's top. Never write a bare `4` for it outside `models.py`.
- Do not touch `GIVE_UP` or `isAttempt` in `attemptTracker.ts`. The routing change makes an edit there unnecessary; editing it anyway would change the give-up gate's behaviour, which is out of scope.

---

### Task 1: The ladder reaches four

**Files:**
- Modify: `backend/models.py:28` (add the constant), `backend/models.py:98` (`le=3` → `le=MAX_HINT_LEVEL`)
- Modify: `backend/session_store.py:1-7` (import), `:32-41` (`resolve_level`), `:66` (in-memory `commit_hint_level`), `:173` (Firestore `commit_hint_level`)
- Test: `backend/tests/test_session_store.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_HINT_LEVEL: int = 4` in `backend/models.py`, imported by `session_store.py` and (Task 2) `hinting_engine.py`. `resolve_level(current: int, escalate: bool) -> int` keeps its signature and now returns up to 4.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_session_store.py`, inside the existing `TestResolveLevel` class:

```python
    def test_escalating_from_three_reaches_the_worked_example(self):
        from session_store import resolve_level
        assert resolve_level(3, escalate=True) == 4

    def test_escalating_stops_at_four(self):
        from session_store import resolve_level
        assert resolve_level(4, escalate=True) == 4

    def test_not_escalating_reuses_level_four(self):
        from session_store import resolve_level
        assert resolve_level(4, escalate=False) == 4

    def test_a_corrupt_high_level_clamps_to_four(self):
        from session_store import resolve_level
        assert resolve_level(99, escalate=False) == 4
```

Note the last one replaces the meaning of the existing `test_a_corrupt_high_level_is_clamped`, which asserts `== 3`. Delete that older test — it is now asserting the bug.

Also append a new class at the end of the file:

```python
class TestBothStoresPersistLevelFour:
    """The fourth rung is only useful if it survives a commit/read cycle."""

    def test_in_memory_store_keeps_four(self):
        store = InMemorySessionStore()
        store.commit_hint_level("u1", "fp1", 4)
        assert store.peek_hint_level("u1", "fp1", escalate=False) == 4

    def test_firestore_store_keeps_four(self):
        store = FirestoreSessionStore(FakeFirestore())
        store.commit_hint_level("u1", "fp1", 4)
        assert store.peek_hint_level("u1", "fp1", escalate=False) == 4

    def test_the_in_memory_ladder_climbs_all_four_rungs(self):
        store = InMemorySessionStore()
        assert [store.next_hint_level("u1", "fp1") for _ in range(5)] == [1, 2, 3, 4, 4]

    def test_the_firestore_ladder_climbs_all_four_rungs(self):
        store = FirestoreSessionStore(FakeFirestore())
        assert [store.next_hint_level("u1", "fp1") for _ in range(5)] == [1, 2, 3, 4, 4]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_session_store.py -q -k "ResolveLevel or PersistLevelFour"` from `backend/`

Expected: FAIL — the escalation tests return 3 where 4 is asserted, and the persistence tests return 3 because `commit_hint_level` clamps.

- [ ] **Step 3: Add the constant**

In `backend/models.py`, after the `MAX_PROBLEM_KEY_CHARS = 512` line (currently line 28), add:

```python

# The top of the hint ladder. Rungs 1-3 are the Socratic ladder; rung 4 *is*
# the worked example - see `effective_mode` in hinting_engine.py. Kept here
# because both session_store (which walks the ladder) and hinting_engine
# (which picks a prompt for it) need the same number, and models.py is the
# only module both already depend on.
MAX_HINT_LEVEL = 4
```

- [ ] **Step 4: Widen the request schema**

In `backend/models.py`, change the `hint_level` field on `HintRequest` (line 98):

```python
    hint_level: int = Field(default=1, ge=1, le=MAX_HINT_LEVEL)
```

- [ ] **Step 5: Raise the cap in the store**

In `backend/session_store.py`, add the import after the existing `from firebase_admin import firestore` line:

```python
from models import MAX_HINT_LEVEL
```

Replace `resolve_level` (lines 32-41):

```python
def resolve_level(current: int, escalate: bool) -> int:
    """The level an ask should answer at, given the level already spent.

    Escalating advances by one and stops at `MAX_HINT_LEVEL`. Not escalating
    re-uses the level, with a floor of 1 so a first-ever non-escalating ask
    still gets a level-1 hint.

    The top rung is the worked example rather than a fourth Socratic hint:
    capping at 3 meant a stuck student got the same pseudocode back for every
    remaining ask, which is the loop this exists to break.
    """
    if escalate:
        return min(MAX_HINT_LEVEL, current + 1)
    return max(1, min(MAX_HINT_LEVEL, current))
```

Then in **both** stores' `commit_hint_level`, replace `max(1, min(3, int(level)))` with `max(1, min(MAX_HINT_LEVEL, int(level)))`. There are two occurrences — `InMemorySessionStore` (around line 66) and `FirestoreSessionStore` (around line 173, inside the `ref.set({...})` dict).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_session_store.py -q` from `backend/`

Expected: PASS, all tests in the file.

- [ ] **Step 7: Run the whole backend suite**

Run: `backend/.venv/Scripts/python.exe -m pytest -q` from `backend/`

Expected: PASS. If `tests/test_main.py::TestHintEndpoint::test_hint_level_caps_at_3` fails, that is expected — it loops 5 times and asserts 3. Update it in place to assert 4 and rename it `test_hint_level_caps_at_4`.

- [ ] **Step 8: Commit**

```bash
git add backend/models.py backend/session_store.py backend/tests/test_session_store.py backend/tests/test_main.py
git commit -m "The hint ladder reaches a fourth rung"
```

---

### Task 2: Level four selects the worked-example prompt

**Files:**
- Modify: `backend/hinting_engine.py` (imports, new `effective_mode`, `_prepare_hint_messages`)
- Test: `backend/tests/test_hinting_engine.py`

**Interfaces:**
- Consumes: `MAX_HINT_LEVEL` from `models.py` (Task 1).
- Produces: `effective_mode(mode: str, hint_level: int) -> str` in `hinting_engine.py`, returning `"worked-example"` for a level-4 `hint` request and the (validated) mode otherwise. `main.py` uses it in Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_hinting_engine.py`:

```python
class TestTheFourthRungIsTheWorkedExample:
    """Level 4 is not a fourth Socratic hint - it *is* the worked example.

    The worked-example prompt was previously reachable only by a button in the
    panel, which a stuck student had to notice at the moment they were least
    likely to go looking. Reaching level 3 and asking again now gets there on
    its own.
    """

    def _engine(self, response_text: str = "ok"):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _system_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[0]["content"]

    def test_effective_mode_is_worked_example_at_level_four(self):
        from hinting_engine import effective_mode
        assert effective_mode("hint", 4) == "worked-example"

    def test_effective_mode_is_hint_below_level_four(self):
        from hinting_engine import effective_mode
        assert [effective_mode("hint", n) for n in (1, 2, 3)] == ["hint"] * 3

    def test_effective_mode_leaves_other_modes_alone(self):
        # A translate or reflect request is not on the ladder, so its level -
        # whatever the client sent - must not turn it into a worked example.
        from hinting_engine import effective_mode
        assert effective_mode("translate", 4) == "translate"
        assert effective_mode("reflect", 4) == "reflect"

    def test_effective_mode_falls_back_to_hint_for_an_unknown_mode(self):
        from hinting_engine import effective_mode
        assert effective_mode("nonsense", 1) == "hint"

    def test_a_level_four_ask_gets_the_worked_example_prompt(self):
        engine = self._engine()
        engine.generate_hint("x = 1", "still stuck", 4)
        assert "WORKED EXAMPLE" in self._system_message(engine)

    def test_a_level_three_ask_still_gets_the_socratic_prompt(self):
        engine = self._engine()
        engine.generate_hint("x = 1", "still stuck", 3)
        system = self._system_message(engine)
        assert "hint_level 3: pseudocode only" in system
        assert "WORKED EXAMPLE" not in system

    def test_streaming_gets_the_worked_example_prompt_too(self):
        engine = self._engine()
        chunk = MagicMock()
        chunk.choices[0].delta.content = "hi"
        engine.client.chat.completions.create.return_value = [chunk]
        list(engine.stream_hint("x = 1", "still stuck", 4))
        assert "WORKED EXAMPLE" in self._system_message(engine)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -q -k "FourthRung"` from `backend/`

Expected: FAIL with `ImportError: cannot import name 'effective_mode'`, and the prompt-selection tests failing because level 4 is clamped to 3.

- [ ] **Step 3: Add `effective_mode`**

In `backend/hinting_engine.py`, change the models import line from `from models import MAX_FOCUS_LABEL_CHARS` to:

```python
from models import MAX_FOCUS_LABEL_CHARS, MAX_HINT_LEVEL
```

Then, directly below the `MODE_SYSTEM_TEMPLATES` dict, add:

```python
def clamp_hint_level(hint_level: int) -> int:
    """A usable rung number, whatever the client sent."""
    try:
        return max(1, min(MAX_HINT_LEVEL, int(hint_level)))
    except (TypeError, ValueError):
        return 1


def effective_mode(mode: str, hint_level: int) -> str:
    """The mode a request actually runs in, which is not always the one asked for.

    The ladder's top rung *is* the worked example, so a level-4 ask in `hint`
    mode runs `WORKED_EXAMPLE_TEMPLATE`. Two callers need to agree on this -
    `_prepare_hint_messages` to pick the prompt, and `/hint` to tell the panel
    what to label the card - so it is derived here once rather than in both.

    Modes that are not on the ladder keep their own prompt no matter what level
    the client sent: a `translate` request at level 4 is still a translation
    check.
    """
    if mode not in MODE_SYSTEM_TEMPLATES:
        mode = "hint"
    if mode == "hint" and clamp_hint_level(hint_level) >= MAX_HINT_LEVEL:
        return "worked-example"
    return mode
```

- [ ] **Step 4: Use it when building the prompt**

In `_prepare_hint_messages`, replace the first four lines of the body:

```python
        level = max(1, min(3, int(hint_level)))
        if mode not in MODE_SYSTEM_TEMPLATES:
            mode = "hint"
        lang = get_language(language)
```

with:

```python
        level = clamp_hint_level(hint_level)
        mode = effective_mode(mode, level)
        lang = get_language(language)
```

The function already returns `mode` as its second value, so the worked-example substitution propagates to `_finalize_hint` with no further change.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -q` from `backend/`

Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add backend/hinting_engine.py backend/tests/test_hinting_engine.py
git commit -m "Level four runs the worked-example prompt, not a fourth Socratic hint"
```

---

### Task 3: The response carries its effective mode

**Files:**
- Modify: `backend/models.py:142-145` (`HintResponse`)
- Modify: `backend/main.py:271` (`/hint` return), `backend/main.py:289` (stream `meta` event)
- Test: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `effective_mode` from `hinting_engine.py` (Task 2).
- Produces: `HintResponse.mode: str`, and a `mode` key on the stream's `meta` SSE event. The webview reads both in Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_main.py`:

```python
class TestTheResponseCarriesItsEffectiveMode:
    """The panel labels a card from the response, not from its own request.

    Without this the backend can silently switch a level-4 ask to a worked
    example and the panel still prints "hint 4" over it.
    """

    def test_an_ordinary_hint_reports_hint_mode(self, client):
        res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["mode"] == "hint"

    def test_a_level_four_hint_reports_worked_example(self, client):
        # Four escalating asks walk 1 -> 2 -> 3 -> 4.
        for _ in range(4):
            res = client.post("/hint", json=VALID_HINT_PAYLOAD)
        assert res.json()["hint_level"] == 4
        assert res.json()["mode"] == "worked-example"

    def test_a_non_hint_mode_reports_itself(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "reflect"}
        assert client.post("/hint", json=payload).json()["mode"] == "reflect"

    def test_the_stream_meta_event_carries_the_mode(self, client, monkeypatch):
        import main as app_main
        app_main._profile_cache.clear()

        def fake_stream(*args, **kwargs):
            yield {"type": "done", "hint": "h", "concept_tags": []}

        monkeypatch.setattr(app_main.engine, "stream_hint", fake_stream)
        res = client.post("/hint/stream", json=VALID_HINT_PAYLOAD)
        assert '"mode": "hint"' in res.text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_main.py -q -k "EffectiveMode"` from `backend/`

Expected: FAIL with `KeyError: 'mode'` on the response JSON, and the stream assertion failing because `meta` carries only `hint_level`.

- [ ] **Step 3: Add the field**

In `backend/models.py`, replace `HintResponse`:

```python
class HintResponse(BaseModel):
    hint: str
    hint_level: int
    concept_tags: List[str]
    # The mode the backend actually ran, which is not always `req.mode`: a
    # level-4 hint runs the worked example. The panel labels each card from
    # this, so without it a worked example arrives titled "hint 4".
    mode: str = "hint"
```

- [ ] **Step 4: Populate it on both endpoints**

In `backend/main.py`, add `effective_mode` to the existing `hinting_engine` import line:

```python
from hinting_engine import build_engine, effective_mode
```

Replace the `/hint` return (line 271):

```python
    return HintResponse(
        hint=hint_text,
        hint_level=level,
        concept_tags=concept_tags,
        mode=effective_mode(req.mode, level),
    )
```

And in `hint_stream`'s `event_source`, replace the `meta` line (line 289):

```python
        yield sse({"type": "meta", "hint_level": level, "mode": effective_mode(req.mode, level)})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_main.py -q` from `backend/`

Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/main.py backend/tests/test_main.py
git commit -m "The hint response reports the mode the backend actually ran"
```

---

### Task 4: `answer` mode on the backend

**Files:**
- Modify: `backend/models.py:12-16` (`TutorMode`)
- Modify: `backend/hinting_engine.py` (new `ANSWER_TEMPLATE`, `MODE_SYSTEM_TEMPLATES`)
- Test: `backend/tests/test_hinting_engine.py`, `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `MODE_SYSTEM_TEMPLATES` and `effective_mode` (Task 2).
- Produces: the `"answer"` literal accepted by `HintRequest.mode`, and `ANSWER_TEMPLATE` in `MODE_SYSTEM_TEMPLATES`. The extension sends this mode in Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_hinting_engine.py`:

```python
class TestAnswerMode:
    """Asked outright for the answer, the tutor gives it.

    Everything else in EduPeer withholds. This one mode does not - a student
    who has decided they want the answer will get it somewhere, and getting it
    here, with the bug named and the reasoning attached, beats getting it from
    a search engine with neither.
    """

    def _engine(self, response_text: str = "ok"):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(response_text)
        return engine

    def _system_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[0]["content"]

    def test_answer_mode_has_a_template(self):
        from hinting_engine import MODE_SYSTEM_TEMPLATES
        assert "answer" in MODE_SYSTEM_TEMPLATES

    def test_answer_mode_selects_its_own_prompt(self):
        engine = self._engine()
        engine.generate_hint("x = 1", "just tell me the answer", 1, mode="answer")
        assert "asked you outright for the answer" in self._system_message(engine)

    def test_the_answer_prompt_bounds_what_it_shows(self):
        from hinting_engine import ANSWER_TEMPLATE
        prompt = ANSWER_TEMPLATE.format(language="Python")
        assert "ONLY the line" in prompt
        assert "Never the whole function" in prompt

    def test_answer_mode_is_not_swapped_for_a_worked_example_at_level_four(self):
        # It is not on the ladder, so the level it happens to carry is inert.
        from hinting_engine import effective_mode
        assert effective_mode("answer", 4) == "answer"
```

Append to `backend/tests/test_main.py`:

```python
class TestAnswerModeEndpoint:
    def test_answer_mode_is_accepted(self, client):
        payload = {**VALID_HINT_PAYLOAD, "mode": "answer"}
        assert client.post("/hint", json=payload).status_code == 200

    def test_answer_mode_does_not_move_the_ladder(self, client):
        # Asking for the answer is neither an attempt nor a rung spent.
        client.post("/hint", json=VALID_HINT_PAYLOAD)  # level 1
        client.post("/hint", json={**VALID_HINT_PAYLOAD, "mode": "answer"})
        assert client.post("/hint", json=VALID_HINT_PAYLOAD).json()["hint_level"] == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py tests/test_main.py -q -k "AnswerMode"` from `backend/`

Expected: FAIL — `ImportError` on `ANSWER_TEMPLATE`, and a 422 on the endpoint because `"answer"` is not in the `TutorMode` literal.

- [ ] **Step 3: Add the template**

In `backend/hinting_engine.py`, add above `MODE_SYSTEM_TEMPLATES`:

```python
ANSWER_TEMPLATE = """You are EduPeer. The student has asked you outright for the answer, and this time they get it.

RULES:
- Name the bug in ONE sentence: what is wrong and where, citing the real line number
- Then show ONLY the line or lines that change, corrected. Never the whole function, never the whole file
- Then one short paragraph on WHY the original was wrong and why the fix works
- Do not lecture them for asking, and do not half-withhold: they asked plainly, and a grudging answer is worse than none
- If the code has more than one bug, answer the one they are asking about and say in a sentence that the others are there
- Keep responses under 200 words"""
```

Then add the entry to `MODE_SYSTEM_TEMPLATES`:

```python
    "answer": ANSWER_TEMPLATE,
```

- [ ] **Step 4: Accept the mode**

In `backend/models.py`, replace the `TutorMode` literal:

```python
TutorMode = Literal[
    "hint", "reflect", "translate", "worked-example",
    "explain-error", "explain-concept", "predict-output", "review-exercise",
    "subgoal-label", "trace-check", "answer",
]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `backend/.venv/Scripts/python.exe -m pytest -q` from `backend/`

Expected: PASS, whole suite. Note `tests/test_hinting_engine.py` has an existing test that loops over every mode name — if it enumerates a hardcoded tuple, add `"answer"` to it.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/hinting_engine.py backend/tests/test_hinting_engine.py backend/tests/test_main.py
git commit -m "Add an answer mode for a student who asks outright"
```

---

### Task 5: `isAnswerRequest`

**Files:**
- Modify: `extension/src/attemptTracker.ts` (append after `isAttempt`)
- Test: `extension/src/__tests__/attemptTracker.test.ts`

**Interfaces:**
- Consumes: the existing module-private `clausesOf` and `GIVE_UP_PADDING` in the same file.
- Produces: `export function isAnswerRequest(message: string): boolean`. `sidebarProvider.ts` imports it in Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/attemptTracker.test.ts`:

```ts
describe("isAnswerRequest", () => {
  it.each([
    "tell me the answer",
    "just tell me the answer",
    "give me the answer",
    "show me the answer",
    "what is the answer",
    "whats the answer",
    "show me the solution",
    "just fix it",
    "show me the code",
  ])("matches %p", (message) => {
    expect(isAnswerRequest(message)).toBe(true);
  });

  it("strips padding the way isAttempt does", () => {
    expect(isAnswerRequest("i really just want the answer please")).toBe(false);
    expect(isAnswerRequest("ok please just tell me the answer")).toBe(true);
  });

  it("ignores case and punctuation", () => {
    expect(isAnswerRequest("Just tell me the answer!")).toBe(true);
  });

  it("matches when it is one clause among several", () => {
    expect(isAnswerRequest("i tried the loop. just tell me the answer")).toBe(true);
  });

  // The bare "tell me" is in GIVE_UP but is far too vague to mean "solve it
  // for me" - "tell me more" and "tell me about ranges" both start that way.
  it("does not match the bare 'tell me'", () => {
    expect(isAnswerRequest("tell me")).toBe(false);
    expect(isAnswerRequest("tell me more about ranges")).toBe(false);
  });

  it("does not match giving up", () => {
    expect(isAnswerRequest("i dont know")).toBe(false);
    expect(isAnswerRequest("i give up")).toBe(false);
  });

  it("does not match an ordinary question", () => {
    expect(isAnswerRequest("what does range do")).toBe(false);
    expect(isAnswerRequest("is the answer 5")).toBe(false);
  });

  it("does not match empty input", () => {
    expect(isAnswerRequest("")).toBe(false);
    expect(isAnswerRequest("   ")).toBe(false);
  });
});
```

Add `isAnswerRequest` to the existing import at the top of that test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/__tests__/attemptTracker.test.ts -t "isAnswerRequest"` from `extension/`

Expected: FAIL — `isAnswerRequest is not a function`.

- [ ] **Step 3: Implement it**

Append to `extension/src/attemptTracker.ts`, after `isAttempt`:

```ts
/**
 * Phrases that mean "stop guiding me and give me the fix".
 *
 * Entries are written in their padding-stripped form, because that is what
 * they are matched against — exactly like `GIVE_UP` above. "just" is padding,
 * so "just fix it" arrives here as "fix it" and the entry reads that way;
 * writing "just fix it" in this set would never match anything.
 *
 * Deliberately excludes the bare "tell me", which `GIVE_UP` does contain:
 * there it is safe because it only holds the ladder, but here it would route
 * "tell me more about ranges" straight past the Socratic tutor to the answer.
 */
const ANSWER_REQUEST = new Set([
  "tell me the answer",
  "give me the answer",
  "show me the answer",
  "what is the answer",
  "whats the answer",
  "show me the solution",
  "give me the solution",
  "whats the fix",
  "fix it",
  "show me the code",
]);

/**
 * Is the student asking outright for the answer?
 *
 * True for any clause in the message, so a student who describes what they
 * tried and *then* asks for the answer still gets it — the request is the
 * signal, and burying it behind a sentence of context does not make it less
 * of one.
 *
 * Routed before the attempt gate in `handleAskFromWebview`, so these phrases
 * never reach `isAttempt`. That is why `GIVE_UP` still contains three of them
 * unchanged: they no longer get that far.
 */
export function isAnswerRequest(message: string): boolean {
  return clausesOf(message).some((clause) => {
    const core = clause
      .split(" ")
      .filter((word) => !GIVE_UP_PADDING.has(word))
      .join(" ");
    return ANSWER_REQUEST.has(core);
  });
}
```

Trace one phrase by hand to confirm the stripping lines up: `"ok please just tell me the answer"` splits to one clause, `GIVE_UP_PADDING` removes `ok`, `please` and `just`, and the remaining `"tell me the answer"` is in the set. `"i really just want the answer please"` strips to `"want the answer"`, which is not — matching the test above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/__tests__/attemptTracker.test.ts` from `extension/`

Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add extension/src/attemptTracker.ts extension/src/__tests__/attemptTracker.test.ts
git commit -m "Recognise a student asking outright for the answer"
```

---

### Task 6: Route `answer` mode

**Files:**
- Modify: `extension/src/pedagogy.ts:6-16` (`TutorMode`)
- Modify: `extension/src/sidebarProvider.ts:4` (import), `:489-494` (`handleAskFromWebview`)
- Test: `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Consumes: `isAnswerRequest` from `attemptTracker.ts` (Task 5).
- Produces: asks whose text matches now reach the backend with `mode: "answer"`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/sidebarProvider.test.ts`, using the helpers that file already defines: `build(overrides?)` returns a `Harness` with `h.send(...)`, `h.posted` and `h.api`; `hintRequest(h.api)` returns the last request handed to `streamHint`; `latest(h.posted, type)` finds the most recent posted message of a type.

```ts
describe("answer on request", () => {
  beforeEach(() => mock.__reset());

  it("routes an outright request to answer mode", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "just tell me the answer", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).mode).toBe("answer");
  });

  it("leaves an ordinary question in hint mode", async () => {
    const h = await build();
    await askPastTheGate(h, "what does range do");
    expect(hintRequest(h.api).mode).toBe("hint");
  });

  it("skips the explain-first gate", async () => {
    // Explain-first guards hint mode only. An answer request must not be held
    // behind "explain it in your own words" before the student sees anything —
    // note this test deliberately uses h.send directly rather than
    // askPastTheGate, because the gate firing at all is the failure.
    const h = await build();
    await h.send({ type: "askHint", question: "just tell me the answer", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeUndefined();
  });

  it("does not spend a rung", async () => {
    // Not a hint, so `attempts.evaluate` never runs: the first real hint that
    // follows still starts the ladder at 1.
    const h = await build();
    await h.send({ type: "askHint", question: "show me the solution", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).mode).toBe("answer");
    await askPastTheGate(h);
    expect(hintRequest(h.api).mode).toBe("hint");
  });
});
```

- [ ] **Step 1b: Confirm the harness reaches the answer path**

`build()` and `askPastTheGate` are defined near the top of the file (around lines 21-183). Read them before writing the block above; if `build` takes a different argument shape than shown, use the file's version rather than adapting the file to this plan.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/__tests__/sidebarProvider.test.ts -t "answer on request"` from `extension/`

Expected: FAIL — the mode stays `"hint"`, and the explain-first gate fires.

- [ ] **Step 3: Widen the mode union**

In `extension/src/pedagogy.ts`, add `"answer"` to `TutorMode`:

```ts
export type TutorMode =
  | "hint"
  | "reflect"
  | "translate"
  | "worked-example"
  | "explain-error"
  | "explain-concept"
  | "predict-output"
  | "review-exercise"
  | "subgoal-label"
  | "trace-check"
  | "answer";
```

- [ ] **Step 4: Route it**

In `extension/src/sidebarProvider.ts`, add `isAnswerRequest` to the `attemptTracker` import (line 4):

```ts
import { AttemptTracker, isAnswerRequest, isAttempt, nudgeForUnchangedCode } from "./attemptTracker";
```

Then in `handleAskFromWebview`, immediately after the existing `looksLikeErrorText` check:

```ts
    // A pasted stack trace or compiler error is a lesson in reading errors,
    // not a level-1 hint.
    if (mode === "hint" && looksLikeErrorText(question)) {
      mode = "explain-error";
    }
    // Asked outright for the answer. Routed here, before the attempt gate, so
    // it neither advances nor spends a rung — and so the three of these
    // phrases that also sit in `GIVE_UP` never reach it to be scored as
    // giving up.
    if (mode === "hint" && isAnswerRequest(question)) {
      mode = "answer";
    }
```

Because `mode` is no longer `"hint"`, the explain-first block below it is skipped and `handleAsk` builds a non-hint request — no `attempts.evaluate` call, no ladder commit. No further edit is needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test` from `extension/`

Expected: PASS, whole suite.

- [ ] **Step 6: Commit**

```bash
git add extension/src/pedagogy.ts extension/src/sidebarProvider.ts extension/src/__tests__/sidebarProvider.test.ts
git commit -m "Route an outright request for the answer to answer mode"
```

---

### Task 7: The panel shows four rungs and drops the button

**Files:**
- Modify: `extension/media/main.js:31-44` (`MODE_LABEL`), `:164` (dot loop), `:477-489` (`handleHint`), `:505-523` (action row)
- Test: `extension/src/__tests__/webviewMain.test.ts`

**Interfaces:**
- Consumes: `HintResponse.mode` (Task 3), `"answer"` mode (Task 4).
- Produces: nothing downstream — this is the last task.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/webviewMain.test.ts`, matching the file's existing `post(...)` helper:

```ts
describe("the fourth rung", () => {
  it("renders four dots on the ladder", () => {
    post({ type: "hint", hint: "h", hint_level: 1, concept_tags: [], mode: "hint" });
    expect(document.querySelectorAll(".ladder__dot").length).toBe(4);
  });

  it("fills all four at level four", () => {
    post({ type: "hint", hint: "h", hint_level: 4, concept_tags: [], mode: "worked-example" });
    expect(document.querySelectorAll(".ladder__dot.is-on").length).toBe(4);
  });

  it("keeps the ladder on a level-four worked example", () => {
    // It arrives as mode "worked-example", but it is still rung four - the
    // student needs to see they have reached the end of the ladder.
    post({ type: "hint", hint: "1. do a thing", hint_level: 4, concept_tags: [], mode: "worked-example" });
    expect(document.querySelector(".ladder")).not.toBeNull();
    expect(document.querySelector(".turn__eyebrow")?.textContent).toBe("Worked example");
  });

  it("shows no ladder on an answer card", () => {
    post({ type: "hint", hint: "Line 11 should be...", hint_level: 1, concept_tags: [], mode: "answer" });
    expect(document.querySelector(".ladder")).toBeNull();
    expect(document.querySelector(".turn__eyebrow")?.textContent).toBe("Answer");
  });

  it("no longer offers a worked-example button at level three", () => {
    post({ type: "hint", hint: "h", hint_level: 3, concept_tags: [], mode: "hint" });
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Show a worked example");
    expect(labels).toContain("Submit my translation");
  });
});
```

The existing test `"offers translation and worked-example actions at depth three"` (around line 395) asserts the button is present. Update it to assert only the translation action, and rename it `"offers the translation action at depth three"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/__tests__/webviewMain.test.ts -t "the fourth rung"` from `extension/`

Expected: FAIL — three dots rendered, no ladder on a worked example, no `Answer` label, and the button still present.

- [ ] **Step 3: Label the new modes**

In `extension/media/main.js`, add to `MODE_LABEL` (after the `"trace-check"` line):

```js
    answer: "Answer",
```

- [ ] **Step 4: Render four dots**

Change the dot loop bound (line 164) from `i <= 3` to `i <= 4`:

```js
      for (let i = 1; i <= 4; i++) {
```

- [ ] **Step 5: Keep the ladder on a worked example**

In `main.js`, add beside `FLAGGED_MODES` (line 47):

```js
  /** Modes that occupy a rung on the hint ladder, so the card shows its depth. */
  const LADDER_MODES = new Set(["hint", "worked-example"]);
```

Then in `handleHint`, replace the `level` line (line 486):

```js
      level: LADDER_MODES.has(mode) ? level : 0,
```

The eyebrow line above it is unchanged: `mode === "hint"` still means no eyebrow, so an ordinary hint looks exactly as it did, while a level-4 worked example now gets both its "Worked example" eyebrow and its four-dot ladder.

- [ ] **Step 6: Drop the button**

Replace the level-3 action row (lines 505-523) with the translation action alone:

```js
    if (mode === "hint" && level === 3) {
      addActionRow([
        {
          label: "Submit my translation",
          onClick: () =>
            setComposerMode("translate", "Paste your code translation of the pseudocode…"),
        },
      ]);
    }
```

The `if (mode === "worked-example")` block below it, offering **Label the steps**, stays exactly as it is — it now fires off the ladder's fourth rung instead of off a button press.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test` from `extension/`

Expected: PASS, whole suite (786+ tests).

- [ ] **Step 8: Run the backend suite once more**

Run: `backend/.venv/Scripts/python.exe -m pytest -q` from `backend/`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add extension/media/main.js extension/src/__tests__/webviewMain.test.ts
git commit -m "The panel shows four rungs, and the worked example arrives without a button"
```

---

## Verification

After Task 7, before merging:

- [ ] `backend/.venv/Scripts/python.exe -m pytest -q` from `backend/` — all green
- [ ] `npm test` from `extension/` — all green
- [ ] Walk the ladder by hand against `demos/demo.py`: ask four times on `average`, confirming the cards read hint 1 → 2 → 3 → 4, that the fourth is a worked example on a *different* problem, and that a fifth ask produces a second, different worked example
- [ ] Type "just tell me the answer" on a fresh function and confirm the card is labelled `Answer`, names the line, shows only the changed lines, and leaves the depth where it was
- [ ] Confirm no **Show a worked example** button appears at level 3
