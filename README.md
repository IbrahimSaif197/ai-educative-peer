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
- `BACKEND_URL` — defaults to `http://localhost:8000`

### 4. Run the backend

```bash
cd backend && uvicorn main:app --reload
```

The API is now at `http://localhost:8000`. Health check: `GET /health`.

### 5. Run the extension

1. Open the `edupeer/extension` folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window open any supported file (`.py`, `.js`, `.java`, `.c`, `.cpp`, `.cs`) — the `demos/` folder has a buggy sample for each language.
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
| `edupeer.showProgress`          | Progress dashboard: badges, streak, concepts, session notes.       |
| `edupeer.setGoal`               | Set (or clear) a free-text learning goal that biases the tutor.    |

## How hinting works

Each call to `POST /hint` advances the hint level (1 → 2 → 3) for the same user + code fingerprint within a session. Reset the session to start over at level 1.

- **Level 1** — one guiding question.
- **Level 2** — points out the specific line/concept and briefly explains it.
- **Level 3** — pseudocode only, never real code in the student's language.

Every response ends with "What do you think should happen next?".

The tutor also remembers the recent conversation: the sidebar sends the last
few student/tutor turns with each question, so follow-ups like "I tried that
and it still fails" are answered in context. Resetting the session clears
this memory.

## Accounts and sign-in

EduPeer works without an account: on first use the extension silently creates
an anonymous Firebase account, so badges and hint levels persist on that
machine. Click **Sign in** in the sidebar (or run `EduPeer: Sign In`) to open
a browser page where you can continue with Google, GitHub, or email+password.
Progress earned anonymously is merged into your account on first sign-in, and
follows you to any machine you sign in on. Tokens are stored in VS Code's
SecretStorage; all backend endpoints except `/health`, `/auth/config`, and
`/auth/login` verify a Firebase ID token.

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
- **Hint Minimiser I/II/III** — solved at hint level 1 three / ten / twenty-five times.
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

All endpoints except `GET /health`, `GET /auth/config`, and `GET /auth/login` require `Authorization: Bearer <Firebase ID token>` in the request header.

## Tutor modes

`POST /hint` takes a `mode` field. Only `hint` advances the 1→2→3 level; the
rest are one-shot teaching moves the sidebar triggers contextually:

- **hint** — the progressive Socratic flow (with an optional, skippable
  "explain the code first" step the first time you ask about a file).
- **reflect** — after you fix a bug (or when a rescan comes back clean), one
  short quiz question about *why* the fix works.
- **translate** — after a level-3 pseudocode hint, submit your code
  translation and get feedback on the translation only.
- **worked-example** — still stuck at level 3? A fully worked example of the
  same concept on a *different* problem.
- **explain-error** — paste a stack trace (auto-detected) or run
  `EduPeer: Explain This Error`; teaches you to *read* the error, not the fix.
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
  🔁 Review button in the sidebar.
- **Session summaries** — resetting a session stores a 3-bullet "what you
  learned" note.

## Streaming and offline behaviour

The sidebar streams hints over SSE (`/hint/stream`) and falls back to the
plain `/hint` call if streaming fails. When the backend is unreachable the
sidebar shows an offline banner, retries `/health` every 30 s, and queues
reset/goal mutations to sync when it returns.

## Packaging a VSIX

```bash
cd extension && npm run package
```

This bundles the extension with esbuild and produces `edupeer-<version>.vsix`
(installable via "Extensions: Install from VSIX..."). No publisher account or
hosted services required.
