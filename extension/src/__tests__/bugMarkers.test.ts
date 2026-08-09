import { findBugMarkers } from "../bugMarkers";

/** Apply the markers to the source, the way the editor edit will. */
function strip(lines: string[], languageId: string): string[] {
  const markers = findBugMarkers(lines, languageId);
  const out = [...lines];
  // Back to front so earlier edits do not shift later indices.
  for (const m of [...markers].reverse()) {
    if (m.wholeLine) out.splice(m.line, 1);
    else out[m.line] = out[m.line].slice(0, m.start) + out[m.line].slice(m.end);
  }
  return out;
}

describe("findBugMarkers — line comments", () => {
  it("finds a trailing Python marker and leaves the code", () => {
    const lines = ["    return a - b          # bug: subtracts instead of adds"];
    expect(strip(lines, "python")).toEqual(["    return a - b"]);
  });

  it("finds a trailing // marker in the C family", () => {
    const lines = ["  return a - b; // bug: subtracts instead of adds"];
    expect(strip(lines, "javascript")).toEqual(["  return a - b;"]);
  });

  it("finds a SQL -- marker", () => {
    const lines = ["SELECT * FROM t; -- bug: no where clause"];
    expect(strip(lines, "sql")).toEqual(["SELECT * FROM t;"]);
  });

  it("removes the whole line when the comment is all there is", () => {
    const lines = ["def f():", "    # bug: returns nothing", "    pass"];
    expect(strip(lines, "python")).toEqual(["def f():", "    pass"]);
  });

  it("finds every marker in a file, not just the first", () => {
    const lines = [
      "a = 1  # bug: one",
      "b = 2",
      "c = 3  # bug: two",
    ];
    expect(strip(lines, "python")).toEqual(["a = 1", "b = 2", "c = 3"]);
  });
});

describe("findBugMarkers — block comments", () => {
  it("finds a C block marker", () => {
    const lines = ["    return a - b; /* bug: subtracts instead of adds */"];
    expect(strip(lines, "c")).toEqual(["    return a - b;"]);
  });

  it("leaves code that follows the block comment", () => {
    const lines = ["int x; /* bug: uninitialised */ int y;"];
    expect(strip(lines, "c")).toEqual(["int x; int y;"]);
  });
});

describe("findBugMarkers — what it must not touch", () => {
  it("ignores prose that merely mentions a bug", () => {
    // demos/demo.rs really does contain this line.
    const lines = ["    // Off-by-one style bug: index 4 does not exist for 4 words."];
    expect(findBugMarkers(lines, "rust")).toEqual([]);
  });

  it("ignores a marker inside a string literal", () => {
    const lines = ['print("# bug: not a comment")'];
    expect(findBugMarkers(lines, "python")).toEqual([]);
  });

  it("ignores an ordinary comment", () => {
    const lines = ["x = 1  # this explains something"];
    expect(findBugMarkers(lines, "python")).toEqual([]);
  });

  it("ignores a TODO or FIXME", () => {
    const lines = ["x = 1  # TODO: fix the bug", "y = 2  // FIXME: bug here"];
    expect(findBugMarkers(lines, "python")).toEqual([]);
  });

  it("returns nothing for an unsupported language", () => {
    expect(findBugMarkers(["x = 1 # bug: nope"], "ruby")).toEqual([]);
  });

  it("returns nothing for a clean file", () => {
    expect(findBugMarkers(["def f():", "    return 1"], "python")).toEqual([]);
  });
});

describe("findBugMarkers — shape", () => {
  it("reports a span that starts after the code, not at the comment token", () => {
    const [marker] = findBugMarkers(["x = 1   # bug: whatever"], "python");
    expect(marker).toMatchObject({ line: 0, start: 5, wholeLine: false });
    expect(marker.end).toBe("x = 1   # bug: whatever".length);
  });

  it("accepts BUG: in any case and without a space", () => {
    expect(findBugMarkers(["x = 1  #BUG:nope"], "python")).toHaveLength(1);
    expect(findBugMarkers(["x = 1  # Bug : spaced"], "python")).toHaveLength(1);
  });
});
