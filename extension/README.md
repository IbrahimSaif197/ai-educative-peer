# EduPeer

A Socratic tutor for people learning to program. EduPeer reads the block you
are working on and replies with a question, not a patch. It will not write your
assignment for you — that is the point.

Works with Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust and SQL.

## How it works

Ask about the code you are stuck on and EduPeer answers at rung 1: a question
aimed at the concept you are missing. Asking the same thing again does not get
you a bigger hint. Editing the code does, and so does telling it what you tried.
The depth advances when you have actually attempted something, so the tutor
stays ahead of you rather than handing over the answer on the second prompt.

There are four rungs, and the fourth is different in kind. Rungs 1–3 are
questions that get more specific: first the concept, then the line, then the
shape of the fix with the answer left out of it. Rung 4 is a worked example —
the deepest help there is, and the panel says so rather than pretending there
is a fifth. If you would rather just be told, ask outright; that is a supported
path and it ends the thread honestly instead of pretending to teach.

Alongside the chat panel:

- **Inline nudges** — a hint beside the line you are editing (`Ctrl+Alt+H`,
  `Cmd+Alt+H` on Mac).
- **Block scan** — suspicious lines flagged in the Problems panel and the
  gutter, for the block you are in rather than the whole file.
- **Trace and predict** — step through what a selection actually does, or
  commit to an answer before you run it.
- **Progress dashboard** — which concepts keep needing deep hints, your streak,
  and when a spaced review is due.

## Getting started

1. Install the extension and open the EduPeer view in the activity bar.
2. Sign in (**EduPeer: Sign In**, or the button in the panel). Progress, badges
   and streaks are tied to your account; without signing in you get a
   local-only session, and the panel says so.
3. Open a file you are stuck on and ask.

A **Get started with EduPeer** walkthrough is available from VS Code's Welcome
page.

## Commands

| Command | What it does |
| --- | --- |
| `EduPeer: Open Tutor Panel` | Focus the chat sidebar |
| `EduPeer: Analyse Selection` | Ask about the selected code |
| `EduPeer: Nudge Current Line` | Hint for the line under the cursor |
| `EduPeer: Scan This Block` | Flag suspicious lines in the block you are in |
| `EduPeer: Explain This Error` | Work through an error message |
| `EduPeer: Explain This Construct` | Explain the selected syntax |
| `EduPeer: Predict the Output` | Commit to an answer, then check it |
| `EduPeer: Trace This Code` | Step through execution — select the code first |
| `EduPeer: Reflection Quiz on My Fix` | Check you understood your own fix |
| `EduPeer: Show My Progress` | Open the progress dashboard |
| `EduPeer: Set Learning Goal` | Set what you are working towards |
| `EduPeer: Reset Session` | Clear the conversation and start at rung 1 |
| `EduPeer: Sign In` / `EduPeer: Sign Out` | Manage your account |

Four more commands exist but take arguments and are only reachable from the
things that use them — the CodeLens entries above your code, and the Quick
Fixes on EduPeer's own diagnostics.

## Settings

Everything except the backend address is also a live control in the panel:
click your avatar in the top-right corner. Changes take effect immediately.

| Setting | Default | |
| --- | --- | --- |
| `edupeer.backendUrl` | `https://edupeer-backend.onrender.com` | Backend address. Point at `http://localhost:8000` to use your own. |
| `edupeer.inlineHints` | `true` | Lenses, underlines and ghost text in the editor |
| `edupeer.autoScan` | `true` | Scan the block as you type, and flag suspicious lines without being asked |
| `edupeer.lensMode` | `"top8"` | Which "ask about this line" entries appear: the eight biggest definitions plus one entry at the top of the file for the rest, or `"flagged"` for only the lines EduPeer has actually flagged |
| `edupeer.debounceMs` | `1800` | Idle time before asking for a line hint |

## Privacy

**Your whole file is not sent.** What leaves your machine is a digest of at
most 120 lines: the block you are working on, your imports and module-level
constants, the class or function enclosing you, and the signature lines of
nearby definitions — with the real line numbers attached so the reply can cite
them. Everything else stays where it is.

That digest, and what you type in the chat, go to the EduPeer backend, which
passes them to **Anthropic** for inference (Claude Haiku 4.5). Interaction
history, badges and streaks are stored in Firestore against your account.

One thing is deliberately not capped: a **Trace This Code** selection travels
whole, because a desk-check over an abridged block would have holes in it.
That is why the command asks you to select the code first — the bound is put
in your hand.

**EduPeer never writes to your code.** Not a formatter, not a fix, not a
comment. Until 1.7.1 there was one exception — a setting that tidied away
`bug:` marker comments once a block scanned clean — and it was removed because
nothing but the bundled demo files ever carries those. There is now no code
path in the extension that edits a file, and a test scans the source to keep it
that way.

Do not use EduPeer on code you cannot share.

Running your own backend keeps that data under your control — the server is in
[the same repository](https://github.com/IbrahimSaif197/ai-educative-peer), and
`edupeer.backendUrl` points wherever you host it.

## Accessibility

The panel follows your VS Code theme, including both high-contrast themes. It
carries no emoji: a screen reader reading out "light bulb" or "fire" is reading
something the words already say. Colour never carries meaning on its own —
every state that has a hue also has a word, a shape, or both. With reduced
motion switched on, nothing that only exists as movement is simply removed;
each has a still version that can still be seen.

## Licence

GPL-3.0-or-later. Source at
[github.com/IbrahimSaif197/ai-educative-peer](https://github.com/IbrahimSaif197/ai-educative-peer).
