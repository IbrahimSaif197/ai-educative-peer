import {
  bandLineCount,
  buildDigest,
  FOCUS_MARGIN_LINES,
  SCOPE_BAND_MAX_LINES,
  SIGNATURE_BAND_MAX_LINES,
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

const CLASSY = [
  "import math",                        // 1
  "",                                   // 2
  "class Stats:",                       // 3
  "    def __init__(self, xs):",        // 4
  "        self.xs = xs",               // 5
  "",                                   // 6
  "    def mean(self):",                // 7
  "        return sum(self.xs)",        // 8
  "",                                   // 9
  "def validate(payload):",             // 10
  "    return bool(payload)",           // 11
  "",                                   // 12
  "",                                   // 13
  "",                                   // 14
  "def report(xs):",                    // 15
  "    return Stats(xs).mean()",        // 16
];

describe("buildDigest names what the block can call", () => {
  it("sends one line per definition without their bodies", () => {
    // report sits three blank lines below validate - past FOCUS_MARGIN_LINES
    // (3), so validate's signature can only reach the digest via the
    // signature band, not via margin bleed off the focus block. That is the
    // point of this test: without it, validate's whole body would ride in
    // for free and the "without their bodies" assertion would pass for the
    // wrong reason.
    const digest = buildDigest(CLASSY, "python", { start: 14, end: 15 });
    expect(digest.code).toContain("def validate(payload):");
    expect(digest.code).not.toContain("    return bool(payload)");
  });

  it("sends the class header a method sits under", () => {
    // focus is `def mean`, lines 7-8 (0-based 6-7).
    const digest = buildDigest(CLASSY, "python", { start: 6, end: 7 });
    expect(digest.code).toContain("class Stats:");
  });

  it("caps the scope chain at three headers, keeping the ones nearest the block", () => {
    expect(SCOPE_BAND_MAX_LINES).toBe(3);
    // Four levels of nesting, with twenty filler methods between class D and
    // the method so that none of the four class headers are close enough to
    // reach the digest via the focus margin - and, since signatureLines
    // scans the whole file for definitions regardless of nesting, so that
    // class A also falls outside its own twenty-nearest window. Both bands
    // are pushed away deliberately: with only one level of nesting (as in
    // the tests above), the cap is never actually exercised, and margin or
    // signature bleed can make a broken cap look like a working one - which
    // is exactly how the test this replaces shipped never having caught one.
    const DEEPLY_NESTED = [
      "class A:",
      " ".repeat(4) + "class B:",
      " ".repeat(8) + "class C:",
      " ".repeat(12) + "class D:",
      ...Array.from(
        { length: 20 },
        (_, i) => " ".repeat(16) + `def filler_${i}(self): pass`
      ),
      " ".repeat(16) + "def method(self):",
      " ".repeat(20) + "return 1",
    ];
    const digest = buildDigest(DEEPLY_NESTED, "python", { start: 24, end: 25 });
    expect(digest.code).toContain("class B:");
    expect(digest.code).toContain("class C:");
    expect(digest.code).toContain("class D:");
    expect(digest.code).not.toContain("class A:");
  });

  it("caps signatures at twenty, keeping the ones nearest the block", () => {
    const many = [
      ...Array.from({ length: 60 }, (_, i) => [`def f_${i}():`, `    return ${i}`]).flat(),
      // lines 121-122
      "def target():",
      "    return 0",
    ];
    const digest = buildDigest(many, "python", { start: 120, end: 121 });
    const signatures = digest.code
      .split("\n")
      .filter((l) => l.startsWith("def f_"));
    expect(signatures).toHaveLength(SIGNATURE_BAND_MAX_LINES);
    // Nearest first: f_59 is adjacent to the block, f_0 is 120 lines away.
    expect(digest.code).toContain("def f_59():");
    expect(digest.code).not.toContain("def f_0():");
  });

  it("still holds the band invariant with every band in play", () => {
    const digest = buildDigest(CLASSY, "python", { start: 6, end: 7 });
    expect(digest.code.split("\n")).toHaveLength(bandLineCount(digest.bands));
  });
});

// Fix round 1: scopeHeaderLines returned [] for idiomatic Allman-brace C#
// and Java - a lone opening brace on its own line either read as a same-
// indent sibling (masking the real header behind it) or, at column 0, as a
// file-level boundary that stopped the walk one line short of the header.

const CSHARP_ALLMAN = [
  "public class Foo",       // 1
  "{",                       // 2
  "    public void Bar()",   // 3
  "    {",                   // 4
  "        DoWork();",       // 5
  "    }",                   // 6
  "}",                       // 7
];

const CSHARP_KNR = [
  "public class Foo {",       // 1
  "    public void Bar() {",  // 2
  "        DoWork();",        // 3
  "    }",                    // 4
  "}",                        // 5
];

describe("scopeHeaderLines reaches past a lone brace to the real header", () => {
  it("C# Allman: the class header sits behind its own opening brace, not the method's", () => {
    // Direct lensRegex match fails on "public class Foo" alone (csharp's
    // pattern requires a trailing `{` or `)`), so this also exercises the
    // join-with-next-line retry - the brace it joins with is two lines up,
    // past the method's own header and its own opening brace.
    const digest = buildDigest(CSHARP_ALLMAN, "csharp", { start: 4, end: 4 });
    expect(digest.code).toContain("public class Foo");
  });

  it("C# K&R: the brace-on-the-header-line style this was already handling keeps working", () => {
    const digest = buildDigest(CSHARP_KNR, "csharp", { start: 2, end: 2 });
    expect(digest.code).toContain("public class Foo {");
  });

  it("Rust: a stray brace between the focus and its impl doesn't cut the walk short", () => {
    // Rust's lensRegex matches "impl Foo" directly (no trailing brace/paren
    // required), so without the twenty fillers below, the signature band
    // would independently pull "impl Foo" into the digest and this test
    // would pass whether or not scopeHeaderLines's own fix worked. The
    // fillers push "impl Foo" outside the signature band's twenty-nearest
    // window (and the focus margin never reaches it either), so its
    // presence here can only come from scopeHeaderLines stepping past the
    // lone `{` between "impl Foo" and its body - the one thing this test
    // exists to prove.
    const RUST_STRAY_BRACE = [
      "impl Foo",
      "{",
      ...Array.from(
        { length: 20 },
        (_, i) => " ".repeat(4) + `fn filler_${i}(&self) {}`
      ),
      " ".repeat(4) + "fn bar(&self)",
      " ".repeat(4) + "{",
      " ".repeat(8) + "do_work();",
      " ".repeat(4) + "}",
      "}",
    ];
    const digest = buildDigest(RUST_STRAY_BRACE, "rust", { start: 24, end: 24 });
    expect(digest.code).toContain("impl Foo");
  });
});

import { MAX_DIGEST_LINES } from "../codeDigest";

describe("buildDigest stays inside its budget", () => {
  const huge = [
    "import math",
    ...Array.from({ length: 400 }, (_, i) => `line_${i + 1} = ${i + 1}`),
  ];

  const withDefinitions = [
    "import math",
    "",
    ...Array.from({ length: 30 }, (_, i) => [
      `def f_${i}():`,
      `    return ${i}`,
    ]).flat(),
    "",
    "def target():",
    ...Array.from({ length: 100 }, (_, i) => `    body_line_${i} = ${i}`),
  ];

  it("saturates the budget when focus alone exceeds it", () => {
    // Focus {100, 399} (0-based) = file lines 101-400 (1-based), 300 lines.
    // With 3-line margin: 98-403 clamped to 98-401 = 304 lines.
    // Header adds 1 line. No signatures (huge has no defs).
    // Without a budget guard, this would send 305 lines; the guard cuts to 120.
    const digest = buildDigest(huge, "python", { start: 100, end: 399 });
    expect(bandLineCount(digest.bands)).toBe(MAX_DIGEST_LINES);
  });

  it("keeps the head of a block too big to fit", () => {
    // The signature and the first lines of a body are what make a function
    // readable; the tail is what you drop.
    const digest = buildDigest(huge, "python", { start: 100, end: 399 });
    expect(digest.code).toContain("line_98 = 98");
    expect(digest.code).not.toContain("line_399 = 399");
  });

  it("spends the budget on the block before the signatures", () => {
    // Header: 1 line (import). Focus on target function (index 63-163): 101 lines.
    // With 3-line margin: 104 lines total. Budget left: ~15 lines for 30 signatures.
    // The nearest ~7-8 definitions fit; the distant ones do not.
    const digest = buildDigest(withDefinitions, "python", { start: 63, end: 163 });
    // target's last body line should be present (focus got all its lines)
    expect(digest.code).toContain("body_line_99 = 99");
    // A near definition should be present (f_29 is adjacent to target)
    expect(digest.code).toContain("def f_29():");
    // A far definition should not be present (f_0 is 63 lines away from target)
    expect(digest.code).not.toContain("def f_0():");
  });

  it("holds the band invariant at saturation", () => {
    // Same saturating focus as test 1: ensure the invariant holds
    // even when the budget truncates the digest.
    const digest = buildDigest(huge, "python", { start: 100, end: 399 });
    expect(digest.code.split("\n")).toHaveLength(bandLineCount(digest.bands));
  });
});
