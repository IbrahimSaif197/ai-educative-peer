# EduPeer: the tutor works on one block, and the rest of the file stays home

Date: 2026-08-11
Status: approved, ready for planning

## Why

Two complaints, one root cause.

The tutor comments on code the student is not working on. `/scan` receives
`doc.getText()` and flags anything in it, so a student editing `parse()` gets
`❓` lenses and Problems entries on three other functions. Worse, the scan fires
on activation and on every tab switch, so those marks appear on a file the
student has only just opened and has not touched.

And the whole file leaves the machine on every request. Six call sites send
`doc.getText()`:

| Site | Endpoint |
|---|---|
| `sidebarProvider.ts:855` `lastFullCode` | `/hint`, `/stream` |
| `inlineTutor.ts:408` `fetchLineHint` | `/line-hint` |
| `inlineTutor.ts:528` `runScan` | `/scan` |
| `extension.ts:216` `predictOutput` | `/hint` |
| `extension.ts:234` `traceCode` | `/trace` |
| `extension.ts:254` `discussLines` | `/hint` |

`3a2ab3f` narrowed what the model *reads* on the conversation path, windowing
files over 120 lines to the focus block plus 25 lines either side. It did not
narrow what the client *sends*, and it left the other five sites alone.

That commit also introduced a defect worth naming. `_window`
(`hinting_engine.py:412`) returns `start - 25 … end + 25` and nothing else, so
on a file over 120 lines with the focus near the bottom the tutor is handed
`[lines 1-172 of this file are not shown]` and never sees a single import. It
is asked to reason about code whose dependencies are out of frame.

## Scope

In scope:

- **A.** A client-built code digest, and the wire contract that carries it.
- **B.** `/scan` scoped to the focus block.
- **C.** Triggers tied to the block the student is working in.
- **D.** Flags that survive per block instead of being replaced wholesale.

Out of scope: the hint ladder, the attempt gate, auth, the progress panel, and
any change to how `focusScope` resolves a block. `focusScope.ts` already
answers "which block is the student on"; this spec changes what is done with
that answer.

### What "the file stays home" means precisely

The digest contains code — it has to. What leaves is the file's imports, the
headers of the scopes enclosing the block, one line per top-level definition,
the block itself, three lines either side of it, and the cursor's own line.
Every other line of the student's file never crosses the network.

One exception, and it is the feature rather than a hole: asking for a desk-check
trace with nothing selected sends the block whole, because the block *is* the
exercise and a digest's elided bands would produce a trace with holes in it.
That path is bounded by the block's own length, not by `MAX_DIGEST_LINES`.
Everything else — hints, scans, the conversation, prediction, and the trace
follow-up — goes through `buildDigest` and is capped.

`/trace` also used to carry a second, redundant copy of the block in `code`,
which the handler reads only when `selection` is empty — something the caller
never allows. It was uploaded and discarded on every trace, and being a plain
string rather than a digest it was unbounded. The client no longer sends it;
the field stays on `TraceRequest` for the published 1.5.1 build.

---

## A. The digest

### A1. `codeDigest.ts`

A new pure module beside `blockHeuristics.ts`: raw lines in, structure out, no
`vscode` import, so the part worth testing is testable without an editor.

```ts
/** 1-based, absolute, inclusive — the same coordinates the backend numbers in. */
export interface CodeBand {
  start: number;
  end: number;
}

export interface CodeDigest {
  /** The selected lines, joined. Never the whole file. */
  code: string;
  /** Which absolute lines `code` corresponds to, ascending and disjoint. */
  bands: CodeBand[];
}

export function buildDigest(
  lines: string[],
  languageId: string,
  focus: LineSpan,
  cursorLine?: number
): CodeDigest;
```

`cursorLine` is 0-based, like `focus`, and optional because not every digest
has a cursor behind it — the panel's conversation is about the block. It was
added after the branch's final review: see **Anchor** below.

`buildDigest` is a pure module and never imports `vscode`. The one door from a
`TextDocument` to a digest is `documentDigest.digestFor(doc, focus,
cursorLine?, languageId?)`, which does the marker strip, the split and the
call.

Up to five bands, merged where they touch or overlap, under a 120-line budget
(`MAX_CODE_LINES_SENT`, unchanged):

**Header** — line 1 to the first line that is not an import, a `#include`,
`using`, `package`, a module-level constant, or a comment. Cap 30 lines. This
is the band whose absence is the defect described above.

Detection needs an `importRegex` on `LanguageInfo` in `languages.ts`, beside
the `lensRegex` already there:

| Language | Matches |
|---|---|
| python | `import x`, `from x import y` |
| javascript, typescript | `import …`, `const x = require(…)`, `export … from` |
| java, csharp | `import …`, `using …`, `package …`, `namespace …` |
| c, cpp | `#include`, `#define`, `using namespace` |
| go | `import`, `package`, and a parenthesised import block |
| rust | `use …`, `mod …`, `extern crate` |
| sql | nothing; the header band is empty and that is correct |

**Signatures** — every top-level line matching the language's existing
`lensRegex`, one line each, bodies omitted. Cap 20, nearest the focus block
first when the cap bites. This is the band that earns its tokens: one line
says `validate(payload)` exists and takes one argument, which is what stops
the tutor proposing a helper the student already wrote.

**Enclosing scope** — the header lines of the blocks the focus sits inside: the
`class`, the `impl`, the `namespace`. `fromSymbols` already walks this chain to
build its breadcrumb, so a method's `class Stats:` line comes for free. One to
three lines. A method read without its class reads as a function with a
mysterious first parameter.

**Focus** — the block itself, plus three lines either side, taking the rest of
the budget. A block larger than the budget keeps its head, the rule `_window`
already applies and for the same reason: a signature and the first lines of a
body are what make a function legible.

Three lines rather than the twenty-five in `FOCUS_CONTEXT_LINES`. That constant
was defending the case where the caller two functions down is what makes a hint
land, and the signature band now covers that case for one line instead of
forty. What ±3 buys that ±0 does not is the decorator, the `@staticmethod`, and
the comment sitting immediately above the block — context that belongs to the
block without being inside it.

**Anchor** — the cursor's own line, claimed before the focus band and so
before anything else. Usually free: in a block that fits the budget the focus
band already holds it, and the chosen lines are a set. It only becomes a band
of its own in a block longer than the budget, where the focus band keeps the
head and drops the tail. Without it, `fetchLineHint` builds a digest around the
*block* and then asks about the *cursor*, and nothing guarantees the two
overlap: the backend finds no such line, returns an empty hint, and the lens
renders that as "✓ Nothing to flag on this line" — the tutor reassuring the
student about code it was never shown.

What the anchor buys is exactly that, plus the same guarantee for the scan: a
flag can land on the line the student is looking at. It does **not** make an
oversized block's verdict trustworthy elsewhere in the block — `setFlagsIn` and
`removeFixedBugMarkers` both act on the whole focus range, so a marker deep in
an unreviewed tail is still deletable. That hazard predates the anchor and is
out of scope here.

On a 241-line file with a 15-line block: 65 lines sent today with no imports,
about 42 after this, imports included.

### A2. The wire contract

`code` carries the digest. A new `bands` field says which absolute lines it
corresponds to:

```python
class CodeBand(BaseModel):
    start: int = Field(ge=1)
    end: int = Field(ge=1)

# on HintRequest, LineHintRequest and ScanRequest
bands: list[CodeBand] | None = None
total_lines: int | None = None
```

Not on `TraceRequest`. `/trace` reads `req.code` only as a fallback when
`selection` is empty (`main.py:451`) and never numbers it, so its fix is
simply to stop sending the file: the extension passes the focus block, and no
coordinates are needed to make sense of it.

A `total_lines: int | None` rides with them. Without it the backend cannot
name its own last elision: it can say `[lines 4-172 of this file are not
shown]` between two bands, because both ends are known, but after the final
band it has no idea whether one line follows or four hundred. One integer buys
an exact marker instead of a vague one, and the panel already computes the
number.

`ScanRequest` also gains the `focus: FocusRange | None` the other two hint
endpoints already carry. The 2026-08-09 spec left it off deliberately, on the
grounds that a scan's job is to flag lines across the whole file; that is the
job this spec is changing.

Bands must be ascending, disjoint, each `end >= start`, and their total length
must equal the digest's line count. Anything else and the request is treated as
carrying a whole file starting at line 1 — today's behaviour exactly, which is
what keeps the published 1.5.1 build working against the new backend. An
invalid `bands` is never an error; it is a client that does not speak this yet.

### A3. `CodeView`

One object in `hinting_engine.py` owns the absolute-line mapping, because three
separate places currently derive line numbers from position in `code` and would
each be wrong on a digest:

```python
CodeView.of(code, bands)   # bands absent or inconsistent -> whole file at line 1
  .numbered()              # "1: import math" … "[lines 4-172 not shown]" … "173: def …"
  .line_at(n)              # the text at absolute line n, or None
  .contains(n)             # is absolute line n present in this view
```

`numbered()` announces every gap in the format `number_lines` already emits, so
a model that cannot see the top of the file knows that rather than reporting a
missing import that is merely out of frame. `number_lines` keeps its signature
and delegates, so the conversation path is unchanged for old clients.

The three callers that need it:

- `number_lines` — rendering, as today.
- `generate_line_hint` (`:692`) — indexes `code.splitlines()[line_number - 1]`.
  Against a digest, absolute line 200 falls off the end of a 42-line string and
  the function silently returns `""`. Line hints would break outright without
  this. Becomes `view.line_at(line_number)`.
- `scan_code` (`:627`) — validates `line <= total_lines` and numbers with its
  own `enumerate`. Becomes `view.contains(line)` and `view.numbered()`.

### A4. Every send site goes through it

Six sites were named here at design time; there were seven —
`extension.ts`'s `askWithActiveFile` was only found in Task 16. None of them
still posts `doc.getText()`, but they do not all reach `buildDigest`, and the
split is deliberate:

- The three that ask for a *hint about a file* — the line hint, the scan and
  the panel's conversation — go through `documentDigest.digestFor`, the one
  document-to-digest door, which calls `buildDigest`.
- `/trace`, `/predict` and `askWithActiveFile` go through
  `extension.ts`'s `blockAround` → `focusText`: the block's own text,
  verbatim, seeded `bug:` markers included. A desk-check exercise with elided
  bands in it is not a desk-check exercise, and `getTrace` never numbers what
  it is given, so absolute coordinates buy nothing there. `blockAround`'s
  comment says this, so the next reader does not "unify" it by mistake.
- `sidebarProvider`'s fallback branch calls `buildDigest` directly on a
  string — a review exercise, a prediction, a trace answer — which was never a
  `TextDocument` and so has no door to go through.

`traceCode`'s no-selection fallback, which traced
`editor.document.getText().trim()`, becomes the focus block either way —
tracing an entire file was never the intent.

`lastFullCode` is renamed `panelFullCode`. It still feeds the webview's
**Whole file** toggle, which is local to the editor and stays exactly as it is;
the rename stops it being reached for as a request payload again.

Tests in `auditRegressions.test.ts` keep this from regressing quietly. They
assert against the chokepoint symbol rather than the shape of the old inline
incantation: no sender feeds a document's own text into a `buildDigest` call
(checked by walking each call's arguments, since the call spans four lines),
`codeDigest.ts` imports no `vscode`, and a bare `getText()` in a sender must be
the panel's display copy or a marker search.

---

## B. Scan, scoped to the block

`/scan` takes the digest and a `focus` like every other endpoint. The model
therefore sees the imports and the block, and flags land inside the block
because there is nothing else to flag.

Flags outside the focus span are dropped server-side and again in the
extension. A model shown an import for context does not get to mark it up.

The prompt changes from "Review this beginner's file. Flag at most 5 suspicious
lines" to naming the block: "Review lines 173-186 (`calculate_average`)". The
existing caps — five bugs, two style notes — are left alone; scoped to one
block they are generous, which is the right direction.

`ScanRequest` without `bands` or `focus` behaves as it does today.

---

## C. Triggers

| Event | Today | After |
|---|---|---|
| Extension activates | scans whole file | nothing |
| Switch tab | scans whole file | nothing |
| Cursor rests in a block | line hint only | line hint, and scan that block |
| Edit anywhere | scans whole file | scans the block the cursor is in |

Opening a file is not working on it. The activation scan
(`inlineTutor.ts:295-298`) and the active-editor scan (`:199-206`) are removed;
nothing runs until the student lands somewhere.

An earlier draft of this table split the edit row in two — "edit inside the
current block" scans it, "edit in a different block" does nothing — and that
is not what ships. `runScan` resolves the focus from the live cursor, so an
edit anywhere scans wherever the cursor is. That is the better behaviour
(you cannot edit a block without your cursor in it) and it needs no
before-and-after comparison of where the edit landed, but it is one row, not
two. One exception is worth knowing: `runScan` returns early when the
document is not the active editor's, so an edit followed by a tab switch
inside the 3.5s debounce drops that scan.

Resting the cursor in a block now schedules a scan of it, which it did not do
before. That is the "using it" signal — a student stuck on a function is
looking at it, not necessarily typing in it.

The obvious risk is a student scrolling through a ten-function file and firing
ten scans. `scanFingerprints` is keyed by document URI, which would treat "same
file" as "already scanned" and mask the problem inconsistently. It becomes
keyed by `uri#breadcrumb`, with the digest's fingerprint as the value, so
revisiting a block that has not changed usually costs nothing. `breadcrumb`,
not `label`: a bare identifier collides — two classes in one file can each have
a `run` — and the breadcrumb is the qualified path. It carries the span on the
selection and window paths, where there is no name to qualify. The 3.5s
debounce and the 429 back-off window are unchanged.

"Usually" is the honest word, and it is narrower than the first draft's "each
block is scanned once per version of its own text". The digest carries the
cursor's own line, so in a block longer than the 120-line budget — where the
digest keeps the block's head and drops its tail — the digest's content moves
with the cursor and its fingerprint moves with it. Resting the cursor at a new
tail position in an unchanged oversized block therefore does cost a scan. That
is the price of the anchor (see below); it does not apply to any block that
fits in the budget, which is nearly all of them.

`edupeer.scanFile` keeps its command id, for anyone who has bound it, and is
retitled **EduPeer: Scan This Block**.

---

## D. Flags survive per block

`setFlags` (`annotationStore.ts:100`) replaces the flag set wholesale. With
per-block scans that means scanning `parse()` erases every flag on
`validate()`. It becomes:

```ts
setFlagsIn(span: LineSpan, flags: LineFlag[]): void
```

Flags inside `span` are replaced; flags outside it are kept. A student keeps
the marks on blocks they have visited and simply never acquires marks on blocks
they have not.

Two consequences follow:

- `maybeOfferReflection` fires when *a block* goes clean rather than the file.
  `lastFlagCounts` is keyed by URI and becomes keyed by block, matching
  `scanFingerprints`.
- `removeFixedBugComments` strips `bug:` markers inside the block that went
  clean, not across the file. This is the one place EduPeer writes into student
  code, and narrowing it is strictly safer.

---

## Data flow

```
cursor rests in a block, or an edit lands inside it
   └─> resolveFocus                       [unchanged]
   └─> digestFor(doc, focus, cursorLine?) [the one document -> digest door]
         └─> stripBugMarkers, split
         └─> buildDigest(lines, language, focus, cursorLine?)
               └─> { code, bands } ──> /scan, /line-hint, /hint
                                    └─> CodeView.of(code, bands)
                                          ├─ numbered()  -> the prompt
                                          ├─ line_at(n)  -> generate_line_hint
                                          └─ contains(n) -> flags outside focus dropped
   └─> setFlagsIn(focusSpan, flags)       [other blocks untouched]

/trace and /predict do not take this path
   └─> blockAround -> focusText           [the block verbatim, markers and all;
                                            getTrace never numbers it]

open a file / switch tab
   └─> nothing
```

## Error handling

| Failure | Behaviour |
|---|---|
| Focus cannot be resolved | `focusScope` falls back to its ±15 window; the digest is built around that |
| `bands` absent, inconsistent, or out of range | Backend treats `code` as a whole file at line 1 — the 1.5.1 path |
| Digest is empty (empty file) | `scan_code` already returns `[]` for blank input; unchanged |
| Flag lands outside focus | Dropped, server and client, without an error |
| Scan fails | Silent, as today: no annotations appear and nothing claims otherwise |

## Testing

`codeDigest` (Jest, pure): header band found per supported language; a file
with no imports yields no header band; header cap at 30; signature cap at 20
prefers the nearest; enclosing class header included for a method; adjacent
bands merge; a block larger than the budget keeps its head; the cursor's line
survives a budget that drops the block's tail; and the band invariant.

The invariant has to be stated as *the bands name the lines the digest
carries* — `expect(code.split("\n")).toEqual(bands.flatMap((b) =>
FIXTURE.slice(b.start - 1, b.end)))` — and not as "band lengths equal the
emitted line count", which is what the first draft said and what shipped.
`code` is built by joining exactly the lines the bands name, so a length
comparison compares `join` with `length` and cannot fail. The form above flips
on any off-by-one in `slice(b.start - 1, b.end)`, which is the most
load-bearing arithmetic in the module.

`CodeView` (pytest): absent bands behave exactly as today; inconsistent bands
fall back rather than raise; `line_at` resolves an absolute number into the
right band across a gap; `contains` rejects a line in a gap; `numbered()`
announces every gap.

Backend endpoints: `/scan` with a focus drops out-of-focus flags; `/line-hint`
answers about an absolute line that sits in the second band; and a request
carrying neither `bands` nor `focus` produces byte-identical prompts to
today's, including the unscoped scan wording.

Extension: no scan on activation or tab switch; a cursor resting in a block
scans it; an edit in block B leaves block A's flags in place; re-entering an
unedited block fires no request; and the audit test that no raw `getText()`
reaches `apiClient`.

Manual, since two of these are about felt behaviour:

1. Open a 250-line file and confirm nothing is flagged until the cursor lands.
2. Rest the cursor in a function near the bottom, ask for a hint, and confirm
   the tutor can name an import from line 2.
3. Flag something in one function, edit another, and confirm the first flag
   stays.

## Risks

- **Cutting ±25 to ±3 removes context that sometimes mattered.** The signature
  band covers the common case, but a hint that needed a caller's body will now
  miss it. Worth watching: the failure is a vaguer hint, not a wrong one.
- **Cursor-rest scanning is a new class of request.** Fingerprinting per block
  bounds it to one scan per block per edit, but a student who scrolls a lot
  will spend more of the rate-limit budget than they do today.
- **Signature extraction leans on `lensRegex`,** which was written to decide
  where a lens goes, not to enumerate definitions. It is approximate on C and
  C++. A missed signature costs context, not correctness.
- **Per-block reflection offers fire more often** than per-file ones did. If it
  becomes nagging, the existing once-per-fingerprint gate is the place to
  tighten.
