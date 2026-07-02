# EduPeer

A VS Code extension that acts as a Socratic AI tutor for novice programmers. EduPeer guides students toward solutions through progressive hints rather than generating complete code.

**Supported languages:** Python, JavaScript, Java, C, C++, C#.

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
SecretStorage; all backend endpoints verify a Firebase ID token.

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
- **Persistent Learner** — 5+ sessions.
- **Hint Minimiser** — solved at hint level 1 three or more times.
- **Concept Explorer** — 5+ unique concept tags touched.

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

All data endpoints (hint, reset, scan, line-hint, badges) require `Authorization: Bearer <Firebase ID token>` in the request header.
