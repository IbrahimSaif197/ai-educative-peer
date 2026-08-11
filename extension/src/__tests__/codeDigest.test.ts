import {
  bandLineCount,
  buildDigest,
  FOCUS_MARGIN_LINES,
  toBands,
} from "../codeDigest";

const PY = [
  "import math",                      // line 1
  "",                                 // line 2
  "def area(r):",                     // line 3
  "    return math.pi * r * r",       // line 4
  "",                                 // line 5
  "def main():",                      // line 6
  "    print(area(2))",               // line 7
];

describe("toBands", () => {
  it("collapses a run of consecutive lines into one band", () => {
    expect(toBands([3, 4, 5])).toEqual([{ start: 3, end: 5 }]);
  });

  it("splits at a gap and sorts ascending", () => {
    expect(toBands([9, 1, 2])).toEqual([
      { start: 1, end: 2 },
      { start: 9, end: 9 },
    ]);
  });

  it("de-duplicates repeated line numbers", () => {
    expect(toBands([4, 4, 5])).toEqual([{ start: 4, end: 5 }]);
  });

  it("returns nothing for no lines", () => {
    expect(toBands([])).toEqual([]);
  });
});

describe("bandLineCount", () => {
  it("counts inclusive ends", () => {
    expect(bandLineCount([{ start: 3, end: 5 }, { start: 9, end: 9 }])).toBe(4);
  });
});

describe("buildDigest emits the block the student is on", () => {
  it("keeps the block and a three-line margin, in 1-based coordinates", () => {
    // focus is 0-based: lines 3-4 of the file, which is `def area` and its body.
    const digest = buildDigest(PY, "python", { start: 2, end: 3 });
    expect(digest.bands).toEqual([{ start: 1, end: 7 }]);
    expect(FOCUS_MARGIN_LINES).toBe(3);
  });

  it("clamps the margin to the start and end of the file", () => {
    const digest = buildDigest(PY, "python", { start: 0, end: 0 });
    expect(digest.bands[0].start).toBe(1);
    const last = buildDigest(PY, "python", { start: 6, end: 6 });
    expect(last.bands[last.bands.length - 1].end).toBe(7);
  });

  it("reports the file's real length, not the digest's", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line_${i + 1} = ${i + 1}`);
    expect(buildDigest(long, "python", { start: 20, end: 21 }).totalLines).toBe(50);
  });

  it("holds the invariant the backend validates: one digest line per band line", () => {
    // The backend rejects a `bands` list whose total length disagrees with the
    // code it arrived with, and falls back to treating the digest as a whole
    // file — which renumbers every line and sends the student to the wrong one.
    const digest = buildDigest(PY, "python", { start: 5, end: 6 });
    expect(digest.code.split("\n")).toHaveLength(bandLineCount(digest.bands));
  });

  it("returns an empty digest for an empty file", () => {
    expect(buildDigest([], "python", { start: 0, end: 0 })).toEqual({
      code: "",
      bands: [],
      totalLines: 0,
    });
  });
});

import { HEADER_BAND_MAX_LINES } from "../codeDigest";

const LONG_PY = [
  "import math",                          // 1
  "from stats import mean",               // 2
  "",                                     // 3
  "TAX = 0.2",                            // 4
  "",                                     // 5
  ...Array.from({ length: 40 }, (_, i) => `filler_${i} = ${i}`), // 6-45
  "def deep(x):",                         // 46
  "    return mean(x) * TAX",             // 47
];

// An ordinary beginner file: several constants in a row under the imports,
// not just one, separated from the function body by a blank line.
const MULTI_CONST_PY = [
  "import math",                          // 1
  "",                                     // 2
  "TAX_RATE = 0.2",                       // 3
  "MAX_ITEMS = 100",                      // 4
  "DEBUG = False",                        // 5
  "",                                     // 6
  ...Array.from({ length: 40 }, (_, i) => `filler_${i} = ${i}`), // 7-46
  "def calculate(items):",                // 47
  "    return len(items) * TAX_RATE",     // 48
];

describe("buildDigest carries the imports however far down the block is", () => {
  it("sends the header even when the block is forty lines below it", () => {
    const digest = buildDigest(LONG_PY, "python", { start: 45, end: 46 });
    expect(digest.code).toContain("import math");
    expect(digest.code).toContain("from stats import mean");
    expect(digest.code).toContain("    return mean(x) * TAX");
  });

  it("keeps the module constant that sits under the imports", () => {
    // A blank line does not end the header; a definition does.
    expect(buildDigest(LONG_PY, "python", { start: 45, end: 46 }).code).toContain(
      "TAX = 0.2"
    );
  });

  it("stops the header at the first definition", () => {
    const digest = buildDigest(LONG_PY, "python", { start: 45, end: 46 });
    expect(digest.bands[0].end).toBeLessThan(6);
  });

  it("emits no header band for a file that opens with a definition", () => {
    const noImports = ["def area(r):", "    return r * r", "", "area(2)"];
    const digest = buildDigest(noImports, "python", { start: 3, end: 3 });
    expect(digest.bands).toEqual([{ start: 1, end: 4 }]);
  });

  it("caps the header at thirty lines", () => {
    const many = [
      ...Array.from({ length: 60 }, (_, i) => `import mod_${i}`),
      ...Array.from({ length: 40 }, (_, i) => `filler_${i} = ${i}`),
      "def deep(x):",
      "    return x",
    ];
    const digest = buildDigest(many, "python", { start: 100, end: 101 });
    expect(digest.bands[0]).toEqual({ start: 1, end: HEADER_BAND_MAX_LINES });
    expect(HEADER_BAND_MAX_LINES).toBe(30);
  });

  it("keeps every constant in a run under the imports, not just the first", () => {
    // TAX_RATE, MAX_ITEMS and DEBUG all sit under the same import with no
    // blank line between them - a tutor that can see only TAX_RATE would
    // explain a loop bound (MAX_ITEMS) it cannot read.
    const digest = buildDigest(MULTI_CONST_PY, "python", { start: 46, end: 47 });
    expect(digest.code).toContain("TAX_RATE = 0.2");
    expect(digest.code).toContain("MAX_ITEMS = 100");
    expect(digest.code).toContain("DEBUG = False");
    // The blank line before the filler body ends the header - the def line
    // and the forty lines above it never enter the header band.
    expect(digest.bands[0].end).toBeLessThan(7);
  });
});

// Fix round 1: cases the code review found broken by execution, in the
// languages whose importRegex changed again to fix them.

const C_HEADER_GUARD = [
  "#ifndef FOO_H",       // 1
  "#define FOO_H",       // 2
  "#include <stdio.h>",  // 3
  "",                    // 4
  "",                    // 5
  "",                    // 6
  "",                    // 7
  "int main(void) {",    // 8
  "    return 0;",       // 9
  "}",                   // 10
];

const RUST_PUB_USE = [
  "pub use crate::foo::Bar;",   // 1
  "pub mod foo;",                // 2
  "",                             // 3
  "",                             // 4
  "",                             // 5
  "",                             // 6
  "",                             // 7
  "fn main() {}",                 // 8
];

const JAVA_IMPORTS = [
  "import java.util.List;",             // 1
  "",                                   // 2
  "import static org.junit.Assert.*;",  // 3
  "",                                   // 4
  "import com.example.Foo;",            // 5
  "",                                   // 6
  "",                                   // 7
  "",                                   // 8
  "",                                   // 9
  "public class Foo {",                 // 10
  "}",                                  // 11
];

const GO_IMPORTS = [
  "package main",          // 1
  "",                      // 2
  "import (",              // 3
  "\t\"fmt\"",              // 4
  "\t\"os\"",               // 5
  ")",                      // 6
  "",                       // 7
  "const MaxRetries = 3",   // 8
  "",                       // 9
  "",                       // 10
  "",                       // 11
  "",                       // 12
  "",                       // 13
  "func main() {",          // 14
  "}",                      // 15
];

describe("buildDigest keeps the header across the languages the fix round touched", () => {
  it("C: a header guard's #ifndef doesn't blank out the header - it still reaches the #include", () => {
    // Before the fix, #ifndef matched nothing, sawImport stayed false, and
    // the catch-all didn't apply either - headerEnd returned 0 on the first
    // iteration and #define/#include on lines 2-3 were never reached.
    const digest = buildDigest(C_HEADER_GUARD, "c", { start: 7, end: 9 });
    expect(digest.bands[0]).toEqual({ start: 1, end: 3 });
    expect(digest.code).toContain("#include <stdio.h>");
  });

  it("Rust: a file opening with pub use / pub mod gets a non-zero header, not the pre-fix zero", () => {
    const digest = buildDigest(RUST_PUB_USE, "rust", { start: 7, end: 7 });
    expect(digest.bands[0]).toEqual({ start: 1, end: 2 });
    expect(digest.code).toContain("pub use crate::foo::Bar;");
    expect(digest.code).toContain("pub mod foo;");
  });

  it("Java: import static does not fall into the constant branch and get cut short by the next blank line", () => {
    // Before the fix, "import static ..." missed importRegex, fell into the
    // module-constant catch-all, set constantTaken, and the blank line after
    // it ended the header before "import com.example.Foo;" was reached.
    const digest = buildDigest(JAVA_IMPORTS, "java", { start: 9, end: 10 });
    expect(digest.bands[0]).toEqual({ start: 1, end: 5 });
    expect(digest.code).toContain("import java.util.List;");
    expect(digest.code).toContain("import static org.junit.Assert.*;");
    expect(digest.code).toContain("import com.example.Foo;");
  });

  it("Go: the closing paren of a multi-import block is not mistaken for a constant, so the real constant survives", () => {
    // Before the fix, the bare ")" missed importRegex, got claimed as a
    // module constant instead, and the blank line after it ended the header
    // before "const MaxRetries = 3" was reached.
    const digest = buildDigest(GO_IMPORTS, "go", { start: 13, end: 14 });
    expect(digest.bands[0]).toEqual({ start: 1, end: 8 });
    expect(digest.code).toContain("const MaxRetries = 3");
  });
});
