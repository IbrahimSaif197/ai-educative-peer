# EduPeer Block-Scoped Tutoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tutor reads the student's imports and the block they are working on, comments only on that block, and never sends the rest of the file.

**Architecture:** A new pure module `extension/src/codeDigest.ts` selects a handful of line ranges — imports, enclosing scope headers, one line per definition, and the focus block with a 3-line margin — and emits them as `{ code, bands, totalLines }` where `bands` are 1-based absolute line ranges. Every request that used to carry `doc.getText()` carries that digest instead. A new `CodeView` in `backend/hinting_engine.py` reconstructs absolute line numbers from `bands`, so hints keep citing real editor lines. A request without `bands` is treated as a whole file, which is what keeps the published 1.5.1 extension working.

**Tech Stack:** TypeScript + Jest (extension), Python 3 + FastAPI + Pydantic v2 + pytest (backend).

## Global Constraints

- **Deploy the backend before the extension.** `bands` is optional on every model and every backend task below keeps the no-`bands` path byte-identical. An extension that sends a digest to a backend that ignores `bands` would have its digest numbered from line 1, and every hint would cite the wrong line.
- **Backend tests:** `cd backend && ./.venv/Scripts/python.exe -m pytest tests/<file> -v`. The repo-root `python` is a different environment; use `backend/.venv` (see `CLAUDE.md`).
- **Extension tests:** `cd extension && npm test -- <pattern>`.
- **Line-number convention:** internal extension code is 0-based, the wire is 1-based. Conversion happens in `codeDigest.ts` and `annotationStore.ts` and nowhere else. This is the existing house rule stated at the top of `annotationStore.ts`.
- **Commit messages:** plain imperative sentences, no `feat:`/`fix:` prefixes, no `Co-Authored-By` trailer. Match the existing log.
- **Existing constants keep their names and values:** `MAX_CODE_LINES_SENT = 120`, `MAX_FOCUS_LINES = 200`, `WINDOW_RADIUS = 15`.
- **Every request carrying no `bands` must produce byte-identical prompts to today.** Several tasks assert this explicitly; do not weaken those assertions.

---

### Task 1: `codeDigest.ts` — bands, and the invariant that holds them together

**Files:**
- Create: `extension/src/codeDigest.ts`
- Test: `extension/src/__tests__/codeDigest.test.ts`

**Interfaces:**
- Consumes: `LineSpan` from `./annotationStore` (0-based, inclusive).
- Produces:
  - `interface CodeBand { start: number; end: number }` — 1-based, absolute, inclusive.
  - `interface CodeDigest { code: string; bands: CodeBand[]; totalLines: number }`
  - `function toBands(lineNumbers: Iterable<number>): CodeBand[]`
  - `function bandLineCount(bands: CodeBand[]): number`
  - `function buildDigest(lines: string[], languageId: string, focus: LineSpan): CodeDigest`
  - `const MAX_DIGEST_LINES = 120`, `const FOCUS_MARGIN_LINES = 3`

This task builds only the focus band. Tasks 2-4 add the other three bands and the budget.

- [ ] **Step 1: Write the failing test**

Create `extension/src/__tests__/codeDigest.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npm test -- codeDigest`
Expected: FAIL — `Cannot find module '../codeDigest'`.

- [ ] **Step 3: Write the minimal implementation**

Create `extension/src/codeDigest.ts`:

```ts
/**
 * What leaves the machine, and nothing else.
 *
 * The tutor needs the student's imports and the block they are working on. It
 * does not need the other four hundred lines, and until this module existed
 * every request carried them: six call sites posted `doc.getText()`.
 *
 * A digest is a handful of line ranges lifted out of the file, plus the
 * absolute line numbers they came from. The numbers are the whole point —
 * `hinting_engine` cites real editor lines back to the student, and a digest
 * renumbered from 1 sends them to code that has nothing to do with the hint.
 *
 * Pure module: raw lines in, a digest out. Line numbers arrive 0-based, the
 * way the editor counts, and leave 1-based, the way the wire counts. That
 * conversion happens here and in `annotationStore`, nowhere else.
 */

import type { LineSpan } from "./annotationStore";

/** Total lines a digest may carry. Matches `MAX_CODE_LINES_SENT` server-side. */
export const MAX_DIGEST_LINES = 120;

/** Lines kept either side of the focus block: a decorator, or the comment above it. */
export const FOCUS_MARGIN_LINES = 3;

/** 1-based, absolute, inclusive — the coordinates the backend numbers in. */
export interface CodeBand {
  start: number;
  end: number;
}

export interface CodeDigest {
  /** The selected lines, joined. Never the whole file. */
  code: string;
  /** Which absolute lines `code` came from, ascending and disjoint. */
  bands: CodeBand[];
  /** Lines in the real file, so an elision can say how much is missing. */
  totalLines: number;
}

/** Ascending contiguous runs over a set of 1-based line numbers. */
export function toBands(lineNumbers: Iterable<number>): CodeBand[] {
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  const bands: CodeBand[] = [];
  for (const n of sorted) {
    const last = bands[bands.length - 1];
    if (last && n === last.end + 1) {
      last.end = n;
      continue;
    }
    bands.push({ start: n, end: n });
  }
  return bands;
}

export function bandLineCount(bands: CodeBand[]): number {
  return bands.reduce((total, b) => total + (b.end - b.start + 1), 0);
}

/**
 * Add 1-based lines `from`..`to` to `chosen`, stopping at the budget.
 *
 * Chosen lines are collected as a set rather than as bands so that overlapping
 * bands — a focus block inside its own enclosing class, an import line that is
 * also a signature — cost one line, not two, and the budget arithmetic cannot
 * drift from what is actually sent.
 */
function take(
  chosen: Set<number>,
  from: number,
  to: number,
  totalLines: number,
  budget: number
): void {
  const first = Math.max(1, from);
  const last = Math.min(totalLines, to);
  for (let n = first; n <= last; n++) {
    if (chosen.size >= budget && !chosen.has(n)) return;
    chosen.add(n);
  }
}

export function buildDigest(
  lines: string[],
  languageId: string,
  focus: LineSpan
): CodeDigest {
  const totalLines = lines.length;
  if (totalLines === 0) return { code: "", bands: [], totalLines: 0 };

  const chosen = new Set<number>();
  // 0-based focus in, 1-based out.
  take(
    chosen,
    focus.start + 1 - FOCUS_MARGIN_LINES,
    focus.end + 1 + FOCUS_MARGIN_LINES,
    totalLines,
    MAX_DIGEST_LINES
  );

  const bands = toBands(chosen);
  const code = bands
    .flatMap((b) => lines.slice(b.start - 1, b.end))
    .join("\n");
  return { code, bands, totalLines };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npm test -- codeDigest`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/codeDigest.ts extension/src/__tests__/codeDigest.test.ts
git commit -m "Carve the block the student is on out of the file

Bands are absolute and 1-based because the tutor cites real editor lines
back to the student; a digest renumbered from 1 sends them to the wrong
code. The band count and the digest's line count must agree - the backend
validates exactly that and falls back to whole-file numbering when they do
not."
```

---

### Task 2: The header band, so the tutor can see the imports

**Files:**
- Modify: `extension/src/languages.ts` (add `importRegex` to `LanguageInfo` and to all ten entries)
- Modify: `extension/src/codeDigest.ts`
- Test: `extension/src/__tests__/codeDigest.test.ts`, `extension/src/__tests__/languages.test.ts`

**Interfaces:**
- Consumes: `buildDigest`, `take`, `MAX_DIGEST_LINES` from Task 1.
- Produces: `LanguageInfo.importRegex: RegExp`; `const HEADER_BAND_MAX_LINES = 30`.

This is the band whose absence is the defect named in the spec: `_window` in `hinting_engine.py:412` returns `start-25 … end+25` and nothing else, so a block near the bottom of a long file is reasoned about with every import out of frame.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/languages.test.ts`:

```ts
import { SUPPORTED_LANGUAGES } from "../languages";

describe("every language knows what one of its import lines looks like", () => {
  const cases: Array<[string, string]> = [
    ["python", "from stats import mean"],
    ["javascript", "import { mean } from './stats.js';"],
    ["typescript", "import type { Stats } from './stats';"],
    ["java", "import java.util.List;"],
    ["csharp", "using System.Collections.Generic;"],
    ["c", "#include <stdio.h>"],
    ["cpp", "#include <vector>"],
    ["go", "import \"fmt\""],
    ["rust", "use std::collections::HashMap;"],
  ];

  it.each(cases)("%s recognises %s", (id, line) => {
    expect(SUPPORTED_LANGUAGES[id].importRegex.test(line)).toBe(true);
  });

  it("does not mistake a function definition for an import", () => {
    expect(SUPPORTED_LANGUAGES.python.importRegex.test("def area(r):")).toBe(false);
    expect(SUPPORTED_LANGUAGES.java.importRegex.test("public class Stats {")).toBe(false);
  });

  it("gives SQL a pattern that matches nothing, because it has no imports", () => {
    expect(SUPPORTED_LANGUAGES.sql.importRegex.test("SELECT * FROM t;")).toBe(false);
  });
});
```

Append to `extension/src/__tests__/codeDigest.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test -- codeDigest languages`
Expected: FAIL — `importRegex` is undefined, and the header assertions fail because only the focus band is emitted.

- [ ] **Step 3: Add `importRegex` to `languages.ts`**

Add the field to the interface, immediately after `lensRegex`:

```ts
  /**
   * Matches a line that belongs to the file's header: an import, an include,
   * a package or namespace declaration. `codeDigest` keeps the header band so
   * the tutor can see what the block depends on, however far down the file
   * the block is.
   */
  importRegex: RegExp;
```

Then add one entry per language, beside each existing `lensRegex`:

```ts
  python:     importRegex: /^\s*(import\s+\w|from\s+[\w.]+\s+import\b)/,
  javascript: importRegex: /^\s*(import\b|export\s+.*\bfrom\b|(const|let|var)\s+.*\brequire\s*\()/,
  typescript: importRegex: /^\s*(import\b|export\s+.*\bfrom\b|(const|let|var)\s+.*\brequire\s*\()/,
  java:       importRegex: /^\s*(import\s+(static\s+)?[\w.*]+\s*;|package\s+[\w.]+\s*;)/,
  csharp:     importRegex: /^\s*(using|namespace)\s+[\w.]+/,
  c:          importRegex: /^\s*#\s*(include|define|pragma|ifndef|ifdef|endif)\b/,
  cpp:        importRegex: /^\s*(#\s*(include|define|pragma|ifndef|ifdef|endif)\b|using\s+namespace\b)/,
  go:         importRegex: /^\s*(import\b|package\s+\w|"[\w./-]+"\s*$|\)\s*$)/,
  rust:       importRegex: /^\s*((pub\s+)?(use|mod)\s+\w|extern\s+crate\b)/,
  sql:        importRegex: /(?!)/,
```

Five of these were widened during execution after review found the original
table lost real header content. `#ifndef` guards made `headerEnd` return 0 for a
canonical C header, so a C student's imports were dropped entirely; the same for
Rust's `pub use` / `pub mod`. Java's `import static` and the closing `)` of a
gofmt multi-import block fell through to the constant branch, where a later blank
line ended the header early. The rule that settled it: the field's job is what
its doc comment says — an import, an include, a package or namespace declaration
— and a value that fails that job is a bug in the value.

Write them as real object properties in each entry — the list above is shorthand for review, not source. SQL's `/(?!)/` is a pattern that cannot match anything, which is the honest answer for a language with no imports.

- [ ] **Step 4: Add the header band to `codeDigest.ts`**

Add the constant beside the others:

```ts
/** Header lines kept, at most. Past this it is not a header, it is the file. */
export const HEADER_BAND_MAX_LINES = 30;
```

Add the helper above `buildDigest`:

```ts
/**
 * The file's header: imports, includes, and the module-level constants under
 * them, up to the first line that is neither.
 *
 * Blank lines and comments continue the header but do not extend it — a file
 * whose imports are followed by forty lines of comment should not spend its
 * header budget on the comment. So the band ends at the last line that
 * actually matched.
 */
function headerEnd(lines: string[], languageId: string): number {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return 0;
  let last = 0;
  const limit = Math.min(lines.length, HEADER_BAND_MAX_LINES);
  for (let i = 0; i < limit; i++) {
    const text = lines[i];
    if (!text.trim()) continue;
    if (text.trim().startsWith(language.lineComment)) continue;
    if (language.importRegex.test(text)) {
      last = i + 1; // 1-based
      continue;
    }
    // A module-level constant under the imports is context worth having;
    // anything indented, or any definition, means the header is over.
    if (last > 0 && !language.lensRegex.test(text) && !/^\s/.test(text)) {
      last = i + 1;
      continue;
    }
    break;
  }
  return last;
}
```

Add `SUPPORTED_LANGUAGES` to the imports at the top of the file:

```ts
import { SUPPORTED_LANGUAGES } from "./languages";
```

In `buildDigest`, take the header before the focus band:

```ts
  const chosen = new Set<number>();
  take(chosen, 1, headerEnd(lines, languageId), totalLines, MAX_DIGEST_LINES);
  take(
    chosen,
    focus.start + 1 - FOCUS_MARGIN_LINES,
    focus.end + 1 + FOCUS_MARGIN_LINES,
    totalLines,
    MAX_DIGEST_LINES
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npm test -- codeDigest languages`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/codeDigest.ts extension/src/languages.ts \
        extension/src/__tests__/codeDigest.test.ts extension/src/__tests__/languages.test.ts
git commit -m "Send the imports with the block, however far apart they are

The window added in 3a2ab3f returns start-25 to end+25 and nothing else,
so a function near the bottom of a long file was reasoned about with every
import out of frame - a tutor asked why a call fails while the line that
imports it is invisible."
```

---

### Task 3: The signature and enclosing-scope bands

**Files:**
- Modify: `extension/src/codeDigest.ts`
- Test: `extension/src/__tests__/codeDigest.test.ts`

**Interfaces:**
- Consumes: `headerEnd`, `take`, `toBands` from Tasks 1-2.
- Produces: `const SIGNATURE_BAND_MAX_LINES = 20`, `const SCOPE_BAND_MAX_LINES = 3`.

One line per definition is the highest information-per-token content in the digest: it tells the tutor `validate(payload)` exists and takes one argument, which is what stops it proposing a helper the student already wrote. The scope band supplies the `class` line a method sits under, so a method does not read as a function with a mysterious first parameter.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/codeDigest.test.ts`:

```ts
import { SCOPE_BAND_MAX_LINES, SIGNATURE_BAND_MAX_LINES } from "../codeDigest";

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
  "def report(xs):",                    // 13
  "    return Stats(xs).mean()",        // 14
];

describe("buildDigest names what the block can call", () => {
  it("sends one line per definition without their bodies", () => {
    const digest = buildDigest(CLASSY, "python", { start: 12, end: 13 });
    expect(digest.code).toContain("def validate(payload):");
    expect(digest.code).not.toContain("    return bool(payload)");
  });

  it("sends the class header a method sits under", () => {
    // focus is `def mean`, lines 7-8 (0-based 6-7).
    const digest = buildDigest(CLASSY, "python", { start: 6, end: 7 });
    expect(digest.code).toContain("class Stats:");
  });

  it("caps the scope chain at three headers", () => {
    expect(SCOPE_BAND_MAX_LINES).toBe(3);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test -- codeDigest`
Expected: FAIL — `SIGNATURE_BAND_MAX_LINES` is undefined and the signature/scope assertions fail.

- [ ] **Step 3: Write the implementation**

Add the constants:

```ts
/** Definition lines kept, at most, nearest the block first. */
export const SIGNATURE_BAND_MAX_LINES = 20;

/** Enclosing headers kept: the class, its class, and one more. */
export const SCOPE_BAND_MAX_LINES = 3;
```

Add the helpers above `buildDigest`:

```ts
/** Leading whitespace width, tabs counted as four columns. Mirrors blockHeuristics. */
function indentOf(line: string): number {
  const expanded = line.replace(/\t/g, "    ");
  return expanded.length - expanded.trimStart().length;
}

/**
 * The headers of the blocks the focus sits inside, outermost last.
 *
 * Walked by decreasing indentation rather than by parsing: a line above the
 * block, matching the language's definition pattern, and indented less than
 * anything already collected, is enclosing it. Good enough for a `class` in
 * Python and an outer `class`/`impl` in the brace languages, which is what
 * this band is for.
 */
function scopeHeaderLines(
  lines: string[],
  languageId: string,
  focusStart: number
): number[] {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return [];
  const found: number[] = [];
  let minIndent = indentOf(lines[focusStart] ?? "");
  for (let i = focusStart - 1; i >= 0 && found.length < SCOPE_BAND_MAX_LINES; i--) {
    const text = lines[i];
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (indent >= minIndent) continue;
    minIndent = indent;
    if (language.lensRegex.test(text)) found.push(i + 1); // 1-based
    if (indent === 0) break;
  }
  return found;
}

/**
 * Definition lines, nearest the block first.
 *
 * Indentation is not filtered on: a Java or C# method lives inside its class
 * and would be missed by a top-level-only rule, and those are exactly the
 * signatures worth having.
 */
function signatureLines(
  lines: string[],
  languageId: string,
  focusStart: number
): number[] {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return [];
  const all: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (language.lensRegex.test(lines[i])) all.push(i + 1);
  }
  return all
    .sort((a, b) => Math.abs(a - focusStart - 1) - Math.abs(b - focusStart - 1))
    .slice(0, SIGNATURE_BAND_MAX_LINES);
}
```

Extend `buildDigest`, keeping the priority order focus → header → scope → signatures so that a tight budget sacrifices the cheapest context first:

```ts
  const chosen = new Set<number>();
  take(
    chosen,
    focus.start + 1 - FOCUS_MARGIN_LINES,
    focus.end + 1 + FOCUS_MARGIN_LINES,
    totalLines,
    MAX_DIGEST_LINES
  );
  take(chosen, 1, headerEnd(lines, languageId), totalLines, MAX_DIGEST_LINES);
  for (const n of scopeHeaderLines(lines, languageId, focus.start)) {
    take(chosen, n, n, totalLines, MAX_DIGEST_LINES);
  }
  for (const n of signatureLines(lines, languageId, focus.start)) {
    take(chosen, n, n, totalLines, MAX_DIGEST_LINES);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test -- codeDigest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/codeDigest.ts extension/src/__tests__/codeDigest.test.ts
git commit -m "Name what the block can call, one line each

A signature line says validate(payload) exists and takes one argument for
the price of one line, which is what stops the tutor proposing a helper the
student already wrote. It is also what earns the cut from 25 context lines
to 3: the caller two functions down is now named rather than pasted."
```

---

### Task 4: The budget

**Files:**
- Modify: `extension/src/codeDigest.ts`
- Test: `extension/src/__tests__/codeDigest.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: no new exports. `buildDigest` now guarantees `bandLineCount(digest.bands) <= MAX_DIGEST_LINES`.

**This is a characterization task, not a TDD one.** `take` already stops at the budget and already keeps a block's head, so every test below passes the moment it is written. That is the point: the budget is emergent from `take` rather than stated anywhere, and emergent behaviour that nothing asserts is behaviour that changes by accident. Do not write a failing test first here — write the tests, watch them pass, and add the comment that says why they do.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/codeDigest.test.ts`:

```ts
import { MAX_DIGEST_LINES } from "../codeDigest";

describe("buildDigest stays inside its budget", () => {
  const huge = [
    "import math",
    ...Array.from({ length: 400 }, (_, i) => `line_${i + 1} = ${i + 1}`),
  ];

  it("never sends more lines than the budget", () => {
    const digest = buildDigest(huge, "python", { start: 200, end: 260 });
    expect(bandLineCount(digest.bands)).toBeLessThanOrEqual(MAX_DIGEST_LINES);
    expect(MAX_DIGEST_LINES).toBe(120);
  });

  it("keeps the head of a block too big to fit", () => {
    // The signature and the first lines of a body are what make a function
    // readable; the tail is what you drop.
    const digest = buildDigest(huge, "python", { start: 100, end: 399 });
    expect(digest.code).toContain("line_98 = 98");
    expect(digest.code).not.toContain("line_399 = 399");
  });

  it("spends the budget on the block before the signatures", () => {
    const digest = buildDigest(huge, "python", { start: 200, end: 260 });
    for (let n = 201; n <= 261; n++) {
      expect(digest.code).toContain(`line_${n} = ${n}`);
    }
  });

  it("holds the band invariant at the budget", () => {
    const digest = buildDigest(huge, "python", { start: 200, end: 260 });
    expect(digest.code.split("\n")).toHaveLength(bandLineCount(digest.bands));
  });
});
```

- [ ] **Step 2: Run the tests and confirm they pass**

Run: `cd extension && npm test -- codeDigest`
Expected: PASS, all four. A failure here means Tasks 1-3 were implemented differently from the plan — read the failure before changing anything, because the budget is the constraint that keeps the digest honest.

- [ ] **Step 3: Say why they pass**

`take` iterates ascending from `from` and returns as soon as `chosen.size >= budget`, so a block larger than the budget keeps its head by construction — the same rule `_window` applies server-side and for the same reason. Add the comment that says so, immediately above the focus `take` in `buildDigest`:

```ts
  // Focus first, so a tight budget spends itself on the block rather than on
  // context for it. A block bigger than the whole budget keeps its head: the
  // signature and the first lines of a body are what make a function legible,
  // which is the rule `_window` already applies server-side.
```

If Step 2 showed a real failure instead, fix `take` so it clamps `to` before iterating and re-run.

- [ ] **Step 4: Re-run the whole file**

Run: `cd extension && npm test -- codeDigest`
Expected: PASS, all suites in the file.

- [ ] **Step 5: Commit**

```bash
git add extension/src/codeDigest.ts extension/src/__tests__/codeDigest.test.ts
git commit -m "Bound the digest at a hundred and twenty lines

Focus first, then the header, then the scope chain, then the signatures, so
a tight budget sacrifices the cheapest context first. A block bigger than
the whole budget keeps its head, which is the rule the server-side window
already applies."
```

---

### Task 5: The wire — `CodeBand` on the three requests that carry line numbers

**Files:**
- Modify: `backend/models.py`
- Test: `backend/tests/test_models.py`

**Interfaces:**
- Produces:
  - `class CodeBand(BaseModel)` with `start: int` and `end: int`, both `ge=1`.
  - `MAX_CODE_BANDS = 64`
  - `bands: Optional[List[CodeBand]]` and `total_lines: Optional[int]` on `HintRequest`, `ScanRequest`, `LineHintRequest`.
  - `focus: Optional[FocusRange]` on `ScanRequest`.

`TraceRequest` gets nothing. `/trace` uses `req.code` only as a fallback when `selection` is empty (`main.py:451`) and never numbers it, so Task 16 makes the extension send the focus block there instead of the file — no bands required.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_models.py`:

```python
class TestCodeBandsRideAlongsideTheDigest:
    """`code` stopped being the whole file, so it needs its coordinates.

    The extension sends a handful of line ranges lifted out of the student's
    file. `bands` says which absolute lines they were, because the tutor
    cites real editor line numbers and a digest numbered from 1 would send
    the student to code that has nothing to do with the hint.
    """

    def test_a_band_is_one_based(self):
        from models import CodeBand
        import pytest
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            CodeBand(start=0, end=4)

    def test_the_three_numbering_requests_accept_bands(self):
        from models import HintRequest, LineHintRequest, ScanRequest
        payload = {"bands": [{"start": 1, "end": 2}, {"start": 40, "end": 55}],
                   "total_lines": 241}
        assert HintRequest(question="help", **payload).bands[1].end == 55
        assert LineHintRequest(line=41, **payload).total_lines == 241
        assert ScanRequest(**payload).bands[0].start == 1

    def test_bands_default_to_none_so_an_old_client_is_unchanged(self):
        from models import HintRequest, LineHintRequest, ScanRequest
        assert HintRequest(question="help").bands is None
        assert LineHintRequest(line=1).bands is None
        assert ScanRequest().bands is None
        assert ScanRequest().total_lines is None

    def test_a_scan_can_name_the_block_it_is_reviewing(self):
        from models import ScanRequest
        req = ScanRequest(focus={"start_line": 40, "end_line": 55, "label": "parse"})
        assert req.focus.label == "parse"

    def test_a_scan_without_a_focus_is_still_valid(self):
        from models import ScanRequest
        assert ScanRequest(code="x = 1").focus is None

    def test_the_band_list_is_bounded(self):
        # An unbounded list is a free multiplier on request size; every other
        # free-form field in this module is capped for the same reason.
        import pytest
        from pydantic import ValidationError
        from models import MAX_CODE_BANDS, ScanRequest
        too_many = [{"start": i, "end": i} for i in range(1, MAX_CODE_BANDS + 2)]
        with pytest.raises(ValidationError):
            ScanRequest(bands=too_many)

    def test_total_lines_cannot_be_negative(self):
        import pytest
        from pydantic import ValidationError
        from models import ScanRequest
        with pytest.raises(ValidationError):
            ScanRequest(total_lines=-1)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_models.py -k CodeBands -v`
Expected: FAIL — `ImportError: cannot import name 'CodeBand' from 'models'`.

- [ ] **Step 3: Write the implementation**

In `backend/models.py`, beside `MAX_CODE_CHARS`:

```python
# A digest is a handful of ranges, not hundreds. Bounded for the same reason
# every other free-form field here is: an unbounded list is a free multiplier
# on request size.
MAX_CODE_BANDS = 64
```

After `FocusRange`:

```python
class CodeBand(BaseModel):
    """One absolute line range that `code` was lifted from.

    The extension stopped sending whole files: `code` now carries the
    student's imports and the block they are working on, and `bands` says
    which editor lines those were. The tutor cites real line numbers back to
    the student, so a digest that arrived without its coordinates - or with
    coordinates that disagree with it - is numbered from line 1 instead,
    which is what an extension that predates this field expects.
    """

    start: int = Field(..., ge=1, description="1-based first line, inclusive")
    end: int = Field(..., ge=1, description="1-based last line, inclusive")
```

Add to `HintRequest`, `ScanRequest` and `LineHintRequest`:

```python
    bands: Optional[List[CodeBand]] = Field(
        default=None,
        max_length=MAX_CODE_BANDS,
        description="Absolute line ranges `code` was lifted from; None means whole file",
    )
    total_lines: Optional[int] = Field(
        default=None, ge=0, description="Lines in the student's real file"
    )
```

Add to `ScanRequest` only:

```python
    focus: Optional[FocusRange] = Field(
        default=None, description="The block the student is working on"
    )
```

Update the `code` descriptions on those three models from `"Full file content"` to `"The student's digest: imports and the block being worked on"`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_models.py -v`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/models.py backend/tests/test_models.py
git commit -m "Let a request say which lines its code came from

Bands default to None, so a request from the published 1.5.1 extension is
byte-identical to what it sends today and is treated as a whole file. The
scan gains the focus the 2026-08-09 spec deliberately left off it, on the
grounds that a scan flags the whole file - which is the job now changing."
```

---

### Task 6: `CodeView` — absolute line numbers out of a digest

**Files:**
- Modify: `backend/hinting_engine.py`
- Test: `backend/tests/test_hinting_engine.py`

**Interfaces:**
- Produces `class CodeView` in `hinting_engine.py`:
  - `CodeView.of(code: str, bands=None, total_lines=None) -> CodeView` — tolerant classmethod, falls back to whole-file.
  - `.numbered() -> str` — `"1: import math"` with `[lines 3-172 of this file are not shown]` between bands.
  - `.line_at(n: int) -> Optional[str]`
  - `.contains(n: int) -> bool`
  - `.slice(start: int, end: int) -> List[Tuple[int, str]]` — inclusive, absolute, skipping numbers not held.
  - `.max_line -> int`
- `bands` arrives as a list of dicts (`{"start": 1, "end": 2}`), which is what `model_dump()` gives.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_hinting_engine.py`:

```python
class TestACodeViewRebuildsAbsoluteLineNumbers:
    """`code` is a digest now, so position in the string is not the line number.

    Three places derived line numbers from position and would each be quietly
    wrong on a digest: the prompt's numbering, `generate_line_hint`'s window,
    and `scan_code`'s flag validation. This is the one object all three ask.
    """

    DIGEST = "import math\nfrom stats import mean\ndef deep(x):\n    return mean(x)"
    BANDS = [{"start": 1, "end": 2}, {"start": 173, "end": 174}]

    def _view(self):
        from hinting_engine import CodeView
        return CodeView.of(self.DIGEST, self.BANDS, total_lines=241)

    def test_it_numbers_each_band_at_its_real_lines(self):
        numbered = self._view().numbered()
        assert "1: import math" in numbered
        assert "2: from stats import mean" in numbered
        assert "173: def deep(x):" in numbered
        assert "174:     return mean(x)" in numbered

    def test_it_announces_the_gap_between_bands(self):
        # A tutor that cannot see lines 3-172 must know that, or it reports an
        # import missing when the import is merely out of frame.
        assert "[lines 3-172 of this file are not shown]" in self._view().numbered()

    def test_it_announces_the_tail_when_it_knows_the_file_is_longer(self):
        assert "[lines 175-241 of this file are not shown]" in self._view().numbered()

    def test_it_announces_nothing_after_the_end_when_the_length_is_unknown(self):
        from hinting_engine import CodeView
        view = CodeView.of(self.DIGEST, self.BANDS)
        assert "175" not in view.numbered()

    def test_it_announces_the_head_when_the_first_band_does_not_start_at_one(self):
        from hinting_engine import CodeView
        view = CodeView.of("def deep(x):\n    return x", [{"start": 40, "end": 41}], 60)
        assert "[lines 1-39 of this file are not shown]" in view.numbered()

    def test_line_at_reaches_across_the_gap(self):
        assert self._view().line_at(173) == "def deep(x):"
        assert self._view().line_at(1) == "import math"

    def test_line_at_returns_nothing_for_a_line_it_does_not_hold(self):
        assert self._view().line_at(100) is None

    def test_contains_rejects_a_line_in_the_gap(self):
        view = self._view()
        assert view.contains(174) is True
        assert view.contains(3) is False

    def test_slice_skips_the_numbers_it_does_not_hold(self):
        assert self._view().slice(1, 173) == [
            (1, "import math"),
            (2, "from stats import mean"),
            (173, "def deep(x):"),
        ]

    def test_max_line_is_the_last_line_it_holds(self):
        assert self._view().max_line == 174

    def test_no_bands_means_the_whole_file_starting_at_line_one(self):
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2")
        assert view.numbered() == "1: a = 1\n2: b = 2"
        assert view.line_at(2) == "b = 2"

    def test_bands_that_disagree_with_the_code_fall_back_to_the_whole_file(self):
        # Two bands claiming six lines against a two-line digest. Believing
        # them would renumber every line and cite the wrong one; the safe
        # reading is that this client does not speak bands.
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", [{"start": 1, "end": 3}, {"start": 9, "end": 11}])
        assert view.numbered() == "1: a = 1\n2: b = 2"

    def test_overlapping_bands_fall_back_to_the_whole_file(self):
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", [{"start": 1, "end": 1}, {"start": 1, "end": 1}])
        assert view.line_at(1) == "a = 1"
        assert view.line_at(2) == "b = 2"

    def test_descending_bands_fall_back_to_the_whole_file(self):
        from hinting_engine import CodeView
        view = CodeView.of("a = 1\nb = 2", [{"start": 9, "end": 9}, {"start": 1, "end": 1}])
        assert view.line_at(2) == "b = 2"

    def test_an_empty_digest_holds_nothing(self):
        from hinting_engine import CodeView
        view = CodeView.of("")
        assert view.line_at(1) is None
        assert view.max_line == 0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -k CodeView -v`
Expected: FAIL — `ImportError: cannot import name 'CodeView' from 'hinting_engine'`.

- [ ] **Step 3: Write the implementation**

In `backend/hinting_engine.py`, immediately after `number_lines`:

```python
def _parse_bands(bands, line_count: int) -> Optional[List[Tuple[int, int]]]:
    """Bands as (start, end) pairs, or None when they cannot be believed.

    Ascending, disjoint, 1-based, and covering exactly as many lines as the
    code arrived with. Anything else and the caller falls back to treating
    the code as a whole file - which is what an extension predating `bands`
    sends, and the only safe reading of a digest whose coordinates are wrong.
    """
    if not bands:
        return None
    parsed: List[Tuple[int, int]] = []
    previous_end = 0
    for band in bands:
        try:
            start = int(band["start"]) if isinstance(band, dict) else int(band.start)
            end = int(band["end"]) if isinstance(band, dict) else int(band.end)
        except (TypeError, ValueError, KeyError, AttributeError):
            return None
        if start < 1 or end < start or start <= previous_end:
            return None
        parsed.append((start, end))
        previous_end = end
    if sum(end - start + 1 for start, end in parsed) != line_count:
        return None
    return parsed


class CodeView:
    """The student's code, and which of their editor's lines it came from.

    `code` stopped being the whole file: it carries the imports and the block
    being worked on. Position in the string is therefore no longer the line
    number, and three separate places used to assume it was - the prompt's
    numbering, `generate_line_hint`'s window, and `scan_code`'s validation of
    the model's flags. All three ask this object instead.
    """

    def __init__(
        self,
        lines: List[str],
        bands: List[Tuple[int, int]],
        total_lines: Optional[int] = None,
    ):
        self._lines = lines
        self._bands = bands
        self._total_lines = total_lines
        self._by_line = {}
        cursor = 0
        for start, end in bands:
            for n in range(start, end + 1):
                self._by_line[n] = lines[cursor]
                cursor += 1

    @classmethod
    def of(cls, code: str, bands=None, total_lines: Optional[int] = None) -> "CodeView":
        lines = code.splitlines()
        parsed = _parse_bands(bands, len(lines))
        if parsed is None:
            parsed = [(1, len(lines))] if lines else []
            total_lines = len(lines) or None
        return cls(lines, parsed, total_lines)

    @property
    def max_line(self) -> int:
        return self._bands[-1][1] if self._bands else 0

    def contains(self, n: int) -> bool:
        return n in self._by_line

    def line_at(self, n: int) -> Optional[str]:
        return self._by_line.get(n)

    def slice(self, start: int, end: int) -> List[Tuple[int, str]]:
        return [(n, self._by_line[n]) for n in range(start, end + 1) if n in self._by_line]

    def numbered(self) -> str:
        """`<n>: <text>`, the format every other prompt in this module uses.

        Each elision is announced. A model handed a block with no notice that
        the top of the file is missing will confidently report an import that
        is simply out of frame.
        """
        if not self._bands:
            return "(no code provided)"
        parts: List[str] = []
        previous_end = 0
        for start, end in self._bands:
            if start > previous_end + 1:
                parts.append(
                    f"[lines {previous_end + 1}-{start - 1} of this file are not shown]"
                )
            parts.extend(f"{n}: {self._by_line[n]}" for n in range(start, end + 1))
            previous_end = end
        if self._total_lines and self._total_lines > previous_end:
            parts.append(
                f"[lines {previous_end + 1}-{self._total_lines} of this file are not shown]"
            )
        return "\n".join(parts)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -k CodeView -v`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the whole backend suite for regressions**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS — nothing calls `CodeView` yet, so this is a floor for the next four tasks.

- [ ] **Step 6: Commit**

```bash
git add backend/hinting_engine.py backend/tests/test_hinting_engine.py
git commit -m "Rebuild absolute line numbers from a digest

Position in `code` stopped being the line number. Three places assumed it
was - the prompt's numbering, the line-hint window and the scan's flag
validation - and all three now ask one object. Bands that disagree with the
code they arrived with are not believed: the safe reading of wrong
coordinates is that the client does not speak them yet."
```

---

### Task 7: The conversation prompt reads the view

**Files:**
- Modify: `backend/hinting_engine.py` (`_build_user_message`, `_prepare_hint_messages`, `generate_hint`, `stream_hint`)
- Test: `backend/tests/test_hinting_engine.py`

**Interfaces:**
- Consumes: `CodeView` from Task 6.
- Produces: an optional `view: Optional[CodeView] = None` keyword on `generate_hint`, `stream_hint`, `_prepare_hint_messages` and `_build_user_message`. When `None`, `number_lines(code, focus)` runs exactly as today.

One optional parameter rather than threading `bands` and `total_lines` separately: the parsing belongs at the endpoint boundary, and everything below it wants the same answer.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_hinting_engine.py`:

```python
class TestTheConversationReadsTheDigest:
    """The panel sends a digest; the prompt has to number it correctly."""

    def _engine(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client("ok")
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def test_a_request_with_no_view_is_unchanged(self):
        # The published 1.5.1 extension sends whole files and must keep
        # producing the prompt it produces today, byte for byte.
        from hinting_engine import number_lines
        engine = self._engine()
        code = "a = 1\nb = 2"
        engine.generate_hint(code, "help", 1)
        assert number_lines(code) in self._user_message(engine)

    def test_a_view_puts_the_imports_and_the_block_in_the_prompt(self):
        from hinting_engine import CodeView
        engine = self._engine()
        view = CodeView.of(
            "import math\ndef deep(x):\n    return math.sqrt(x)",
            [{"start": 1, "end": 1}, {"start": 173, "end": 174}],
            total_lines=241,
        )
        engine.generate_hint("ignored", "help", 1, view=view)
        sent = self._user_message(engine)
        assert "1: import math" in sent
        assert "173: def deep(x):" in sent
        assert "[lines 2-172 of this file are not shown]" in sent

    def test_the_streaming_path_reads_the_view_too(self):
        from hinting_engine import CodeView
        engine = self._engine()
        view = CodeView.of("def deep(x):\n    return x", [{"start": 40, "end": 41}], 60)
        list(engine.stream_hint("ignored", "help", 1, view=view))
        assert "40: def deep(x):" in self._user_message(engine)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -k TheConversationReadsTheDigest -v`
Expected: FAIL — `generate_hint() got an unexpected keyword argument 'view'`.

- [ ] **Step 3: Write the implementation**

In `_build_user_message`, replace the `code_block` line:

```python
        # `focus` decides which window survives when the file is too big to
        # send whole, so it has to reach the numbering rather than only the
        # instruction below it. A `view` means the client already made that
        # choice and sent a digest; its bands carry the real line numbers.
        code_block = view.numbered() if view is not None else number_lines(code, focus)
```

Add `view: Optional["CodeView"] = None` as the last keyword parameter of `_build_user_message`, `_prepare_hint_messages`, `generate_hint` and `stream_hint`, and pass it down at each call site. `_extract_concept_tags` keeps taking `code` and is unchanged — it reads the text, not its coordinates.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -q`
Expected: PASS — the whole file, including the existing `TestABigFileIsWindowedNotSentWhole` suite, which is what pins the no-view path.

- [ ] **Step 5: Commit**

```bash
git add backend/hinting_engine.py backend/tests/test_hinting_engine.py
git commit -m "Number the conversation's code from its bands when it has them

One optional view rather than threading bands and a line count through four
signatures: the parsing belongs at the endpoint, and everything below it
wants the same answer. Without one, number_lines runs exactly as before."
```

---

### Task 8: `generate_line_hint` stops indexing by position

**Files:**
- Modify: `backend/hinting_engine.py` (`generate_line_hint`)
- Test: `backend/tests/test_hinting_engine.py`

**Interfaces:**
- Consumes: `CodeView.line_at`, `CodeView.slice`.
- Produces: `generate_line_hint(code, line_number, language="python", focus=None, view=None)`.

Without this the feature breaks outright: the function does `lines = code.splitlines()` then `if line_number > len(lines): return "", "general"`. Absolute line 200 against a 42-line digest falls off the end, and every inline hint on a long file silently returns empty.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_hinting_engine.py`:

```python
class TestTheLineHintReadsAbsoluteLineNumbers:
    """The cursor's line number is absolute; the code it arrives with is not.

    `generate_line_hint` indexed `code.splitlines()[line_number - 1]`. Against
    a digest, line 200 of a 42-line digest is out of range and the function
    returns an empty hint - the whole inline surface going quiet on exactly
    the long files the digest exists for.
    """

    def _engine(self):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client('{"hint": "check the bound", "concept": "loops"}')
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def _view(self):
        from hinting_engine import CodeView
        return CodeView.of(
            "import math\ndef deep(n):\n    for i in range(1, n):\n        print(i)",
            [{"start": 1, "end": 1}, {"start": 198, "end": 200}],
            total_lines=241,
        )

    def test_it_answers_about_a_line_in_the_second_band(self):
        engine = self._engine()
        hint, concept = engine.generate_line_hint("ignored", 199, "python", view=self._view())
        assert hint == "check the bound"
        assert concept == "loops"

    def test_it_marks_the_cursor_line_at_its_real_number(self):
        engine = self._engine()
        engine.generate_line_hint("ignored", 199, "python", view=self._view())
        sent = self._user_message(engine)
        assert "The student's cursor is on line 199" in sent
        assert "199>     for i in range(1, n):" in sent
        assert "198: def deep(n):" in sent

    def test_it_skips_the_numbers_the_view_does_not_hold(self):
        engine = self._engine()
        engine.generate_line_hint("ignored", 199, "python", view=self._view())
        assert "197" not in self._user_message(engine)

    def test_it_declines_a_line_the_view_does_not_hold(self):
        engine = self._engine()
        assert engine.generate_line_hint("ignored", 50, "python", view=self._view()) == (
            "",
            "general",
        )

    def test_a_request_with_no_view_behaves_as_it_does_today(self):
        engine = self._engine()
        code = "x = 1\ny = 2\nz = 3"
        hint, _ = engine.generate_line_hint(code, 2, "python")
        assert hint == "check the bound"
        assert "2> y = 2" in self._user_message(engine)

    def test_a_line_past_the_end_of_a_whole_file_still_declines(self):
        engine = self._engine()
        assert engine.generate_line_hint("x = 1", 9, "python") == ("", "general")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -k TheLineHintReadsAbsolute -v`
Expected: FAIL — `generate_line_hint() got an unexpected keyword argument 'view'`.

- [ ] **Step 3: Write the implementation**

Replace the head of `generate_line_hint` — everything from `lines = code.splitlines()` through the `window = ...` assignment — with:

```python
        view = view if view is not None else CodeView.of(code)
        if view.line_at(line_number) is None:
            return "", "general"
        lang = get_language(language)
        # A resolved focus block is a better window than a fixed ±3, but it is
        # capped so a 200-line function does not become the whole prompt.
        start, end = line_number - 3, line_number + 3
        if focus:
            try:
                f_start = int(focus.get("start_line", 0))
                f_end = int(focus.get("end_line", 0))
            except (TypeError, ValueError):
                f_start, f_end = 0, 0
            if 0 < f_start <= line_number <= f_end:
                start = max(f_start, line_number - 30)
                end = min(f_end, line_number + 30)
        # Absolute numbers throughout, and lines the view does not hold are
        # skipped rather than counted - the window may span a band boundary.
        window = "\n".join(
            f"{n}{'>' if n == line_number else ':'} {text}"
            for n, text in view.slice(start, end)
        )
```

Add `view: Optional["CodeView"] = None` as the last parameter of the signature.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -q`
Expected: PASS, including the pre-existing line-hint suites.

- [ ] **Step 5: Commit**

```bash
git add backend/hinting_engine.py backend/tests/test_hinting_engine.py
git commit -m "Look the cursor's line up rather than counting to it

generate_line_hint indexed code.splitlines() by the absolute line number.
Against a digest that is out of range on every long file, and the function
returns an empty hint - the inline surface going silent on exactly the
files the digest exists for."
```

---

### Task 9: The scan reviews one block

**Files:**
- Modify: `backend/hinting_engine.py` (`scan_code`)
- Test: `backend/tests/test_hinting_engine.py`

**Interfaces:**
- Consumes: `CodeView.numbered`, `.contains`, `.max_line`.
- Produces: `scan_code(code, language="python", focus=None, view=None)`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_hinting_engine.py`:

```python
class TestTheScanReviewsTheBlockNotTheFile:
    """A scan of the whole file marks up code the student is not working on.

    A student editing `parse` collected lenses and Problems entries on three
    other functions - and, because the scan also fired on activation, on a
    file they had only just opened.
    """

    FLAGS = (
        '{"flags": ['
        '{"line": 174, "end_line": 174, "question": "Off by one?", "concept": "loops"},'
        '{"line": 2, "end_line": 2, "question": "Unused import?", "concept": "imports"}'
        "]}"
    )

    def _engine(self, reply=None):
        from hinting_engine import HintingEngine
        engine = HintingEngine(api_key="test-key")
        engine.client = _make_mock_client(reply if reply is not None else self.FLAGS)
        return engine

    def _user_message(self, engine):
        messages = engine.client.chat.completions.create.call_args.kwargs["messages"]
        return messages[-1]["content"]

    def _view(self):
        from hinting_engine import CodeView
        return CodeView.of(
            "import math\nfrom stats import mean\ndef deep(n):\n    return n - 1",
            [{"start": 1, "end": 2}, {"start": 173, "end": 174}],
            total_lines=241,
        )

    FOCUS = {"start_line": 173, "end_line": 174, "label": "deep"}

    def test_it_names_the_block_it_is_reviewing(self):
        engine = self._engine()
        engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert "Review lines 173-174 (deep)" in self._user_message(engine)

    def test_it_keeps_a_flag_inside_the_block(self):
        engine = self._engine()
        flags = engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert [f["line"] for f in flags] == [174]

    def test_it_drops_a_flag_on_an_import_it_was_only_shown_for_context(self):
        engine = self._engine()
        flags = engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert all(f["line"] != 2 for f in flags)

    def test_it_drops_a_flag_on_a_line_the_view_never_held(self):
        engine = self._engine('{"flags": [{"line": 90, "end_line": 90, "question": "Why?"}]}')
        assert engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view()) == []

    def test_it_clamps_a_flag_that_runs_past_the_block(self):
        engine = self._engine(
            '{"flags": [{"line": 173, "end_line": 400, "question": "Why?"}]}'
        )
        flags = engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        assert flags[0]["end_line"] == 174

    def test_a_scan_with_no_focus_keeps_todays_wording(self):
        # The published extension sends no focus and must get the prompt it
        # gets today, byte for byte.
        engine = self._engine('{"flags": []}')
        engine.scan_code("x = 1\ny = 2", "python")
        assert "Review this beginner's Python file." in self._user_message(engine)

    def test_a_scan_with_no_focus_still_flags_anywhere_in_the_file(self):
        engine = self._engine('{"flags": [{"line": 2, "end_line": 2, "question": "Why?"}]}')
        flags = engine.scan_code("x = 1\ny = 2", "python")
        assert [f["line"] for f in flags] == [2]

    def test_it_numbers_the_digest_at_its_real_lines(self):
        engine = self._engine()
        engine.scan_code("ignored", "python", focus=self.FOCUS, view=self._view())
        sent = self._user_message(engine)
        assert "173: def deep(n):" in sent
        assert "[lines 3-172 of this file are not shown]" in sent
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -k TheScanReviewsTheBlock -v`
Expected: FAIL — `scan_code() got an unexpected keyword argument 'focus'`.

- [ ] **Step 3: Write the implementation**

Add a helper above `scan_code`:

```python
def scan_target(focus: Optional[dict]) -> Optional[Tuple[int, int, str]]:
    """The block a scan is scoped to, or None to review the whole file."""
    if not focus:
        return None
    try:
        start = int(focus.get("start_line", 0))
        end = int(focus.get("end_line", 0))
    except (TypeError, ValueError):
        return None
    if start < 1 or end < start:
        return None
    label = " ".join(str(focus.get("label", "")).split())[:MAX_FOCUS_LABEL_CHARS]
    return start, end, label
```

Change `scan_code`'s signature to `(self, code, language="python", focus=None, view=None)` and replace its head, from `lang = get_language(language)` through the `user_msg` assignment, with:

```python
        lang = get_language(language)
        view = view if view is not None else CodeView.of(code)
        target = scan_target(focus)
        nonce = secrets.token_hex(8)
        if target:
            start, end, label = target
            named = f" ({label})" if label else ""
            what = f"lines {start}-{end}{named} of this beginner's {lang['display_name']} file"
        else:
            what = f"this beginner's {lang['display_name']} file"
        user_msg = (
            f"Review {what}. Flag at most 5 suspicious lines.\n\n"
            + self._wrap_untrusted("student_code", nonce, view.numbered())
            + "\n\nRespond with JSON only."
        )
```

Replace `total_lines = max(1, len(code.splitlines()))` with nothing, and replace the two validation lines inside the loop:

```python
            # A model shown an import for context does not get to mark it up.
            if not view.contains(line):
                continue
            if target and not (target[0] <= line <= target[1]):
                continue
            ceiling = target[1] if target else view.max_line
            end_line = max(line, min(end_line, ceiling))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_hinting_engine.py -q`
Expected: PASS, including the existing scan suites.

- [ ] **Step 5: Commit**

```bash
git add backend/hinting_engine.py backend/tests/test_hinting_engine.py
git commit -m "Review the block, and only flag inside it

A model shown an import so it can understand the block does not get to mark
the import up. Without a focus the wording and the behaviour are what they
were, which is what the published extension still sends."
```

---

### Task 10: The endpoints build the view

**Files:**
- Modify: `backend/main.py` (`/scan`, `/line-hint`, `/hint`, `/stream`)
- Test: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: `CodeView.of`, and the model fields from Task 5.
- Produces: no new exports. `/scan` and `/line-hint` cache keys gain the bands and the focus.

The cache keys matter: `SCAN_CACHE` is keyed on `raw_code_hash(req.code)`, and two different band sets over identical digest text describe different lines. Serving one against the other would put a flag on the wrong function.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_main.py`, following the file's existing client fixture and auth-stubbing conventions:

```python
class TestTheEndpointsHandDownTheDigest:
    """Bands are parsed once, at the boundary, and everything below asks it."""

    DIGEST = {
        "code": "import math\ndef deep(n):\n    return n - 1",
        "bands": [{"start": 1, "end": 1}, {"start": 173, "end": 174}],
        "total_lines": 241,
    }

    def test_scan_passes_the_focus_and_the_view_to_the_engine(self, client, monkeypatch):
        seen = {}

        def fake_scan(code, language="python", focus=None, view=None):
            seen["focus"] = focus
            seen["numbered"] = view.numbered() if view else None
            return []

        monkeypatch.setattr("main.engine.scan_code", fake_scan)
        res = client.post(
            "/scan",
            json={**self.DIGEST, "focus": {"start_line": 173, "end_line": 174, "label": "deep"}},
        )
        assert res.status_code == 200
        assert seen["focus"]["label"] == "deep"
        assert "173: def deep(n):" in seen["numbered"]

    def test_line_hint_passes_the_view(self, client, monkeypatch):
        seen = {}

        def fake_hint(code, line_number, language="python", focus=None, view=None):
            seen["line"] = line_number
            seen["holds"] = view.contains(line_number) if view else None
            return "ok", "loops"

        monkeypatch.setattr("main.engine.generate_line_hint", fake_hint)
        res = client.post("/line-hint", json={**self.DIGEST, "line": 174})
        assert res.status_code == 200
        assert seen["line"] == 174 and seen["holds"] is True

    def test_two_band_sets_over_identical_text_do_not_share_a_cache_entry(
        self, client, monkeypatch
    ):
        # Same digest text, different lines. Serving one against the other
        # puts a flag on the wrong function.
        calls = []

        def fake_scan(code, language="python", focus=None, view=None):
            calls.append(view.max_line if view else 0)
            return []

        monkeypatch.setattr("main.engine.scan_code", fake_scan)
        body = {"code": "a = 1\nb = 2", "total_lines": 90}
        client.post("/scan", json={**body, "bands": [{"start": 1, "end": 2}]})
        client.post("/scan", json={**body, "bands": [{"start": 40, "end": 41}]})
        assert calls == [2, 41]

    def test_a_request_with_no_bands_still_works(self, client, monkeypatch):
        seen = {}

        def fake_scan(code, language="python", focus=None, view=None):
            seen["view"] = view
            return []

        monkeypatch.setattr("main.engine.scan_code", fake_scan)
        assert client.post("/scan", json={"code": "x = 1"}).status_code == 200
        assert seen["view"] is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest tests/test_main.py -k TheEndpointsHandDown -v`
Expected: FAIL — `scan_code()` is called without `focus`/`view`.

- [ ] **Step 3: Write the implementation**

Add `CodeView` to the `from hinting_engine import ...` line, and `Optional` to the `from typing import Dict, List, Tuple` line — `main.py` does not import it today and the helper below needs it. Nothing new is needed from `models`.

Add a helper beside the other module-level helpers in `main.py`:

```python
def _view_for(req) -> Tuple[Optional[CodeView], Optional[tuple]]:
    """The request's code view, and a hashable key for the cache.

    Two different band sets over identical digest text describe different
    lines, so the bands are part of the key. Without bands there is no view
    and the engine falls back to whole-file numbering.
    """
    if not req.bands:
        return None, None
    bands = [b.model_dump() for b in req.bands]
    key = tuple((b["start"], b["end"]) for b in bands)
    return CodeView.of(req.code, bands, req.total_lines), key
```

In `/scan`:

```python
    focus = req.focus.model_dump() if req.focus else None
    view, bands_key = _view_for(req)
    focus_key = (focus["start_line"], focus["end_line"]) if focus else None
    key = (uid, language, bands_key, focus_key, raw_code_hash(req.code))
    ...
        raw_flags = await asyncio.to_thread(
            engine.scan_code, req.code, language, focus, view
        )
```

In `/line-hint`, add the view to the existing key and the call:

```python
    view, bands_key = _view_for(req)
    key = (uid, language, req.line, focus_key, bands_key, raw_code_hash(req.code))
    ...
        hint_text, concept = await asyncio.to_thread(
            engine.generate_line_hint, req.code, req.line, language, focus, view
        )
```

In the `/hint` and `/stream` handlers, build the view the same way and pass `view=view` to `engine.generate_hint` / `engine.stream_hint`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS, the whole backend suite.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_main.py
git commit -m "Parse the bands once, at the boundary

The scan and line-hint caches key on an exact hash of the code, and two
different band sets over identical digest text describe different lines -
serving one against the other puts a flag on the wrong function. The bands
are part of the key."
```

**The backend is now complete and deployable. Deploy it before continuing.** Every task above keeps the no-`bands` path byte-identical, so the published extension is unaffected; the tasks below start sending digests and require this backend to be live.

---

### Task 11: `apiClient` sends the digest

**Files:**
- Modify: `extension/src/apiClient.ts`
- Test: `extension/src/__tests__/apiClient.test.ts`

**Interfaces:**
- Consumes: `CodeBand`, `CodeDigest` from `./codeDigest`.
- Produces:
  - `function digestFields(digest: CodeDigest): { code: string; bands: CodeBand[]; total_lines: number }`
  - `scanCode(digest: CodeDigest, language?: string, focus?: FocusRange): Promise<ScanResponse>`
  - `getLineHint(digest: CodeDigest, line: number, language?: string, focus?: FocusRange): Promise<LineHintResponse>`
  - `HintRequest` gains `bands?: CodeBand[]` and `total_lines?: number`.
  - `getTrace` is unchanged in shape; Task 16 changes what its caller passes.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/apiClient.test.ts`, following the file's existing `fetch` stubbing:

```ts
import { digestFields } from "../apiClient";
import type { CodeDigest } from "../codeDigest";

const DIGEST: CodeDigest = {
  code: "import math\ndef deep(n):",
  bands: [
    { start: 1, end: 1 },
    { start: 173, end: 173 },
  ],
  totalLines: 241,
};

describe("digestFields", () => {
  it("renames totalLines to the wire's snake_case and nothing else", () => {
    expect(digestFields(DIGEST)).toEqual({
      code: "import math\ndef deep(n):",
      bands: [
        { start: 1, end: 1 },
        { start: 173, end: 173 },
      ],
      total_lines: 241,
    });
  });
});

describe("the inline endpoints send bands", () => {
  it("scanCode posts the digest and the focus", async () => {
    const body = await captureBody(() =>
      client.scanCode(DIGEST, "python", { start_line: 173, end_line: 174, label: "deep" })
    );
    expect(body.code).toBe(DIGEST.code);
    expect(body.bands).toEqual(DIGEST.bands);
    expect(body.total_lines).toBe(241);
    expect(body.focus.label).toBe("deep");
  });

  it("scanCode omits the focus when there isn't one", async () => {
    const body = await captureBody(() => client.scanCode(DIGEST, "python"));
    expect(body).not.toHaveProperty("focus");
  });

  it("getLineHint posts the digest alongside the absolute line", async () => {
    const body = await captureBody(() => client.getLineHint(DIGEST, 173, "python"));
    expect(body.line).toBe(173);
    expect(body.bands).toEqual(DIGEST.bands);
  });
});
```

Write `captureBody` as a local helper matching the file's existing fetch stub: it installs the stub, runs the thunk, and returns `JSON.parse(init.body)` from the recorded call.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npm test -- apiClient`
Expected: FAIL — `digestFields` is not exported, and `scanCode` receives an object where it expects a string.

- [ ] **Step 3: Write the implementation**

At the top of `apiClient.ts`:

```ts
import type { CodeBand, CodeDigest } from "./codeDigest";
```

Add beside the other exported helpers:

```ts
/**
 * The three fields every code-carrying request shares.
 *
 * One function so there is one place the digest becomes a payload — the
 * property that makes "the file never leaves the machine" checkable rather
 * than merely intended. `auditRegressions` asserts nothing else does it.
 */
export function digestFields(digest: CodeDigest): {
  code: string;
  bands: CodeBand[];
  total_lines: number;
} {
  return { code: digest.code, bands: digest.bands, total_lines: digest.totalLines };
}
```

Add to `HintRequest`:

```ts
  /** Absolute line ranges `code` was lifted from. */
  bands?: CodeBand[];
  /** Lines in the real file, so an elision can say how much is missing. */
  total_lines?: number;
```

Rewrite the two methods:

```ts
  async scanCode(
    digest: CodeDigest,
    language = "python",
    focus?: FocusRange
  ): Promise<ScanResponse> {
    const res = await this.authedJson("/scan", {
      ...digestFields(digest),
      language,
      ...(focus ? { focus } : {}),
    });
    if (res.status === 429) throw rateLimitErrorFrom(res);
    if (!res.ok) throw new Error(`scan failed (${res.status})`);
    return (await res.json()) as ScanResponse;
  }

  async getLineHint(
    digest: CodeDigest,
    line: number,
    language = "python",
    focus?: FocusRange
  ): Promise<LineHintResponse> {
    const res = await this.authedJson("/line-hint", {
      ...digestFields(digest),
      line,
      language,
      ...(focus ? { focus } : {}),
    });
    if (res.status === 429) throw rateLimitErrorFrom(res);
    if (!res.ok) throw new Error(`line-hint failed (${res.status})`);
    return (await res.json()) as LineHintResponse;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npm test -- apiClient`
Expected: PASS. `npm test` as a whole will now fail to compile in `inlineTutor.ts`, which Task 13 fixes.

- [ ] **Step 5: Commit**

```bash
git add extension/src/apiClient.ts extension/src/__tests__/apiClient.test.ts
git commit -m "One place where a digest becomes a payload

digestFields is the only function that turns document text into request
fields, which is what makes the claim checkable instead of merely intended."
```

---

### Task 12: `annotationStore` replaces flags per block

**Files:**
- Modify: `extension/src/annotationStore.ts`
- Test: `extension/src/__tests__/annotationStore.test.ts`

**Interfaces:**
- Consumes: `LineSpan`, `LineFlag`.
- Produces: `setFlagsIn(span: LineSpan, flags: LineFlag[]): void`, replacing `setFlags`.

`setFlags` replaces the flag set wholesale. With per-block scans that means scanning `parse()` erases every flag on `validate()`.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/annotationStore.test.ts`:

```ts
import { AnnotationStore } from "../annotationStore";
import type { LineFlag } from "../apiClient";

const flag = (line: number, question = "Why?"): LineFlag => ({
  line,
  end_line: line,
  question,
  concept: "general",
  severity: "info",
  kind: "bug",
});

describe("a scan of one block leaves the other blocks alone", () => {
  it("keeps flags outside the scanned span", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5)]);
    store.setFlagsIn({ start: 40, end: 60 }, [flag(45)]);
    expect(store.flags().map((f) => f.line).sort((a, b) => a - b)).toEqual([5, 45]);
  });

  it("replaces flags inside the scanned span", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5, "First")]);
    store.setFlagsIn({ start: 0, end: 20 }, [flag(7, "Second")]);
    expect(store.flags()).toHaveLength(1);
    expect(store.flags()[0].question).toBe("Second");
  });

  it("clears a block whose scan came back clean", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5)]);
    store.setFlagsIn({ start: 0, end: 20 }, []);
    expect(store.flags()).toEqual([]);
  });

  it("drops a flag that merely overlaps the scanned span", () => {
    // A multi-line flag straddling the boundary was written against code the
    // new scan has just re-read. Keeping it would double up.
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [{ ...flag(18), end_line: 22 }]);
    store.setFlagsIn({ start: 20, end: 40 }, []);
    expect(store.flags()).toEqual([]);
  });

  it("still converts to and from the wire's 1-based lines", () => {
    const store = new AnnotationStore();
    store.setFlagsIn({ start: 0, end: 20 }, [flag(5)]);
    expect(store.annotationsAt(4).flag?.line).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npm test -- annotationStore`
Expected: FAIL — `store.setFlagsIn is not a function`.

- [ ] **Step 3: Write the implementation**

Replace `setFlags` in `annotationStore.ts`:

```ts
  /**
   * Replace the flags inside one span, leaving every other block alone.
   *
   * Scans are per block now, so a wholesale replacement would mean reviewing
   * `parse` erased every flag on `validate` — the student losing marks on
   * code they have not touched, simply for moving the cursor.
   *
   * A flag merely overlapping the span goes too: it was written against code
   * this scan has just re-read, and keeping it would double up.
   */
  setFlagsIn(span: LineSpan, flags: LineFlag[]): void {
    const outside = this.storedFlags.filter(
      (f) => f.end < span.start || f.start > span.end
    );
    this.storedFlags = [
      ...outside,
      ...flags.map((flag) => ({
        // The backend is 1-based; everything below this line is 0-based.
        start: Math.max(0, flag.line - 1),
        end: Math.max(0, Math.max(flag.line, flag.end_line) - 1),
        flag,
      })),
    ].sort((a, b) => a.start - b.start);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npm test -- annotationStore`
Expected: PASS. Callers of `setFlags` in `inlineTutor.ts` now fail to compile; Task 13 fixes them.

- [ ] **Step 5: Commit**

```bash
git add extension/src/annotationStore.ts extension/src/__tests__/annotationStore.test.ts
git commit -m "Replace flags per block, not per file

Scans are per block now, so a wholesale replacement meant reviewing parse
erased every flag on validate - the student losing marks on code they had
not touched, for moving the cursor."
```

---

### Task 13: `inlineTutor` sends digests and scans one block

**Files:**
- Modify: `extension/src/inlineTutor.ts` (`fetchLineHint`, `runScan`, `maybeOfferReflection`, `removeFixedBugMarkers`)
- Test: `extension/src/__tests__/inlineTutor.test.ts`

**Interfaces:**
- Consumes: `buildDigest` (Task 1-4), `scanCode`/`getLineHint` (Task 11), `setFlagsIn` (Task 12), `resolveFocus` (existing).
- Produces: `scanFingerprints`, `inFlightFingerprints` and `lastFlagCounts` keyed by `` `${uri}#${label}` `` rather than by URI alone.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/inlineTutor.test.ts`, following the file's existing document/editor mock setup:

```ts
describe("the inline surface works on one block", () => {
  it("sends a digest to the scan, not the file", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    const [digest] = api.scanCode.mock.calls[0];
    expect(digest.code).not.toContain("line_10 = 10");
    expect(digest.code).toContain("import math");
    expect(digest.bands.length).toBeGreaterThan(1);
  });

  it("tells the scan which block it is reviewing", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    const [, , focus] = api.scanCode.mock.calls[0];
    expect(focus.start_line).toBeLessThanOrEqual(200);
    expect(focus.end_line).toBeGreaterThanOrEqual(200);
  });

  it("drops a flag the backend returned outside the block", async () => {
    // Defence in depth: the model should not have been able to see line 3.
    api.scanCode.mockResolvedValue({
      flags: [{ line: 3, end_line: 3, question: "Why?", concept: "general",
                severity: "info", kind: "bug" }],
    });
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    expect(tutor.storeForTest(doc.uri).flags()).toEqual([]);
  });

  it("sends a digest to the line hint too", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await mock.__runCommand("edupeer.nudgeLine");
    const [digest, line] = api.getLineHint.mock.calls[0];
    expect(line).toBe(200);
    expect(digest.totalLines).toBe(LONG_PYTHON_FILE.split("\n").length);
    expect(digest.code).not.toContain("line_10 = 10");
  });

  it("scans a block once per version of its own text", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    placeCursorOn(doc, 200);
    await runScanNow();
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("scans a second block on its own fingerprint", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    placeCursorOn(doc, 20);
    await runScanNow();
    expect(api.scanCode).toHaveBeenCalledTimes(2);
  });
});
```

Define `LONG_PYTHON_FILE` at the top of the suite as `"import math\n" + 200 filler assignments + "def deep(n):\n    return n - 1\n"` so line 200 falls inside a named block, and add a `storeForTest(uri)` accessor to `InlineTutor` if the suite has no existing way to read the store.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npm test -- inlineTutor`
Expected: FAIL to compile — `scanCode` is called with a string where a `CodeDigest` is required, and `store.setFlags` no longer exists.

- [ ] **Step 3: Write the implementation**

In `fetchLineHint`, replace the `code`/`getLineHint` pair:

```ts
      const focus = await resolveFocus(doc, selection);
      const lines = stripBugMarkers(doc.getText(), doc.languageId).split("\n");
      const digest = buildDigest(lines, doc.languageId, {
        start: focus.startLine,
        end: focus.endLine,
      });
      const res = await this.api.getLineHint(digest, line + 1, doc.languageId, {
        start_line: focus.startLine + 1,
        end_line: focus.endLine + 1,
        label: focus.label,
      });
```

Replace `runScan` with a block-scoped version:

```ts
  private async runScan(doc: vscode.TextDocument, opts: { force?: boolean } = {}) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc) return;
    const focus = await resolveFocus(doc, editor.selection);
    const lines = stripBugMarkers(doc.getText(), doc.languageId).split("\n");
    const digest = buildDigest(lines, doc.languageId, {
      start: focus.startLine,
      end: focus.endLine,
    });
    if (!digest.code.trim()) return;

    // Keyed by block, not by document: a file is not one thing to scan any
    // more, and a URI key would report the second block already scanned.
    const key = `${doc.uri.toString()}#${focus.label}`;
    const fp = fingerprintCode(digest.code);
    if (!opts.force && this.scanFingerprints.get(key) === fp) return;
    if (!opts.force && this.inFlightFingerprints.get(key) === fp) return;
    this.inFlightFingerprints.set(key, fp);
    try {
      const res = await this.api.scanCode(digest, doc.languageId, {
        start_line: focus.startLine + 1,
        end_line: focus.endLine + 1,
        label: focus.label,
      });
      this.scanFingerprints.set(key, fp);
      const store = this.storeFor(doc.uri);
      // The backend drops these too. Doing it here as well means a flag can
      // only ever appear on the block the student is actually on.
      const inFocus = (res.flags || []).filter(
        (f) => f.line - 1 >= focus.startLine && f.line - 1 <= focus.endLine
      );
      store.setFlagsIn({ start: focus.startLine, end: focus.endLine }, inFocus);
      this.applyFlagsToDoc(doc);
      this.emitter.fire();
      this.renderActiveLineDecoration(editor);
      this.maybeOfferReflection(doc, key, focus, digest.code, inFocus.length);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.quietUntil = Date.now() + err.retryAfterSeconds * 1000;
      }
      /* scan failures are otherwise non-fatal */
    } finally {
      if (this.inFlightFingerprints.get(key) === fp) {
        this.inFlightFingerprints.delete(key);
      }
    }
  }
```

Change `maybeOfferReflection` to take the block key and span, and to pass the span to `removeFixedBugMarkers`:

```ts
  private maybeOfferReflection(
    doc: vscode.TextDocument,
    key: string,
    focus: { startLine: number; endLine: number },
    code: string,
    flagCount: number
  ) {
    const prev = this.lastFlagCounts.get(key) ?? 0;
    this.lastFlagCounts.set(key, flagCount);
    if (prev === 0 || flagCount > 0) return;
    void this.removeFixedBugMarkers(doc, focus);
    // ... rest unchanged
  }
```

In `removeFixedBugMarkers`, take the span and filter the markers to it:

```ts
  private async removeFixedBugMarkers(
    doc: vscode.TextDocument,
    focus: { startLine: number; endLine: number }
  ) {
    ...
    const markers = findBugMarkers(doc.getText().split("\n"), doc.languageId).filter(
      // Narrowed with the scan: this is the one place EduPeer writes into the
      // student's code, and it may only speak for the block that went clean.
      (m) => m.line >= focus.startLine && m.line <= focus.endLine
    );
```

Update the `onDidCloseTextDocument` cleanup to drop every key prefixed with the document's URI rather than the single URI key:

```ts
        const prefix = doc.uri.toString();
        for (const map of [
          this.scanFingerprints,
          this.inFlightFingerprints,
          this.lastFlagCounts as Map<string, unknown>,
        ]) {
          for (const k of [...map.keys()]) {
            if (k === prefix || k.startsWith(`${prefix}#`)) map.delete(k);
          }
        }
```

Add `import { buildDigest } from "./codeDigest";` at the top.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npm test -- inlineTutor annotationStore apiClient`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/inlineTutor.ts extension/src/__tests__/inlineTutor.test.ts
git commit -m "Scan the block the cursor is in, and send only that

Fingerprints are keyed by block rather than by document, so revisiting an
unedited block costs nothing and a second block is not reported already
scanned. The bug-marker rewrite - the one place EduPeer writes into the
student's code - is narrowed to the block that went clean."
```

---

### Task 14: Nothing runs until the student lands somewhere

**Files:**
- Modify: `extension/src/inlineTutor.ts` (constructor listeners, `scheduleScan`)
- Modify: `extension/package.json` (`edupeer.scanFile` title)
- Test: `extension/src/__tests__/inlineTutor.test.ts`

**Interfaces:**
- Consumes: `runScan` from Task 13.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/inlineTutor.test.ts`:

```ts
describe("the tutor waits until the student is working on something", () => {
  it("scans nothing when the extension activates", async () => {
    openDocument(LONG_PYTHON_FILE, "python");
    new InlineTutor(context, api);
    await flushTimers(4000);
    expect(api.scanCode).not.toHaveBeenCalled();
  });

  it("scans nothing when the student switches tabs", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    mock.__fireActiveEditorChange({ document: doc, selection: selectionAt(0) });
    await flushTimers(4000);
    expect(api.scanCode).not.toHaveBeenCalled();
  });

  it("scans the block the cursor comes to rest in", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    mock.__fireSelectionChange(doc);
    await flushTimers(4000);
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("scans the block an edit lands in", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    mock.__fireDocumentChange(doc, { startLine: 199, endLine: 199, insertedLineCount: 1 });
    await flushTimers(4000);
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("opening a file and reading it costs nothing", async () => {
    openDocument(LONG_PYTHON_FILE, "python");
    await flushTimers(10000);
    expect(api.scanCode).not.toHaveBeenCalled();
    expect(api.getLineHint).not.toHaveBeenCalled();
  });
});
```

Use the suite's existing timer-advancing helper for `flushTimers`; if there is none, add one that runs `jest.advanceTimersByTime(ms)` followed by a flushed microtask queue.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npm test -- inlineTutor`
Expected: FAIL — the activation and tab-switch tests see one `scanCode` call each; the cursor-rest test sees zero.

- [ ] **Step 3: Write the implementation**

Delete the activation scan at the end of the constructor:

```ts
    // Opening a file is not working on it. Nothing runs until the student
    // lands somewhere — see the trigger table in the 2026-08-11 spec.
    const editor = vscode.window.activeTextEditor;
    if (editor && this.isSupported(editor.document)) {
      this.renderActiveLineDecoration(editor);
    }
```

Remove `this.scheduleScan(editor.document)` from the `onDidChangeActiveTextEditor` listener, leaving only `renderActiveLineDecoration`.

Add the scan to the selection listener, beside the line hint it already schedules:

```ts
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.isSupported(e.textEditor.document)) return;
        this.scheduleLineHint(e.textEditor);
        // Resting the cursor in a block is working on it. The fingerprint in
        // `runScan` is per block, so a student scrolling through a file pays
        // once per block rather than once per pause.
        this.scheduleScan(e.textEditor.document);
        this.renderActiveLineDecoration(e.textEditor);
      })
```

The document-change listener already calls `scheduleScan`, and `runScan` now resolves the focus from the live cursor, so an edit in another block scans that block rather than this one. Leave it as it is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npm test -- inlineTutor`
Expected: PASS.

- [ ] **Step 5: Retitle the command**

In `extension/package.json`, change the `edupeer.scanFile` command title to `EduPeer: Scan This Block`. Keep the command id: anyone who has bound it keeps their binding.

- [ ] **Step 6: Run the extension suite**

Run: `cd extension && npm test`
Expected: PASS except `sidebarProvider`, `extension` and `auditRegressions`, which Tasks 15-16 fix.

- [ ] **Step 7: Commit**

```bash
git add extension/src/inlineTutor.ts extension/src/__tests__/inlineTutor.test.ts extension/package.json
git commit -m "Stop scanning files the student has only just opened

Opening a file is not working on it, and neither is switching to its tab.
Both fired a whole-file scan, which is how marks appeared on code nobody had
touched. Resting the cursor in a block now scans that block instead."
```

---

### Task 15: The conversation sends a digest

**Files:**
- Modify: `extension/src/sidebarProvider.ts`
- Test: `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Consumes: `buildDigest`, `digestFields`.
- Produces: `lastFullCode` renamed `panelFullCode`; a new private `lastDigest?: CodeDigest`.

`panelFullCode` still feeds the webview's **Whole file** toggle, which is local to the editor and stays exactly as it is. The rename is what stops it being reached for as a request payload again.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
describe("the conversation carries a digest, not the file", () => {
  it("sends the imports and the block, and nothing between them", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await provider.sendFocusNow();
    await provider.askExternal("why does this fail?", "");
    const body = api.getHint.mock.calls[0][0];
    expect(body.code).toContain("import math");
    expect(body.code).toContain("def deep(n):");
    expect(body.code).not.toContain("line_10 = 10");
    expect(body.bands.length).toBeGreaterThan(1);
    expect(body.total_lines).toBe(LONG_PYTHON_FILE.split("\n").length);
  });

  it("still shows the student their whole file in the panel", async () => {
    // The webview is in the editor; nothing it renders crosses the network.
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await provider.sendFocusNow();
    await provider.handleMessageForTest({ type: "requestFullFile" });
    const posted = postedMessages().find((m) => m.type === "fullFile");
    expect(posted.code).toBe(LONG_PYTHON_FILE);
  });

  it("streams a digest too", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await provider.sendFocusNow();
    await provider.askExternal("why?", "", "hint");
    const body = api.streamHint.mock.calls[0]?.[0] ?? api.getHint.mock.calls[0][0];
    expect(body.bands).toBeDefined();
  });
});
```

Use the suite's existing helpers for `sendFocusNow`, `postedMessages` and the webview-message entry point; add thin test-only accessors only where the suite has none.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npm test -- sidebarProvider`
Expected: FAIL — `body.bands` is undefined and `body.code` contains the whole file.

- [ ] **Step 3: Write the implementation**

Add the imports and the field. `sidebarProvider.ts` already imports from `./apiClient`, so extend that import rather than adding a second one:

```ts
import { buildDigest, type CodeDigest } from "./codeDigest";
// on the existing apiClient import, add: digestFields
```

```ts
  /** The digest for `lastFocus`, rebuilt whenever the focus block changes. */
  private lastDigest?: CodeDigest;
```

Rename the field and add the digest beside it, in the focus-resolution path around line 855:

```ts
    this.lastFocus = focus;
    // Display only: the panel's "Whole file" toggle renders this, and the
    // webview is in the editor. It must never become a request payload —
    // `auditRegressions` asserts that it does not.
    this.panelFullCode = doc.getText();
    this.lastDigest = buildDigest(
      stripBugMarkers(doc.getText(), this.lastLanguageId).split("\n"),
      this.lastLanguageId,
      { start: focus.startLine, end: focus.endLine }
    );
```

Rename every other `lastFullCode` reference to `panelFullCode`, including the `fullFile` post and the reset at line 812.

In the request builder, replace `requestCode` with the digest fields:

```ts
    // The digest, so a hint about one function still sees its imports and
    // what it can call — without the four hundred lines between them.
    const digest =
      aboutOpenFile && this.lastDigest
        ? this.lastDigest
        : buildDigest((code || "").split("\n"), this.lastLanguageId, {
            start: 0,
            end: Math.max(0, (code || "").split("\n").length - 1),
          });
```

and in the request literal, replace `code: requestCode,` with `...digestFields(digest),`.

`attemptCode` is unchanged: it already uses `threadBlockCode`, the text of the block the thread is keyed on.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && npm test -- sidebarProvider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidebarProvider.ts extension/src/__tests__/sidebarProvider.test.ts
git commit -m "The conversation carries a digest too

The panel was the last and busiest whole-file path: every ask and every
follow-up posted doc.getText(). panelFullCode keeps its old job of feeding
the Whole file toggle, which is local to the editor, and its new name is
what stops it being reached for as a payload again."
```

---

### Task 16: The last three sites, and the guard that keeps them shut

**Files:**
- Modify: `extension/src/extension.ts` (`predictOutput`, `traceCode`, `discussLines`)
- Modify: `extension/src/__tests__/auditRegressions.test.ts`
- Test: `extension/src/__tests__/extension.test.ts`

**Interfaces:**
- Consumes: `buildDigest`, `resolveFocus`, `focusText`.
- Produces: no new exports.

`/trace` uses `req.code` only when `selection` is empty (`main.py:451`) and never numbers it, so its fallback becomes the focus block rather than the file — no bands needed.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/extension.test.ts`:

```ts
describe("the commands that reach for the file send a block instead", () => {
  it("predictOutput sends the block around the selection", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    selectLines(doc, 199, 200);
    await mock.__runCommand("edupeer.predictOutput");
    const [, code] = provider.startPrediction.mock.calls[0];
    expect(code).not.toContain("line_10 = 10");
    expect(code).toContain("def deep(n):");
  });

  it("traceCode with no selection traces the block, not the file", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await mock.__runCommand("edupeer.traceCode");
    const [snippet] = provider.startTrace.mock.calls[0];
    expect(snippet).not.toContain("line_10 = 10");
    expect(snippet).toContain("def deep(n):");
  });

  it("discussLines sends the block, not the file", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    await mock.__runCommand("edupeer.discussLines", doc.uri, 199, 200, "Off by one?");
    const [, code] = provider.askExternal.mock.calls[0];
    expect(code).not.toContain("line_10 = 10");
  });
});
```

Append to `extension/src/__tests__/auditRegressions.test.ts`:

```ts
import * as fs from "fs";
import * as path from "path";

// ------------------------------------------------- the file stays on the machine

describe("no source file hands raw document text to the network", () => {
  const SRC = path.join(__dirname, "..");
  const SENDERS = ["sidebarProvider.ts", "inlineTutor.ts", "extension.ts"];

  it("reaches apiClient only through buildDigest", () => {
    // The whole point of codeDigest is that the student's file does not leave
    // their machine. That is a property of the call sites, not of the module,
    // so it is asserted here rather than trusted.
    for (const name of SENDERS) {
      const source = fs.readFileSync(path.join(SRC, name), "utf8");
      const offenders = source
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /getText\(\)/.test(line))
        .filter(([, line]) => !/buildDigest|panelFullCode|split\("\\n"\)|findBugMarkers/.test(line));
      expect({ name, offenders }).toEqual({ name, offenders: [] });
    }
  });

  it("keeps the panel's whole-file copy out of every request", () => {
    const source = fs.readFileSync(path.join(SRC, "sidebarProvider.ts"), "utf8");
    expect(source).not.toMatch(/code:\s*this\.panelFullCode/);
    expect(source).toContain("digestFields(");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test -- extension auditRegressions`
Expected: FAIL — the three commands still pass `doc.getText()`, and the audit lists them as offenders.

- [ ] **Step 3: Write the implementation**

All three commands want the *enclosing block* as context, not the selection. `resolveFocus` ranks a non-empty selection above everything, so passing the live selection would make the context identical to the snippet and the tutor would lose the surrounding function. Resolve from a collapsed cursor instead — the same synthetic-selection pattern `fetchLineHint` already uses and documents at `inlineTutor.ts:395-406`.

Add the helper near the top of `extension.ts`:

```ts
/**
 * The block around a position, ignoring any selection.
 *
 * `resolveFocus` ranks a selection above the enclosing symbol, which is right
 * when the selection *is* the question. Here it is the answer's subject and
 * the block around it is the context, so the selection must not win.
 */
async function blockAround(
  doc: vscode.TextDocument,
  at: vscode.Position
): Promise<string> {
  return focusText(doc, await resolveFocus(doc, new vscode.Selection(at, at)));
}
```

In `predictOutput`, replace the `startPrediction` call:

```ts
      provider.startPrediction(
        snippet,
        await blockAround(editor!.document, editor!.selection.active)
      );
```

In `traceCode`, replace both the fallback snippet and the context:

```ts
      const block = await blockAround(editor.document, editor.selection.active);
      // Tracing a whole file was never the intent; with no selection the
      // block the cursor is in is what the student means.
      const snippet = editor.document.getText(editor.selection).trim() || block;
      if (!snippet) {
        vscode.window.showInformationMessage("EduPeer: there's nothing here to trace.");
        return;
      }
      await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
      await provider.startTrace(snippet, block);
```

In `discussLines`, replace `doc.getText()`:

```ts
        await provider.askExternal(
          question
            ? `About these lines you flagged — "${question}"\n\n${snippet}`
            : `What is wrong with these lines?\n\n${snippet}`,
          await blockAround(doc, new vscode.Position(first, 0))
        );
```

Add `import { focusText, resolveFocus } from "./focusScope";` to `extension.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: PASS, the whole extension suite.

- [ ] **Step 5: Run the whole backend suite one more time**

Run: `cd backend && ./.venv/Scripts/python.exe -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/extension.ts extension/src/__tests__/extension.test.ts \
        extension/src/__tests__/auditRegressions.test.ts
git commit -m "Close the last three whole-file paths, and pin them shut

Predict, trace and discuss each posted doc.getText(); trace also traced the
entire file whenever nothing was selected. The audit test reads the three
sending modules and fails on a raw getText() reaching the network, because
the claim is a property of the call sites rather than of codeDigest."
```

---

## Manual verification

After the last task, with the backend deployed and the extension running under F5:

1. Open a file of 250 lines or more. **Nothing is flagged.** Switch tabs and back: still nothing.
2. Click into a function near the bottom and pause. That block — and only that block — picks up marks.
3. Ask the panel a question about it. The answer can name an import from line 2, and any line number it cites points at the right line.
4. Flag something in one function, then edit a different one. The first flag stays.
5. With the Network tab of the extension host open, confirm the `/hint` request body contains the imports and the block and not the lines between them.
