import {
  AttemptTracker,
  HINT_COOLDOWN_MS,
  MAX_EDIT_SUMMARY_CHARS,
  nudgeForUnchangedCode,
  summarizeEdit,
} from "../attemptTracker";

describe("summarizeEdit", () => {
  it("returns nothing when the code is identical", () => {
    expect(summarizeEdit("a\nb", "a\nb")).toBe("");
  });

  it("reports a changed line as a removal and an addition", () => {
    const summary = summarizeEdit("a\nold\nc", "a\nnew\nc");
    expect(summary).toBe("2 - old\n2 + new");
  });

  it("numbers lines from 1", () => {
    expect(summarizeEdit("old", "new")).toBe("1 - old\n1 + new");
  });

  it("reports a pure insertion with no removal line", () => {
    expect(summarizeEdit("a\nc", "a\nb\nc")).toBe("2 + b");
  });

  it("reports a pure deletion with no addition line", () => {
    expect(summarizeEdit("a\nb\nc", "a\nc")).toBe("2 - b");
  });

  it("ignores untouched surrounding lines", () => {
    const summary = summarizeEdit("x\ny\nold\nz\nw", "x\ny\nnew\nz\nw");
    expect(summary).toBe("3 - old\n3 + new");
  });

  it("caps the number of reported lines", () => {
    const before = Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 40 }, (_, i) => `new ${i}`).join("\n");
    const summary = summarizeEdit(before, after, 4);
    expect(summary.split("\n")).toHaveLength(5);
    expect(summary).toContain("more changed line(s)");
  });

  it("truncates very long lines", () => {
    const summary = summarizeEdit("a", "b".repeat(500));
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(200);
  });

  it("never exceeds the size the backend accepts", () => {
    const before = Array.from({ length: 200 }, (_, i) => "x".repeat(300) + i).join("\n");
    const after = Array.from({ length: 200 }, (_, i) => "y".repeat(300) + i).join("\n");
    expect(summarizeEdit(before, after).length).toBeLessThanOrEqual(MAX_EDIT_SUMMARY_CHARS);
  });

  it("handles an empty starting file", () => {
    expect(summarizeEdit("", "print('hi')")).toBe("1 + print('hi')");
  });

  it("handles everything being deleted", () => {
    expect(summarizeEdit("print('hi')", "")).toBe("1 - print('hi')");
  });

  it("ignores trailing whitespace changes in the rendered text", () => {
    const summary = summarizeEdit("a\nb   \nc", "a\nb\nc");
    // The lines differ, so the edit is reported, but neither side shows the
    // stray spaces the student cannot see anyway.
    expect(summary).toBe("2 - b\n2 + b");
  });
});

describe("AttemptTracker", () => {
  const CODE = "x = 1";

  it("treats the first ask as a fresh start", () => {
    const tracker = new AttemptTracker();
    const result = tracker.evaluate("file", CODE, 1000);
    expect(result.signal).toBe("first");
    expect(result.escalate).toBe(true);
    expect(result.editSummary).toBe("");
  });

  it("holds the level when nothing changed and no time passed", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);
    const result = tracker.evaluate("file", CODE, 2000);
    expect(result.signal).toBe("unchanged");
    expect(result.escalate).toBe(false);
    expect(result.cooldownRemainingMs).toBe(HINT_COOLDOWN_MS - 1000);
  });

  it("escalates once the cooldown has elapsed", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);
    const result = tracker.evaluate("file", CODE, 1000 + HINT_COOLDOWN_MS);
    expect(result.signal).toBe("stalled");
    expect(result.escalate).toBe(true);
    expect(result.cooldownRemainingMs).toBe(0);
  });

  it("escalates immediately when the code changed", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", CODE, 1000);
    const result = tracker.evaluate("file", "x = 2", 1100);
    expect(result.signal).toBe("changed");
    expect(result.escalate).toBe(true);
    expect(result.editSummary).toBe("1 - x = 1\n1 + x = 2");
  });

  it("keeps documents independent", () => {
    const tracker = new AttemptTracker();
    tracker.record("a", CODE, 1000);
    expect(tracker.evaluate("b", CODE, 1100).signal).toBe("first");
  });

  it("does not record on evaluate alone", () => {
    const tracker = new AttemptTracker();
    tracker.evaluate("file", CODE, 1000);
    expect(tracker.evaluate("file", CODE, 1100).signal).toBe("first");
  });

  it("forgets one document on clear(key)", () => {
    const tracker = new AttemptTracker();
    tracker.record("a", CODE, 1000);
    tracker.record("b", CODE, 1000);
    tracker.clear("a");
    expect(tracker.evaluate("a", CODE, 1100).signal).toBe("first");
    expect(tracker.evaluate("b", CODE, 1100).signal).toBe("unchanged");
  });

  it("forgets everything on clear()", () => {
    const tracker = new AttemptTracker();
    tracker.record("a", CODE, 1000);
    tracker.clear();
    expect(tracker.evaluate("a", CODE, 1100).signal).toBe("first");
  });

  it("honours a custom cooldown", () => {
    const tracker = new AttemptTracker(5_000);
    tracker.record("file", CODE, 0);
    expect(tracker.evaluate("file", CODE, 4_999).escalate).toBe(false);
    expect(tracker.evaluate("file", CODE, 5_000).escalate).toBe(true);
  });

  it("re-records after each hint so the diff is always since the last one", () => {
    const tracker = new AttemptTracker();
    tracker.record("file", "a", 0);
    tracker.record("file", "b", 1000);
    expect(tracker.evaluate("file", "c", 2000).editSummary).toBe("1 - b\n1 + c");
  });
});

describe("nudgeForUnchangedCode", () => {
  it("tells the student what unlocks a deeper hint", () => {
    const text = nudgeForUnchangedCode(30_000);
    expect(text).toContain("haven't changed anything");
    expect(text).toContain("30s");
  });

  it("never counts down below one second", () => {
    expect(nudgeForUnchangedCode(1)).toContain("1s");
  });

  it("rounds part-seconds up", () => {
    expect(nudgeForUnchangedCode(4200)).toContain("5s");
  });
});
