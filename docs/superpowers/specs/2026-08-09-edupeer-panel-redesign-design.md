# EduPeer: a branded, expressive sidebar panel with a motion system

Date: 2026-08-09
Status: approved, ready for planning

## Why

The panel is not accidentally plain. `extension/media/style.css` opens by stating
that every colour derives from VS Code theme tokens "without a single hard-coded
colour decision of our own", and styles the tutor's replies as "a rule, not a
bubble" so the tutor is "never the loudest thing on screen".

That restraint succeeded at what it aimed for and produced something the owner
describes as ugly. The panel reads as chrome rather than as a product, it shares
no identity with the sign-in page rebuilt in 1.1.0, and it has almost no motion,
so every state change lands as a jump cut.

Two decisions were taken explicitly during design, both recorded here because
each has a cost:

1. **Full brand takeover, no fallback.** The panel gets its own palette and does
   not adapt to the user's theme.
2. **Expressive personality.** Warm, rewarding, alive — not editorial restraint,
   not terminal cool.

## Scope

In scope:

- **A.** Brand palette and typography for `extension/media/style.css`.
- **B.** Structural changes: the hint ladder moves into each tutor card, the
  streak becomes a live chip, tutor replies become cards.
- **C.** A motion system covering every state change in the panel.

Out of scope, deliberately:

- `extension/src/progressPanel.ts`, a separate webview. It will still look like
  the old panel afterwards. Raised during design and left out.
- `backend/static/auth.html`. It already has a card entrance and its own
  identity; extending the motion identity into it was offered and not selected.
- The inline editor surfaces. See "The API ceiling" below.

## A. Palette and typography

### Palette

Inherited from the sign-in page so the two surfaces read as one product. The
contrast figures were measured against `--card` during the 1.1.0 review and
carry over unchanged.

| Token | Value | Role | Contrast on `--card` |
|---|---|---|---|
| `--ground` | `#12101B` | panel background | — |
| `--card` | `#1B1826` | tutor cards, inputs | — |
| `--card-lit` | `#221E30` | hover, raised rows | — |
| `--line` | `#6D6198` | borders, dividers | 3.16:1 |
| `--muted` | `#9C93B8` | secondary text | 6.04:1 |
| `--ink` | `#F2EFFA` | primary text | 15.35:1 |
| `--coral` | `#FF6B4A` | the student's turns, primary actions, ladder fill | — |
| `--mint` | `#7CE0D3` | success only: the clean-scan sweep | — |

`--card-lit` is new to this spec and its contrast against `--ink` and `--muted`
must be measured during implementation and recorded, the same way the others
were. Any pair that fails is raised until it passes; the palette is not shipped
on assumption.

`--coral` as a background takes `#1A0A05` as its foreground, matching the
sign-in page's primary button, which measured 6.84:1.

### Typography

- **Display — Bricolage Grotesque.** The empty state, the focus breadcrumb's
  symbol name, and the hint-card headers.
- **Body — Geist Sans.** All prose.
- **Code — unchanged.** The focus preview keeps
  `var(--vscode-editor-font-family)`.

That last one is a deliberate exception to the takeover. The preview shows the
student's own code; rendering it in a UI face would be worse, not braver.

Both faces ship as `woff2` under `extension/media/fonts/`, latin subset. They are
not fetched: a webview with no network must still render, and the current CSP
has no `font-src` at all. The CSP gains `font-src ${webview.cspSource}` — scoped
to the extension's own directory, not a CDN.

Expected cost is roughly 60-70KB against a 64KB VSIX. Trivial in absolute terms
and close to a doubling in relative terms; the implementation must report the
actual figure.

## B. Structure

### The hint ladder moves

Today a `1 2 3` stepper sits pinned above the composer, describing a hint that
may be several turns up the transcript. It moves into each tutor card's header:

```
┌──────────────────────────────┐
│ hint 2   ●●○                 │
│                              │
│ What happens when the list   │
│ is empty?                    │
└──────────────────────────────┘
```

The depth belongs with the hint it describes, and the composer loses a control
that was competing with the input for attention. `#stepper` and its
`holdLevel()` treatment are removed; the "asked again without editing" signal
becomes a held state on the card's dots instead.

### The streak becomes a chip

The top row gains `🔥 4` beside the brand. The data already exists —
`extension.ts` fetches `progress.streak_days` for the status bar — so the panel
receives it by push rather than by a second request:

```ts
// sidebarProvider.ts
public postStreak(days: number): void {
  this.post({ type: "streak", days });
}
```

called from the same place in `extension.ts` that calls `statusBar.update(...)`.
No new network call. When the streak is zero the chip is hidden rather than
showing a zero.

### The clean-scan celebration needs wiring

Nothing currently tells the webview that a file went clean. `InlineTutor`
detects the flagged-to-clean transition, but it is a different object from the
sidebar and they do not talk.

It follows the pattern the sidebar already uses for the hint level
(`onDidChangeHintLevel`, consumed by `extension.ts`). `InlineTutor` gains:

```ts
private readonly cleanEmitter = new vscode.EventEmitter<void>();
readonly onDidScanClean = this.cleanEmitter.event;
```

fired from the same transition branch that strips the `bug:` markers, and
`extension.ts` subscribes and calls `sidebar.postScanClean()`. The emitter is
disposed alongside the others in `dispose()`.

Without this the sweep and the streak-chip pop have no trigger.

### Tutor replies become cards

`.turn--tutor` changes from a left-margin hairline rule to a filled `--card`
surface with `--radius-lg` and a soft shadow. `.turn--student` becomes a coral
rounded bubble, right-aligned, with `#1A0A05` text.

### Empty and signed-out states

Both get the display face at `calc(var(--vscode-font-size, 13px) * 1.7)`. The
signed-out card added in 1.1.0 keeps its copy and gains the brand surface.

## C. Motion system

### Identity

Three constants, applied throughout:

| Constant | Value |
|---|---|
| Signature easing | `cubic-bezier(0.34, 1.26, 0.64, 1)` |
| Quick | `140ms` |
| Standard | `240ms` |
| Slow | `420ms` |
| Entrance pattern | rise 8px + fade, always from below |

Archetype is Playful. Amplitude is governed by frequency: overshoot is spent on
rare rewarding moments and withheld from anything that fires on a keystroke.
Exits run shorter than entrances throughout.

As CSS custom properties:

```css
  --ease-signature: cubic-bezier(0.34, 1.26, 0.64, 1);
  --ease-exit: cubic-bezier(0.3, 0, 1, 1);
  --ease-loop: cubic-bezier(0.4, 0, 0.6, 1);
  --t-quick: 140ms;
  --t-standard: 240ms;
  --t-slow: 420ms;
```

### The inventory

| Moment | Primary | Secondary | Ambient |
|---|---|---|---|
| Turn arrives | `translateY(8px)`→0 + fade, 240ms | shadow transitions in at +60ms | — |
| Ladder dot fills | scale `0.6`→1 + coral fill, 220ms, 40ms stagger | coral ring expands and fades | — |
| Streaming | caret blink, 1s sine loop | — | card border opacity ±4%, 2s sine loop |
| Thinking | 3 dots scale-pulse, 120ms stagger, 1.2s loop | — | — |
| File goes clean | mint sweep across the top edge, 600ms | streak chip pops 1→1.12→1 at +200ms | ground lightens 3% for 400ms |
| Button press | scale `0.97`, 120ms | settles 1.01→1, 220ms | — |
| Button hover | 90ms | — | — |
| Confidence pill selected | scale pop + coral fill, 180ms | — | — |
| Banner enters | slide + fade, 240ms | — | — |
| Banner exits | slide + fade, 160ms, `--ease-exit` | — | — |
| Empty / signed-out card | rise + fade, 300ms, 80ms delay | — | — |

The ladder dots are the signature: they encode the product's actual mechanic and
are on screen constantly, so they earn the most craft.

### The restraint that matters most

The focus panel re-renders whenever the cursor moves, debounced at 150ms.
Animating it like everything else would make the panel seasick.

- Cursor moves **within** the same block: only the coral cursor bar slides,
  180ms. Nothing else moves.
- Cursor crosses **into a different block**: breadcrumb and code crossfade,
  140ms.

**This needs a new message.** `sendFocus` suppresses a post when its signature —
`uri:startLine:endLine:focusCode` — is unchanged, and moving the cursor inside a
block changes none of those. So today the webview is never told the cursor
moved, and the bar could not slide.

Rather than widen the signature and reinstate a full post per keystroke, the
cursor gets its own lightweight message. `sendFocus` keeps its existing
suppression for the `focus` message and, when it suppresses one but the cursor
line has changed, posts instead:

```ts
this.post({ type: "cursor", cursorLine: editor.selection.active.line + 1 });
```

`main.js` moves the bar on `cursor` and re-renders on `focus`. The code rows are
untouched by a `cursor` message, which is the whole point.

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

State changes still land: dots still fill coral, the sweep still tints, banners
still appear. Reduced motion means no movement, not no feedback. The
near-zero-duration form is used rather than `animation: none` so that
`animationend` handlers still fire and nothing waits forever on an event that
never arrives.

### Performance

Every animation drives `transform` and `opacity`, which stay on the compositor.
Two exceptions, both cheap at this element count: `background-color` on the
ladder dots and `box-shadow` on the cards. No `height`, `width`, `top` or
`left` is animated anywhere — those trigger layout, and layout thrash is what
makes a webview feel cheap.

`will-change` is not used. At this element count it costs more in layer memory
than it saves.

### No animation library

GSAP is available but is not used. A webview has a strict CSP, ships offline,
and this is roughly fifteen discrete animations. CSS transitions plus a small
number of WAAPI calls cover all of it at zero bundle cost.

## The API ceiling

The inline editor surfaces — the CodeLens, the ghost-text hint, the gutter
decorations — cannot be animated. VS Code renders them itself and exposes no
hook for transitions. The panel and the sign-in page will feel smooth; the
editor decorations will keep appearing instantly, as they do now. This is an
API limit, not a decision, and it should not be reported as an oversight.

## The accessibility consequence

Recorded because it was chosen knowingly and should not be rediscovered later as
a surprise.

The panel will look identical in a light theme and a dark one, and VS Code's
high-contrast themes will no longer affect it. Every colour pair clears WCAG on
its own, so text stays legible — but a student running high contrast for a visual
impairment loses that setting inside this panel. There is no fallback and no
setting to restore one; that was the explicit choice.

## Files

**Create**
- `extension/media/fonts/bricolage-grotesque-subset.woff2`
- `extension/media/fonts/geist-sans-subset.woff2`

**Modify**
- `extension/media/style.css` — the bulk of the work, 852 lines today.
- `extension/media/main.js` — per-turn ladder dots, streak chip, the
  same-block-vs-new-block focus distinction, the clean-scan trigger.
- `extension/src/sidebarProvider.ts` — CSP `font-src`; remove `#stepper` from
  the HTML; add the streak chip element; add `postStreak` and `postScanClean`;
  post the new `cursor` message from `sendFocus`.
- `extension/src/inlineTutor.ts` — add the `onDidScanClean` emitter, fire it on
  the flagged-to-clean transition, dispose it with the others.
- `extension/src/extension.ts` — call `postStreak` where the status bar is
  already updated; subscribe to `onDidScanClean` and call `postScanClean`.
- `extension/.vscodeignore` — confirm `media/fonts/` ships.

## Testing

Automated, in `extension/src/__tests__/webviewMain.test.ts`:

- A tutor turn at hint 2 renders two filled dots and one empty.
- The ladder appears per card, and `#stepper` no longer exists.
- A `streak` message shows the chip; zero hides it.
- A `cursor` message moves the marker without re-rendering the code rows; a
  `focus` message with a new breadcrumb re-renders them.
- `sendFocus` posts `cursor` rather than `focus` when only the cursor line
  changed, and `focus` when the block changed (`sidebarProvider.test.ts`).
- `InlineTutor` fires `onDidScanClean` exactly once per flagged-to-clean
  transition, and not while the file is still flagged
  (`inlineTutor.test.ts`).
- `postScanClean` adds and then removes the celebration class.

Not automatable, and therefore listed for the human pass rather than claimed:

- That the motion reads as smooth rather than busy over a long session.
- That the palette looks right on a real display.
- Font rendering and the actual VSIX size delta.
- `prefers-reduced-motion` actually honoured by the OS toggle.

## Risks

- **The panel updates constantly.** The focus restraint above is the mitigation;
  if it is got wrong the panel will feel worse than the version being replaced,
  not better.
- **Bundled fonts double the package.** Acceptable, but the implementation must
  report the real number rather than the estimate here.
- **High contrast is gone.** Stated above. No mitigation by design.
- **`--card-lit` is unmeasured.** It is the one colour in the palette without a
  verified ratio.
