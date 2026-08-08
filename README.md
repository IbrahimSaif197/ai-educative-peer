# EduPeer

A VS Code extension that acts as a Socratic AI tutor for novice programmers. EduPeer guides students toward solutions through progressive hints rather than generating complete code.

**Supported languages:** Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust, SQL.

The system consists of:

- **VS Code extension** (TypeScript, sidebar webview) that reads the active file and shows a chat UI.
- **FastAPI backend** that calls Groq `llama-3.3-70b-versatile` and persists interactions/badges to Firestore.
- **Firebase Firestore** for interaction logs and user badges.

## Architecture

```
edupeer/
├── extension/    VS Code extension (TypeScript)
└── backend/      FastAPI + Groq + Firestore
```

## Setup

### 1. Install Python dependencies

```bash
pip install -r backend/requirements.txt
```

To run the test suite as well, install the dev extras instead:

```bash
pip install -r backend/requirements-dev.txt
```

### 2. Install Node dependencies

```bash
cd extension && npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env` and fill in:

- `GROQ_API_KEY` — your Groq API key
- `FIREBASE_PROJECT_ID` — your Firebase project id
- `FIREBASE_PRIVATE_KEY` — the `private_key` field from your Firebase service-account JSON (keep the quotes and `\n` escaping)
- `FIREBASE_CLIENT_EMAIL` — the `client_email` from the same service-account JSON
- `FIREBASE_WEB_API_KEY` — the web-app API key from Firebase Console > Project settings > Your apps
- `FIREBASE_AUTH_DOMAIN` — your Firebase project's auth domain (e.g., `your-project.firebaseapp.com`)

The extension gets the backend address from the `edupeer.backendUrl` VS Code
setting (default `http://localhost:8000`), not from the environment.

### 4. Run the backend

```bash
cd backend && uvicorn main:app --reload
```

The API is now at `http://localhost:8000`. Health check: `GET /health`.

Note that `edupeer.backendUrl` now defaults to the hosted backend, so for local
development set it back to `http://localhost:8000` in your VS Code settings.

### 5. Run the extension

1. Open the repository root (`ai-educative-peer`) in VS Code — the shipped
   `.vscode/launch.json` resolves `${workspaceFolder}/extension`, so opening
   the `extension/` folder directly will not find it.
2. Press `F5` to launch an Extension Development Host. The `npm: compile`
   pre-launch task builds `extension/out/` first.
3. In the new window open any supported file (`.py`, `.js`, `.ts`, `.java`, `.c`, `.cpp`, `.cs`, `.go`, `.rs`, `.sql`) — the `demos/` folder has a buggy sample for each language.
4. Click the **EduPeer** icon in the Activity Bar, or run `EduPeer: Open Tutor Panel` from the command palette.

### Adjusting the inline hint (CodeLens) font size

The "Get a hint" prompts and the 🤔 questions that appear above your code are
rendered as VS Code CodeLenses. To make them larger (handy for presentations or
projectors), change the editor's CodeLens font size:

- Open Settings (`Ctrl+,` / `Cmd+,`), search for **CodeLens Font Size**, and set
  a value such as `16`, **or**
- add this to your VS Code `settings.json`:

  ```json
  "editor.codeLensFontSize": 16
  ```

This repo already ships `.vscode/settings.json` with `editor.codeLensFontSize`
set to `16`.

## Commands

| Command                         | Description                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| `edupeer.activate`              | Opens the EduPeer sidebar panel.                                   |
| `edupeer.analyseSelection`      | Right-click selected code → sends it with "What is wrong…".        |
| `edupeer.resetSession`          | Clears chat history and resets hint level to 1.                    |
| `edupeer.signIn`                | Opens the browser to sign in with Google, GitHub, or email.        |
| `edupeer.signOut`               | Signs out and switches to a fresh anonymous profile.               |
| `edupeer.explainError`          | Socratic walkthrough of a pasted error or stack trace.             |
| `edupeer.explainSelection`      | Plain-language explanation of the selected construct.              |
| `edupeer.predictOutput`         | Predict-the-output exercise on the selected code.                  |
| `edupeer.reflectQuiz`           | One-question reflection quiz after you fix a bug.                  |
| `edupeer.traceCode`             | Desk-check exercise: fill in a variable trace, get it marked.      |
| `edupeer.showProgress`          | Progress dashboard: badges, streak, concepts, session notes.       |
| `edupeer.setGoal`               | Set (or clear) a free-text learning goal that biases the tutor.    |
| `edupeer.nudgeLine`             | Hint on the line under the cursor (`Ctrl+Alt+H` / `Cmd+Alt+H`).    |
| `edupeer.scanFile`              | Scan the open file and flag suspicious lines in the Problems panel.|

`Ctrl+Alt+H` (`Cmd+Alt+H` on macOS) is the fastest path to a hint; the same
command is on the editor right-click menu. One further command,
`edupeer.discussLines`, is deliberately hidden from the command palette — it is
reachable only from the Quick Fix on an EduPeer diagnostic.

A status bar entry shows the current hint depth, your streak and whether a
review is waiting; click it to open the panel. EduPeer's own diagnostics also
offer Quick Fix actions ("nudge me on this line", "explain this line"), and a
`Get started with EduPeer` walkthrough ships in the Welcome page.

## How hinting works

Each call to `POST /hint` advances the hint level (1 → 2 → 3) for the same user
and problem within a session. The ladder is keyed on the file you are working
in, not on a hash of its contents, so editing your code deepens the hint
instead of restarting it. Reset the session to start over at level 1.

- **Level 1** — one guiding question.
- **Level 2** — points out the specific line/concept and briefly explains it.
- **Level 3** — pseudocode only, never real code in the student's language.

Every response ends with "What do you think should happen next?".

The tutor also remembers the recent conversation: the sidebar sends the last
few student/tutor turns with each question, so follow-ups like "I tried that
and it still fails" are answered in context. Resetting the session clears
this memory.

### Depth is earned, not spent

Asking again without changing anything does **not** buy a deeper hint. The
extension tracks the code each hint was given against:

- **You edited something** — the level advances, and a compact diff of what
  you changed rides along so the tutor answers against your actual attempt.
- **You changed nothing** — you get the same depth back plus a prompt to say
  what you tried. Editing the code (or waiting 45 seconds) unlocks the next
  level.

This targets hint abuse, the well-documented habit of bottoming out a tutor's
hints to reach the answer without engaging.

### Confidence and calibration

Before asking, you can optionally rate how sure you are (*No idea* / *Some
idea* / *Pretty sure*). EduPeer compares that against how much help you
actually needed and reports the match on your dashboard. Novices are
systematically overconfident, and this is the feedback loop that fixes it.
Ratings are optional and nothing is recorded when you skip them.

## Accounts and sign-in

EduPeer works without an account: on first use the extension silently creates
an anonymous Firebase account, so badges and hint levels persist on that
machine. Click **Sign in** in the sidebar (or run `EduPeer: Sign In`) to open
a browser page where you can continue with Google, GitHub, or email+password.
Progress earned anonymously is merged into your account on first sign-in, and
follows you to any machine you sign in on. Tokens are stored in VS Code's
SecretStorage; all backend endpoints except `/health`, `/auth/config`, and
`/auth/login` verify a Firebase ID token.

The sign-in callback is bound to a one-time 128-bit nonce that VS Code puts on
the login URL and the page hands back, so no other page open in the browser can
POST its own tokens to the loopback port and hijack the session. Anonymous
progress is merged only into the account it was captured for, which matters on
a shared machine: migration deletes the source record, so replaying a failed
merge into whoever signs in next would hand one student's work to another.

### One-time Firebase Console setup

1. **Authentication → Sign-in method:** enable Email/Password, Google,
   GitHub, and Anonymous.
2. **GitHub provider:** create a GitHub OAuth App (GitHub Settings →
   Developer settings → OAuth Apps), set its callback URL to the one Firebase
   shows, and paste the client ID/secret into Firebase.
3. **Project settings → Your apps:** add a Web app and copy its `apiKey` and
   `authDomain` into `.env` as `FIREBASE_WEB_API_KEY` / `FIREBASE_AUTH_DOMAIN`.

## Language support

The extension detects the language from VS Code's `languageId` and sends it
with every request; the backend adapts its Socratic prompts and concept tags
(e.g. `pointers`/`segfault` for C, `equality`/`promises` for JavaScript) to
the language. Unknown languages fall back to Python-style tutoring, and
requests from older clients that send no language keep working. Adding a
language is one registry entry in `backend/languages.py` plus one in
`extension/src/languages.ts`.

## Badges

Awarded automatically after each interaction:

- **First Question** — 1 total interaction.
- **Persistent Learner / Marathon Learner / Scholar** — 5 / 15 / 50 sessions.
  A session ends when you press Reset or go 30 minutes without asking anything.
- **Hint Minimiser I/II/III** — solved at hint level 1 three / ten / twenty-five times.
  Only progressive `hint`-mode asks count; explanations, quizzes and traces do not.
- **Concept Explorer** — 5+ unique concept tags touched.
- **3-Day Streak / Week Streak / Month Streak** — consecutive days of practice.
- **<Language> Learner** — first interaction in each supported language.
- **Polyglot** — practised in 3+ languages.

## Endpoints

| Method | Path             | Description                                    |
| ------ | ---------------- | ---------------------------------------------- |
| GET    | `/health`        | Health check.                                  |
| GET    | `/auth/config`   | Firebase web-app config (public values).       |
| GET    | `/auth/login`    | Browser-based Firebase sign-in flow.           |
| POST   | `/auth/migrate`  | Migrate anonymous progress to a signed-in account. |
| POST   | `/hint`          | Main tutor endpoint.                           |
| POST   | `/reset`         | Reset the hint-level counter for a user.       |
| POST   | `/scan`          | Scan code for potential issues.                |
| POST   | `/line-hint`     | Get hint for a specific line.                  |
| GET    | `/badges`        | Badges for the authenticated user.             |
| POST   | `/hint/stream`   | SSE variant of `/hint` (meta, delta…, done).   |
| GET    | `/progress`      | Progress report: badges, streak, concept stats. |
| GET    | `/review`        | Spaced-review status and micro-exercise.       |
| POST   | `/goal`          | Set or clear the student's learning goal.      |
| POST   | `/trace`         | Design a desk-check exercise for a snippet.    |

All endpoints except `GET /health`, `GET /auth/config`, and `GET /auth/login` require `Authorization: Bearer <Firebase ID token>` in the request header.

## Tutor modes

`POST /hint` takes a `mode` field. Only `hint` advances the 1→2→3 level; the
rest are one-shot teaching moves the sidebar triggers contextually:

- **hint** — the progressive Socratic flow, with an optional, skippable
  "explain the code first" step. The step is keyed on the exact state of your
  code, so it returns whenever you have edited since the last time you
  answered it.
- **reflect** — after you fix a bug (or when a rescan comes back clean), one
  short quiz question about *why* the fix works.
- **translate** — after a level-3 pseudocode hint, submit your code
  translation and get feedback on the translation only.
- **worked-example** — still stuck at level 3? A fully worked example of the
  same concept on a *different* problem.
- **explain-error** — paste a stack trace (auto-detected) or run
  `EduPeer: Explain This Error`; teaches you to *read* the error, not the fix.
- **subgoal-label** — a worked example arrives as unlabelled numbered steps;
  you name what each step accomplishes and get judged on the *purpose*, not
  the syntax. Labelling sub-goals yourself is what makes worked examples
  transfer to new problems.
- **trace-check** — `EduPeer: Trace This Code` picks 2–4 variables worth
  following and gives you a grid to fill in step by step. Submitting it marks
  the first row where your trace diverges from reality, and asks a question
  about that line. Students who can't trace code can't write it.
- **explain-concept** / **predict-output** / **review-exercise** — construct
  explanations, output-prediction exercises, and spaced-review drills.

The extension also watches for teachable moments: a debugger stop on an
exception and a failing terminal test run (VS Code 1.93+) each offer to talk
it through.

## Progress, review and goals

Every hint is tagged with concepts (the model emits them; a keyword fallback
guards parsing). Per-concept stats feed:

- **Adaptive pacing** — the tutor scaffolds concepts you keep needing deep
  hints on and stays terse where you solve at level 1.
- **`EduPeer: Show My Progress`** — dashboard with badges, streak, languages,
  struggles/strengths and session notes.
- **Spaced review** — concepts you struggled with 3–7 days ago surface as a
  Review button in the sidebar.
- **Session summaries** — resetting a session stores a 3-bullet "what you
  learned" note.

The dashboard renders as inline SVG with no chart library and no network: a
hint-depth distribution, a 14-day activity strip, per-concept mastery bars and
your confidence calibration. Colours come from VS Code's chart tokens and every
series is labelled in text, so it reads correctly in any theme.

## Streaming, offline behaviour and quota

The sidebar streams hints over SSE (`/hint/stream`) and falls back to the
plain `/hint` call if streaming fails. When the backend is unreachable the
sidebar shows an offline banner, retries `/health` every 30 s, and queues
reset/goal mutations to sync when it returns.

**Local fallback tutor.** With the backend down, EduPeer still teaches from a
rule table built into the extension (`src/localTutor.ts`): roughly a dozen
patterns per language that return a Socratic question rather than nothing.
It says plainly that it is offline and never advances your hint level.

**Cache and rate limits.** `/scan` and `/line-hint` fire automatically as you
type, so the backend caches both for 5 minutes keyed on your uid plus a
fingerprint of the code — an unchanged file costs no LLM call. Per-user token
buckets cap `/hint` at 30/min, the inline endpoints at 60/min, `/trace` at
10/min, `/reset` and `/goal` at a shared 10/min and `/review` at 6/min,
returning `429` with `Retry-After`. Every endpoint that can reach the LLM has
a bucket. The extension treats a 429 as a
soft failure: inline features go quiet until the budget refills and the
sidebar says so rather than showing an error. All of this exists to keep the
project inside the Groq free tier.

## Packaging a VSIX

```bash
cd extension && npm run package
```

This bundles the extension with esbuild and produces `edupeer-<version>.vsix`
(installable via "Extensions: Install from VSIX..."). No publisher account or
hosted services required.

## Deploying the backend to Render

`render.yaml` in the repository root is a Render blueprint for the backend.

1. On [render.com](https://render.com), **New > Blueprint** and connect this
   repository. Render reads `render.yaml` and proposes an `edupeer-backend`
   web service.
2. It then prompts for the six values marked `sync: false`. Paste the same
   values as your local `.env`. `FIREBASE_PRIVATE_KEY` goes in as a single line
   with the literal `\n` escapes intact — `firebase_service.py` un-escapes them.
3. Apply. First build takes a few minutes (`grpcio` compiles from source if a
   wheel is missing, which is why `PYTHON_VERSION` is pinned to 3.12.6).
4. Confirm `https://<service>.onrender.com/health` returns
   `{"status":"ok","service":"edupeer-backend"}`.
5. If Render assigned a hostname other than `edupeer-backend.onrender.com`,
   update the `edupeer.backendUrl` default in `extension/package.json` and
   `DEFAULT_BACKEND_URL` in `extension/src/extension.ts` to match.

Add the deployed origin to the Firebase Console under **Authentication >
Settings > Authorized domains**, otherwise the browser sign-in flow served from
`/auth/login` will be rejected.

### Keeping the service awake

Render's free plan stops the service after ~15 minutes idle and takes roughly
50 seconds to wake. The extension abandons a request after 20 seconds
(`REQUEST_TIMEOUT_MS` in `extension/src/apiClient.ts`), so the first student to
ask a question after an idle period gets a timeout and the offline fallback
tutor instead of the real one.

Two ways round it, before putting the backend in front of testers:

- Upgrade to the Starter plan (currently $7/month), which does not sleep.
- Keep the free plan and ping `/health` every 10 minutes from an external cron
  (GitHub Actions, cron-job.org). One always-on service fits inside the free
  monthly instance-hour allowance, but nothing else will.

## Publishing the extension to the Marketplace

Prerequisites: a Microsoft account, an Azure DevOps organisation, and a
personal access token scoped to **Marketplace > Manage** across all accessible
organisations. Create the publisher at
[marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage);
its ID must match `"publisher"` in `extension/package.json`.

```bash
cd extension
npx vsce login <publisher>
npm run package     # sanity-check the .vsix first
npx vsce publish
```

Add `--pre-release` to publish into the pre-release channel while the extension
is still under test.
