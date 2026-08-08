# EduPeer: responsive inline tutor, focus-block scoping, and a rebuilt sign-in page

Date: 2026-08-09
Status: approved, ready for planning

## Why

Three reports from using the packaged 1.0.1 extension:

1. Clicking `💡 Get a hint` appears to do nothing.
2. After fixing the mistake, the lens and the hint are still sitting there.
3. The sidebar shows the whole file instead of the code being worked on.

Plus a fourth, separate ask: the hosted sign-in page looks unfinished.

All three extension complaints trace to real defects, not to misunderstanding.

### 1. Silent failure and invisible success

`inlineTutor.ts:277-288` catches every `getLineHint` failure. A 401, a 502 from
the LLM, a network timeout, or an empty hint from the model all produce exactly
zero user-visible output. Nothing is logged where a student can see it, nothing
appears in the editor, and the lens does not change.

Even the success path gives no acknowledgement. `edupeer.nudgeLine` moves the
cursor, awaits a multi-second LLM round trip, and only then paints grey italic
`after`-text 2rem past the end of a single line. Between click and paint the
interface is indistinguishable from broken.

### 2. Stale annotations

Two distinct causes:

- The `💡 Get a hint` lens is not tied to a problem. `inlineTutor.ts:472-488`
  attaches it to every line matching `lensRegex` — every `def`, `class`,
  `function`. It is permanent furniture, so after fixing a bug it reads as a
  standing accusation that the bug is still there.
- Scan flags survive edits. `state.flags` is keyed by line *number* and is only
  replaced by a later successful scan (3.5s debounce plus a network round trip).
  Inserting a line above a flag slides it onto unrelated code; editing the
  flagged line itself leaves the flag, its diagnostic and its lens in place.

### 3. Whole-file context

`sidebarProvider.ts:539-554` posts `document.getText()` on every keystroke.
`main.js` renders up to 200 lines of it. That same blob is what goes to the
backend as `code`, so the tutor's attention is spread over the entire file and
the attempt-gate treats an edit anywhere in the file as evidence the student
tried something.

## Scope

In scope:

- **A.** Inline tutor: lens state machine, error surfacing, annotation expiry.
- **B.** Focus-block scoping across the sidebar, the API request and the ladder.
- **C.** A rebuilt `backend/static/auth.html`, plus the sidebar's signed-out state.

Out of scope: the progress panel, new tutor modes, backend prompt work beyond
threading the `focus` field through, and any change to the auth protocol.

---

## A. Inline tutor

### A1. Two lens families

The single `💡 Get a hint` label is replaced by two labels that mean different
things:

| Family | Where | Label | Meaning |
|---|---|---|---|
| Offer | lines matching `lensRegex` | `💡 Ask EduPeer` | An invitation. Never implies a problem exists. |
| Flag | ranges returned by `/scan` | `❓ <flag.question>` | A real observation about this code. |

Only flag lenses can go stale, because only they make a claim.

A new setting `edupeer.lensMode` with values `all` (default) and `flagged` lets
a student who finds the offer lenses noisy keep only the flag lenses. It does
not have an `off` value; the existing `edupeer.inlineHints: false` already turns
the whole inline surface off, and two settings meaning "off" would be one too
many.

### A2. The lens is the feedback channel

Each `(documentUri, line)` carries a lens state. The command handler fires
`onDidChangeCodeLenses` **synchronously, before awaiting anything**, so the
transition to `loading` is visible within one frame.

```
idle      💡 Ask EduPeer              (or  ❓ <question>)
loading   ⏳ EduPeer is thinking…
ready     💡 <hint>  ·  Go deeper  ·  Discuss  ·  ✕
error     ⚠️ <reason> — click to retry
empty     ✓ Nothing to flag on this line
```

`ready` renders as sibling `CodeLens` objects on the same range so each action
is independently clickable:

- **Go deeper** — hands off to the sidebar via `askExternal(question, focusCode,
  "hint")`. Inline gives the one-line nudge; the real 1→2→3 ladder lives in the
  conversation. The inline path deliberately does not grow its own ladder.
- **Discuss** — existing `edupeer.discussLines` with the focus range.
- **✕** — returns the line to `idle`.

`error` reasons are specific, and each maps to one sentence:

| Cause | Lens text |
|---|---|
| `AuthError` / 401 | `⚠️ Sign in to get hints — click to sign in` |
| `RateLimitError` / 429 | `⚠️ Hint budget used up, back in Nm — click to retry` |
| 502 from the LLM | `⚠️ The tutor couldn't answer that — click to retry` |
| `!api.isAvailable` | `⚠️ Backend unreachable — click for a local nudge` |
| model returned `""` | `empty` state, not an error |

The offline branch falls through to `localLineHint`, which already exists, so
the lens still teaches something with no network.

The status bar mirrors `loading` with `$(sync~spin) EduPeer` via a new
`thinking` field on `StatusSnapshot`, keeping `renderStatus` pure and unit
tested as it is today.

`edupeer.nudgeLine` invoked from the keybinding, the context menu or the
command palette drives the same state machine, so all four entry points behave
identically.

### A3. `annotationStore.ts` — annotations expire when touched

A new module lifted out of the 574-line `inlineTutor.ts`. It owns flags, line
hints, local hints and lens states for one document, and imports nothing from
`vscode` beyond types. Interface:

```ts
setFlags(flags: LineFlag[]): void
setHint(line: number, hint: LineHint): void
setLensState(line: number, state: LensState): void
applyChanges(changes: readonly TextDocumentContentChange[]): void
annotationsAt(line: number): { flag?: LineFlag; hint?: LineHint }
lenses(): LensDescriptor[]
diagnostics(): DiagnosticDescriptor[]
```

`applyChanges` implements the whole staleness rule:

- A change whose range **intersects** an annotation's range drops that
  annotation entirely — flag, hint, diagnostic and lens state. The student
  changed the thing we commented on, so the comment is void. This is what makes
  the lens disappear the moment the mistake is fixed, instead of after the next
  scan lands.
- A change **entirely above** an annotation shifts its start and end lines by
  the change's line delta (`insertedLineCount - removedLineCount`).
- A change **entirely below** leaves it alone.

`inlineTutor` becomes the VS Code adapter: it wires events, calls the API, and
renders whatever the store reports. The store is where the logic lives.

### A4. Everything else stays

Decorations, hovers, quick fixes, the reflection-quiz offer, the 429 back-off
window and the `md.isTrusted` command allow-list are unchanged. The hover keeps
showing the cached hint, and now also reflects `error` and `loading` states so
the two surfaces never disagree.

---

## B. Focus-block scoping

### B1. `focusScope.ts`

```ts
interface FocusScope {
  range: vscode.Range;        // resolved block
  label: string;              // "calculate_average" | "selection" | "lines 40–55"
  breadcrumb: string;         // "demo.py › Stats › calculate_average"
  kind: "selection" | "symbol" | "heuristic" | "window";
}

resolveFocus(doc: vscode.TextDocument, sel: vscode.Selection): Promise<FocusScope>
```

Resolution order, first match wins:

1. **Selection.** A non-empty selection *is* the scope. Most explicit signal
   available, so it outranks everything.
2. **Symbol.** `vscode.executeDocumentSymbolProvider` on the document, then the
   innermost symbol containing the cursor whose kind is `Function`, `Method`,
   `Constructor`, `Class` or `Struct`. Works for every language with a symbol
   provider installed, and supplies the breadcrumb for free.
3. **Heuristic.** No provider, or no containing symbol: walk up to the nearest
   line matching the language's `lensRegex`, then down until indentation
   returns to that header's level (Python, SQL) or braces balance (C-family,
   Go, Rust, JS/TS). Caps at 200 lines.
4. **Window.** ±15 lines around the cursor, clamped to the document.

Resolution is cached per `(uri, version, cursorLine)` so it does not re-run on
every keystroke.

### B2. Sidebar panel

`sendActiveCode` becomes `sendFocus`, posting:

```ts
{ type: "focus", focusCode, breadcrumb, startLine, endLine,
  cursorLine, fileName, language, totalLines }
```

Rendered as:

```
demo.py › calculate_average · lines 12–19        [Whole file]
12  def calculate_average(n):
13      total = 0
…
16 ▸    return total / len(n)
```

Real line numbers from the document, a `▸` marker on the cursor's line, and a
`Whole file` toggle for when the student genuinely wants everything. The
existing `Hide` / `Refresh` controls stay.

Posting is debounced at 150ms and suppressed when neither the focus range nor
its text changed, which removes the current whole-document-per-keystroke
traffic.

### B3. Request and ladder

`code` still carries the full file — the model needs imports, globals and
callers to give a correct hint. The request gains:

```python
class FocusRange(BaseModel):
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    label: str = Field(default="", max_length=120)

# on HintRequest and LineHintRequest only
focus: FocusRange | None = None
```

`ScanRequest` is deliberately left alone: a scan's job is to flag lines across
the whole file, so narrowing it would defeat it.

The prompt builder is told to answer about the focus block and to cite real
line numbers. `end_line >= start_line` is validated; an out-of-range focus is
ignored rather than rejected, so an older extension keeps working.

Two client-side consequences:

- `problem_key` becomes `${uri}#${focus.label}`. The hint ladder is per
  function, so being stuck on a different function starts at hint 1. That is
  the correct pedagogy and it is what the ladder was always meant to key on.
- `AttemptTracker` is fed the focus block instead of the whole file, so
  "unchanged" means the student did not touch the code they are stuck on.
  Today, editing an unrelated line elsewhere in the file unlocks a deeper hint.

---

## C. Sign-in page

`backend/main.py:149-153` serves `backend/static/auth.html` with
`__FIREBASE_API_KEY__` and `__FIREBASE_AUTH_DOMAIN__` substituted in.
`backend/tests/test_auth_page.py` asserts only that substitution, so the markup
is free. Everything security-bearing is preserved verbatim: the
`EDITOR_SCHEMES` allow-list, the `state` nonce check, the `rawExt` hostname
regex, the deep-link-then-loopback handoff order, and the three card states.

### C1. Direction

Audience is 16–24, most of them in a first or second programming course. The
page has one job: sign in and get back to the editor in under ten seconds. The
brief asks for a shadcn login and a Gen Z register — so the structure and
discipline come from shadcn (card, hairline borders, outline OAuth buttons, the
centred-label divider, an 8px spacing scale) and the whole personality budget
is spent on palette, one display face, and one signature element.

**Palette** — deep aubergine rather than the neutral zinc that every AI-authored
login page lands on:

| Token | Value | Use |
|---|---|---|
| `--ground` | `#12101B` | page |
| `--card` | `#1B1826` | the card |
| `--line` | `#2E2940` | hairlines, button borders |
| `--muted` | `#9C93B8` | secondary text, divider label |
| `--ink` | `#F2EFFA` | primary text |
| `--coral` | `#FF6B4A` | primary action, focus rings, error accent |
| `--mint` | `#7CE0D3` | signature only, nowhere else |

**Type** — `Bricolage Grotesque` for the single headline: variable, slightly
odd, contemporary without being a meme, and used exactly once. `Geist Sans` for
UI, `Geist Mono` for the eyebrow and the divider label. Loaded from a font CDN
with `font-display: swap` behind a system stack, matching the page's existing
reliance on `gstatic.com` for Firebase.

**Signature** — one oversized `?` set in Bricolage, cropped by the viewport
edge, filled at near-ground contrast, with the card sitting over its bowl and a
single mint stroke where the card's top edge crosses it. EduPeer's entire
thesis is that it answers with questions; the mark says that without a line of
copy. No JS, no gradient mesh, no typing animation.

The risk being taken: the near-invisible cropped glyph reads as a mistake if the
contrast is wrong. It is worth taking because it is the one thing on the page
that could not appear on any other product's login.

### C2. Structure

```
┌──────────────────────────────────────────┐
│  EDUPEER                     (mono, muted)│
│  Ready to get unstuck?      (Bricolage)   │
│  Sign in to keep your hints, badges       │
│  and progress.                            │
│                                           │
│  ┌────────────┐  ┌────────────┐           │
│  │ G  Google  │  │ ⌥  GitHub  │           │
│  └────────────┘  └────────────┘           │
│                                           │
│  ───────  or continue with email  ─────── │
│                                           │
│  Email     [                    ]         │
│  Password  [              ] [show]        │
│  ┌─────────────────────────────────────┐  │
│  │            Sign in                  │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  New here? Create an account              │
└──────────────────────────────────────────┘
```

The Google and GitHub marks are **inline SVG**, not `<img>`: the official
four-colour Google G and the GitHub Octocat, both used within their brand
guidelines for sign-in buttons. Inline avoids two extra requests and any
`img-src` question. Side by side above 380px, stacked below.

### C3. Copy

Every string does one job and names things from the user's side:

| Element | Text |
|---|---|
| Eyebrow | `EDUPEER` |
| Headline | `Ready to get unstuck?` |
| Sub | `Sign in to keep your hints, badges and progress.` |
| OAuth | `Continue with Google` / `Continue with GitHub` |
| Divider | `or continue with email` |
| Submit | `Sign in` — becomes `Create account` in create mode |
| Toggle | `New here? Create an account` / `Already have an account? Sign in` |
| Success | `You're in.` + `Head back to VS Code — EduPeer is ready.` |
| Handoff | `Didn't jump back to VS Code?` + `Send it again` |
| Invalid | `This link is missing its security token` + `Close this tab and start sign-in again from VS Code.` |

Firebase error codes map to plain sentences instead of surfacing raw codes.
Errors state what happened and how to fix it, and do not apologise:

| Code | Message |
|---|---|
| `auth/invalid-email` | `That doesn't look like an email address.` |
| `auth/user-not-found` | `No account for that email yet — create one below.` |
| `auth/wrong-password`, `auth/invalid-credential` | `That password doesn't match this email.` |
| `auth/email-already-in-use` | `That email already has an account — sign in instead.` |
| `auth/weak-password` | `Passwords need at least 6 characters.` |
| `auth/popup-blocked` | `Your browser blocked the sign-in window. Allow pop-ups and try again.` |
| `auth/popup-closed-by-user` | `Sign-in window closed before it finished.` |
| `auth/network-request-failed` | `Can't reach the sign-in service. Check your connection and try again.` |
| anything else | `Sign-in failed (<code>). Try again, or use a different method.` |

### C4. Quality floor

Responsive from 320px. Coral 2px focus rings on every interactive element,
never removed. `prefers-reduced-motion` disables the card's entrance. A real
`<form>` with `autocomplete="email"` and `autocomplete="current-password"`,
visually-hidden `<label>`s alongside the placeholders, `aria-live="polite"` on
the error region, a show/hide password toggle, and every button disabled with an
inline spinner while an auth call is in flight.

### C5. Sidebar signed-out state

`media/style.css` deliberately derives every colour from VS Code theme tokens so
the panel is correct in light, dark and high-contrast themes. The signed-out
card therefore borrows the login page's **layout and copy only** — headline,
sub, one primary `Sign in` button — and keeps using `--accent`, `--surface` and
the rest of the token system. No aubergine, no coral, no web fonts in the
webview.

---

## Data flow

```
edit / cursor move
   └─> focusScope.resolveFocus  ──> sidebar panel (debounced 150ms)
                               └──> HintRequest.focus + problem_key + AttemptTracker

click lens
   └─> lensState = loading, fire onDidChangeCodeLenses   [synchronous]
   └─> api.getLineHint(code, line, language, focus)
         ├─ hint   -> annotationStore.setHint  -> lensState = ready
         ├─ ""     -> lensState = empty
         └─ throw  -> lensState = error(reason)          [never silent]

document change
   └─> annotationStore.applyChanges
         ├─ intersects annotation -> drop it (lens, hint, flag, diagnostic)
         └─ above annotation      -> shift line numbers
   └─> scheduleScan (unchanged 3.5s debounce)
```

## Error handling

Every failure now has exactly one visible home:

| Failure | Surface |
|---|---|
| Line-hint request fails | Lens `error` state with a specific reason and retry |
| Scan fails | Silent by design — no annotations appear, nothing claims otherwise |
| Sidebar ask fails | Existing `postFailure` path, unchanged |
| Focus resolution fails | Falls through to the ±15-line window; never throws |
| Firebase auth fails | Mapped sentence in the page's `aria-live` error region |

## Testing

New unit tests, Jest for the extension and pytest for the backend:

- `annotationStore` — shift on insert above, shift on delete above, drop on
  intersecting edit, keep on edit below, drop on multi-line replace spanning a
  flag.
- `focusScope` — selection wins over symbol; symbol wins over heuristic;
  Python indentation heuristic; C-family brace heuristic; window fallback at
  top and bottom of file; cap at 200 lines.
- Lens state machine — every transition, and that `error` is reached for each
  failure class rather than being swallowed.
- `renderStatus` — the new `thinking` field.
- Backend — `FocusRange` validation, an out-of-range focus being ignored, and
  the existing auth-page substitution test still passing against the new HTML.

Manual verification, since this is a bug report about felt behaviour:

1. Open `demos/demo.py`, click `💡 Ask EduPeer`, confirm the lens flips to
   `⏳` before the answer arrives.
2. Sign out, click the lens, confirm `⚠️ Sign in to get hints`.
3. Let a flag appear, fix the flagged line, confirm the lens and the Problems
   entry disappear on the keystroke, not seconds later.
4. Insert ten lines above a flag, confirm it stayed on its own code.
5. Move the cursor between two functions, confirm the sidebar follows and the
   hint level restarts.

## Risks

- **Symbol providers are not guaranteed.** A student with no Python extension
  installed gets the heuristic path. Mitigated by making the heuristic the
  tested default rather than an afterthought.
- **Per-function `problem_key` resets the ladder more often.** Intended, but it
  changes felt behaviour; worth watching once it ships.
- **Dropping annotations on any intersecting edit is aggressive.** A typo fix
  inside a flagged line clears a flag that may still be valid. Correct trade:
  a missing flag returns on the next scan, a wrong flag teaches the wrong thing.
- **The cropped `?` depends on contrast.** Needs checking against real displays,
  not just one monitor.
