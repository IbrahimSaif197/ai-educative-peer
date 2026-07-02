# Login Authentication — Design

**Date:** 2026-07-02
**Status:** Approved

## Goal

Give EduPeer users real accounts so that (1) badges and progress follow them
across machines and reinstalls, (2) interactions carry a real identity
(name/email), and (3) the backend verifies who is calling instead of trusting
a client-supplied `user_id`. Everything must run on free tiers.

## Current state

- The extension generates a random anonymous ID (`user-xxxx…`) on first run and
  stores it in VS Code `globalState` (`sidebarProvider.ts`).
- The backend trusts the `user_id` field in request bodies and the
  `/badges/{user_id}` path parameter — anyone can read or write as anyone.
- Firebase Admin SDK is already configured server-side (Firestore persistence
  works); there is no Firebase Authentication usage yet.

## Decisions made during brainstorming

- **Goals:** cross-device persistence + identity + backend security (all three).
- **Sign-in methods:** Google, GitHub, email+password, and an anonymous
  fallback (users may skip login entirely).
- **Migration:** progress earned anonymously is carried over on first real
  sign-in.
- **Cost:** must be free. Firebase Authentication's Spark plan covers all four
  methods at no cost (only SMS/phone auth is paid, which we do not use). The
  auth page is served by our own FastAPI backend, so no extra hosting.
- **Approach:** hosted auth page + browser handoff (chosen over per-provider
  in-extension REST flows and over custom JWT auth, both of which are more
  work for less).

## Architecture

```
Extension (VS Code)                 Backend (FastAPI)              Firebase
┌──────────────────┐   opens       ┌──────────────────┐
│ authManager.ts   │──browser────▶ │ GET /auth/login  │──JS SDK──▶ Firebase Auth
│  - localhost     │               │  (auth.html)     │            (Google/GitHub/
│    callback      │◀──POST tokens─│                  │             email/anon)
│  - SecretStorage │               ├──────────────────┤
│                  │──Bearer ID───▶│ get_current_uid  │──admin───▶ verify_id_token
│ apiClient.ts     │   token       │  dependency      │
└──────────────────┘               └──────────────────┘
```

### 1. Auth page — `backend/static/auth.html`, served at `GET /auth/login`

- Uses the Firebase JS Web SDK (loaded from Firebase's CDN).
- UI: "Continue with Google", "Continue with GitHub", and an email+password
  form with sign-in / create-account modes.
- Opened as `…/auth/login?port=<N>` where `<N>` is the extension's one-shot
  localhost listener port.
- On successful sign-in it POSTs
  `{ idToken, refreshToken, uid, email, displayName }` to
  `http://127.0.0.1:<N>/callback`, then shows
  "You're signed in — return to VS Code."
- The Firebase **web app config** (apiKey, authDomain, projectId — public
  values, not secrets) is embedded in the page; the backend injects them from
  env vars `FIREBASE_WEB_API_KEY` and `FIREBASE_AUTH_DOMAIN`.

### 2. Extension auth manager — `extension/src/authManager.ts`

- **Sign in:** start a one-shot `http.Server` on `127.0.0.1` with a random
  port, open the browser (`vscode.env.openExternal`) to `/auth/login?port=N`,
  await the callback, store tokens. Listener times out after 5 minutes and
  the Sign in button resets.
- **Token storage:** refresh token in `context.secrets` (VS Code
  SecretStorage, OS-encrypted). ID token cached in memory; refreshed via
  Firebase's secure-token endpoint (`https://securetoken.googleapis.com/v1/token`)
  when expired (Firebase ID tokens last 1 hour).
- **Anonymous fallback:** if no stored session exists, silently call
  Firebase's REST sign-up endpoint (`accounts:signUp` with no email) once to
  create an anonymous account, and store its tokens the same way. Every user
  therefore has a real Firebase UID and valid tokens; the legacy random-ID
  scheme is removed.
- **Sign out:** clear SecretStorage, create a fresh anonymous account.
- **Events:** emits an event on auth-state change so the sidebar can update.
- **Web API key:** the anonymous sign-up and token-refresh REST calls need
  the Firebase web API key. The extension fetches it once from a new public
  endpoint `GET /auth/config` (returns `{ apiKey, authDomain }` — public
  values) and caches it, so no Firebase config is baked into the extension.

### 3. Sidebar and commands

- Account row at the top of the existing sidebar webview: "Signed in as
  \<displayName or email\>" + Sign out link when authenticated; a "Sign in"
  button when anonymous.
- New commands: `edupeer.signIn`, `edupeer.signOut` (also registered in
  `package.json`).

### 4. Backend token verification

- New FastAPI dependency `get_current_uid` (in a new `backend/auth.py`):
  reads `Authorization: Bearer <idToken>`, verifies with
  `firebase_admin.auth.verify_id_token()`, returns the UID. Missing or
  invalid token → `401`.
- All data endpoints switch from body/path `user_id` to the verified UID:
  `POST /hint`, `POST /reset`, `POST /scan`, `POST /line-hint`, and
  `GET /badges` (path parameter removed — you can only read your own).
- Public (no auth): `GET /health`, `GET /auth/login`, `GET /auth/config`.
- `apiClient.ts` attaches the Bearer token to every request; on `401` it
  refreshes the ID token once and retries.
- **Breaking API change, accepted:** extension and backend ship together from
  this repo; no compatibility shim.

### 5. Migration — `POST /auth/migrate`

Carries anonymous progress into a real account. Runs once, immediately after
the first non-anonymous sign-in.

- Request body: `{ old_id_token?: string, legacy_user_id?: string }`, with the
  new account's ID token in the `Authorization` header.
- The backend verifies **both** Firebase tokens with the admin SDK, so the
  caller must genuinely own both accounts. It then merges the old UID's user
  document into the new UID's: numeric counters (total interactions, session
  count, level-1 solves) added; concept tags and badges unioned; badges
  recomputed from the merged stats. The old anonymous user doc is deleted
  afterwards.
- `legacy_user_id` covers pre-auth `user-xxxx` IDs. Those were never
  verifiable (the old API trusted any string), so merging them is best-effort
  by design and not a new security exposure. The extension sends its stored
  legacy ID once, then deletes the `edupeer.userId` globalState key.
- Old interaction **log** documents are left in place under their original
  IDs; only the user stats/badges document merges.

## Error handling

- **Expired ID token:** auto-refresh once and retry the request. If refresh
  fails (token revoked, offline), the sidebar shows "Session expired — sign
  in again" and hint requests are blocked with a friendly message.
- **Abandoned browser handoff:** localhost listener times out after 5
  minutes; Sign in button resets.
- **Backend unreachable during anonymous bootstrap:** sidebar still loads;
  bootstrap retries on the next interaction.
- **Migration failure:** non-fatal; logged, retried on next activation (a
  `pendingMigration` flag in globalState until it succeeds).

## Testing

- **Backend (pytest):** `get_current_uid` with valid / expired / missing /
  malformed tokens (mock `verify_id_token`); `/auth/migrate` merge logic
  (counters added, tags and badges unioned, old doc deleted, both-token
  verification enforced); endpoints reject unauthenticated requests.
- **Extension (jest):** `authManager` — token refresh flow, SecretStorage
  round-trip, callback payload parsing, anonymous bootstrap; `apiClient` —
  Bearer header attached, 401-refresh-retry (following existing test
  patterns in `extension/src/__tests__/`).
- **Manual E2E checklist:** sign in with each provider; sign out; anonymous
  usage then Google sign-in migrates badges; reinstall extension and sign in
  to recover progress.

## One-time Firebase Console setup (manual)

1. Firebase Console → Authentication → Sign-in method: enable **Email/
   Password**, **Google**, **GitHub**, and **Anonymous**.
2. For GitHub: create a free GitHub OAuth App
   (Settings → Developer settings → OAuth Apps), set its callback URL to the
   one Firebase displays, and paste the client ID/secret into Firebase.
3. Project settings → General → Your apps: add a **Web app** (no hosting
   needed) and copy `apiKey` and `authDomain` into `.env` as
   `FIREBASE_WEB_API_KEY` and `FIREBASE_AUTH_DOMAIN`.
4. Authentication → Settings → Authorized domains: `localhost` is authorized
   by default, which covers this setup.

## Out of scope

- Password reset UI (Firebase's hosted email flow can be enabled later).
- Firestore security rules (clients never talk to Firestore directly; all
  access stays server-side through the admin SDK).
- Multi-account switching, profile editing, avatars.
