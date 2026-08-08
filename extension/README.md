# EduPeer

A Socratic tutor for people learning to program. EduPeer reads the file you are
working on and replies with a question, not a patch. It will not write your
assignment for you — that is the point.

Works with Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust and SQL.

## How it works

Ask about the code you are stuck on and EduPeer responds at hint level 1: a
question aimed at the concept you are missing. Asking the same thing again does
not get you a bigger hint. Editing the code does. The hint level advances when
you have actually tried something, so the tutor stays ahead of you rather than
handing you the answer on the second prompt.

Alongside the chat panel:

- **Inline nudges** — a hint beside the line you are editing (`Ctrl+Alt+H`,
  `Cmd+Alt+H` on Mac).
- **File scan** — suspicious lines flagged in the Problems panel and the gutter.
- **Trace and predict** — step through what a selection actually does, or commit
  to an answer before you run it.
- **Progress dashboard** — which concepts keep needing deep hints, and how well
  your confidence lines up with your results.

## Getting started

1. Install the extension and open the EduPeer view in the activity bar.
2. Sign in (**EduPeer: Sign In**). Progress, badges and streaks are tied to your
   account; without signing in you get a local-only session.
3. Open a file you are stuck on and ask.

The **Get started with EduPeer** walkthrough opens automatically on first run.

## Commands

| Command | What it does |
| --- | --- |
| `EduPeer: Open Tutor Panel` | Focus the chat sidebar |
| `EduPeer: Analyse Selection` | Ask about the selected code |
| `EduPeer: Nudge Current Line` | Hint for the line under the cursor |
| `EduPeer: Scan File for Issues` | Flag suspicious lines |
| `EduPeer: Explain This Error` | Work through an error message |
| `EduPeer: Explain This Construct` | Explain the selected syntax |
| `EduPeer: Predict the Output` | Commit to an answer, then check it |
| `EduPeer: Trace This Code` | Step through execution |
| `EduPeer: Reflection Quiz on My Fix` | Check you understood your own fix |
| `EduPeer: Show My Progress` | Open the progress dashboard |
| `EduPeer: Set Learning Goal` | Set what you are working towards |
| `EduPeer: Reset Session` | Start the hint ladder over |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `edupeer.backendUrl` | `https://edupeer-backend.onrender.com` | Backend address. Point at `http://localhost:8000` to use your own. |
| `edupeer.inlineHints` | `true` | Hints beside the current line |
| `edupeer.autoScan` | `true` | Scan the file and flag lines automatically |
| `edupeer.debounceMs` | `1800` | Idle time before asking for a line hint |

## Privacy

The code in your active file, and what you type in the chat, are sent to the
EduPeer backend, which passes them to Groq for inference. Interaction history
and badges are stored in Firestore against your account. Do not use EduPeer on
code you cannot share.

Running your own backend keeps that data under your control — the server is in
[the same repository](https://github.com/IbrahimSaif197/ai-educative-peer), and
`edupeer.backendUrl` points wherever you host it.

## Licence

GPL-3.0-or-later. Source at
[github.com/IbrahimSaif197/ai-educative-peer](https://github.com/IbrahimSaif197/ai-educative-peer).
