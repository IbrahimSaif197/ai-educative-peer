import {
  AnnotationStore,
  ContentChange,
  lineDelta,
} from "../annotationStore";
import type { LineFlag } from "../apiClient";

/** A flag over 1-based lines `start`..`end`, as the backend sends them. */
function flag(start: number, end: number, question = "why?"): LineFlag {
  return {
    line: start,
    end_line: end,
    question,
    concept: "loops",
    severity: "info",
  };
}

/** A replacement of 0-based lines `from`..`to` with `inserted` lines. */
function change(from: number, to: number, inserted: number): ContentChange {
  return { startLine: from, endLine: to, insertedLineCount: inserted };
}

/**
 * A span wide enough to hold every flag these tests seed with, standing in
 * for "the whole file was just scanned" now that seeding requires a span.
 */
const wholeFile = { start: 0, end: 100 };

describe("lineDelta", () => {
  it("is zero for an edit inside one line", () => {
    expect(lineDelta(change(2, 2, 1))).toBe(0);
  });

  it("is positive when a newline is typed", () => {
    expect(lineDelta(change(2, 2, 2))).toBe(1);
  });

  it("is negative when lines are collapsed", () => {
    expect(lineDelta(change(2, 4, 1))).toBe(-2);
  });
});

describe("AnnotationStore.applyChanges", () => {
  it("shifts a flag down when lines are inserted above it", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(10, 12)]);

    store.applyChanges([change(0, 0, 4)]); // 3 new lines at the top

    expect(store.flags()).toEqual([
      expect.objectContaining({ line: 13, end_line: 15 }),
    ]);
  });

  it("shifts a flag up when lines are deleted above it", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(10, 12)]);

    store.applyChanges([change(0, 2, 1)]); // 3 lines become 1

    expect(store.flags()).toEqual([
      expect.objectContaining({ line: 8, end_line: 10 }),
    ]);
  });

  it("drops a flag when the edit lands inside it", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(10, 12)]);

    store.applyChanges([change(10, 10, 1)]); // 0-based line 10 == 1-based 11

    expect(store.flags()).toEqual([]);
  });

  it("leaves a flag alone when the edit is below it", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(10, 12)]);

    store.applyChanges([change(40, 40, 1)]);

    expect(store.flags()).toEqual([
      expect.objectContaining({ line: 10, end_line: 12 }),
    ]);
  });

  it("drops a flag when a multi-line replace spans it", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(10, 12)]);

    store.applyChanges([change(5, 20, 1)]);

    expect(store.flags()).toEqual([]);
  });

  it("applies every change against pre-edit coordinates, in any order", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(30, 30)]);

    // VS Code delivers contentChanges in reverse document order.
    store.applyChanges([change(20, 20, 3), change(5, 5, 3)]);

    // Four lines added above by each change: +2 and +2.
    expect(store.flags()).toEqual([
      expect.objectContaining({ line: 34, end_line: 34 }),
    ]);
  });

  it("drops the hint and lens state for a line that was edited", () => {
    const store = new AnnotationStore();
    store.setHint(9, { hint: "what if it is empty?", concept: "lists" });
    store.setLensState(9, { kind: "ready", hint: "what if it is empty?" });

    store.applyChanges([change(9, 9, 1)]);

    expect(store.annotationsAt(9).hint).toBeUndefined();
    expect(store.lensStateAt(9)).toEqual({ kind: "idle" });
  });

  it("moves a hint with its line when text is inserted above", () => {
    const store = new AnnotationStore();
    store.setHint(9, { hint: "off by one?", concept: "loops" });

    store.applyChanges([change(0, 0, 3)]);

    expect(store.annotationsAt(9).hint).toBeUndefined();
    expect(store.annotationsAt(11).hint).toEqual({
      hint: "off by one?",
      concept: "loops",
    });
  });
});

describe("AnnotationStore lookups", () => {
  it("finds the flag covering a line anywhere in its span", () => {
    const store = new AnnotationStore();
    store.setFlagsIn(wholeFile, [flag(10, 12)]);

    expect(store.annotationsAt(10).flag).toBeDefined(); // 0-based 10 == 1-based 11
    expect(store.annotationsAt(13).flag).toBeUndefined();
  });

  it("reports idle for a line that has never been asked about", () => {
    expect(new AnnotationStore().lensStateAt(4)).toEqual({ kind: "idle" });
  });
});

describe("AnnotationStore.revision", () => {
  it("starts at zero and is unmoved by writes that invalidate nothing", () => {
    const store = new AnnotationStore();
    const start = store.revision;

    store.setFlagsIn(wholeFile, [flag(3, 3)]);
    store.setHint(2, { hint: "off by one?", concept: "loops" });
    store.setLensState(2, { kind: "loading" });
    store.clearHint(2);

    expect(store.revision).toBe(start);
  });

  it("moves when an edit ages the annotations", () => {
    const store = new AnnotationStore();
    const start = store.revision;

    store.applyChanges([change(0, 0, 2)]);

    expect(store.revision).toBeGreaterThan(start);
  });

  it("does not move for an empty change batch, matching the early return", () => {
    const store = new AnnotationStore();
    const start = store.revision;

    store.applyChanges([]);

    expect(store.revision).toBe(start);
  });

  it("moves when the student dismisses a line", () => {
    const store = new AnnotationStore();
    const start = store.revision;

    store.clearLine(4);

    expect(store.revision).toBeGreaterThan(start);
  });
});

describe("AnnotationStore.clearHint", () => {
  it("forgets the hint and leaves the lens state alone", () => {
    const store = new AnnotationStore();
    store.setHint(4, { hint: "off by one?", concept: "loops" });
    store.setLensState(4, { kind: "empty" });

    store.clearHint(4);

    expect(store.annotationsAt(4).hint).toBeUndefined();
    expect(store.lensStateAt(4)).toEqual({ kind: "empty" });
  });
});

/**
 * The revision guard in `inlineTutor.fetchLineHint` is store-wide, so a bump
 * invalidates EVERY in-flight write-back — not only the one whose line moved.
 * Nothing is therefore coming to resolve any surviving `loading` state, and one
 * left behind renders as a "⏳ EduPeer is thinking…" lens that waits forever
 * while the status bar's spinner correctly clears.
 */
describe("AnnotationStore — a revision bump orphans every loading state", () => {
  function loadingAt(line: number) {
    const store = new AnnotationStore();
    store.setLensState(line, { kind: "loading" });
    return store;
  }

  const states = (store: AnnotationStore) =>
    store.activeLensLines().map((line) => [line, store.lensStateAt(line).kind]);

  it("drops it when the edit is above the line", () => {
    const store = loadingAt(4);
    store.applyChanges([change(0, 0, 2)]);
    expect(states(store)).toEqual([]);
  });

  it("drops it when the edit is below the line", () => {
    const store = loadingAt(4);
    store.applyChanges([change(9, 9, 2)]);
    expect(states(store)).toEqual([]);
  });

  it("drops it when the edit is on the line", () => {
    const store = loadingAt(4);
    store.applyChanges([change(4, 4, 1)]);
    expect(states(store)).toEqual([]);
  });

  it("drops it when an unrelated line is dismissed", () => {
    const store = loadingAt(4);
    store.clearLine(9);
    expect(states(store)).toEqual([]);
  });

  it("leaves states that are already resolved alone", () => {
    const store = new AnnotationStore();
    store.setLensState(4, { kind: "ready", hint: "off by one?" });
    store.setLensState(6, { kind: "error", reason: "llm", message: "nope" });

    store.applyChanges([change(9, 9, 2)]);

    expect(states(store)).toEqual([
      [4, "ready"],
      [6, "error"],
    ]);
  });
});

// `AnnotationStore` and `LineFlag` are already imported above, and `flag(start,
// end, question)` above already makes a single-line flag via `flag(n, n)`, so
// this block reuses both rather than redeclaring them under the same names.
describe("a scan of one block leaves the other blocks alone", () => {
  it("keeps flags outside the scanned span", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5, 5)]);
    store.setFlagsIn({ start: 40, end: 60 }, [flag(45, 45)]);
    expect(store.flags().map((f) => f.line).sort((a, b) => a - b)).toEqual([5, 45]);
  });

  it("replaces flags inside the scanned span", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5, 5, "First")]);
    store.setFlagsIn({ start: 0, end: 20 }, [flag(7, 7, "Second")]);
    expect(store.flags()).toHaveLength(1);
    expect(store.flags()[0].question).toBe("Second");
  });

  it("clears a block whose scan came back clean", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5, 5)]);
    store.setFlagsIn({ start: 0, end: 20 }, []);
    expect(store.flags()).toEqual([]);
  });

  it("drops a flag that merely overlaps the scanned span", () => {
    // A multi-line flag straddling the boundary was written against code the
    // new scan has just re-read. Keeping it would double up.
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [{ ...flag(18, 18), end_line: 22 }]);
    store.setFlagsIn({ start: 20, end: 40 }, []);
    expect(store.flags()).toEqual([]);
  });

  it("still converts to and from the wire's 1-based lines", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5, 5)]);
    expect(store.annotationsAt(4).flag?.line).toBe(5);
  });
});
