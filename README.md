# EduPeer

A VS Code extension that acts as a Socratic AI tutor for novice Python programmers. EduPeer guides students toward solutions through progressive hints rather than generating complete code.

The system consists of:

- **VS Code extension** (TypeScript, sidebar webview) that reads the active Python file and shows a chat UI.
- **FastAPI backend** that calls Claude `claude-sonnet-4-6` and persists interactions/badges to Firestore.
- **Firebase Firestore** for interaction logs and user badges.

## Architecture

```
edupeer/
├── extension/    VS Code extension (TypeScript)
└── backend/      FastAPI + Anthropic + Firestore
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

- `ANTHROPIC_API_KEY` — your Anthropic API key
- `FIREBASE_PROJECT_ID` — your Firebase project id
- `FIREBASE_PRIVATE_KEY` — the `private_key` field from your Firebase service-account JSON (keep the quotes and `\n` escaping)
- `FIREBASE_CLIENT_EMAIL` — the `client_email` from the same service-account JSON
- `BACKEND_URL` — defaults to `http://localhost:8000`

### 4. Run the backend

```bash
cd backend && uvicorn main:app --reload
```

The API is now at `http://localhost:8000`. Health check: `GET /health`.

### 5. Run the extension

1. Open the `edupeer/extension` folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the new window open any `.py` file.
4. Click the **EduPeer** icon in the Activity Bar, or run `EduPeer: Open Tutor Panel` from the command palette.

## Commands

| Command                         | Description                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| `edupeer.activate`              | Opens the EduPeer sidebar panel.                                   |
| `edupeer.analyseSelection`      | Right-click selected Python code → sends it with "What is wrong…". |
| `edupeer.resetSession`          | Clears chat history and resets hint level to 1.                    |

## How hinting works

Each call to `POST /hint` advances the hint level (1 → 2 → 3) for the same user + code fingerprint within a session. Reset the session to start over at level 1.

- **Level 1** — one guiding question.
- **Level 2** — points out the specific line/concept and briefly explains it.
- **Level 3** — pseudocode only, never real Python.

Every response ends with "What do you think should happen next?".

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
| POST   | `/hint`          | Main tutor endpoint.                           |
| POST   | `/reset`         | Reset the hint-level counter for a user.       |
| GET    | `/badges/{uid}`  | Returns current badge list for the given user. |
