# EduPeer Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the EduPeer sidebar's theme-derived styling with its own brand identity and a motion system, so the panel matches the sign-in page and stops reading as chrome.

**Architecture:** `extension/media/style.css` swaps its VS Code theme tokens for the sign-in page's palette and two bundled `woff2` faces. The hint ladder moves out of the composer into each tutor card. Two new webview messages (`streak`, `cursor`) and one new extension event (`onDidScanClean`) supply the data the new surfaces need. All motion is CSS transitions and keyframes driven by class toggles; no animation library.

**Tech Stack:** Vanilla CSS and JS in a VS Code webview under a strict CSP, TypeScript extension host, Jest with a hand-written `vscode` mock at `extension/src/__mocks__/vscode.ts`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-09-edupeer-panel-redesign-design.md`.
- Extension tests live in `extension/src/__tests__/*.test.ts` and run with `npm test` from `extension/`. **686 tests pass before this plan starts.**
- `media/main.js` runs under CSP: build DOM with `createElement`/`textContent`, **never `innerHTML`**, no inline `on*=` attributes, no `eval`. This is a security property.
- Fonts are bundled and served from the extension directory. **Never** add a CDN to the CSP.
- Every animation drives `transform` and `opacity` only, except `background-color` on the ladder dots and `box-shadow` on the cards. **No `height`, `width`, `top` or `left` is ever animated** — those trigger layout.
- Signature easing `cubic-bezier(0.34, 1.26, 0.64, 1)`. Durations: quick `140ms`, standard `240ms`, slow `420ms`. Entrance is always rise 8px + fade from below. Exits are shorter than entrances.
- `prefers-reduced-motion: reduce` collapses durations to `0.01ms`, **not** `animation: none` — `animationend` handlers must still fire.
- `.vscodeignore` does **not** exclude `media/**`, so `media/fonts/` ships with no change to it. Do not add one.
- Never add a Claude co-author trailer to commits.

---

## File Structure

**Create**
- `extension/media/fonts/bricolage-grotesque-700-latin.woff2` — display face.
- `extension/media/fonts/geist-latin.woff2` — variable body face, covers 400–600.
- `extension/media/fonts/LICENSE.md` — SIL OFL 1.1 text, required to ship with both.

**Modify**
- `extension/media/style.css` — the bulk. 852 lines today.
- `extension/media/main.js` — ladder dots per card, streak chip, `cursor` handling, celebration trigger.
- `extension/src/sidebarProvider.ts` — CSP, HTML, `postStreak`, `postScanClean`, the `cursor` message.
- `extension/src/inlineTutor.ts` — `onDidScanClean` emitter.
- `extension/src/extension.ts` — wire streak and clean-scan into the provider.
- `extension/package.json`, `extension/CHANGELOG.md` — release.

---

## Task 1: Fonts, brand tokens and the CSP

**Files:**
- Create: `extension/media/fonts/bricolage-grotesque-700-latin.woff2`, `extension/media/fonts/geist-latin.woff2`, `extension/media/fonts/LICENSE.md`
- Modify: `extension/media/style.css:12-51` (the `:root` block), `extension/src/sidebarProvider.ts:683`
- Test: `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Produces: the CSS custom properties every later task uses — `--ground`, `--card`, `--card-lit`, `--line`, `--muted`, `--ink`, `--coral`, `--coral-ink`, `--mint`, `--display`, `--sans`, `--mono`.

- [ ] **Step 1: Download the fonts**

These exact URLs were verified. Run from the repo root:

```bash
mkdir -p extension/media/fonts
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
lat() { awk '/^\/\* latin \*\//{f=1} f && /https:/{gsub(/.*url\(/,"");gsub(/\).*/,"");print;exit}' "$1"; }
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700&display=swap" -o /tmp/br.css
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap" -o /tmp/g.css
curl -s -o extension/media/fonts/bricolage-grotesque-700-latin.woff2 "$(lat /tmp/br.css)"
curl -s -o extension/media/fonts/geist-latin.woff2 "$(lat /tmp/g.css)"
```

Verify both are real woff2 — the first four bytes must be `774f4632` (`wOF2`):

```bash
for f in extension/media/fonts/*.woff2; do echo "$f $(head -c4 "$f" | xxd -p)"; done
```

Expected sizes: Bricolage ~21.9 KB, Geist ~28.7 KB. If either is under 1 KB the download returned an error page — stop and report rather than committing it.

- [ ] **Step 2: Add the licence**

Both faces are SIL Open Font License 1.1, which requires the licence to ship with the font. Fetch the canonical text:

```bash
curl -s -o extension/media/fonts/OFL.txt https://openfontlicense.org/documents/OFL.txt
head -3 extension/media/fonts/OFL.txt
```

If that returns anything other than the OFL text, stop and report — do not ship the fonts without it.

Then write `extension/media/fonts/LICENSE.md`:

```markdown
# Bundled fonts

Both faces are used under the SIL Open Font License 1.1. The full licence text
is in `OFL.txt` in this directory.

- **Bricolage Grotesque** (700, latin subset) — Copyright the Bricolage
  Grotesque Project Authors. https://github.com/googlefonts/bricolage
- **Geist** (variable, latin subset) — Copyright Vercel, Inc.
  https://github.com/vercel/geist-font

Subsets were taken from the Google Fonts CDN and are shipped locally so the
webview renders with no network access.
```

- [ ] **Step 3: Write the failing test for the CSP**

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
describe("EduPeerSidebarProvider — webview CSP", () => {
  it("allows fonts from the extension, and nothing else", async () => {
    const { html } = await setupProvider(); // returns the resolved webview html
    const csp = /content="([^"]*)"/.exec(html)![1];

    expect(csp).toContain("font-src");
    // Scoped to the extension's own directory, never a CDN.
    expect(csp).not.toContain("https://fonts.gstatic.com");
    expect(csp).not.toContain("https://fonts.googleapis.com");
    expect(csp).toContain("default-src 'none'");
  });
});
```

If `setupProvider` does not already expose the resolved HTML, read the file's existing helper and extend it to return `view.webview.html`; do not write a second helper.

- [ ] **Step 4: Run it and watch it fail**

Run: `cd extension && npx jest src/__tests__/sidebarProvider.test.ts -t "webview CSP"`
Expected: FAIL — the CSP has no `font-src`.

- [ ] **Step 5: Add `font-src` to the CSP**

In `extension/src/sidebarProvider.ts:683`:

```ts
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
```

- [ ] **Step 6: Replace the token block**

In `extension/media/style.css`, replace the whole `:root { … }` block (lines 12-51) with:

```css
/* EduPeer sidebar.
 *
 * This panel has its own identity rather than deriving from the workbench
 * theme, so it matches the hosted sign-in page. The consequence is recorded
 * in the spec: VS Code's high-contrast themes no longer affect this panel.
 *
 * The one exception is the code preview, which keeps the editor's own
 * monospace face. It shows the student's code; rendering that in a UI face
 * would be worse, not braver.
 */

@font-face {
  font-family: "Bricolage Grotesque";
  src: url("fonts/bricolage-grotesque-700-latin.woff2") format("woff2");
  font-weight: 700;
  font-display: swap;
}

@font-face {
  font-family: "Geist";
  src: url("fonts/geist-latin.woff2") format("woff2");
  font-weight: 400 600;
  font-display: swap;
}

:root {
  color-scheme: dark;

  /* Surfaces */
  --ground: #12101B;
  --card: #1B1826;
  --card-lit: #221E30;

  /* Lines */
  --line: #6D6198;
  --line-soft: #2E2940;

  /* Ink */
  --ink: #F2EFFA;
  --muted: #9C93B8;
  --coral: #FF6B4A;
  --coral-lit: #FF8366;
  /* Foreground for text sitting on --coral. */
  --coral-ink: #1A0A05;
  --mint: #7CE0D3;
  --warn: #FFC46B;
  --danger: #FF8E7A;

  /* Space — a 4px rhythm */
  --s1: 2px;
  --s2: 4px;
  --s3: 6px;
  --s4: 8px;
  --s5: 12px;
  --s6: 16px;
  --s7: 24px;

  /* Type — anchored to the workbench size so it tracks the user's zoom */
  --t-micro: calc(var(--vscode-font-size, 13px) * 0.72);
  --t-small: calc(var(--vscode-font-size, 13px) * 0.82);
  --t-body: calc(var(--vscode-font-size, 13px) * 0.94);
  --t-lead: var(--vscode-font-size, 13px);
  --t-display: calc(var(--vscode-font-size, 13px) * 1.7);

  --radius-sm: 3px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-pill: 999px;

  --display: "Bricolage Grotesque", var(--vscode-font-family), sans-serif;
  --sans: "Geist", var(--vscode-font-family), sans-serif;
  --mono: var(--vscode-editor-font-family, ui-monospace, "Cascadia Mono", Consolas, monospace);
}
```

Then change `body`'s `font-family` from `var(--vscode-font-family)` to `var(--sans)`, and its `background` to `var(--ground)`.

- [ ] **Step 7: Measure `--card-lit`**

The spec requires this: `--card-lit` is the one colour without a verified contrast ratio. Compute it with the standard WCAG formula (sRGB → linear → relative luminance → `(L1+0.05)/(L2+0.05)`), for `--ink` on `--card-lit` and `--muted` on `--card-lit`. Both must clear 4.5:1. Record both figures in your report. If either fails, lighten `--ink`/`--muted` or darken `--card-lit` until it passes and report what you changed.

- [ ] **Step 8: Run the suite**

Run: `cd extension && npm test`
Expected: PASS, 687 tests (686 + the CSP test). Existing tests do not assert on colours, so nothing else should move.

- [ ] **Step 9: Commit**

```bash
git add extension/media/fonts extension/media/style.css extension/src/sidebarProvider.ts extension/src/__tests__/sidebarProvider.test.ts
git commit -m "Give the panel its own palette and faces instead of the workbench's"
```

---

## Task 2: Motion tokens, reduced motion, and the entrance

**Files:**
- Modify: `extension/media/style.css` (`:root`, `.turn`)
- Test: none automatable; see the note in Step 4.

**Interfaces:**
- Consumes: the tokens from Task 1.
- Produces: `--ease-signature`, `--ease-exit`, `--ease-loop`, `--t-quick`, `--t-standard`, `--t-slow`, and the `.turn` entrance every later surface reuses.

- [ ] **Step 1: Add the motion tokens**

Append inside `:root` in `extension/media/style.css`:

```css
  /* Motion. One signature curve carries about 80% of the panel; the overshoot
     is small enough to read as warm rather than as a toy in a tool you stare
     at all day. Amplitude is governed by frequency, not by importance: the
     rare rewarding moments get overshoot, anything that fires on a keystroke
     does not. */
  --ease-signature: cubic-bezier(0.34, 1.26, 0.64, 1);
  --ease-exit: cubic-bezier(0.3, 0, 1, 1);
  --ease-loop: cubic-bezier(0.4, 0, 0.6, 1);
  --t-quick: 140ms;
  --t-standard: 240ms;
  --t-slow: 420ms;
```

- [ ] **Step 2: Add the reduced-motion block**

Append at the very end of `extension/media/style.css`:

```css
/* Reduced motion means no movement, not no feedback: the ladder dots still
   fill, the sweep still tints, banners still appear. Durations collapse
   rather than animations being removed, so `animationend` handlers still
   fire and nothing waits forever on an event that never arrives. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 3: Give turns the entrance**

In `extension/media/style.css`, add to the `.turn` rule:

```css
.turn {
  /* … existing declarations stay … */
  animation: turn-in var(--t-standard) var(--ease-signature) both;
}

@keyframes turn-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

- [ ] **Step 4: Verify by eye, and say so**

There is no renderer in this environment and jsdom does not compute animations, so this task has no automated test and you must not invent one. Run `cd extension && npm test` to confirm nothing regressed (687 tests), and add to your report a line for the human checklist: *"turns rise into place rather than appearing; the movement is 8px, not a slide."*

- [ ] **Step 5: Commit**

```bash
git add extension/media/style.css
git commit -m "Add the motion identity: one signature curve, three durations, one entrance"
```

---

## Task 3: Tutor cards and student bubbles

**Files:**
- Modify: `extension/media/style.css` (`.turn--tutor`, `.turn--student`, `.empty`, `.signin`)
- Test: `extension/src/__tests__/webviewMain.test.ts`

**Interfaces:**
- Consumes: Task 1 tokens, Task 2 entrance.

- [ ] **Step 1: Replace the tutor rule**

The current `.turn--tutor` is a left-margin hairline. Replace it with a card:

```css
/* The tutor speaks from a card now, not a margin rule. The old treatment was
   the single biggest reason the panel read as chrome. */
.turn--tutor {
  background: var(--card);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  padding: var(--s5);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
  /* The shadow arrives after the card lands, which is what stops the entrance
     reading as a single flat slab moving. */
  transition: box-shadow var(--t-standard) var(--ease-signature) 60ms,
    border-color var(--t-quick) linear;
}

.turn--tutor:hover {
  border-color: var(--line);
}
```

- [ ] **Step 2: Replace the student rule**

```css
/* The student's own words: a filled coral bubble, right-aligned, so the
   transcript reads as a conversation rather than a log. */
.turn--student {
  align-self: flex-end;
  max-width: 85%;
  background: var(--coral);
  color: var(--coral-ink);
  border-radius: var(--radius-lg) var(--radius-lg) var(--radius-sm) var(--radius-lg);
  padding: var(--s4) var(--s5);
}
```

Keep whatever existing `.turn--student` declarations govern text wrapping.

- [ ] **Step 3: Give the placeholders the display face**

```css
.empty strong,
.signin strong {
  display: block;
  font-family: var(--display);
  font-size: var(--t-display);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--ink);
}
```

- [ ] **Step 4: Confirm the markup still matches**

The tests in `webviewMain.test.ts` assert on `.empty` and `.signin` existing and on their text. Run:

Run: `cd extension && npm test`
Expected: PASS, 687. If a test fails on structure rather than style, the CSS changed something the markup depends on — fix the CSS, not the test.

- [ ] **Step 5: Commit**

```bash
git add extension/media/style.css
git commit -m "Make the tutor speak from a card and the student from a bubble"
```

---

## Task 4: The hint ladder moves into the card

**Files:**
- Modify: `extension/src/sidebarProvider.ts:746-753` (remove `#stepper`), `extension/media/main.js` (`setLevel`, `holdLevel`, `buildTurn`), `extension/media/style.css`
- Test: `extension/src/__tests__/webviewMain.test.ts`

**Interfaces:**
- Produces: a `.ladder` element inside each tutor turn whose filled-dot count equals the hint level.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/webviewMain.test.ts`:

```ts
describe("webview — the hint ladder lives in the card", () => {
  it("renders one dot per level, filled up to the current one", () => {
    const { post, dom } = loadWebview();
    post({ type: "hint", hint: "why is it empty?", hint_level: 2, concept_tags: [], mode: "hint" });

    const dots = dom.querySelectorAll(".turn--tutor .ladder__dot");
    expect(dots).toHaveLength(3);
    expect(dom.querySelectorAll(".turn--tutor .ladder__dot.is-on")).toHaveLength(2);
  });

  it("labels the card with the level", () => {
    const { post, dom } = loadWebview();
    post({ type: "hint", hint: "h", hint_level: 3, concept_tags: [], mode: "hint" });

    expect(dom.querySelector(".turn--tutor .ladder__label").textContent).toBe("hint 3");
  });

  it("gives a non-hint turn no ladder", () => {
    const { post, dom } = loadWebview();
    post({ type: "hint", hint: "nice work", hint_level: 0, concept_tags: [], mode: "reflect" });

    expect(dom.querySelector(".ladder")).toBeNull();
  });

  it("marks the ladder held when the tutor refuses to go deeper", () => {
    const { post, dom } = loadWebview();
    post({ type: "hint", hint: "same depth", hint_level: 0, concept_tags: [], mode: "attempt-gate" });
    post({ type: "hint", hint: "why empty?", hint_level: 1, concept_tags: [], mode: "hint" });

    // The gate turn carries no ladder; the hint that follows does.
    expect(dom.querySelectorAll(".ladder")).toHaveLength(1);
  });

  it("no longer has a stepper above the composer", () => {
    const { dom } = loadWebview();
    expect(dom.querySelector("#stepper")).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd extension && npx jest src/__tests__/webviewMain.test.ts -t "hint ladder lives"`
Expected: FAIL — no `.ladder` element exists and `#stepper` still does.

- [ ] **Step 3: Remove the stepper from the HTML**

In `extension/src/sidebarProvider.ts`, delete the whole `<div class="stepper" id="stepper" hidden> … </div>` block (lines 746-753).

- [ ] **Step 4: Build the ladder in `buildTurn`**

In `extension/media/main.js`, inside `buildTurn`, after the eyebrow is appended and before the body:

```js
    // The depth belongs with the hint it describes. It used to sit pinned
    // above the composer, describing a hint that could be several turns up.
    if (turn.level >= 1) {
      const ladder = document.createElement("div");
      ladder.className = "ladder";
      const label = document.createElement("span");
      label.className = "ladder__label";
      label.textContent = `hint ${turn.level}`;
      ladder.appendChild(label);
      for (let i = 1; i <= 3; i++) {
        const dot = document.createElement("span");
        dot.className = i <= turn.level ? "ladder__dot is-on" : "ladder__dot";
        dot.style.setProperty("--dot-index", String(i - 1));
        ladder.appendChild(dot);
      }
      wrap.appendChild(ladder);
    }
```

In `handleHint`, set `level` on the turn and stop calling the stepper:

```js
    addTurn({
      role: "tutor",
      text: msg.hint,
      eyebrow: mode === "hint" ? undefined : MODE_LABEL[mode] || mode,
      level: mode === "hint" ? level : 0,
      tags: msg.concept_tags || [],
      flagged: FLAGGED_MODES.has(mode),
    });
```

Delete `setLevel`, `holdLevel`, the `stepperEl` reference, and the `setLevel(0)` call in the `resetDone` case. The eyebrow for a hint is now redundant with the ladder label, hence `undefined` above.

- [ ] **Step 5: Style the ladder**

Append to `extension/media/style.css`:

```css
/* The signature element: the product's own mechanic, on screen constantly. */
.ladder {
  display: flex;
  align-items: center;
  gap: var(--s2);
  margin-bottom: var(--s4);
}

.ladder__label {
  margin-right: var(--s2);
  font-family: var(--display);
  font-size: var(--t-small);
  font-weight: 700;
  color: var(--muted);
}

.ladder__dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--line-soft);
  transition: background-color var(--t-standard) var(--ease-signature);
}

.ladder__dot.is-on {
  background: var(--coral);
  animation: dot-fill 220ms var(--ease-signature) both;
  /* Left to right, 40ms apart: a micro cascade well inside the 200ms budget. */
  animation-delay: calc(var(--dot-index, 0) * 40ms);
}

@keyframes dot-fill {
  from {
    transform: scale(0.6);
  }
  60% {
    transform: scale(1.15);
  }
  to {
    transform: scale(1);
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd extension && npm test`
Expected: PASS. Existing tests that asserted on `#stepper` or on a `Hint 2` eyebrow must be updated to the ladder, not deleted — quote each before and after in your report and say what it protected.

- [ ] **Step 7: Commit**

```bash
git add extension/media/main.js extension/media/style.css extension/src/sidebarProvider.ts extension/src/__tests__/webviewMain.test.ts
git commit -m "Move the hint ladder into the card that owns it"
```

---

## Task 5: The streak chip

**Files:**
- Modify: `extension/src/sidebarProvider.ts` (HTML + `postStreak`), `extension/src/extension.ts:69-75`, `extension/media/main.js`, `extension/media/style.css`
- Test: `extension/src/__tests__/webviewMain.test.ts`, `extension/src/__tests__/sidebarProvider.test.ts`

**Interfaces:**
- Produces: `sidebarProvider.postStreak(days: number): void`, posting `{ type: "streak", days }`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/webviewMain.test.ts`:

```ts
describe("webview — streak chip", () => {
  it("shows the streak when there is one", () => {
    const { post, dom } = loadWebview();
    post({ type: "streak", days: 4 });

    const chip = dom.querySelector("#streakChip");
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain("4");
  });

  it("hides the chip at zero rather than showing a zero", () => {
    const { post, dom } = loadWebview();
    post({ type: "streak", days: 0 });

    expect(dom.querySelector("#streakChip").hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd extension && npx jest src/__tests__/webviewMain.test.ts -t "streak chip"`
Expected: FAIL — `#streakChip` does not exist.

- [ ] **Step 3: Add the chip to the HTML**

In `extension/src/sidebarProvider.ts`, in the `topbar__row`, immediately after the `brand` span:

```html
      <span id="streakChip" class="streak" hidden><span aria-hidden="true">🔥</span><span id="streakDays">0</span></span>
```

- [ ] **Step 4: Add `postStreak`**

In `extension/src/sidebarProvider.ts`, beside `postOffline`:

```ts
  /**
   * Mirror the practice streak into the panel. The value comes from the same
   * progress call the status bar already makes, so this costs no extra
   * request.
   */
  public postStreak(days: number): void {
    this.post({ type: "streak", days });
  }
```

- [ ] **Step 5: Handle it in the webview**

In `extension/media/main.js`, add the refs beside the others and a case in the message switch:

```js
      case "streak": {
        const days = Number(msg.days) || 0;
        streakDaysEl.textContent = String(days);
        streakChipEl.hidden = days <= 0;
        break;
      }
```

- [ ] **Step 6: Wire the extension host**

In `extension/src/extension.ts`, inside `refreshStatusFromProgress` where `statusBar.update({ … })` already receives `progress.streak_days`, add:

```ts
      provider.postStreak(progress.streak_days);
```

- [ ] **Step 7: Style it**

```css
.streak {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  padding: var(--s1) var(--s3);
  border-radius: var(--radius-pill);
  background: var(--card-lit);
  font-family: var(--display);
  font-size: var(--t-small);
  font-weight: 700;
  color: var(--ink);
}
```

- [ ] **Step 8: Run the suite and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/media/main.js extension/media/style.css extension/src/sidebarProvider.ts extension/src/extension.ts extension/src/__tests__/webviewMain.test.ts
git commit -m "Show the practice streak in the panel, from data the status bar already fetches"
```

---

## Task 6: The clean-scan celebration

**Files:**
- Modify: `extension/src/inlineTutor.ts` (emitter), `extension/src/extension.ts`, `extension/src/sidebarProvider.ts`, `extension/media/main.js`, `extension/media/style.css`
- Test: `extension/src/__tests__/inlineTutor.test.ts`, `extension/src/__tests__/webviewMain.test.ts`

**Interfaces:**
- Produces: `InlineTutor.onDidScanClean: vscode.Event<void>` and `sidebarProvider.postScanClean(): void` posting `{ type: "scanClean" }`.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/inlineTutor.test.ts`, inside the "stripping fixed bug markers" describe (it already has the flagged-then-clean helper):

```ts
  it("announces the clean scan exactly once per transition", async () => {
    const api = makeApi({ scanCode: flaggedThenClean() });
    const { tutor } = setupMarked(api);
    let announced = 0;
    tutor.onDidScanClean(() => announced++);

    await mock.__runCommand("edupeer.scanFile");
    expect(announced).toBe(0); // still flagged

    await mock.__runCommand("edupeer.scanFile");
    expect(announced).toBe(1);
  });
```

Append to `extension/src/__tests__/webviewMain.test.ts`:

```ts
describe("webview — clean scan celebration", () => {
  it("adds the celebration class and then takes it off again", () => {
    jest.useFakeTimers();
    const { post, dom } = loadWebview();

    post({ type: "scanClean" });
    expect(dom.body.classList.contains("is-celebrating")).toBe(true);

    jest.advanceTimersByTime(1000);
    expect(dom.body.classList.contains("is-celebrating")).toBe(false);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `cd extension && npx jest src/__tests__/inlineTutor.test.ts src/__tests__/webviewMain.test.ts -t "clean"`
Expected: FAIL — `onDidScanClean` is not a function; `is-celebrating` never appears.

- [ ] **Step 3: Add the emitter**

In `extension/src/inlineTutor.ts`, beside the existing `emitter` field:

```ts
  /**
   * Fires when a file goes from flagged to clean. The sidebar is a different
   * object and the two do not talk, so this follows the same pattern the
   * sidebar already uses for the hint level.
   */
  private readonly cleanEmitter = new vscode.EventEmitter<void>();
  readonly onDidScanClean = this.cleanEmitter.event;
```

Push it into `this.disposables` in `activate()` next to `this.disposables.push(this.emitter)`, and fire it in `maybeOfferReflection` immediately after the existing `void this.removeFixedBugMarkers(doc);`:

```ts
    this.cleanEmitter.fire();
```

- [ ] **Step 4: Add `postScanClean` and wire it**

In `extension/src/sidebarProvider.ts`:

```ts
  /** A file just went clean. The panel marks the moment. */
  public postScanClean(): void {
    this.post({ type: "scanClean" });
  }
```

In `extension/src/extension.ts`, beside the other `context.subscriptions.push` calls:

```ts
  context.subscriptions.push(inlineTutor.onDidScanClean(() => provider.postScanClean()));
```

- [ ] **Step 5: Handle it in the webview**

```js
      case "scanClean":
        document.body.classList.add("is-celebrating");
        setTimeout(() => document.body.classList.remove("is-celebrating"), 900);
        break;
```

- [ ] **Step 6: Style the sweep**

```css
/* The payoff. Three layers: a mint band travelling the top edge, the streak
   chip popping as the band passes it, and the ground lifting briefly. Once,
   then gone. */
body.is-celebrating::before {
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--mint), transparent);
  transform: translateX(-100%);
  animation: sweep 600ms var(--ease-loop) both;
  pointer-events: none;
  z-index: 10;
}

body.is-celebrating {
  animation: ground-lift 400ms var(--ease-loop) both;
}

body.is-celebrating .streak {
  animation: chip-pop 300ms var(--ease-signature) 200ms both;
}

@keyframes sweep {
  to {
    transform: translateX(100%);
  }
}

@keyframes ground-lift {
  50% {
    background: var(--card);
  }
}

@keyframes chip-pop {
  50% {
    transform: scale(1.12);
  }
}
```

- [ ] **Step 7: Run the suite and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/src extension/media extension/src/__tests__
git commit -m "Mark the moment a file goes clean"
```

---

## Task 7: The cursor message and the focus restraint

**Files:**
- Modify: `extension/src/sidebarProvider.ts` (`sendFocus`), `extension/media/main.js`, `extension/media/style.css`
- Test: `extension/src/__tests__/sidebarProvider.test.ts`, `extension/src/__tests__/webviewMain.test.ts`

**Interfaces:**
- Produces: the `{ type: "cursor", cursorLine }` message.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/__tests__/sidebarProvider.test.ts`:

```ts
describe("EduPeerSidebarProvider — cursor vs focus", () => {
  it("posts cursor, not focus, when only the cursor line moved", async () => {
    // Same document, same version, same block: the focus signature is
    // unchanged, so the panel would otherwise never learn the cursor moved.
    const { provider, posted, doc } = await setupProvider(TWO_LINE_BLOCK, 0);
    await provider["sendFocus"]();
    posted.length = 0;

    moveCursor(doc, 1);
    await provider["sendFocus"]();

    expect(posted.map((m: any) => m.type)).toEqual(["cursor"]);
    expect(posted[0].cursorLine).toBe(2);
  });

  it("posts focus when the block changed", async () => {
    const { provider, posted } = await setupProvider(TWO_FUNCTIONS, 1);
    await provider["sendFocus"]();
    posted.length = 0;

    moveCursorToSecondFunction();
    await provider["sendFocus"]();

    expect(posted.map((m: any) => m.type)).toContain("focus");
  });
});
```

Use the file's existing helpers for building the provider and moving the cursor; add fixtures only where none exists.

Append to `extension/src/__tests__/webviewMain.test.ts`:

```ts
describe("webview — cursor moves without re-rendering", () => {
  it("moves the marker and leaves the code rows alone", () => {
    const { post, dom } = loadWebview();
    post({
      type: "focus", focusCode: "a\nb\nc", breadcrumb: "demo.py › f",
      startLine: 1, endLine: 3, cursorLine: 1,
      fileName: "/tmp/demo.py", language: "Python", totalLines: 3,
    });
    const before = dom.querySelectorAll(".ln")[0];

    post({ type: "cursor", cursorLine: 3 });

    expect(dom.querySelectorAll(".ln.is-cursor")).toHaveLength(1);
    expect(dom.querySelectorAll(".ln.is-cursor")[0].textContent).toContain("c");
    // Same node: the rows were not rebuilt.
    expect(dom.querySelectorAll(".ln")[0]).toBe(before);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd extension && npx jest src/__tests__/sidebarProvider.test.ts src/__tests__/webviewMain.test.ts -t "cursor"`
Expected: FAIL — no `cursor` message is ever posted.

- [ ] **Step 3: Post the cursor message**

In `extension/src/sidebarProvider.ts`'s `sendFocus`, replace the early return at the suppression check:

```ts
    if (!opts.force && signature === this.lastFocusSignature) {
      // The block is unchanged, so the panel does not need re-rendering — but
      // the cursor may still have moved inside it, and the marker has to
      // follow. A full focus post here would put the whole file back on the
      // wire on every keystroke, which is what the signature exists to stop.
      const cursorLine = editor.selection.active.line + 1;
      if (cursorLine !== this.lastCursorLine) {
        this.lastCursorLine = cursorLine;
        this.post({ type: "cursor", cursorLine });
      }
      return;
    }
    this.lastCursorLine = editor.selection.active.line + 1;
```

Add the field beside `lastFocusSignature`:

```ts
  /** Last cursor line posted, 1-based. Suppresses repeat cursor messages. */
  private lastCursorLine = 0;
```

Reset it to `0` in `resolveWebviewView` alongside `lastFocusSignature`, and in the no-editor branch of `sendFocus`.

- [ ] **Step 4: Move the marker in the webview**

```js
      case "cursor": {
        const line = Number(msg.cursorLine) || 0;
        cursorLine = line;
        const rows = codeEl.querySelectorAll(".ln");
        rows.forEach((row) => {
          const no = row.querySelector(".ln__no");
          row.classList.toggle("is-cursor", !!no && Number(no.textContent) === line);
        });
        break;
      }
```

- [ ] **Step 5: Make the marker slide**

```css
/* The one thing that moves when the cursor moves inside a block. Everything
   else holds still: this fires on every keystroke and a panel that redraws
   itself that often is a panel nobody can read. */
.ln {
  transition: background-color var(--t-quick) linear;
}

.ln::before {
  content: "";
  position: absolute;
  left: 0;
  width: 2px;
  height: 100%;
  background: var(--coral);
  opacity: 0;
  transition: opacity 180ms var(--ease-signature);
}

.ln.is-cursor::before {
  opacity: 1;
}
```

`.ln` needs `position: relative` for this; add it if the existing rule lacks it.

- [ ] **Step 6: Run the suite and commit**

Run: `cd extension && npm test`
Expected: PASS.

```bash
git add extension/src extension/media extension/src/__tests__
git commit -m "Move the cursor marker without redrawing the block around it"
```

---

## Task 8: Composer, controls and banners

**Files:**
- Modify: `extension/media/style.css` (`.btn`, `.conf`, `textarea`, `.banner`, `.thinking`, `.chip`, `.tag`, `.badge`, `.filecard`, `.trace`)
- Test: none automatable beyond the existing suite.

- [ ] **Step 1: Restyle the controls**

Replace the button, input, confidence-pill, banner, thinking and chip rules so they use the brand tokens and the motion identity. The complete replacement block:

```css
.btn {
  font-family: var(--sans);
  font-size: var(--t-small);
  color: var(--ink);
  background: var(--card-lit);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  padding: var(--s3) var(--s5);
  cursor: pointer;
  transition: background-color 90ms linear, border-color 90ms linear,
    transform var(--t-standard) var(--ease-signature);
}

.btn:hover:not(:disabled) {
  background: var(--card);
  border-color: var(--line);
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
  transition-duration: 120ms;
}

.btn--primary {
  background: var(--coral);
  border-color: transparent;
  color: var(--coral-ink);
  font-weight: 600;
}

.btn--primary:hover:not(:disabled) {
  background: var(--coral-lit);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

textarea,
input[type="text"] {
  font-family: var(--sans);
  font-size: var(--t-body);
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-md);
  padding: var(--s4);
  transition: border-color var(--t-quick) linear;
}

textarea:focus,
input[type="text"]:focus {
  border-color: var(--coral);
}

.conf {
  border-radius: var(--radius-pill);
  transition: background-color var(--t-quick) linear,
    transform 180ms var(--ease-signature);
}

.conf[aria-pressed="true"] {
  background: var(--coral);
  color: var(--coral-ink);
  border-color: transparent;
  transform: scale(1.04);
}

.banner {
  animation: banner-in var(--t-standard) var(--ease-signature) both;
}

@keyframes banner-in {
  from {
    opacity: 0;
    transform: translateY(-100%);
  }
}

.thinking__dots i {
  animation: dot-pulse 1200ms var(--ease-loop) infinite;
}

.thinking__dots i:nth-child(2) { animation-delay: 120ms; }
.thinking__dots i:nth-child(3) { animation-delay: 240ms; }

@keyframes dot-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}

.caret {
  animation: caret-blink 1s var(--ease-loop) infinite;
}

@keyframes caret-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}

/* Ambient: while the tutor is mid-sentence its card breathes very slightly,
   which says "working" without a second spinner. */
.turn__body--streaming {
  animation: streaming-breathe 2s var(--ease-loop) infinite;
}

@keyframes streaming-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.96; }
}
```

### Migrate every remaining retired token

Task 1 replaced the `:root` block, which retired `--surface`, `--surface-raised`,
`--surface-sunken`, `--accent` and `--ink-dim`. **45 references to those tokens
survive elsewhere in the file and currently resolve to nothing**, so the panel is
visually incoherent from Task 1 until this task finishes. That is expected on
this branch and must not ship.

Apply this mapping throughout `extension/media/style.css`:

| Retired | Replacement |
|---|---|
| `var(--surface)` | `var(--ground)` |
| `var(--surface-raised)` | `var(--card)` |
| `var(--surface-sunken)` | `var(--card-lit)` |
| `var(--ink-dim)` | `var(--muted)` |
| `var(--accent)` | `var(--coral)` |

Where a retired token sits as the *fallback* of a workbench token, the workbench
token goes too — this panel no longer follows the theme:

| Before | After |
|---|---|
| `var(--vscode-badge-background, var(--surface-sunken))` | `var(--card-lit)` |
| `var(--vscode-button-background, var(--accent))` | `var(--coral)` |
| `var(--vscode-focusBorder, var(--accent))` | `var(--coral)` |
| `var(--vscode-input-placeholderForeground, var(--ink-dim))` | `var(--muted)` |

The selectors carrying them, so none is missed: `.visually-hidden`,
`.brand__mark`, `.topbar__account`, `.badges__summary`, `.badge`,
`.filecard__name`, `.filecard__code`, `.filecard__range`, `.chip`, `.ln__no`,
`.ln.is-cursor`, `.empty`, `.turn__eyebrow`, `.turn--student .turn__body`,
`.turn__body code`, `.turn__body pre`, `.tag`, `.caret`, `.trace__prompt`,
`.trace__grid th`, `.trace__step`, `.trace__cell`, `.thinking`,
`.thinking__dots i`, `.composer`, and the input, button and confidence rules
below line 686.

`.stepper__*` rules are deleted outright — Task 4 removed the element.

`color-mix(in srgb, var(--accent) 45%, var(--warn))` becomes
`color-mix(in srgb, var(--coral) 45%, var(--warn))`.

- [ ] **Step 2: Verify no orphan tokens**

```bash
cd extension && grep -o -- "--vscode-[a-zA-Z-]*" media/style.css | sort -u
```

Also confirm the retired brand tokens are gone:

```bash
cd extension && grep -c -- "var(--surface\|var(--accent)\|var(--ink-dim" media/style.css
```

Expected: `--vscode-` yields exactly `--vscode-editor-font-family`,
`--vscode-font-family`, `--vscode-font-size`; the retired-token count is **0**.

This is the gate for the whole plan. A custom property with no definition and no
fallback makes its declaration invalid at computed-value time, so the property
silently falls back to its inherited or initial value — grey text on a
transparent background, with nothing in the console to say so. The test suite
cannot catch it and no agent here has a renderer.

- [ ] **Step 3: Run the suite and commit**

Run: `cd extension && npm test`
Expected: PASS, 687+.

```bash
git add extension/media/style.css
git commit -m "Bring the controls, banners and loading states onto the brand"
```

---

## Task 9: Package, measure and release

**Files:**
- Modify: `extension/package.json`, `extension/CHANGELOG.md`

- [ ] **Step 1: Compile and package**

```bash
cd extension && npm run compile && npm test && npm run package
```

- [ ] **Step 2: Report the real size**

The spec requires the actual figure, not the estimate. Compare against the 1.2.0 package:

```bash
ls -l extension/edupeer-1.2.0.vsix extension/edupeer-1.3.0.vsix
```

State both sizes and the delta in your report. The fonts are expected to add roughly 50.6 KB.

Confirm the fonts actually shipped:

```bash
cd extension && unzip -l edupeer-1.3.0.vsix | grep -c "fonts/"
```

Expected: 4 (two woff2, `OFL.txt`, `LICENSE.md`). Zero means `.vscodeignore` excluded them after all and the panel will render in a fallback face.

- [ ] **Step 3: Version and changelog**

Set `"version": "1.3.0"` in `extension/package.json`. Prepend to `extension/CHANGELOG.md`:

```markdown
## 1.3.0

- The tutor panel has been rebuilt. It has its own look now instead of
  borrowing the editor's, replies arrive in cards rather than as plain text,
  and your own messages sit in their own bubble.
- The hint depth meter moved out of the bottom of the panel and into the hint
  it describes, so you can see at a glance how deep any answer went.
- Your practice streak shows at the top, and the panel marks the moment a file
  stops being flagged.
- Everything moves now: replies rise into place, the depth dots fill as the
  tutor goes deeper, and the marker follows your cursor. If you have "reduce
  motion" turned on, the panel respects it.
- Note: this panel no longer follows your VS Code colour theme, including the
  high-contrast themes.
```

- [ ] **Step 4: Repackage at the new version and commit**

```bash
cd extension && rm -f edupeer-1.3.0.vsix && npm run package
git add extension/package.json extension/CHANGELOG.md
git commit -m "Release 1.3.0"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| A. Palette | 1 |
| A. Typography, fonts, CSP | 1 |
| A. `--card-lit` must be measured | 1 step 7 |
| B. Hint ladder moves | 4 |
| B. Streak chip + `postStreak` | 5 |
| B. Clean-scan wiring (`onDidScanClean`) | 6 |
| B. Tutor cards / student bubbles | 3 |
| B. Empty and signed-out display type | 3 |
| C. Motion identity tokens | 2 |
| C. Turn entrance | 2 |
| C. Ladder dots, streaming, thinking, buttons, banners | 4, 8 |
| C. Clean-scan celebration | 6 |
| C. Cursor restraint + new `cursor` message | 7 |
| C. Reduced motion | 2 |
| C. Performance (no layout properties) | Global Constraints |
| Testing section | tests inside 1, 4, 5, 6, 7 |
| Real VSIX size reported | 9 step 2 |

No spec requirement is unassigned. One spec statement is corrected here: the spec listed `.vscodeignore` as a file to modify, but it does not exclude `media/**`, so no change is needed. Task 9 step 2 verifies the fonts shipped rather than assuming.

**Type consistency checked:** `postStreak(days: number)` posts `{ type: "streak", days }` and the webview reads `msg.days`. `postScanClean()` posts `{ type: "scanClean" }` and the webview matches on that exact string. `onDidScanClean` is used with that name in Tasks 6's emitter, its test, and the `extension.ts` subscription. The `cursor` message carries `cursorLine` 1-based, matching `focus`'s existing convention. `turn.level` is set in `handleHint` and read in `buildTurn`.

**Known follow-up, deliberately out of scope:** `extension/src/progressPanel.ts` still uses the old theme-token styling and will look like a different product after this ships. Raised during design and excluded.
