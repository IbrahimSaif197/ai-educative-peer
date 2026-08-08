import { blockStyleFor, findEnclosingBlock, MAX_FOCUS_LINES } from "../blockHeuristics";

const PYTHON = [
  "import math",                        // 0
  "",                                   // 1
  "def calculate_average(numbers):",    // 2
  "    total = 0",                      // 3
  "    for n in numbers:",              // 4
  "        total += n",                 // 5
  "    return total / len(numbers)",    // 6
  "",                                   // 7
  "def main():",                        // 8
  "    print(calculate_average([]))",   // 9
];

const JS = [
  "const PI = 3.14;",                   // 0
  "",                                   // 1
  "function area(r) {",                 // 2
  "  if (r < 0) {",                     // 3
  "    return 0;",                      // 4
  "  }",                                // 5
  "  return PI * r * r;",               // 6
  "}",                                  // 7
  "",                                   // 8
  "area(2);",                           // 9
];

describe("blockStyleFor", () => {
  it("uses indentation for Python", () => {
    expect(blockStyleFor("python")).toBe("indent");
  });

  it("uses braces for the C family and its descendants", () => {
    for (const id of ["javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust"]) {
      expect(blockStyleFor(id)).toBe("brace");
    }
  });

  it("uses statement terminators for SQL", () => {
    expect(blockStyleFor("sql")).toBe("statement");
  });
});

describe("findEnclosingBlock — indentation languages", () => {
  it("returns the whole function from a line in its body", () => {
    expect(findEnclosingBlock(PYTHON, 5, "python")).toEqual({ start: 2, end: 6 });
  });

  it("returns the whole function from its own header line", () => {
    expect(findEnclosingBlock(PYTHON, 2, "python")).toEqual({ start: 2, end: 6 });
  });

  it("does not run past a blank line into the next function", () => {
    expect(findEnclosingBlock(PYTHON, 6, "python")).toEqual({ start: 2, end: 6 });
  });

  it("returns null for a top-level line with no enclosing def", () => {
    expect(findEnclosingBlock(PYTHON, 0, "python")).toBeNull();
  });
});

describe("findEnclosingBlock — brace languages", () => {
  it("returns the function including its closing brace", () => {
    expect(findEnclosingBlock(JS, 6, "javascript")).toEqual({ start: 2, end: 7 });
  });

  it("returns the outer function from inside a nested block", () => {
    expect(findEnclosingBlock(JS, 4, "javascript")).toEqual({ start: 2, end: 7 });
  });

  it("returns null for a line outside any function", () => {
    expect(findEnclosingBlock(JS, 9, "javascript")).toBeNull();
  });
});

describe("findEnclosingBlock — SQL statements", () => {
  const SQL = [
    "CREATE TABLE t (id INT);",         // 0
    "",                                 // 1
    "SELECT id,",                       // 2
    "       name",                      // 3
    "FROM t",                           // 4
    "WHERE id > 0;",                    // 5
  ];

  it("spans from the statement start to its terminator", () => {
    expect(findEnclosingBlock(SQL, 3, "sql")).toEqual({ start: 2, end: 5 });
  });

  it("handles a statement that is one line", () => {
    expect(findEnclosingBlock(SQL, 0, "sql")).toEqual({ start: 0, end: 0 });
  });
});

describe("findEnclosingBlock — limits", () => {
  it("caps a runaway block at MAX_FOCUS_LINES", () => {
    const long = ["def big():", ...Array.from({ length: 400 }, (_, i) => `    x = ${i}`)];
    const span = findEnclosingBlock(long, 300, "python");
    expect(span).not.toBeNull();
    expect(span!.end - span!.start + 1).toBeLessThanOrEqual(MAX_FOCUS_LINES);
  });

  it("returns null for an out-of-range cursor", () => {
    expect(findEnclosingBlock(PYTHON, 99, "python")).toBeNull();
    expect(findEnclosingBlock(PYTHON, -1, "python")).toBeNull();
  });

  it("returns null for an unsupported language", () => {
    expect(findEnclosingBlock(PYTHON, 5, "ruby")).toBeNull();
  });
});
