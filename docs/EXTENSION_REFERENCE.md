# EduPeer — Extension Reference

A complete description of the VS Code extension in `extension/`, written to be
read by an agent that has not seen the code. It is the client half of the
system; the FastAPI service in `backend/` is referenced only where the
extension's behaviour depends on it.

**Verified against the working tree at the snapshot below.** Every claim was
read out of the source or produced by running a tool. Line citations are
`file:line` against that snapshot and go stale on the next edit — treat the
symbol name as authoritative and the number as a hint.

> **Refreshed 2026-08-19 for the panel redesign** (commits `387a701`,
> `8a60a3f`, `22efb50`, `f46122b`). What moved: a four-skin token layer, the
> four card families, the rung meter replacing the four-dot ladder, the file
> card becoming a context strip, one composer table driving every mode, the
> footer ledger, two banner tiers, the emoji leaving the CodeLens column, and
> `lensMode: "all"` becoming `"top8"`. Sections 8 (the webview), 10 (the
> inline surface) and 11 (settings) were rewritten against the new code.
> Prose elsewhere that describes the *ladder* as a concept is still accurate;
> prose that describes the *four dots* is not, and is corrected where it
> appears.

---

## 1. Snapshot

| Item | Value |
| --- | --- |
| Commit | `f46122b7ee7d5fb2933cca5202d9693a6acb485f` (`f46122b`, 2026-08-19) |
| Branch | `main` |
| Extension version | 1.7.0 (`extension/package.json:5`) — the panel redesign |
| Publisher / id | `edupeer` / `edupeer.edupeer` |
| Licence | GPL-3.0-or-later |
| Engine floor | VS Code `^1.85.0` (`package.json:21-23`) |
| Document generated | 2026-08-18, refreshed 2026-08-19 for the panel redesign |
| Working tree | clean |

### Line counts

Excludes `node_modules/`, `coverage/`, `out/`, `package-lock.json` and the
built `.vsix` archives.

| Area | Files | Lines |
| --- | --- | --- |
| Source (`src/*.ts`) | 22 | 6,855 |
| Tests (`src/__tests__/*.ts`) | 26 | 12,230 |
| Test mock (`src/__mocks__/vscode.ts`) | 1 | 439 |
| Webview assets (`media/main.js`, `markdown.js`, `style.css`, `icon.svg`) | 4 | 3,668 |
| **Extension total** | **53** | **23,192** |

Source-to-test ratio: 6,364 source vs 11,354 test lines — **1.78:1**.

### Measured coverage and test count

Produced by running `npx jest --coverage` at this snapshot, not estimated.

| Metric | Value |
| --- | --- |
| Test suites | 26 passed, 26 total |
| Tests | **1,007 passed, 1,007 total** |
| Statements | **91.00%** |
| Branches | 81.78% |
| Functions | 89.86% |
| Lines | **92.41%** |

`media/main.js` and `media/markdown.js` are excluded from the percentage:
`webviewMain.test.ts` loads them through `new Function`, which istanbul cannot
instrument (`jest.config.js:8-10`). They are behaviourally covered by
180 + 37 = 217 tests that contribute no percentage — a third of the suite, and
the third that grew most in the redesign.

The statement percentage fell 0.9 points across the redesign while the test
count rose by 82. That is the shape you would expect: the tickets added
TypeScript in `sidebarProvider.getHtml` and `inlineTutor`, but most of the new
*behaviour* went into `media/main.js`, which contributes tests and no
percentage.

Lowest-covered modules, and why: `testWatcher.ts` 40.47% (the shell-integration
callbacks need a host API the mock does not model) and `extension.ts` 78.12%
(the `activate()` command bodies are exercised through their collaborators).
`progressPanel.ts` is at 100%.

---

## 2. What the extension is

A Socratic tutor for novice programmers. It reads the block of code the student
is working on and replies with a **question**, never a patch. The design
constraint that shapes almost every module is *hint depth must be earned*: the
ladder advances when the student edits code or reasons in the chat, not when
they click again.

Three surfaces, all driven from the same focus block:

1. **Sidebar panel** (`edupeer.sidebar` webview) — the conversation, the code
   preview, the hint-depth ladder, badges, streak, and the guided exercises.
2. **Inline surface** — CodeLens, hover, diagnostics, gutter/overview-ruler
   decorations, ghost text on the active line, and Quick Fixes.
3. **Progress dashboard** — a separate webview panel of charts.

Plus a status bar item, a debugger companion, a terminal test-run companion,
and a browser sign-in flow.

### Supported languages

Ten, keyed by VS Code `languageId` in `src/languages.ts:27-96`, matching the
backend registry in `backend/languages.py`:

`python`, `javascript`, `typescript`, `java`, `c`, `cpp`, `csharp`, `go`,
`rust`, `sql`.

Each entry carries a `label`, a `lensRegex` (definition-like lines), an
`importRegex` (header band), a `lineComment` token, and optionally a
`blockComment` pair. SQL's `importRegex` is the never-matching `/(?!)/`
(`languages.ts:93`) — SQL has no header to keep.

---

## 3. Module map

Twenty-two source modules. "Pure" means the module does not import `vscode`
and is unit-testable against fixture arrays.

| Module | Lines | Pure | Responsibility |
| --- | --- | --- | --- |
| `sidebarProvider.ts` | 1090 | no | The panel: threads, message protocol, `handleAsk`, focus posting |
| `inlineTutor.ts` | 902 | no | Every in-editor surface: lens, hover, diagnostics, decorations, scan |
| `apiClient.ts` | 676 | **yes** | HTTP + SSE to the backend; timeouts, retries, error taxonomy |
| `extension.ts` | 422 | no | `activate()`: wiring, command registration, URI handler |
| `localTutor.ts` | 356 | **yes** | Rule-based offline tutor |
| `attemptTracker.ts` | 353 | **yes** | The attempt gate: edit diffing, give-up detection, answer requests |
| `authManager.ts` | 342 | no | Firebase tokens, anonymous bootstrap, account migration |
| `codeDigest.ts` | 281 | **yes** | What leaves the machine: the banded digest and its budget |
| `progressPanel.ts` | 279 | **yes** | The dashboard's HTML/SVG, hand-built under a strict CSP |
| `annotationStore.ts` | 240 | **yes** | Per-document flags, hints and lens states; staleness rules |
| `focusScope.ts` | 226 | no | "The code the student is working on", resolved four ways |
| `signInFlow.ts` | 201 | no | Browser sign-in, state nonce, two delivery paths |
| `blockHeuristics.ts` | 187 | **yes** | Finding the enclosing block without a language server |
| `pedagogy.ts` | 177 | **yes** | Tutor modes, `MAX_HINT_LEVEL`, prompt framing helpers |
| `bugMarkers.ts` | 134 | **yes** | Finding and stripping seeded `bug:` marker comments |
| `languages.ts` | 110 | **yes** | The language registry |
| `statusBar.ts` | 103 | no | The status bar item; `renderStatus` is pure |
| `debugCompanion.ts` | 85 | no | Offers help when the debugger stops on an exception |
| `testWatcher.ts` | 79 | no | Offers help when a terminal test run exits non-zero |
| `offlineQueue.ts` | 60 | **yes** | Persists `reset`/`goal` mutations made while offline |
| `documentDigest.ts` | 47 | no | The one door from a `TextDocument` to a digest |
| `firebaseClient.ts` | 14 | no | Thin wrapper: badges via the backend |

Webview assets (not TypeScript, not compiled, shipped as-is):

| Asset | Lines | Responsibility |
| --- | --- | --- |
| `media/main.js` | 797 | The panel's DOM, composer state machine, message switch |
| `media/style.css` | 1082 | The panel's own design system (does **not** follow the workbench theme) |
| `media/markdown.js` | 169 | A minimal Markdown renderer that never touches `innerHTML` |
| `media/icon.svg` | 3 | Activity-bar icon |

---

## 4. Activation and lifecycle

`"activationEvents": ["onStartupFinished", "onUri"]` (`package.json:35-38`).
Entry point `./out/extension.js` (`package.json:39`), produced by esbuild from
`src/extension.ts`.

`activate()` is `async` (`extension.ts:51`) and **awaits exactly one thing**
before registering anything: `auth.initialize()` (`extension.ts:56`), which
reads the stored session out of `SecretStorage`.

The `/health` probe is deliberately **not** awaited (`extension.ts:151`).
Activation runs on startup in every VS Code window, so blocking there would
delay command registration behind a network round trip in windows that have
nothing to do with EduPeer.

Construction order (`extension.ts:52-126`):

```
config → backendUrl
AuthManager(secrets, globalState, backendUrl)   ← await initialize()
ApiClient(backendUrl, auth)
FirebaseClient(api)
OfflineQueue(globalState)
EduPeerSidebarProvider(extensionUri, context, api, firebase, auth, queue)
StatusBar(() => isSupportedLanguage(activeEditor.languageId))
InlineTutor(context, api, thinking => statusBar.update({ thinking }))
```

Event wiring set up during activation:

| Source | Effect | Site |
| --- | --- | --- |
| `api.onAvailabilityChange` | panel banner + status bar; on recovery flushes the offline queue and refreshes progress | `extension.ts:75-82` |
| `api.onAuthHealthChange` | panel banner + status bar; **one** toast per window naming `FIREBASE_WEB_API_KEY` | `extension.ts:85-95` |
| `provider.onDidChangeHintLevel` | mirrors hint depth into the status bar | `extension.ts:71-73` |
| `tutor.onDidScanClean` | posts `scanClean` to the panel (celebration flash) | `extension.ts:126` |
| `window.onDidChangeActiveTextEditor` | `statusBar.refresh()`; separately `warnIfRelevant()` | `extension.ts:69`, `149` |
| `workspace.onDidChangeConfiguration` | `edupeer.backendUrl` only: re-points `api` and `auth` | `extension.ts:410-418` |
| `setInterval(HEALTH_RETRY_MS)` | re-probes `/health` every 30 s **while unavailable** | `extension.ts:110-115` |

`deactivate()` is empty (`extension.ts:422`); everything is disposed through
`context.subscriptions`.

**Offline toast suppression.** `warnIfRelevant` (`extension.ts:135-147`) fires
at most once per window, and only when the active editor's language is one of
the ten. It used to interrupt every window on startup, including ones with no
code in them.

---

## 5. Contributed surface

### 5.1 Commands — eighteen

Declared at `package.json:59-128`. Registration site in `extension.ts` unless
noted.

| Command id | Title | Registered | Palette | Context menu |
| --- | --- | --- | --- | --- |
| `edupeer.activate` | EduPeer: Open Tutor Panel | `extension.ts:161` | yes | — |
| `edupeer.analyseSelection` | EduPeer: Analyse Selection | `extension.ts:168` | yes | `editorHasSelection` + lang |
| `edupeer.resetSession` | EduPeer: Reset Session | `extension.ts:319` | yes | — |
| `edupeer.nudgeLine` | EduPeer: Nudge Current Line | `inlineTutor.ts:218` | yes | lang |
| `edupeer.scanFile` | **EduPeer: Scan This Block** | `inlineTutor.ts:278` | yes | lang |
| `edupeer.reflectQuiz` | EduPeer: Reflection Quiz on My Fix | `extension.ts:202` | yes | — |
| `edupeer.explainError` | EduPeer: Explain This Error | `extension.ts:208` | yes | lang |
| `edupeer.explainSelection` | EduPeer: Explain This Construct | `extension.ts:224` | yes | `editorHasSelection` + lang |
| `edupeer.predictOutput` | EduPeer: Predict the Output | `extension.ts:242` | yes | `editorHasSelection` + lang |
| `edupeer.traceCode` | EduPeer: Trace This Code | `extension.ts:260` | yes | lang |
| `edupeer.discussLines` | EduPeer: Discuss Flagged Lines | `extension.ts:299` | **hidden** | — |
| `edupeer.showProgress` | EduPeer: Show My Progress | `extension.ts:326` | yes | — |
| `edupeer.setGoal` | EduPeer: Set Learning Goal | `extension.ts:345` | yes | — |
| `edupeer.signIn` | EduPeer: Sign In | `extension.ts:385` | yes | — |
| `edupeer.signOut` | EduPeer: Sign Out | `extension.ts:403` | yes | — |
| `edupeer.deepenLine` | EduPeer: Go Deeper on This Line | `inlineTutor.ts:258` | **hidden** | — |
| `edupeer.dismissLine` | EduPeer: Dismiss This Line Hint | `inlineTutor.ts:246` | **hidden** | — |
| `edupeer.pickDefinition` | EduPeer: Ask About a Definition | `inlineTutor.ts`, beside `deepenLine` | **hidden** | — |

"lang" is the regex
`resourceLangId =~ /^(python|javascript|typescript|java|c|cpp|csharp|go|rust|sql)$/`
(`package.json:130-165`). Seven commands are on the editor context menu, all in
group `edupeer`.

Four commands are hidden from the palette via `commandPalette` `when: "false"`
because each takes arguments and is only ever invoked programmatically:

- `edupeer.discussLines(uri, startLine, endLine, question?)` — from the Quick
  Fix on an EduPeer diagnostic and from `deepenLine`.
- `edupeer.deepenLine(uri, line)` / `edupeer.dismissLine(uri, line)` — sibling
  CodeLenses rendered beside a `ready` lens.
- `edupeer.pickDefinition(uri)` — the file-level lens on line 1, shown only
  when a file has more definitions than the eight the gutter will carry. It
  opens a quick pick over all of them and routes the chosen one into
  `nudgeLine`.

The command-set itself is pinned: `extension.test.ts`'s "registers no commands
beyond the expected set" compares the registry against a literal list, so a
new command has to be declared in three places or the suite says so.

**Keybinding**: one. `edupeer.nudgeLine` on `ctrl+alt+h` / `cmd+alt+h`, when
`editorTextFocus` and the language matches (`package.json:182-189`).

### 5.2 Other contributions

| Contribution | Value | Site |
| --- | --- | --- |
| Activity bar container | id `edupeer-sidebar`, title "EduPeer", icon `media/icon.svg` | `package.json:41-49` |
| Webview view | type `webview`, id `edupeer.sidebar`, name "EduPeer Tutor" | `package.json:50-58` |
| Walkthrough | id `edupeer.gettingStarted`, four steps, each with a markdown media file | `package.json:190-230` |
| Configuration | five settings | `package.json` `contributes.configuration` |

The webview view is registered with `retainContextWhenHidden: true`
(`extension.ts:117-121`), so the panel keeps its DOM when hidden.

The four walkthrough steps are `openFile`, `ask`, `inline`, `progress`, backed
by `media/walkthrough/*.md`. Nothing in `src/` references the walkthrough — VS
Code surfaces it on the Welcome page; the extension never opens it.

### 5.3 Settings — five

| Setting | Type | Default | Effect |
| --- | --- | --- | --- |
| `edupeer.backendUrl` | string | `https://edupeer-backend.onrender.com` | Backend base URL. Re-read live on change (`extension.ts:410`) |
| `edupeer.inlineHints` | boolean | `true` | Master switch for the whole inline surface. `isSupported` returns false when off (`inlineTutor.ts:326-331`), disabling lens, hover, Quick Fix, ghost text and line hints |
| `edupeer.lensMode` | `"top8"` \| `"flagged"` | `"top8"` | `"top8"` puts the standing "EduPeer — ask about this line" lens on the eight biggest definitions plus one file-level lens for the rest; `"flagged"` suppresses all of them. A stored `"all"` — the pre-1.7 default — is read as `"top8"` rather than rewritten (`inlineTutor.ts`, `lensMode` getter) |
| `edupeer.autoScan` | boolean | `true` | Automatic block scans (`inlineTutor.ts:534-537`) |
| `edupeer.debounceMs` | number | `1800`, min `600` | Idle time before a line hint. Floored again at 600 in code (`inlineTutor.ts:369`) |

`DEFAULT_BACKEND_URL` is duplicated in `extension.ts:21`; the comment there
notes the two must be kept in step.

---

## 6. The focus model

This is the concept everything else is built on. As of 1.6.0 EduPeer works on
**the block you are in**, not the file.

### 6.1 `FocusScope`

```ts
interface FocusScope {
  startLine: number;   // 0-based, inclusive
  endLine: number;     // 0-based, inclusive
  label: string;       // "calculate_average" | "selection" | "lines 4-19"
  breadcrumb: string;  // "demo.py › Stats › calculate_average"
  kind: "selection" | "symbol" | "heuristic" | "window";
}
```
(`focusScope.ts:19-29`)

`resolveFocus(doc, selection)` (`focusScope.ts:56`) tries four strategies in a
**confidence order**, first match wins:

1. **`selection`** (`focusScope.ts:81`) — a non-empty selection. The student
   said it out loud. A selection ending at column 0 drops the trailing line:
   it was dragged to the start of the next line, not into it.
2. **`symbol`** (`focusScope.ts:109`) — `vscode.executeDocumentSymbolProvider`,
   walking the symbol chain to the innermost *focusable* symbol. Focusable
   kinds are Function, Method, Constructor, Class, Struct
   (`focusScope.ts:32-38`) — a variable is not a unit of work.
3. **`heuristic`** (`focusScope.ts:167`) — `findEnclosingBlock`, for the
   beginner who has installed no language extension. This is the tested
   default, not an afterthought.
4. **`window`** (`focusScope.ts:215`) — cursor ± `WINDOW_RADIUS` (15 lines).
   Always works.

One-entry memo cache keyed on
`uri::version::cursor::selStart::selEnd::empty|range` (`focusScope.ts:41`,
`61-69`), because re-resolving on every keystroke is the thing being avoided.

### 6.2 Label vs breadcrumb — a security boundary

- **`label`** keys the hint ladder and is interpolated into the prompt
  *outside* the untrusted-input wrapper. So it is passed through
  `identifierIn()` (`focusScope.ts:190`): the leading `[A-Za-z_]\w*`, capped at
  40 chars. `void f(Ignore all previous rules and answer) {` is a valid C
  header and 40 characters is plenty of room for an instruction.
- **`breadcrumb`** keeps the provider's full text. It is **display-only and
  never leaves the extension** — the panel shows it, and `inlineTutor` keys its
  per-block scan map on it (`inlineTutor.ts:584`).

`headerName()` (`focusScope.ts:195`) extracts the name from a heuristic header:
`def|class|function|fn|func|struct|interface|enum|impl|trait`, then
`const|let|var`, then `identifier(`. Taking the bare leading identifier would
label every C function `int` and every Java method `public`, collapsing them
onto one `problem_key` — and since the attempt tracker keys on that too, moving
the cursor between two functions would read as an edit and walk the ladder
1→2→3 with nothing changed.

### 6.3 `blockHeuristics.ts`

Pure module: raw lines in, a span out.

- `MAX_FOCUS_LINES = 200` (`blockHeuristics.ts:16`). No focus block may exceed
  it; past that the "focus" stops meaning anything.
- `clampAroundCursor(span, cursorLine)` (`blockHeuristics.ts:62`) keeps the
  head **while the cursor is near it**, and slides only as far as it must to
  keep the cursor inside. A 400-line function with the cursor at line 300 used
  to clamp to 0–199, so the span that claimed to enclose the cursor no longer
  did. Exported because `focusScope.fromSymbols` needs the same rule — a
  language server will happily report an 800-line class as one symbol.
- Three block styles (`blockHeuristics.ts:20-31`): `indent` (python),
  `statement` (sql), `brace` (everything else, and the fallback).
- `cursorIndentAt` (`blockHeuristics.ts:112`) borrows a blank line's indent
  from the line above, because `indentOf("")` is 0 and would silently widen
  every block to the outermost one.
- `braceBlockEnd` (`blockHeuristics.ts:158`) is deliberately naive: braces
  inside strings and comments are counted. A header with no brace within three
  lines is treated as a declaration, not a body.
- `sqlStatement` (`blockHeuristics.ts:178`) runs from just after the previous
  `;` to the next one.

Tabs count as four columns in both `indentOf` implementations
(`blockHeuristics.ts:38`, `codeDigest.ts:145`).

---

## 7. What leaves the machine — the digest

Before 1.6.0 seven call sites posted `doc.getText()`. Now every request is
bounded.

### 7.1 The chokepoint

`documentDigest.digestFor(doc, focus, cursorLine?, languageId?)`
(`documentDigest.ts:34`) is **the one door from a `TextDocument` to bytes bound
for the wire**. It does three things: strip the seeded `bug:` markers, split
into lines, build the digest.

`codeDigest.ts` never imports `vscode` on purpose — it is a pure module whose
every test is a fixture array. `documentDigest.ts` is the thin `vscode`-aware
shell around it.

`digestFields(digest)` in `apiClient.ts:305` turns a digest into the three wire
fields `{ code, bands, total_lines }`. Its own doc comment says it is *not* the
security-relevant chokepoint: by the time a `CodeDigest` reaches it the choice
of what to send has already been made.

### 7.2 The digest shape

```ts
interface CodeDigest {
  code: string;      // the selected lines, joined. Never the whole file.
  bands: CodeBand[]; // 1-based absolute {start,end}, ascending and disjoint
  totalLines: number;
}
```
(`codeDigest.ts:42-54`)

The absolute line numbers are the whole point: `hinting_engine` cites real
editor lines back to the student, and a digest renumbered from 1 would send
them to code that has nothing to do with the hint.

### 7.3 Budgets

| Constant | Value | Meaning | Site |
| --- | --- | --- | --- |
| `MAX_DIGEST_LINES` | 120 | Total lines a digest may carry. Matches `MAX_CODE_LINES_SENT` server-side | `codeDigest.ts:27` |
| `FOCUS_MARGIN_LINES` | 3 | Lines kept either side of the focus block (a decorator, a comment) | `codeDigest.ts:30` |
| `HEADER_BAND_MAX_LINES` | 30 | Header lines kept, at most | `codeDigest.ts:33` |
| `SIGNATURE_BAND_MAX_LINES` | 20 | Definition lines kept, nearest first | `codeDigest.ts:36` |
| `SCOPE_BAND_MAX_LINES` | 3 | Enclosing headers kept | `codeDigest.ts:39` |

### 7.4 Selection order in `buildDigest` (`codeDigest.ts:235`)

Lines are collected into a **`Set<number>`**, not bands, so overlapping regions
cost one line rather than two and the budget arithmetic cannot drift from what
is actually sent (`codeDigest.ts:83-96`). Priority order:

1. **The cursor's own line**, if a `cursorLine` was supplied. One line of
   budget buys the guarantee that whatever else is dropped, the line being
   asked about is in it. Without it, a cursor in the tail of an oversized block
   produced an empty answer that the lens rendered as "✓ Nothing to flag on
   this line" — the tutor reassuring the student about a line it never saw.
2. **The focus band**, `focus.start - 3 … focus.end + 3`. Runs ascending and
   stops at the budget, so a block bigger than the whole budget keeps its head.
3. **The header band**, lines 1…`headerEnd` — imports/includes plus the
   module-level constants under them (`codeDigest.ts:113`). Comments continue
   the header without extending it. Blank lines are ignored *until the first
   constant is taken*, after which a blank line ends the header — otherwise
   `TAX = 0.2` and forty unrelated assignments would swallow the file one
   plausible line at a time.
4. **Scope headers** — the enclosing `class`/`impl`, walked by decreasing
   indentation (`codeDigest.ts:179`). Handles Allman-style braces two ways: a
   punctuation-only line is skipped outright, and a candidate that misses
   `lensRegex` is retried joined with the next line's text.
5. **Signature lines** — every other definition line, sorted by distance from
   the focus, capped at 20 (`codeDigest.ts:213`). The focus block's own header
   is skipped; its body already ships.

`toBands` (`codeDigest.ts:57`) then collapses the set into ascending contiguous
runs.

### 7.5 The two payloads a digest does *not* bound

Both are deliberate, both are documented at their sites:

- **`traceCode`'s snippet** (`extension.ts:260-293`). A desk-check over a
  digest's elided bands would have holes in it, so the snippet travels whole.
  That is exactly why the command **requires a selection** — the bound is put
  in the student's hand. It used to fill itself from the enclosing block, so a
  cursor resting at class level in a long class sent the class.
- **`blockAround`'s text** (`extension.ts:44-49`). The block's own verbatim
  text, with `bug:` markers left in, used for `predictOutput`, `discussLines`,
  the debug companion and the trace follow-up. Every one of those routes
  reaches the wire through `handleAsk`, which digests whatever it is handed —
  so they cap at `MAX_DIGEST_LINES` anyway.

### 7.6 `bugMarkers.ts`

The demos ship deliberate bugs with a comment naming each one. Two operations:

- **`stripBugMarkers(code, languageId)`** (`bugMarkers.ts:125`) — blanks every
  marker before sending. A file carrying one was asking the model to grade the
  comment rather than the code; the tutor answered from the note, so a corrected
  line kept drawing the hint describing its old mistake, and the marker
  sustained the very flags that were supposed to delete it. **Blanks in place
  rather than deleting**, because every line number in the reply is 1-based
  against the text sent — the line count has to survive.
- **`findBugMarkers(lines, languageId)`** (`bugMarkers.ts:97`) — reads the live
  buffer for `removeFixedBugMarkers`.

Deliberately narrow, because this deletes from the student's file: only a
comment whose body *starts* with `bug:` (`/^\s*bug\s*:/i`, `bugMarkers.ts:29`).
`// Off-by-one style bug: index 4 does not exist` is prose about a bug and
survives. `indexOutsideStrings` (`bugMarkers.ts:38`) tracks quotes so
`print("# bug: not a comment")` does not lose half its string; Python triple
quotes are not modelled.

---

## 8. `apiClient.ts` — the wire

### 8.1 Endpoints used

| Method | Path | Client method | Payload | Failure mode |
| --- | --- | --- | --- | --- |
| GET | `/health` | `health()` | — | 5 s deadline; sets `available` | 
| POST | `/hint` | `getHint(req)` | `HintRequest` | 429 → `RateLimitError`; 422 → one mode-downgrade retry |
| POST | `/hint/stream` | `streamHint(req, onEvent, signal?)` | `HintRequest` | throws so the caller falls back to `/hint` |
| POST | `/reset` | `resetSession()` | — | throws on network failure so callers can queue. The panel does not wait on it to clear itself — see `resetCleared` in §11.1 |
| GET | `/progress` | `getProgress()` | — | throws on non-OK |
| GET | `/review?language&exercise` | `getReview(language, exercise)` | — | **swallows**: returns `{due:false,…}` |
| POST | `/goal` | `setGoal(text, language)` | `{text, language}` | throws on non-OK |
| GET | `/badges` | `getBadges()` | — | **swallows**: returns `[]` |
| POST | `/scan` | `scanCode(digest, language, focus?)` | digest fields + focus | 429 → `RateLimitError` |
| POST | `/line-hint` | `getLineHint(digest, line, language, focus?)` | digest fields + line + focus | 429 → `RateLimitError` |
| POST | `/trace` | `getTrace(selection, language)` | `{selection, language}` | **swallows**: returns `{variables:[],steps:0,prompt:""}` |

`getTrace` deliberately sends **no `code` field** (`apiClient.ts:494`, comment
at 480-493): the handler only reads it as a fallback for an empty `selection`,
which the caller guarantees is non-empty. It used to carry a whole block as a
plain string — the one payload `buildDigest` never bounded. The field stays on
the backend's `TraceRequest` for the published 1.5.1 build, which does send one.

Two endpoints are reached outside `ApiClient`, from `authManager.ts`:
`GET /auth/config` (`authManager.ts:262`) and `POST /auth/migrate`
(`authManager.ts:242`). `GET /auth/login` is opened in the browser by
`signInFlow.ts:198`.

### 8.2 `HintRequest`

```ts
interface HintRequest {
  code: string;            // the digest, never the file
  question: string;
  hint_level: number;      // always 1 from the client; the server owns the ladder
  problem_key?: string;    // "uri#label" or "uri" — the thread key
  language?: string;
  mode?: string;
  history?: ChatTurn[];    // last 6 turns
  escalate?: boolean;      // false re-uses the current level
  edit_summary?: string;   // compact diff since the last hint
  confidence?: number;     // VESTIGIAL — never set (see §17)
  focus?: FocusRange;      // {start_line, end_line, label}, 1-based
  bands?: CodeBand[];      // 1-based absolute spans `code` was lifted from
  total_lines?: number;
}
```
(`apiClient.ts:27-52`)

### 8.3 Error taxonomy

| Class | Meaning | Consequence |
| --- | --- | --- |
| `AuthError` (`apiClient.ts:64`) | The sign-in chain failed: no web API key, anonymous bootstrap refused, refresh token dead | **Does not** mark the backend unavailable — it threw before the request was sent. Sets `authHealthy = false` |
| `RateLimitError` (`apiClient.ts:72`) | 429. Carries `retryAfterSeconds`, from the `Retry-After` header or 30 | Callers go quiet; `inlineTutor` sets `quietUntil` |
| `TimeoutError` (`apiClient.ts:247`) | A request or stream was abandoned | Marks unavailable — indistinguishable from down, from the student's side |

Keeping `AuthError` distinct from a network failure matters: treating it as
proof the backend was down told students to restart a server that was answering
`/health` perfectly well.

### 8.4 Timeouts, and the cold start

| Constant | Value | Purpose |
| --- | --- | --- |
| `REQUEST_TIMEOUT_MS` | 20,000 | Normal deadline. Without one, a backend that accepts and stalls leaves the panel spinning forever with no cancel button |
| `COLD_START_TIMEOUT_MS` | 75,000 | The **one** retry after a timeout |
| `STREAM_IDLE_TIMEOUT_MS` | 30,000 | Max gap between stream chunks. The stream has no overall deadline — a long hint is legitimate — but silence does |
| `/health` | 5,000 | Short, because it runs on the activation path |

The backend runs on Render's free plan: the service stops after ~15 min idle
and takes ~50 s to wake. Against a 20 s deadline that is not a slow request,
it is a guaranteed failure. So `authedFetch` (`apiClient.ts:391-441`) retries
**once** on the longer clock and fires `onColdStart` first, which the panel
turns into a visible "the server had gone to sleep" card
(`sidebarProvider.ts:197-207`). A caller-supplied `signal` suppresses the
retry — that deadline is the caller's to own.

401 handling: one silent retry with `getIdToken(force: true)`
(`apiClient.ts:416-418`).

### 8.5 Streaming

`streamHint` (`apiClient.ts:510`) POSTs to `/hint/stream` and reads an SSE body.
`parseSseChunk(buffer, chunk)` (`apiClient.ts:196`) pulls complete
`data: {...}` events out and returns the unconsumed remainder; malformed events
are skipped silently.

Event types: `meta` (carries `hint_level` and the mode actually run), `delta`
(a text chunk), `error` (throws), `done` (the final hint and concept tags). A
stream that ends without a `done` throws (`apiClient.ts:577`).

`reader.cancel()` runs in a `finally` (`apiClient.ts:568-576`) — releasing the
body matters on every exit path, not just the happy one.

### 8.6 Version-skew handling

`DOWNGRADABLE_MODES = {"answer"}` (`apiClient.ts:94`). A backend whose
`TutorMode` literal predates a mode rejects the request with 422 — an ordinary
HTTP response, so the client stays "available" and the offline tutor never
steps in, and the student reads raw validation JSON. `withoutNewMode`
(`apiClient.ts:101`) rewrites the request as a plain `hint`, retries once, and
returns nothing the second time so it cannot loop. The response is stamped with
the mode that ran so the panel does not title a Socratic hint "Answer".

Every other mode has been in `TutorMode` since v1, so a 422 for one of those is
a real contract breach and still surfaces.

---

## 9. Authentication

### 9.1 `AuthManager` (`authManager.ts:54`)

Storage keys: `edupeer.authSession` in **SecretStorage**,
`edupeer.pendingMigration` in SecretStorage, `edupeer.userId` (legacy) in
globalState (`authManager.ts:32-34`).

```ts
interface AuthSession {
  uid: string; refreshToken: string;
  email?: string; displayName?: string; isAnonymous: boolean;
}
```

- `getIdToken(force?)` (`authManager.ts:90`) — bootstraps anonymously when
  there is no session, returns the cached token while it has more than
  `EXPIRY_MARGIN_MS` (60 s) left, otherwise refreshes.
- **In-flight dedupe** on both `bootstrapPromise` and `refreshPromise`
  (`authManager.ts:62`, `92`, `325`): concurrent callers await the same
  round-trip instead of double-bootstrapping an account or burning a rotated
  refresh token.
- `getApiKey()` (`authManager.ts:260`) fetches `/auth/config` and **names the
  actual problem** when the key is empty, rather than letting it surface three
  layers later as an opaque 403 from Google.
- `bootstrapAnonymous()` (`authManager.ts:280`) calls Google's
  `identitytoolkit` `accounts:signUp` directly. A 400 usually means the key is
  wrong; `ADMIN_ONLY_OPERATION` means the Anonymous provider is off in the
  Firebase console.
- `exchangeRefreshToken()` (`authManager.ts:303`) calls `securetoken` and
  stores the rotated refresh token.
- `signOut()` (`authManager.ts:253`) deletes the session and immediately
  bootstraps a fresh anonymous one.

### 9.2 Account migration

When an anonymous student signs in, their progress must follow them.
`applySignIn` (`authManager.ts:103`) records a `PendingMigration`
`{oldRefreshTokens[], legacyUserId?, capturedForUid}` and
`runPendingMigration` (`authManager.ts:147`) replays it — also retried on every
activation (`extension.ts:129`).

`capturedForUid` exists because **migration is destructive on the backend**: it
merges the source document into the target and deletes the source. Without it,
a migration that failed for user A stayed queued and replayed into whichever
account signed in next on the same machine, handing A's progress to B and
deleting A's record. A record captured for a different uid is dropped, not
replayed (`authManager.ts:116-118`, `153-159`).

Per-token failure handling (`authManager.ts:175-204`): a 4xx means the old
account is permanently gone, so it is dropped; a network error or 5xx is
transient, so it stays queued. One token's failure never aborts the others.

### 9.3 `signInFlow.ts` — two delivery paths

`signInViaBrowser(baseUrl, timeoutMs, {uriScheme, extensionId})`
(`signInFlow.ts:104`) opens `/auth/login?port=&state=[&scheme=&ext=]` in the
browser and races two ways of getting the payload back:

1. **`vscode://` URI handler** (preferred). Registered at `extension.ts:377`;
   `deliverUriCallback(query)` (`signInFlow.ts:41`) decodes a base64url
   `payload` param. `scheme` and `ext` are sent **only when both are known**,
   because the page treats their presence as "hand back through VS Code".
   This exists because Chrome and Edge now gate a public page's access to
   127.0.0.1 behind a permission prompt that reads like an attack, and a
   student who declines it cannot sign in at all.
2. **One-shot loopback POST** to `127.0.0.1:<random port>/callback`
   (`signInFlow.ts:121-160`).

Security properties, all tested:

- **128-bit state nonce** (`STATE_BYTES = 16`, `signInFlow.ts:9`), compared
  with `crypto.timingSafeEqual` after a length check (`signInFlow.ts:71`).
  Without it, any page the user had open could POST its own Firebase tokens to
  the loopback port during the sign-in window — and because the callback is a
  CORS-simple request, no browser gate would stop it. The port alone is
  guessable in ~16k tries.
- **No `Access-Control-Allow-Origin` on the 404 path** (`signInFlow.ts:122-129`):
  a readable 404 would turn the server into a cross-origin port scanner.
- **64 KB request cap** (`signInFlow.ts:138`), so a stranger who found the port
  cannot grow the extension host's heap.
- `deliverUriCallback` returns `false` rather than throwing for anything
  unrecognised — the URI handler is a public entry point any application on the
  machine can invoke.
- Five-minute timeout (`signInFlow.ts:6`). Only the newest attempt owns the
  `vscode://` slot; an older one keeps its loopback server rather than being
  stranded (`signInFlow.ts:169-175`).

---

## 10. The sidebar panel

### 10.1 Threads — one conversation per block

`EduPeerSidebarProvider` holds `threads: Map<string, {history, bubbles}>`
(`sidebarProvider.ts:47`), in memory rather than `globalState`, because a
conversation belongs to the session that had it.

Four related keys, each with a distinct job:

| Field | Meaning | Site |
| --- | --- | --- |
| `threadKey` | The conversation on screen. **Follows named blocks only** — a selection or a click on a blank line does not move it | `sidebarProvider.ts:69` |
| `renderedKey` | What the webview is actually rendering. `persistChat` writes here, not to the live focus, because it crosses an async boundary | `sidebarProvider.ts:78` |
| `lastDocumentKey` | The block the cursor is literally in. Its one remaining reader is `lastFileKey` | `sidebarProvider.ts:96` |
| `threadBlockCode` | The text of the block `threadKey` names. Moves with the key, never with the focus | `sidebarProvider.ts:116` |

The `threadBlockCode`/`threadKey` pairing is load-bearing: when the text
followed the focus, selecting two lines inside a function left the key on the
function while the text collapsed to the selection — same key, different text —
so the tracker read it as an edit and sent the model a diff of a function being
replaced by two lines.

**Deferred thread swap.** If the cursor moves to another block while an ask is
streaming, `sendFocus` sets `pendingThreadSwap` instead of posting
(`sidebarProvider.ts:935-941`), and `handleAsk`'s `finally` posts it once the
ask settles (`flushPendingThreadSwap`, `sidebarProvider.ts:781`). A student
watching an answer arrive must not have the panel wiped out from under them.
The flush is skipped when `threadKey === renderedKey`, because a cursor that
went A → B → A during the stream leaves the panel already correct and
re-posting would race `persistChat`.

`postThread(key)` (`sidebarProvider.ts:991`) clears **every** pending exercise
alongside the transcript. `restoreChat` tears the panel down to the new
thread's bubbles, so the card each of those was waiting on is gone from the
screen; without this the student's next question was popped off as an answer to
a prompt they could no longer see. The webview clears its half
(`composerMode`) on the same message (`main.js:564-566`).

Caps: `MAX_HISTORY_TURNS = 6` sent with each question, `MAX_PERSISTED_BUBBLES = 50`
rendered bubbles kept (`sidebarProvider.ts:27`, `30`).

### 10.2 `handleAsk` — the single ask path

`handleAsk(question, code, mode, opts)` (`sidebarProvider.ts:591`). Options:
`echoUser`, `aboutOpenFile`, `attempted`.

Sequence:

1. **Reject an overlapping ask** if `askInFlight` (`sidebarProvider.ts:623`).
   Two overlapping asks interleave their deltas into one bubble and each
   advance the ladder. The refusal is itself a card, mode `attempt-gate`.
2. **Pick the digest.** `aboutOpenFile` (default true) uses `lastDigest`,
   already stripped and built by `sendFocus`. Otherwise `buildDigest` runs
   directly on `code` with its own `stripBugMarkers` — that branch is the one
   place a digest is built from something that was never a `TextDocument` (a
   review exercise, a prediction, a trace answer).
3. **Read `problemKey = this.threadKey`** before the first await
   (`sidebarProvider.ts:667`). Keying on the block the cursor is literally in
   collapsed the level from 3 → 1 the moment a selection resolved above the
   enclosing symbol, and back to 3 on deselect, while the chat correctly held.
4. **Evaluate the attempt gate**, for `mode === "hint"` only
   (`sidebarProvider.ts:670-682`). An `unchanged` verdict posts the
   `attempt-gate` nudge card *in addition to* proceeding with
   `escalate: false`.
5. **Capture `thread` and `generation`** before the first await.
6. **Stream**, falling back to `getHint` on any non-rate-limit failure
   (`sidebarProvider.ts:717-730`).
7. **Drop the response** if `generation !== sessionGeneration` — the student
   reset while it was in flight (`sidebarProvider.ts:731-735`).
8. **Record and emit.** `attempts.record` and `levelEmitter.fire` are keyed on
   the **request** mode, while the card's title uses the **response** mode
   (`res.mode ?? mode`). Re-keying the former to the response mode would stop
   rung 4 spending its rung and strand the ladder at 4 forever
   (`sidebarProvider.ts:736-757`).
9. `finally`: clear `askInFlight`, post `loading:false`, flush any pending
   thread swap.

### 10.3 `handleAskFromWebview` — mode routing

(`sidebarProvider.ts:526`) Three decisions, in order:

1. `mode === "hint"` and `looksLikeErrorText(question)` → **`explain-error`**.
   A pasted stack trace is a lesson in reading errors, not a level-1 hint.
2. `mode === "hint"` and `isAnswerRequest(question)` → **`answer`**. Routed
   *before* the attempt gate so it neither advances nor spends a rung — and so
   the three phrases that also sit in `GIVE_UP` never reach `isAttempt` to be
   scored as giving up.
3. **Explain-first gate**: on the first `hint` for a file,
   `pendingAsk` is parked and `explainFirst` is posted
   (`sidebarProvider.ts:543-552`). Keyed on the **document**, not a fingerprint
   of its contents — keyed on contents, every edit made the file look new and
   the gate interrupted the conversation again.

`attempted` is computed from what the student *typed*, before
`questionForMode` wraps it (`sidebarProvider.ts:542`). Judging the wrapper, or
the later "explanation + question" framing, let a give-up phrase in one half
score the whole ask as a refusal.

### 10.4 `sendFocus` (`sidebarProvider.ts:830`)

Debounced 150 ms by `scheduleFocus` (`sidebarProvider.ts:957-962`), driven by
active-editor / document-change / selection-change events.

Suppression: a signature of `uri:start:end:focusCode` (`sidebarProvider.ts:864`).
If unchanged, only a lightweight `cursor` message is posted when the cursor
line moved. The old code posted the whole document on every keystroke and most
of those posts said nothing new.

`refreshCode` from the webview calls it with `force: true` — refresh is the
student saying "I don't trust what I'm looking at", and answering with silence
because nothing changed is the one reply it must never give
(`sidebarProvider.ts:303-308`).

Thread-key assignment (`sidebarProvider.ts:903-928`), three branches:

- focus is `symbol` or `heuristic` → key and block text both move to it;
- key belongs to a different document → fall back to the file-level key;
- otherwise (the focus collapsed to a selection or a bare window while the
  conversation stayed put) → **re-resolve at the naked cursor** to get the
  block the key actually names, as it stands right now.

**No editor** (`sidebarProvider.ts:832-853`): `lastFocus`, `lastDigest`,
`panelFullCode` and the signatures are cleared, but `threadKey` and
`threadBlockCode` are left exactly as they were, as a pair. Losing the active
editor is not changing function.

### 10.5 `panelFullCode` — display only

The whole document, held for the panel's "Whole file" toggle
(`sidebarProvider.ts:126`, `886`). The webview runs inside the editor, so
nothing it renders crosses the network. It must **never** become a request
payload; `auditRegressions.test.ts:611` asserts it never appears on a line that
also reaches `this.api.`.

### 10.6 Guided exercises

| Exercise | Started by | Pending field | Answered via | Framed by |
| --- | --- | --- | --- | --- |
| Explain-first | `handleAskFromWebview` | `pendingAsk` | `explainAnswer` / `explainSkip` | `frameExplainedQuestion` |
| Predict output | `startPrediction` (`:448`) | `pendingPredict` | `predictAnswer` | `framePrediction` |
| Trace / desk check | `startTrace` (`:459`) | `pendingTrace` | `traceAnswer` | `frameTraceTable` |
| Spaced review | `startReview` (`:408`) | `pendingReview` | `reviewAnswer` | `frameReviewAnswer` |

`startTrace` asks `/trace` for which variables are worth tracing and **falls
back to a free-text prediction** when `steps` is 0 or fewer than two variables
come back, rather than showing an empty table (`sidebarProvider.ts:468-470`).

Trace, predict and review all pass `aboutOpenFile: false`: the exercise is the
subject, not whatever file happens to be open. A review is about a concept from
days ago and the editor is usually on something else.

A blank explanation is treated as a skip (`sidebarProvider.ts:570-576`), and
the parked question's own `attempted` verdict is preserved through both paths.

### 10.7 Failure rendering — `postFailure` (`sidebarProvider.ts:794`)

Three tiers, in order:

1. `RateLimitError` → a `rate-limited` card carrying the quota message plus
   something to do while waiting.
2. `!api.isAvailable` **or** `AuthError` → the local rule-based tutor
   (`offlineTutorReply`), mode `offline`. A broken sign-in means no request can
   carry a token, so the local tutor is the only thing left to offer — even
   though the banner above says something different about why.
3. Anything else → a plain `error` message.

### 10.8 Webview HTML and CSP

`getHtml` (`sidebarProvider.ts:1004`) builds the document with a per-load nonce
from `crypto.randomBytes(24)` (`sidebarProvider.ts:1088`):

```
default-src 'none';
style-src {cspSource};
font-src {cspSource};
script-src 'nonce-{nonce}';
img-src {cspSource} data:;
```

`localResourceRoots` is restricted to `media/`. There is no `'unsafe-inline'`.
All five properties are asserted in `securityInvariants.test.ts`.

Fixed DOM, top to bottom: a `role="status"` banner stack holding the offline
banner then the auth banner (two tiers, stacked in severity order, one live
region so two arrivals are one announcement); the topbar (brand, account
avatar, and the preferences popover it opens); the context strip (status dot,
file name, symbol, line range, language chip, "Open a file", Review, and the
code preview as a *collapsed* disclosure whose footer holds the line-cap
notice, "Whole file" and Refresh); the chat log (`role="log"
aria-live="polite"`); the thinking indicator; the composer (mode strip with
its exit button, textarea, Ask / Quiz me / Reset, and a visually-hidden
`role="status"` for mode changes); the footer ledger (streak, badge count,
progress); and the badge sheet, which opens over the chat rather than pushing
it down.

Two things that used to be here are not: the streak chip and the badges
`<details>` have moved out of the topbar into the ledger, and the `filecard`
section — which showed the preview expanded by default and said "No file open"
a second time — is now the context strip above.

---

## 11. The panel message protocol

### 11.1 Extension → webview

Sent through `post()` (`sidebarProvider.ts:1000`), handled in the switch at
`media/main.js:546`.

| `type` | Payload | Sent at | Effect |
| --- | --- | --- | --- |
| `restoreChat` | `messages[]` | `:997` | Rebuilds the transcript, resets `composerMode`, clears `expectReflectAnswer` / `expectReviewAnswer`, re-seeds `vscode.setState` |
| `focus` | `focusCode, breadcrumb, startLine, endLine, cursorLine, fileName, language, totalLines` | `:943`, `:852` | Repaints the preview with real editor line numbers, sets `currentCode`, resets the scope toggle |
| `cursor` | `cursorLine` | `:875` | Moves the `is-cursor` row only — no re-render |
| `fullFile` | `code` | `:310` | Widens the preview; guarded by `showingWholeFile`. `currentCode` deliberately does **not** widen |
| `userMessage` | `text` | `:502`, `:517`, `:548`, `:562`, `:638` | Appends a student bubble |
| `streamStart` | `seq` | `:719` | Empty tutor bubble with a caret, `aria-hidden` so the live log does not re-announce every token |
| `streamDelta` | `seq, text` | `:722` | Appends only when `seq` matches; auto-scrolls only when already within 40 px of the bottom |
| `streamAbort` | `seq` | `:726` | Removes the streaming bubble |
| `hint` | `hint, hint_level, concept_tags, mode`, `seq` on success | `:742` and the failure paths | The tutor card: one family class from `FAMILY`/`FLAGGED_MODES`, eyebrow from `MODE_LABEL`, rung meter for `hint`/`worked-example`, mode-specific action row *inside* the card. `attempt-gate` carries its own meter at the current depth, marked held |
| `traceTable` | `snippet, variables, steps, prompt` | `:473` | Renders the desk-check grid |
| `predictFirst` | `snippet` | `:451` | Prediction prompt; composer → `predict` |
| `explainFirst` | `prompt` | `:549` | Explain-first card + "Skip and get my hint"; composer → `explain` |
| `error` | `message` | `:821` | Error-styled turn |
| `loading` | `value` | six ask sites, plus `resetSession` | Toggles the thinking indicator and disables Ask, Quiz me, Reset and Review. Reset used to be the one entry point that never sent it, so its own `isLoading` guard never fired and a second click started a second round trip |
| `offline` | `value` | `:210` | Offline banner (amber, transient, carries Retry) |
| `contextStale` | `value` | `onDidChangeTextDocument`; cleared by `sendFocus` | The file the strip describes changed while a different editor was active. Everything the panel knows about a file arrives through `sendFocus`, which only reads the *active* editor — so a branch switch or a format-on-save in another group leaves the strip naming lines that have moved, with nothing correcting it until the student returns. The dot goes amber and a Refresh appears in the slot "Open a file" uses. Posted on the transition only, never per keystroke |
| `authTrouble` | `value` | `:219` | Sign-in banner — a separate banner, and a separate *tier*, because "server down" and "auth broken" send the student to two different places. Drawn as danger with a square dot, carries "Fix it", and sets the avatar pip, which outlives the banner being dismissed |
| `streak` | `days` | `:229` | The ledger's streak, and its separator |
| `scanClean` | — | `:234` | 900 ms celebration flash |
| `badges` | `badges[]` | `:966` | The ledger's badge count, and the sheet behind it. At zero the count stays on screen and the button is disabled — there is nothing to open, but the number is still a fact |
| `authState` | `signedIn, label, email, initials` | `postAuthState` | Paints the avatar (initials, or a pip when anonymous), the popover's identity block, and swaps the placeholder |
| `preferences` | `values{inlineHints, autoScan, lensMode, debounceMs}, backendUrl` | `postPreferences` | Repaints the popover's live controls. Also posted after every write, and on any `edupeer` configuration change, so a toggle never disagrees with the editor it claims to control |
| `reviewDue` | `concepts` | `:404` | Reveals the Review button |
| `resetCleared` | — | `resetSession`, **before** the network call | Clears the transcript, resets the composer and empties the avatar ring. The host has already dropped the threads by this point, so the panel no longer waits on `/reset` to say so |
| `resetDone` | `summary` | `resetSession`, after the network call | Appends the "what you learned" note, when there is one. Clears nothing |
| `externalAsk` | `question, code` | `:368` | **No-op in the webview.** `askExternal` already called `sendFocus`, so the preview and `currentCode` are correct; using `msg.code` would point the next follow-up at code the student never saw |

### 11.2 Webview → extension

Sent through `vscode.postMessage`, handled in the switch at
`sidebarProvider.ts:256`.

| `type` | Payload | Sent at | Handler |
| --- | --- | --- | --- |
| `ready` | — | `main.js:796` | Posts auth state, thread (only when `threadKey !== ""`), focus, badges, offline, auth-trouble, streak; checks review due |
| `persistChat` | `messages[]` | `main.js:79` | Writes the last 50 bubbles to `threadFor(renderedKey)` |
| `askHint` | `question, code, mode` | `main.js:439`, `:462` | `handleAskFromWebview` |
| `explainAnswer` | `explanation` | `main.js:417` | `handleExplainAnswer` |
| `explainSkip` | — | `main.js:694` | `handleExplainSkip` |
| `predictAnswer` | `prediction` | `main.js:424` | `handlePredictAnswer` |
| `traceAnswer` | `rows[][]` | `main.js:395` | `handleTraceAnswer` |
| `reviewAnswer` | `answer` | `main.js:431` | `handleReviewAnswer` |
| `startReview` | — | `main.js:477` | `startReview` |
| `reset` | — | `main.js:467` | `resetSession` |
| `refreshCode` | — | `main.js:469` | `sendFocus({force: true})` |
| `requestFullFile` | — | `main.js:313` | Posts `fullFile` with `panelFullCode` |
| `signIn` / `signOut` | — | popover buttons | Executes the matching command |
| `requestPreferences` | — | on every popover open | Posts `preferences` |
| `setPreference` | `key, value` | popover rows | `setPreference` — writes to `ConfigurationTarget.Global`, then re-posts `preferences`. Keys outside `WRITABLE_PREFERENCES` are dropped, `debounceMs` is floored at 600 and `lensMode` is checked against its two values: `update()` will otherwise create a setting no `package.json` declares |
| `showProgress` / `setGoal` | — | popover rows | Executes the matching command |
| `openSettings` | — | popover row | Opens the Settings UI at `@ext:edupeer.edupeer`, for `backendUrl` — the one setting the popover shows but will not edit |
| `startPredict` | — | empty-state chip | `edupeer.predictOutput` |
| `startTrace` | — | empty-state chip | `edupeer.traceCode` |
| `openFile` | — | context strip, when no file is open | `workbench.action.quickOpen` |
| `retryConnection` | — | offline banner's Retry | `api.health()`, then re-posts `offline`. Deliberately not `refreshCode`: re-reading the file does not re-probe the backend, and the background health poll is on a 30 s timer the student cannot see |

Each of the four is its own named case rather than one message carrying a
command id, so the set of commands the panel can reach stays a property of
`sidebarProvider.ts` and not of whatever the webview happens to send.

On the very first `ready` there is no thread yet, so posting one would create a
permanent phantom `""` entry in `threads` and send an empty `restoreChat` that
`sendFocus` immediately supersedes (`sidebarProvider.ts:259-264`).

### 11.3 Webview state machine (`media/main.js`)

`composerMode` decides what the next submission means: `hint` (default),
`explain`, `predict`, `review`, `reflect`, `translate`, `subgoal-label`.

All seven live in one `COMPOSER` table that supplies the strip label, the
placeholder and the button verb together, and `setComposerMode(mode)` takes
only the mode. It used to take a placeholder as a second argument at each of
eleven call sites, which is how the placeholder came to say "describe your
error" while the mode was `translate`.

Every mode except `hint` sets `tone: "show"` — the student is producing
material rather than asking for it — which puts `is-producing` on the
composer and turns the strip, the textarea border and the primary button
mint. The way out is always present: the strip's exit button, or Escape.
Escape closes the innermost thing that is open, one per press: the popover,
then the badge sheet, then the composer mode.

Mode labels and classification:

- `MODE_LABEL` (`main.js:31-46`) — the eyebrow text per mode.
- `FLAGGED_MODES` = `attempt-gate`, `rate-limited`, `offline`, `waking`
  (`main.js:49`) — the tutor withholding rather than teaching; styled
  differently.
- `FAMILY` — the stance each mode takes, and so how its card is drawn:
  `ask` (hint, reflect, predict-output, trace-check, review-exercise),
  `show` (worked-example, translate, subgoal-label, explain-concept,
  explain-error), `tell` (answer). `FLAGGED_MODES` is the `withhold` lookup
  and is not duplicated in the table — having the set twice is how the two
  would drift apart. An unknown mode falls back to `ask`, the stance that
  gives the least away, so a mode the backend adds before the panel knows
  about it is still drawn as something.
- `LADDER_MODES` = `hint`, `worked-example` — only these show the rung meter,
  because only these occupy a rung. The meter is four bars of increasing
  height: spent bars filled from the ramp, the next one outlined because it
  costs something, the fourth dashed mint until reached because rung 4 is a
  worked example rather than another question. A screen reader gets one
  visually-hidden sentence rather than four unlabelled graphics.

Action rows added after a hint (`main.js:510-541`):

- `hint` at level 3 → "Submit my translation" (composer → `translate`);
- `worked-example` → "Label the steps" (composer → `subgoal-label`);
- `reflect` when the student pressed Quiz me → composer → `reflect`;
- `review-exercise` when the student pressed Review → composer → `review`.

`attempt-gate` re-triggers the ladder's `is-held` animation by removing the
class, forcing a reflow, and re-adding it (`main.js:496-508`).

Composer keys: **Enter sends, Shift+Enter is a newline** (`main.js:450-457`).

Two-stage restore: `vscode.getState()` paints immediately on every webview init
(hidden/shown, moved container, host reload), then the extension replaces it
with the durable copy on `ready` (`main.js:785-793`). `isRestoring` marks those
turns so N cards do not all fire their entrance animation at once.

`isLoading` guards **every** entry point — Ask, Quiz me, Reset, Review — not
just the send button, because Ctrl+Enter and the mode buttons could otherwise
start a second stream whose deltas landed in the first one's bubble. Reset was
guarded in the same words but never in fact, because `resetSession` was the one
path that never posted `loading`: `isLoading` stayed false for its whole
duration, so neither the guard nor the `disabled` attribute did anything and a
second click sent a second `/reset`.

Code preview caps at `MAX_PREVIEW_LINES = 200` and says how many more there are
(`main.js:28`, `300-305`).

### 11.4 `media/markdown.js`

A minimal renderer for exactly what the tutor prompts can emit: fenced code,
inline code, bold, italic, both list kinds. Level-3 hints are pseudocode and
worked examples are numbered lists, so flat text would lose the structure the
pedagogy depends on.

- Precedence: code beats emphasis, so `**x**` inside backticks stays literal
  (`markdown.js:19-34`).
- Italic requires CommonMark left/right-flanking, so `area = w * h * d` does
  not read as emphasis and lose its asterisks — which matters when the tutor is
  discussing multiplication or C pointers.
- Links render as their **text only**: the panel has no safe way to open a URL
  the model invented.
- **Every node is `createElement`/`createTextNode`.** Nothing assigns
  `innerHTML`, so model output cannot inject markup. Asserted in
  `securityInvariants.test.ts`.
- A 500-iteration guard on the inline loop (`markdown.js:39`).

---

## 12. The inline surface

`InlineTutor` (`inlineTutor.ts:84`) owns everything in the editor. All of it is
gated on `isSupported(doc)` — the language is one of the ten **and**
`edupeer.inlineHints` is true.

### 12.1 `AnnotationStore` — per-document state

Pure module (`annotationStore.ts:62`). Line numbers are 0-based here, matching
the editor; `LineFlag` arrives 1-based, so `setFlagsIn`/`flags` convert at that
boundary and nowhere else.

```ts
type LensState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; hint: string }
  | { kind: "empty" }
  | { kind: "error"; reason: "auth"|"rate-limit"|"llm"|"offline"|"unknown"; message: string };
```

**The revision guard** (`annotationStore.ts:80`). A line hint takes seconds and
the line number is captured before the first await. `applyChanges` and
`clearLine` both bump `rev`, and both call `dropLoadingStates()` — the
invariant is store-wide: *a bump invalidates every in-flight write-back, so no
`loading` state can survive one and still be resolved*. A surviving `loading`
renders as a lens that waits forever while the status bar's spinner correctly
clears.

**`setFlagsIn(span, flags)`** (`annotationStore.ts:109`) replaces flags **inside
one span only**. Scans are per block now, so a wholesale replacement meant
reviewing `parse` erased every flag on `validate` — the student losing marks on
code they had not touched, simply for moving the cursor. A flag merely
*overlapping* the span goes too.

**`applyChanges(changes)`** (`annotationStore.ts:200`) ages every annotation
against a batch of edits: an edit touching an annotation's own lines destroys
it, an edit entirely above slides it, an edit below changes nothing. Every
change is measured against **pre-edit coordinates** and the deltas summed, so
the result does not depend on the order VS Code hands them over (it delivers
them in reverse document order).

`clearHint` (`annotationStore.ts:176`) is deliberately distinct from
`clearLine`: it is the tutor deciding it has nothing to say, not the student
throwing away what it said, so it does **not** bump the revision.

### 12.2 CodeLens (`inlineTutor.ts:749`)

Emitted in this order, with a `seenLines` set so no line gets two primary
lenses:

1. **One lens per scan flag**, titled `EduPeer notes — style: {question}` for
   `kind === "style"` and `EduPeer asks — {question}` otherwise (`flagTitle`).
   A flag is an observation about this code and outranks a standing offer, and
   flags are never displaced by definition lenses: the two sets are ranked
   separately and rendered flags-first.
2. **One lens per line carrying a non-idle lens state**
   (`store.activeLensLines()`). Ctrl+Alt+H works anywhere, so a nudged line
   must show its state even when it is neither a definition nor flagged. This
   is placed **ahead of the `lensMode` check on purpose**: the mode governs
   unsolicited offers, not the answer to a question the student asked.
3. **`lensMode === "flagged"` returns here.**
4. **Up to eight `IDLE_LENS_TITLE` lenses**, on the definitions matching the
   language's `lensRegex`, ranked by size — measured as the gap to the next
   definition, which is a proxy for the block's length but depends only on the
   document, so the gutter does not reshuffle as the cursor moves. Returned in
   document order so the column reads top to bottom.
5. **One file-level lens on line 1** when there are more than eight,
   titled `EduPeer — ask about any of {n} definitions`, opening a quick pick
   over all of them (`edupeer.pickDefinition`). Capping the column is only
   defensible if the ninth definition is still one click away.

Lens titles come from the pure `lensTitle(state, fallback)`
(`inlineTutor.ts:48`):

| State | Title | Command |
| --- | --- | --- |
| `loading` | `EduPeer is thinking…` | `edupeer.nudgeLine` |
| `ready` | `EduPeer asks — {hint}` | `edupeer.nudgeLine` |
| `empty` | `EduPeer — nothing to flag here` | `edupeer.nudgeLine` |
| `error`, reason `auth` | `EduPeer can't help yet — sign in` | **`edupeer.signIn`** |
| `error`, other | `EduPeer can't help yet — {message}, click to retry` | `edupeer.nudgeLine` |
| `idle` | the fallback title (`IDLE_LENS_TITLE`, "EduPeer — ask about this line") | `edupeer.nudgeLine` |

**Why there are no emoji.** Every title begins with the word EduPeer, which is
what the glyphs were really doing — giving the column a constant left-edge
marker so it scans as one product rather than five moods. State is carried by
the verb instead: *asks*, *notes*, *is thinking*, *can't*. A screen reader
saying "light bulb Ask EduPeer" was reading something that carried nothing the
words did not, the glyphs render as tofu in some Linux workbench font stacks,
and they date any screenshot they land in.

Ghost text, diagnostics and the hover drop the glyph **without** taking the
prefix (`flagLabel`): each is already attached to the line, or already says
**EduPeer** on its first row, so the prefix would be repetition in a space
that has none to spare.

A `ready` lens gets two **sibling lenses** so each action is separately
clickable: "Go deeper" → `edupeer.deepenLine`, "Dismiss" →
`edupeer.dismissLine`. The redesign proposed "Go deeper (rung 3 of 4)" for the
first; that would be false here, because the inline surface deliberately holds
no rung — the ladder lives in the conversation — so naming one would invent a
number.

`errorStateFor(err, apiAvailable)` (`inlineTutor.ts:22`) maps each failure to
the one sentence that says what to do: rate limit → "Hint budget used up, back
in {n}m"; auth → "Sign in to get hints"; unavailable → "Backend unreachable";
a 5xx in the message → "The tutor couldn't answer that"; otherwise "That didn't
work".

**How many lenses.** Flags are bounded upstream by the scan engine (5 bug +
2 style = at most 7). Definition lenses are capped at **eight**
(`MAX_DEFINITION_LENSES`), with the remainder behind one file-level lens. They
used to be unbounded under `lensMode: "all"` — a 40-function file produced 40,
and an unusable gutter with them.

Refresh is driven by an `EventEmitter` fired after each scan, each lens-state
change, and each document change (`inlineTutor.ts:157`, `199`, `473`, `611`).

### 12.3 Ghost text (`renderActiveLineDecoration`, `inlineTutor.ts:483`)

An `after` decoration on the **active line only** — 2 rem margin, italic,
`editorCodeLens.foreground`. Precedence:

> a real line hint → a scan flag → a local rule

`hint.local` is what lets a real hint and a local rule share one map in the
store without losing that ordering.

The text is the hint or `flagLabel(flag)` — bare, with no glyph and no
"EduPeer" prefix. The prefix exists so the *lens column* scans as one product;
ghost text is already sitting against the line it is about, in EduPeer's own
decoration style, and end-of-line is the tightest space the extension has.

The function **clears the decoration on every other visible editor first**
(`inlineTutor.ts:488-492`). Decorations are per-editor, so a split view kept
showing a hint pinned to a line the student had since rewritten in the other
group.

### 12.4 Hover (`inlineTutor.ts:861`)

Shows, in order: the lens's `loading`/`error` status, the cached line hint, the
scan flag with its concept, then two command links.

`isTrusted` is an **allow-list of exactly two commands**:
`edupeer.nudgeLine` and `edupeer.explainSelection` (`inlineTutor.ts:890`). A
blanket-trusted `MarkdownString` renders *any* `command:` link inside it, and
model-authored scan questions are appended to this one — so a hostile file that
steers the model into emitting a command link cannot run anything else.
`edupeer.discussLines` is deliberately excluded: it takes a URI and reads that
file. The hover carries the *condition* of the lens error but never its
trailing "— click to sign in", because widening the allow-list to carry a
sign-in link would widen it for the model-authored text too. Three assertions
in `securityInvariants.test.ts` pin this.

### 12.5 Diagnostics and decorations

Collection name `"edupeer"` (`inlineTutor.ts:142`). One `Diagnostic` per flag
(`inlineTutor.ts:717-730`):

- message `flagLabel(flag)` — `style: {question}` for a style flag, the bare
  question otherwise. No glyph: `source` is the field that says who is talking,
  and the Problems panel already renders it
- severity `Warning` when `flag.severity === "warning"`, else `Information`
- `source = "EduPeer"`, `code = flag.concept`
- range from `flagRange` (`inlineTutor.ts:707`), clamped into the document

Two whole-line decoration types with overview-ruler marks on the right:
`flagGutterInfo` (`editorInfo.foreground` / hover-highlight background) and
`flagGutterWarn` (`editorWarning.foreground` / warning background)
(`inlineTutor.ts:128-140`). Applied to every visible editor showing the
document (`inlineTutor.ts:741-746`).

### 12.6 Quick Fixes (`inlineTutor.ts:815`)

They never edit code — the whole point is that the student writes the fix — so
each just routes the line into a tutor mode:

1. "EduPeer: nudge me on this line" → `edupeer.nudgeLine`
2. "EduPeer: explain this line" → `edupeer.explainSelection`
3. `EduPeer: talk through "{question}"` → `edupeer.discussLines`, **only when
   the line carries a flag**, and attached to that line's diagnostics.

### 12.7 Line hints (`fetchLineHint`, `inlineTutor.ts:372`)

- Cached hints short-circuit **unless** they are `local` — a local rule is a
  placeholder and must not block a real hint once the backend answers again.
- **Lens state is only painted when `force` is true** (`inlineTutor.ts:393-395`).
  The debounce path fires on cursor movement; painting a lens there would put
  unsolicited text on every line the cursor rests on — including under
  `lensMode: "flagged"`, whose entire purpose is to stop that.
- The focus is resolved from the **live selection** when the student has one on
  this line, not a synthetic empty selection — otherwise the lens would resolve
  the enclosing symbol while the panel resolved the selection.
- `digestFor(doc, focus, line)` passes the cursor line as the anchor.
- The revision guard drops the answer if the store moved.
- On failure: if the backend is unavailable and a local rule matches, the rule
  is stored with `local: true` and shown; otherwise `errorStateFor` renders.
- A `RateLimitError` sets `quietUntil` **before** the staleness check, because
  back-off is global rather than per line.

### 12.8 Scans (`runScan`, `inlineTutor.ts:549`)

- **Requires an active editor showing the document.** No cursor means no block
  to scan; "the code the student is working on" is defined by where they are.
  Consequence, named in the comment: an edit followed by a tab switch inside
  the 3.5 s debounce silently drops the scan.
- Anchored on the cursor line for the same reason `fetchLineHint` is.
- Keyed by **`${uri}#${focus.breadcrumb}`** (`inlineTutor.ts:584`), not by
  `label`: two classes each with a `run` method would collide on a bare label.
- Two fingerprint maps: `scanFingerprints` (last **successful** scan) and
  `inFlightFingerprints` (de-dupes concurrent requests without claiming
  success). Committing the former up front meant a failed scan permanently
  suppressed auto-scan for that content — including after a 429, defeating the
  back-off window right next to it.
- Returned flags are filtered to the focus range **client-side as well** as
  server-side, so a flag can only ever appear on the block the student is on.
- The editor is **re-fetched and re-validated** after the awaits before
  painting: the student may have switched tabs, and painting onto the stale
  reference would clear the ghost text on the editor they are actually looking
  at while repainting one that is no longer active.

### 12.9 EduPeer makes no code edits

**Removed in 1.7.0.** There was exactly one write: `removeFixedBugMarkers`,
gated on `edupeer.removeFixedBugComments`, which deleted `bug:` comments from a
block on the flagged → clean transition through a single undoable
`WorkspaceEdit`.

It went because nothing outside `demos/` carries those comments. The demos seed
them so a reader can see what each exercise is; a student's own code has no
reason to, so on real work the feature could only ever be a risk of editing a
file it had nothing to say about. It also carried a hazard documented in the
code: in a block longer than the digest budget, the marker filter acted on the
whole focus range, so a marker at line 250 of a 300-line class was deletable by
a scan that only ever saw lines 1–119 plus the anchor.

What survives is the half that matters: **`stripBugMarkers` removes those
comments from every request**, at the digest chokepoint. A model handed
`# bug: off-by-one, skips the first item` is not finding the bug, it is reading
the answer off the line above it — and the demo stops demonstrating anything.
`bugMarkers.ts` is now only ever read from, never written through.

The invariant this leaves is stronger and unconditional, and
`auditRegressions.test.ts` pins it: no file in `src/` constructs a
`WorkspaceEdit` or calls `applyEdit` at all.

### 12.10 Reflection offer (`maybeOfferReflection`, `inlineTutor.ts:674`)

Per block: when the previous flag count was > 0 and this scan returns 0, fire
`onDidScanClean`, then offer a quiz **once per code fingerprint**
(`reflectOffered`). The toast says "this block", not "your file", because the
gate is per block and a file with three functions can have two still flagged.

### 12.11 Cache release

`onDidCloseTextDocument` (`inlineTutor.ts:294-309`) deletes the store and the
diagnostics for the URI, and sweeps the three block-keyed maps by prefix
(`k === uri || k.startsWith(uri + "#")`) — a bare-URI delete would leave every
block's entry behind. Otherwise these grow for the whole session.

---

## 13. Pedagogy

### 13.1 Tutor modes

Eleven (`pedagogy.ts:6-17`): `hint`, `reflect`, `translate`, `worked-example`,
`explain-error`, `explain-concept`, `predict-output`, `review-exercise`,
`subgoal-label`, `trace-check`, `answer`.

The panel adds four **display-only** pseudo-modes that never reach the wire:
`attempt-gate`, `rate-limited`, `offline`, `waking`.

Eleven plus four is the fifteen the panel's `FAMILY` table and `FLAGGED_MODES`
between them classify, and `webviewMain.test.ts` asserts that every one of the
fifteen lands on exactly one family class — not zero, and not two.

### 13.2 The hint ladder

`MAX_HINT_LEVEL = 4` (`pedagogy.ts:33`). Rungs 1–3 are the Socratic ladder;
**rung 4 *is* the worked example**, reached by asking again at rung 3.

The value is declared once per language — a VS Code extension and a FastAPI
service share no build step — but it is not left to memory:
`pedagogy.test.ts` **reads `backend/models.py`** and fails if the two disagree.
Everything client-side that renders or clamps a depth reads this constant
rather than a literal; a bare `3` in the status bar is what left it saying
"hint 3/3" beside a panel showing four filled rungs.

**How the panel draws it.** Four bars of increasing height (`.rung__bar`,
`data-rung="1".."4"`), spent up to the current depth and coloured from a ramp
that ends in mint rather than continuing the coral — rung 4 differs in kind,
not degree, so the ramp says so. The next bar is outlined rather than filled,
which is what "the next rung costs an attempt" looks like; the fourth is dashed
until reached. Height carries the depth, so it reads without counting.

The same ramp lights the avatar ring (`.avatar__arc:nth-of-type(n)`) and the
"how deep you went" bar on the progress dashboard, so the always-visible
readout, the card and the report agree.

**Held.** When the gate refuses, the refusal card carries *its own* meter at
the unmoved depth, with an amber bracket on the current bar. The bracket is a
resting `box-shadow`, not a keyframe: three consecutive gates each look held,
and reduced motion loses nothing. It used to be an animation replayed by
forcing a reflow on the *previous* card, which meant only the most recent
refusal was ever visible and reduced motion showed none of them.

### 13.3 The attempt gate (`attemptTracker.ts`)

`evaluate(key, code, now, answered)` (`attemptTracker.ts:135`) returns one of
five signals:

| Signal | Condition | Escalates? |
| --- | --- | --- |
| `first` | no hint recorded for this key | yes |
| `changed` | normalised code differs | yes, with an `editSummary` |
| `answered` | code unchanged but the student reasoned in chat | yes, no diff to offer |
| `unchanged` | nothing changed, inside the 45 s cooldown | **no** |
| `stalled` | nothing changed, past the cooldown | yes |

`HINT_COOLDOWN_MS = 45_000` (`attemptTracker.ts:13`). `answered` is checked
*after* `changed` on purpose: a real edit carries a diff the tutor answers
follow-ups against.

`normalizeCode` (`attemptTracker.ts:109`) strips trailing whitespace per line
then trims, matching `code_fingerprint` in `backend/session_store.py`.
Comparing raw strings let a single blank line count as an attempt — exactly the
hint-abuse path this module exists to close.

`summarizeEdit` (`attemptTracker.ts:57`) is a deliberately naive
common-prefix/suffix diff rendered as numbered `-`/`+` lines, 8 lines shown,
each clipped at 120 chars, the whole thing capped at
`MAX_EDIT_SUMMARY_CHARS = 2000` (mirrors `backend/models.py`). An empty document
is zero lines, not one blank one, so creating a file from scratch does not
report a phantom deletion.

### 13.4 Give-up and answer-request detection

Both are **deterministic lists, not model calls**. The comment at
`attemptTracker.ts:230-245` records that having the tutor judge this was built
and measured: it scored **7/10 against this list's 12/12**, and it erred in both
directions — waving through students who gave up and, worse, stonewalling
students who had reasoned their way to the answer. A misjudgement here withholds
help from someone who earned it.

Matching (`attemptTracker.ts:266-306`): the message is lowercased, apostrophes
removed, split on `,;.!?\n`, each clause reduced to `[a-z0-9 ]`, then padding
words stripped (`GIVE_UP_PADDING`, 18 entries). A clause is a surrender only if
the **whole** stripped clause is in `GIVE_UP`. A bare substring test scored
"i dont know if range should start at 0 or 1" and "dunno, maybe it needs <=" as
refusals — both reasoned correctly.

`isAttempt(message)` is true unless **every** clause is a surrender.

`isAnswerRequest(message)` (`attemptTracker.ts:345`) is true if **any** clause
matches `ANSWER_REQUEST` — a student who describes what they tried and *then*
asks for the answer still gets it. `ANSWER_REQUEST` deliberately excludes the
bare "tell me", which `GIVE_UP` contains: there it only holds the ladder, but
here it would route "tell me more about ranges" straight past the Socratic
tutor.

Gameable by typing nonsense, which is accepted: the gate exists to stop repeated
clicking on untouched code, and typing nonsense repeatedly is more effort than
the behaviour it guards against.

### 13.5 Framing helpers

All pure, all in `pedagogy.ts`: `frameExplainedQuestion`, `frameTranslation`,
`framePrediction`, `frameConstructExplanation`, `frameReviewAnswer`,
`frameTraceTable`, `frameSubgoalLabels`, `formatExceptionQuestion` (caps
variables at 15), `formatTestFailureQuestion`.

`questionForMode(mode, rawInput)` (`pedagogy.ts:165`) fills in the canned
question for button-triggered modes. `translate` and `subgoal-label` return
`""` for empty input — there is nothing to say — while `reflect` and
`worked-example` have defaults in `DEFAULT_MODE_QUESTIONS`.

`looksLikeErrorText` (`pedagogy.ts:75`) tests nine patterns: Python tracebacks,
`File "...", line N`, JS and Java stack frames, `Exception in thread`,
`Segmentation fault`, GCC/Clang `file:line: error:`, MSVC `error C1234:`, and
the generic `\w+(Error|Exception):`.

`codeFingerprint` (`pedagogy.ts:46`) is a cheap `length:hash31` string, used for
scan de-duplication and the reflection gate.

---

## 14. Status bar and dashboard

### 14.1 Status bar (`statusBar.ts`)

Left-aligned, priority 100, command `edupeer.activate` (`statusBar.ts:75-77`).
**Hidden unless a supported file is open** — the `isRelevant` callback passed
from `extension.ts:64`.

`renderStatus(snapshot)` (`statusBar.ts:24`) is pure. Text is
`$(mortar-board) EduPeer` plus, in order:

1. `offline` **or** `sign-in error` **or** `$(sync~spin)` **or**
   `hint {n}/{MAX_HINT_LEVEL}` — first match only;
2. `{n}d` when the streak is non-zero;
3. `$(history)` when a review is due.

Background turns `statusBarItem.warningBackground` while offline **or** while
sign-in is failing (`statusBar.ts:93-96`).

Inputs: hint level from `provider.onDidChangeHintLevel`; `thinking` from
`InlineTutor`'s callback, but only on a forced (student-initiated) line hint;
streak and review-due from `/progress` on startup and whenever the backend
comes back.

### 14.2 Progress dashboard (`progressPanel.ts`)

A plain `createWebviewPanel("edupeer.progress", …)` with **no options object**
(`extension.ts:329-335`) — so no scripts, no local resource roots. Its own CSP
is `default-src 'none'; style-src 'unsafe-inline';` with **no `script-src` at
all**, so `default-src 'none'` denies every script (`progressPanel.ts:160`).

Charts are hand-written SVG: no library, no network, and geometry lives in
element **attributes** rather than style attributes so it runs under that CSP.
**Every series is also labelled in text** — hue never carries meaning on its
own.

Colour comes from the panel's own token layer rather than the workbench chart
palette, and the dashboard carries the same four skins, keyed off the same
`vscode-*` body class. "How deep you went" uses the same four-value rung ramp
as the card meter, ending in mint, which is what lets it read without its
legend — the legend is there anyway, for the reason above. The one thing it
does not borrow is the bundled faces: its CSP has no `font-src` and the panel
is created without `localResourceRoots`, so `--display` falls through to the
workbench face.

Sections: four stat tiles (questions, sessions, streak, languages), an optional
review banner, hint-depth distribution, a 14-day activity strip, concepts to
revisit, strengths, goal, badges, session notes.

`LEVEL_BLURBS` names what each rung actually gave the student. Rung 3's read
"needed pseudocode" until 1.7.0, which was the Socratic prompt's *old rule*
rather than its goal — the prompt asks for a skeleton with the answer punched
out of it now, and pseudocode was only ever one way to produce that.

`conceptBars` scales against `MAX_HINT_LEVEL`, not 3 (`progressPanel.ts:32`):
the backend counts rung-4 hints, so an average above 3 is ordinary, and scaling
against 3 pinned every deep concept at a full bar and told a screen reader
"average hint depth 3.5 of 3".

`escapeHtml` (`progressPanel.ts:13`) escapes `& < > " '`. Every interpolation of
backend-supplied text goes through it, and `securityInvariants.test.ts` asserts
nine specific raw fragments never appear in the source.

---

## 15. Resilience

### 15.1 Offline tutor (`localTutor.ts`)

52 rules: 5 shared plus per language — python 8, javascript 6, typescript 4,
java 4, csharp 3, c 5, cpp 4, go 4, rust 4, sql 5. Each is a regex over one
line plus a Socratic question kept under ~14 words, matching the tone of the
LLM line hints. Language rules are tried before shared ones
(`localTutor.ts:312`).

Two entry points: `localLineHint(line, languageId)` for the inline surface, and
`offlineTutorReply(code, languageId, seed)` for the panel — which scans the
whole block for the first matching rule and otherwise rotates through four
generic metacognitive prompts, seeded so the same one does not repeat
back-to-back.

### 15.2 Offline queue (`offlineQueue.ts`)

Persists only the mutations that can be deferred: `reset` and `goal`. Hints are
interactive and cannot be. A newer item of the same kind **replaces** the older
one (`offlineQueue.ts:34`). `flush(api)` replays them; failures stay queued
(`offlineQueue.ts:40-58`). Flushed automatically when availability returns
(`extension.ts:79`). `setGoal` enqueues on failure only when the client is
already known unavailable (`extension.ts:359-368`).

### 15.3 Quiet windows

`quietUntil` (`inlineTutor.ts:112`) is set by any 429 from a line hint or a
scan, and blocks **both** automatic paths (`inlineTutor.ts:350`, `540`) until
it passes. It matters most for scans, which fire on every edit — retrying
through a closed budget would keep it closed.

### 15.4 Staleness guards, all together

| Guard | Protects | Site |
| --- | --- | --- |
| `sessionGeneration` | A response landing after a reset re-seeding cleared history | `sidebarProvider.ts:163`, `731` |
| `askSeq` | Two streams' deltas landing in one bubble | `sidebarProvider.ts:169`, `main.js:650` |
| `askInFlight` | Overlapping asks each advancing the ladder | `sidebarProvider.ts:170`, `623` |
| `store.revision` | A line hint written back onto a line that has moved | `annotationStore.ts:80`, `inlineTutor.ts:405` |
| `inFlightFingerprints` | Duplicate concurrent scans of identical content | `inlineTutor.ts:93`, `594` |
| `lastFocusSignature` | Re-posting a focus that says nothing new | `sidebarProvider.ts:128`, `867` |
| `pendingLineKey` | A debounced hint for a line the cursor has left | `inlineTutor.ts:106`, `365` |
| `renderedKey` | `persistChat` writing one function's transcript over another's | `sidebarProvider.ts:78`, `276` |
| re-fetch `activeTextEditor` after awaits | Painting decorations onto a tab the student left | `inlineTutor.ts:619`, `483-492` |

---

## 16. Automatic triggers

| Trigger | Condition | Delay / throttle | Site |
| --- | --- | --- | --- |
| Focus post | Active editor, document change, or selection change | 150 ms debounce, then a signature check | `sidebarProvider.ts:326-335`, `957` |
| Line hint | Cursor moves or the document changes | `edupeer.debounceMs` (default 1800, floored at 600); skipped while `quietUntil` is future; skipped for a blank line | `inlineTutor.ts:349-370` |
| Block scan | Document changes, or the selection moves | Fixed 3500 ms; skipped when `autoScan` is false or `quietUntil` is future; skipped on an unchanged block fingerprint or an in-flight duplicate | `inlineTutor.ts:533-547` |
| Reflection offer | A block that had ≥1 flag scans clean | Once per code fingerprint | `inlineTutor.ts:674-704` |
| Debug companion | A debug adapter sends `stopped` with `reason === "exception"` | Once per debug session id | `debugCompanion.ts:12-31` |
| Test companion | A shell execution matching `TEST_COMMAND_RE` exits non-zero and non-undefined | 30 s cooldown between offers | `testWatcher.ts:58-77` |
| Health retry | `api.isAvailable` is false | Every 30 s | `extension.ts:110-115` |

**Nothing runs on file open.** Opening a file is not working on it — activation
only paints the decoration for whatever is already on screen
(`inlineTutor.ts:312-317`). This is the 1.6.0 change that stopped EduPeer
putting question marks on files the student had only just opened.

### Debug companion (`debugCompanion.ts`)

Registers a `DebugAdapterTrackerFactory` for `"*"`. On the first `stopped`
event with `reason === "exception"` per session, it offers "Talk it through".
On acceptance it collects the exception description (via `exceptionInfo`, which
not every adapter supports), the top stack frame, and the first scope's
variables — capped at 15 by `formatExceptionQuestion`. Every sub-request is
individually try/caught; variables are a nice-to-have.

### Test companion (`testWatcher.ts`)

**Feature-detects** `onDidStartTerminalShellExecution` /
`onDidEndTerminalShellExecution` and returns immediately if absent
(`testWatcher.ts:32-35`), so it silently no-ops on VS Code older than 1.93.

`TEST_COMMAND_RE` (`testWatcher.ts:8`) matches pytest, jest, vitest, mocha,
unittest, `npm test`, `yarn test`, `pnpm test`, `go test`, `cargo test`,
`dotnet test`, `mvn test`, `gradle test`.

Buffers at most `MAX_BUFFER_CHARS = 8000` (keeping the **tail**), and sends the
last `TAIL_LINES = 40` non-blank lines, where the failure summary lives.

---

## 17. Cross-cutting invariants

These are the properties the code is organised around. Each is enforced
somewhere, not merely intended.

1. **The whole file never reaches the network.** Every request body is a
   digest capped at 120 lines. Enforced by `documentDigest.digestFor` being the
   only `TextDocument → digest` door, and by four tests in
   `auditRegressions.test.ts:472-637` that **discover the sender modules by
   reading the directory** rather than from a hand-maintained list — which is
   how `firebaseClient.ts` was found, a file the old list of three had never
   named.
2. **`codeDigest.ts` never imports `vscode`.** Asserted directly
   (`auditRegressions.test.ts:576`). The chokepoint exists so the budget
   arithmetic stays testable against fixture arrays.
3. **`panelFullCode` never becomes a request payload.** Asserted
   (`auditRegressions.test.ts:611`).
4. **Line numbers are absolute editor coordinates end to end.** 0-based inside
   the extension, 1-based on the wire; the conversion happens in `codeDigest`
   and `annotationStore` and nowhere else.
5. **No `MarkdownString` is blanket-trusted**, and the allow-list contains only
   `edupeer.*` commands, never `discussLines`
   (`securityInvariants.test.ts:24-51`).
6. **Neither webview script assigns markup as a string.** No `innerHTML`,
   `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval`
   (`securityInvariants.test.ts:75-84`).
7. **The panel CSP has a cryptographic nonce and no `'unsafe-inline'`**; the
   dashboard has no `script-src` at all (`securityInvariants.test.ts:53-73`,
   `86-115`).
8. **The two surfaces never disagree** ("spec A4"): the lens and the hover show
   the same state, and a lens that says "nothing to flag" clears the stored
   hint alongside it (`inlineTutor.ts:443-448`, `868-882`).
9. **`MAX_HINT_LEVEL` matches the backend**, checked by reading
   `backend/models.py` from the test (`pedagogy.test.ts`).
10. **The transcript on screen and the depth beside it describe the same
    problem.** Both ride `threadKey`.
11. **EduPeer never writes to the student's code.** Not under a setting, not
    on any transition. Scanned for in `src/` by
    `auditRegressions.test.ts`'s "no source file writes to the student's
    code". Until 1.7.0 this read "exactly once, under one setting".

---

## 18. Build, test and packaging

| Script | Command | Notes |
| --- | --- | --- |
| `esbuild` | `esbuild src/extension.ts --bundle --outfile=out/extension.js --external:vscode --format=cjs --platform=node` | |
| `vscode:prepublish` | removes `out/`, then `esbuild --minify` | |
| `compile` / `watch` | `tsc -p ./` | Type-checking only; not the shipped artefact |
| `package` | `vsce package --no-dependencies` | |
| `test` | `jest --passWithNoTests` | |
| `test:coverage` | `jest --coverage` | |

`tsconfig.json`: commonjs, ES2020, `strict: true`, `outDir: out`,
`rootDir: src`.

`jest.config.js`: ts-jest preset, **node** test environment,
`moduleNameMapper` maps `vscode` → `src/__mocks__/vscode.ts` (439 lines).
`jest-environment-jsdom` is a devDependency and used per-file for the webview
tests. Coverage collects from `src/**/*.ts` only.

`.vscodeignore` excludes `src/`, `node_modules/`, source maps, compiled tests
and mocks, `tsconfig.json`, `jest.config.js` and `coverage/`.

Six built archives sit in `extension/`, `edupeer-1.3.1.vsix` through
`edupeer-1.7.0.vsix` — present in the working tree but **not tracked**:
`.gitignore` carries `*.vsix`, and `git ls-files` returns none of them. (An
earlier version of this document said they were checked in. They are not, and
were not.) The last is 148 KB across 21 files — up from 128 KB,
almost all of it the redesigned `style.css` (52 KB) and `main.js` (52 KB),
which ship unminified because they are webview assets rather than bundle
input. The two bundled woff2 faces are 50 KB of the total and always were.

**Publishing** is done by uploading the built `.vsix` at
`marketplace.visualstudio.com/manage`, not with `vsce publish`.

---

## 19. Test inventory

26 suites, 1,007 tests, all passing at this snapshot. The redesign added 82,
almost all of them in `webviewMain.test.ts`, which is where the behaviour it
added lives.

| Suite | Tests | Lines | Covers |
| --- | --- | --- | --- |
| `webviewMain.test.ts` | 180 | 2096 | `media/main.js` end to end (28 describes), including one that walks a whole session |
| `sidebarProvider.test.ts` | 135 | 2487 | Threads, `handleAsk`, focus, exercises, failure tiers |
| `inlineTutor.test.ts` | 103 | 1753 | Lens, hover, scan, decorations, marker removal, the eight-lens cap |
| `attemptTracker.test.ts` | 81 | 366 | The gate, diffing, give-up and answer-request lists |
| `apiClient.test.ts` | 47 | 660 | Endpoints, errors, timeouts, mode downgrade |
| `extension.test.ts` | 40 | 601 | Activation, command registration, wiring |
| `markdown.test.ts` | 37 | 282 | `media/markdown.js` |
| `codeDigest.test.ts` | 36 | 530 | Band selection and budget arithmetic |
| `pedagogy.test.ts` | 34 | 198 | Modes, framing, **and the `MAX_HINT_LEVEL` cross-check** |
| `auditRegressions.test.ts` | 30 | 637 | The data-flow and lifecycle invariants of §17 |
| `languages.test.ts` | 28 | 124 | Every regex against real fixtures |
| `annotationStore.test.ts` | 28 | 297 | Staleness, shifting, the revision guard |
| `bugMarkers.test.ts` | 23 | 159 | Marker detection, string safety, blanking |
| `streamHint.test.ts` | 22 | 284 | SSE parsing, idle deadline, reader release |
| `signInFlow.test.ts` | 22 | 258 | State nonce, both delivery paths, the size cap |
| `localTutor.test.ts` | 22 | 128 | Rule matching per language |
| `focusScope.test.ts` | 21 | 326 | The four strategies and the label/breadcrumb split |
| `blockHeuristics.test.ts` | 21 | 168 | Indent/brace/statement blocks, clamping |
| `statusBar.test.ts` | 19 | 128 | `renderStatus` for every snapshot |
| `progressPanel.test.ts` | 19 | 180 | Chart geometry, escaping, empty states |
| `testWatcher.test.ts` | 17 | 49 | `TEST_COMMAND_RE`, buffering, tail |
| `debugCompanion.test.ts` | 15 | 208 | Exception capture, per-session dedupe |
| `securityInvariants.test.ts` | 10 | 112 | The source-level security guards |
| `authManager.test.ts` | 10 | 262 | Token lifecycle, migration safety |
| `offlineQueue.test.ts` | 4 | 56 | Enqueue/replace/flush |
| `firebaseClient.test.ts` | 3 | 38 | Delegation |

`securityInvariants.test.ts` and parts of `auditRegressions.test.ts` assert on
**source text** rather than behaviour, because the webview and hover paths need
far more of the VS Code API than the mock provides and the properties are
structural anyway. Both files are explicit that a regex over source is not a
data-flow proof, and name the behavioural tests that carry the real weight.

---

## 20. Known gaps and dead code

Facts about the current tree, not recommendations.

1. **`HintRequest.confidence` is declared and never set.** No source file
   outside `apiClient.ts` references it. It is vestigial from the 1.4.0 removal
   of "How sure are you?".
2. **`ProgressReport.calibration` / `CalibrationReport` are declared and never
   rendered.** `progressPanel.ts` has no calibration section, though
   `securityInvariants.test.ts` still lists `${data.samples}` and friends among
   the fragments that must not appear — leftovers from when it did.
3. *(Closed 2026-08-19.)* Definition CodeLenses were unbounded: `lensMode:
   "all"` put 40 lenses on a 40-function file. The mode is `"top8"` now, with
   the remainder behind one file-level quick pick.
4. *(Closed 2026-08-19.)* Oversized blocks could lose a `bug:` marker they
   were never reviewed against: the marker filter acted on the whole focus
   range while the scan had only seen the digest's share of it. The deletion
   that made this possible is gone, and nothing in `src/` writes to the
   student's file at all.
5. **A scheduled scan is dropped by a tab switch inside its 3.5 s debounce.**
   Named at `inlineTutor.ts:552-556`; bounded and arguably correct.
6. **`braceBlockEnd` counts braces inside strings and comments.** A deliberate
   trade against carrying a parser per language.
7. **Python triple-quoted strings are not modelled** in
   `indexOutsideStrings`, so a `bug:` marker inside a one-line docstring is
   treated as a comment. Since 1.7.0 the only consequence is that such a
   marker is stripped out of a request it could have stayed in — the
   conservative direction, and no longer a deletion from a file.
8. **`testWatcher.ts` is 40% covered**, the lowest in the tree, because its
   callbacks need a host API the mock does not model.
9. *(Closed 2026-08-19.)* The panel did not follow the VS Code colour theme,
   including the high-contrast themes — a deliberate 1.3.0 decision recorded
   in the changelog, and a genuine accessibility cost. It now re-points its
   token layer from the `vscode-light` / `vscode-high-contrast` /
   `vscode-high-contrast-light` class VS Code puts on `<body>`, keeping the
   brand in all four skins. Nothing past the `:root` block is skin-aware.
10. *(Closed 2026-08-19.)* `extension.ts` and `package.json` each declare the
    default backend URL, and were kept in step by a comment rather than a
    test. `auditRegressions.test.ts`'s "duplicated constants stay in step"
    now parses both and compares them.
11. **The banner exit is timed, not event-driven.** `setBanner` hides on a
    160 ms `setTimeout` rather than `animationend`, because that event does not
    fire for a webview hidden mid-animation and a banner that never hides is
    worse than one that hides abruptly. The timer and the CSS duration are now
    compared by the same audit as item 10, so they can no longer drift
    silently — a short timer cuts the exit off, a long one leaves the banner
    finished but present.
12. **`--e2` and `--s8` are declared and unused.** Both came in with the
    redesign's token layer; the elevation scale is deliberately near-unused
    (only the popover and the badge sheet float at all).
13. **The composer has no "Sending…" verb.** The component spec lists it as a
    per-mode state; the thinking row directly above already says "EduPeer is
    thinking…", so a third copy of the same fact was left out.
14. **Several things the deck specifies have no ticket. Two are deliberately
    not built, and both reasons are below.** T1-T15 name C1-C7; **C8
    ("Accessibility, the parts that need words") is referenced by no ticket at
    all**, and neither is §2's icon grid, M11's measure cap, M12's short-panel
    layout or C3's stale state. All of those landed 2026-08-19 except two.
    From C8, the trace table's caption/scope and the popover's focus trap
    landed; the "2 of 3 rows correct" announcement did not,
    because nothing produces that count — `trace-check` comes back as prose
    from the model, and deriving a number client-side would be inventing one.
    **§2's "eleven inline SVGs"** is not being chased, and the reason is worth
    recording. The deck asserts the count and never enumerates it. Counting
    the distinct icon *jobs* the panel actually has gives about eight
    — chevron-right, chevron-down, close, minus, plus, external-link,
    corner-down-right, return — and reaching eleven would mean iconifying
    things that are currently words: Refresh, Whole file, Review, Quiz me. At
    320px those words fit, and replacing them with glyphs would cost clarity
    rather than buy any.

    What the deck's *reasons* do justify was done on 2026-08-19. Its case
    against emoji is three-part: a screen reader reads them, they are tofu in
    some Linux workbench font stacks, and they date a screenshot. Applied to
    the typographic marks that replaced them, only the first two bite, and
    only in specific places — so the panel now carries four inline SVGs (the
    avatar ring, the sheet close, and the two marks outside the block a
    minimal font stack can be relied on for: `⌄` and `↳`), and every
    remaining mark sits in an `aria-hidden` wrapper. `webviewMain.test.ts`'s
    "no control reads a decorative mark aloud" holds that line; it found the
    Ask button announcing "Ask↵" on its first run.

    So the two standing deviations are the icon count and the trace
    announcement. Everything else the deck asks for is built.
15. **The redesign's own preview is a paint check, not a render.**
    `docs/mockups/make-preview.py` lifts the markup from `getHtml()` and points
    it at the real stylesheet, but runs no script — so it shows the chrome and
    never a card. It exits non-zero when a substitution stops matching, which
    is what keeps it honest.

---

## 21. Differences from the existing documentation

Checked against `docs/SYSTEM_REFERENCE.md` (§14 "Extension reference"),
`README.md` and `extension/README.md` at this same snapshot. Listed so the three
can be reconciled; none of these is a code defect.

### 21.1 `docs/SYSTEM_REFERENCE.md` §14

That section carries its own staleness banner dated 2026-08-09 and is accurate
about being wrong. Concretely, against 1.7.0:

- **Commands: says fifteen, there are eighteen.** `edupeer.deepenLine`,
  `edupeer.dismissLine` and `edupeer.pickDefinition` are missing, and all three
  are hidden from the palette.
- **`edupeer.scanFile` is titled "EduPeer: Scan File for Issues"**; it is
  "EduPeer: Scan This Block", and it scans the focus block, not the file.
- **Activation events: says `["onStartupFinished"]`**; `onUri` was added for
  the sign-in deep link.
- **Settings: says four, there are five.** `edupeer.lensMode` is missing.
  It also predates `removeFixedBugComments` being added *and* removed.
- **The extension→webview table is substantially out of date.** It lists
  `activeCode`, which no longer exists. It is missing `focus`, `cursor`,
  `fullFile`, `authTrouble`, `streak` and `scanClean`. `restoreChat` is now
  per-thread rather than global, and `hint` no longer drives a composer-level
  stepper.
- **The webview→extension table** is missing `requestFullFile`, and maps
  `signIn`/`signOut` to the wrong handler line numbers.
- **CodeLens**: no mention of `lensMode`, of the "Go deeper" / "Dismiss"
  sibling lenses, of `activeLensLines()`, or of the auth-error lens routing to
  `edupeer.signIn` instead of `nudgeLine`.
- **Status bar**: missing the `thinking` spinner and the `sign-in error` state,
  and the warning background now also covers auth failure.
- **Triggers table**: says the scan runs "once on activation" and on active
  editor change. Neither is true in 1.6.0 — nothing runs until the student
  lands somewhere, and the scan is per block.
- **Line citations** throughout point at pre-1.6.0 positions (e.g.
  `retainContextWhenHidden` cited at `extension.ts:72`, now `117-121`).
- **Three modules it does not mention**: `annotationStore.ts`,
  `blockHeuristics.ts`, `focusScope.ts` — its own banner already says so. To
  those add `codeDigest.ts`, `documentDigest.ts` and `bugMarkers.ts`, which
  postdate it.
- **Counts**: it reports 16 source modules / 3,843 source lines / 21 test files
  / 5,307 test lines, and 89.45% statement coverage. Current: 22 / 6,855 /
  26 / 12,230, and 91.00%.
- **Everything it says about the panel's structure** is superseded by the
  2026-08-19 redesign; its own banner now carries a section listing what
  moved.

### 21.2 `README.md` (repository root)

- **Command table lists 14** and mentions `discussLines` in prose (15). Missing
  `edupeer.deepenLine`, `edupeer.dismissLine` and `edupeer.pickDefinition`.
- **`edupeer.scanFile` described as "Scan the open file"** — it is per block,
  and retitled.
- **`edupeer.signIn` described as "sign in with Google, GitHub, or email"** —
  worth re-checking against the current `backend/static/auth.html`, which was
  rewritten on the focus-scope branch.
- Correct where `extension/README.md` is not: it says the walkthrough "ships in
  the Welcome page" rather than opening automatically.

### 21.3 `extension/README.md` (the Marketplace page)

*(Rewritten 2026-08-19. The list below is what it said beforehand, kept
because the same drift is what to watch for next time.)*

- **Settings table listed four** of the then-six; `edupeer.lensMode` and
  `edupeer.removeFixedBugComments` were missing. It now lists all five — the
  latter having gone with the code edit it gated.
- **Command table listed 12**; `signIn`/`signOut` appeared only in prose, and
  `deepenLine`, `dismissLine`, `discussLines`, `pickDefinition` were absent.
- **Its description of the panel** predated the redesign: the
  streak chip and badges are in a footer ledger now, the code preview is a
  collapsed disclosure, the hint dots are a bar meter, and the panel follows
  the workbench theme in four skins rather than being dark always.
- **"The **Get started with EduPeer** walkthrough opens automatically on first
  run."** Nothing in `src/` opens it — `grep -rn walkthrough extension/src`
  returns nothing. VS Code surfaces it on the Welcome page.
- **Privacy section says "The code in your active file … are sent to the
  EduPeer backend".** As of 1.6.0 that is a digest — imports, enclosing
  headers, one line per top-level definition, the focus block and three lines
  either side — capped at 120 lines. This is both the most user-visible
  claim on the page and the most out of date, and it understates the product.
- The "How it works" section predates the fourth rung: it describes the ladder
  without mentioning that rung 4 is a worked example, or that asking outright
  for the answer is a supported, ladder-free path.

---

## 22. Quick index for an agent

| To change… | Start at |
| --- | --- |
| What code is sent | `codeDigest.ts` (rules), `documentDigest.ts` (the door) |
| What "the current block" means | `focusScope.ts`, then `blockHeuristics.ts` |
| The conversation, threads, or the ask path | `sidebarProvider.ts` |
| Anything drawn in the editor | `inlineTutor.ts` + `annotationStore.ts` |
| The panel's DOM or composer | `media/main.js` (+ `style.css`); the markup itself is a template literal in `sidebarProvider.getHtml` |
| A colour, a size, a radius, a skin | the `:root` block and the three `body.vscode-*` blocks at the top of `style.css`. Nothing below them is skin-aware, so a value is changed in one place |
| How a card is drawn | the `FAMILY` table in `main.js`, then `.turn--ask` / `--show` / `--tell` / `--withhold`. Never per mode |
| What the composer says in a mode | the `COMPOSER` table in `main.js` — strip, placeholder and verb together, so they cannot drift |
| Hint depth, modes, prompt framing | `pedagogy.ts` |
| When a hint gets deeper | `attemptTracker.ts` |
| HTTP, streaming, retries, error classes | `apiClient.ts` |
| Sign-in, tokens, migration | `authManager.ts` + `signInFlow.ts` |
| A new language | `languages.ts` (and `backend/languages.py`, which must agree) |
| A new command | `package.json` `contributes.commands`, a registration site, **and** `EXPECTED_COMMANDS` in `extension.test.ts`, which pins the set |
| The dashboard | `progressPanel.ts` |
| The offline experience | `localTutor.ts` + `offlineQueue.ts` |

Before editing anything that reaches the network, read
`src/__tests__/auditRegressions.test.ts:472-637` — it will tell you what the
change is allowed to look like. In particular a bare `getText()` in a sender
module fails that scan by design, so code needing whole-document text has to
go through the chokepoint or be rewritten to read line numbers instead.

For the panel, `webviewMain.test.ts`'s "a whole session holds together" is the
fastest way to see the pieces working as one: it walks cold start → sign-in →
open a file → three rungs → a gate → the translation offer → the worked
example → reset, and asserts the meter, the families, the context strip, the
composer strip and the ledger all agree at each step. And
`docs/mockups/make-preview.py` will show you the chrome in a browser, against
the real stylesheet.
