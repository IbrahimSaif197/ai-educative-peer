# Login Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Firebase Authentication (Google, GitHub, email+password, anonymous fallback) to EduPeer so progress follows users across machines and the backend verifies every caller instead of trusting a client-supplied `user_id`.

**Architecture:** The FastAPI backend serves a small Firebase JS SDK sign-in page; the extension opens it in the browser and receives tokens on a one-shot localhost callback, storing them in VS Code SecretStorage. Every data endpoint verifies a `Bearer` Firebase ID token via `firebase-admin` and takes the UID from the token. Anonymous users get a silent Firebase anonymous account; on first real sign-in a `/auth/migrate` endpoint merges their old progress.

**Tech Stack:** FastAPI + firebase-admin (already installed), Firebase Auth REST API + Firebase JS Web SDK (CDN), VS Code extension API (SecretStorage, `env.openExternal`), Node's built-in `http` module. Spec: `docs/superpowers/specs/2026-07-02-login-authentication-design.md`.

## Global Constraints

- **No new dependencies.** Backend uses the already-pinned `firebase-admin==6.5.0`; extension uses Node's built-in `http` and global `fetch` (VS Code ≥ 1.85 ships Node 18). The auth page loads the Firebase JS SDK from Firebase's CDN.
- **Free tier only.** Firebase Spark plan; no paid services.
- **UID always comes from the verified token.** No endpoint may read a `user_id` from a request body or path (exception: `legacy_user_id` inside `/auth/migrate`, which is best-effort by design — see spec).
- **New env vars:** `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN` (public web-app config values, not secrets).
- **Commit messages:** plain, no `Co-Authored-By` trailer (user preference).
- **Run backend tests from `backend/`:** `cd backend && python -m pytest tests/ -v`. Run extension tests from `extension/`: `cd extension && npx jest`.

---

### Task 1: Backend auth dependency (`backend/auth.py`)

**Files:**
- Create: `backend/auth.py`
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `firebase_admin.auth.verify_id_token` (already installed).
- Produces: `get_current_uid(authorization: str = Header(default="")) -> str` (FastAPI dependency, raises `HTTPException(401)`) and `verify_token(id_token: str) -> str` (verifies a raw token, returns uid, raises `HTTPException(401)`). Tasks 3 and 4 import both from `auth`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_auth.py`:

```python
import pytest
from fastapi import HTTPException

import auth


def test_missing_header_raises_401():
    with pytest.raises(HTTPException) as exc:
        auth.get_current_uid("")
    assert exc.value.status_code == 401


def test_non_bearer_scheme_raises_401():
    with pytest.raises(HTTPException) as exc:
        auth.get_current_uid("Basic abc123")
    assert exc.value.status_code == 401


def test_valid_token_returns_uid(monkeypatch):
    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", lambda t: {"uid": "user-123"})
    assert auth.get_current_uid("Bearer good-token") == "user-123"


def test_invalid_token_raises_401(monkeypatch):
    def boom(_):
        raise ValueError("expired")

    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", boom)
    with pytest.raises(HTTPException) as exc:
        auth.get_current_uid("Bearer bad-token")
    assert exc.value.status_code == 401


def test_token_without_uid_raises_401(monkeypatch):
    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", lambda t: {})
    with pytest.raises(HTTPException) as exc:
        auth.verify_token("weird-token")
    assert exc.value.status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_auth.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auth'`

- [ ] **Step 3: Write the implementation**

Create `backend/auth.py`:

```python
from fastapi import Header, HTTPException
from firebase_admin import auth as firebase_auth


def verify_token(id_token: str) -> str:
    """Verify a Firebase ID token and return its uid.

    Raises HTTPException(401) on any verification failure so callers can use
    it directly inside request handlers.
    """
    try:
        decoded = firebase_auth.verify_id_token(id_token)
    except Exception:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    uid = decoded.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="token has no uid")
    return uid


def get_current_uid(authorization: str = Header(default="")) -> str:
    """FastAPI dependency: extract and verify the Bearer ID token."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return verify_token(authorization[len("Bearer "):])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_auth.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add backend/auth.py backend/tests/test_auth.py
git commit -m "Add Firebase ID token verification dependency"
```

---

### Task 2: Auth config endpoint and hosted sign-in page

**Files:**
- Create: `backend/static/auth.html`
- Modify: `backend/main.py` (add `GET /auth/config`, `GET /auth/login`)
- Test: `backend/tests/test_auth_page.py`

**Interfaces:**
- Consumes: env vars `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`.
- Produces: `GET /auth/config` → `{"apiKey": str, "authDomain": str}` (public; Task 5's extension AuthManager fetches this). `GET /auth/login?port=N` → HTML sign-in page that POSTs `{idToken, refreshToken, uid, email, displayName}` as JSON to `http://127.0.0.1:<port>/callback` (Task 6's callback server receives this exact payload).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_auth_page.py`. The env vars must be set **before** `import main` (module-level FastAPI app construction requires `GROQ_API_KEY`):

```python
import os

os.environ.setdefault("GROQ_API_KEY", "test-key")
os.environ["FIREBASE_WEB_API_KEY"] = "test-web-key"
os.environ["FIREBASE_AUTH_DOMAIN"] = "test-project.firebaseapp.com"

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)


def test_auth_config_returns_public_firebase_config():
    res = client.get("/auth/config")
    assert res.status_code == 200
    assert res.json() == {
        "apiKey": "test-web-key",
        "authDomain": "test-project.firebaseapp.com",
    }


def test_auth_login_serves_html_with_injected_config():
    res = client.get("/auth/login")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    assert "test-web-key" in res.text
    assert "test-project.firebaseapp.com" in res.text
    assert "__FIREBASE_API_KEY__" not in res.text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_auth_page.py -v`
Expected: FAIL with 404s (routes don't exist yet)

- [ ] **Step 3: Create the sign-in page**

Create `backend/static/auth.html` (complete file):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in to EduPeer</title>
  <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; background: #1e1e2e; color: #eee;
           display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #2a2a3c; border-radius: 12px; padding: 32px; width: 320px; }
    h1 { font-size: 20px; margin: 0 0 20px; }
    button { width: 100%; padding: 10px; margin: 6px 0; border: none; border-radius: 6px;
             font-size: 14px; cursor: pointer; background: #444; color: #eee; }
    button.primary { background: #4f7cff; color: white; }
    input { width: 100%; padding: 9px; margin: 5px 0; border-radius: 6px; border: 1px solid #555;
            background: #1e1e2e; color: #eee; box-sizing: border-box; }
    .divider { text-align: center; color: #888; margin: 14px 0 8px; font-size: 12px; }
    .error { color: #ff7b7b; font-size: 13px; min-height: 18px; margin-top: 8px; }
    .hidden { display: none; }
    .toggle { color: #9ab4ff; font-size: 13px; cursor: pointer; text-align: center; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="card" id="signin">
    <h1>Sign in to EduPeer</h1>
    <button class="primary" id="google">Continue with Google</button>
    <button id="github">Continue with GitHub</button>
    <div class="divider">or use email</div>
    <input type="email" id="email" placeholder="Email" />
    <input type="password" id="password" placeholder="Password" />
    <button id="emailSubmit">Sign in</button>
    <div class="toggle" id="modeToggle">New here? Create an account</div>
    <div class="error" id="error"></div>
  </div>
  <div class="card hidden" id="done">
    <h1>You're signed in ✔</h1>
    <p>Return to VS Code — EduPeer is ready.</p>
  </div>

  <script>
    const config = {
      apiKey: "__FIREBASE_API_KEY__",
      authDomain: "__FIREBASE_AUTH_DOMAIN__",
    };
    firebase.initializeApp(config);
    const auth = firebase.auth();
    const port = new URLSearchParams(location.search).get("port");
    const errorEl = document.getElementById("error");
    let createMode = false;

    document.getElementById("modeToggle").addEventListener("click", () => {
      createMode = !createMode;
      document.getElementById("emailSubmit").textContent = createMode ? "Create account" : "Sign in";
      document.getElementById("modeToggle").textContent = createMode
        ? "Already have an account? Sign in"
        : "New here? Create an account";
    });

    async function deliver(user) {
      const idToken = await user.getIdToken();
      const payload = JSON.stringify({
        idToken,
        refreshToken: user.refreshToken,
        uid: user.uid,
        email: user.email || "",
        displayName: user.displayName || "",
      });
      // text/plain avoids a CORS preflight to the extension's one-shot server.
      await fetch(`http://127.0.0.1:${port}/callback`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload,
      });
      document.getElementById("signin").classList.add("hidden");
      document.getElementById("done").classList.remove("hidden");
    }

    function run(promise) {
      errorEl.textContent = "";
      promise.then((cred) => deliver(cred.user)).catch((e) => {
        errorEl.textContent = e.message || String(e);
      });
    }

    document.getElementById("google").addEventListener("click", () =>
      run(auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()))
    );
    document.getElementById("github").addEventListener("click", () =>
      run(auth.signInWithPopup(new firebase.auth.GithubAuthProvider()))
    );
    document.getElementById("emailSubmit").addEventListener("click", () => {
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;
      if (!email || !password) {
        errorEl.textContent = "Enter an email and password.";
        return;
      }
      run(
        createMode
          ? auth.createUserWithEmailAndPassword(email, password)
          : auth.signInWithEmailAndPassword(email, password)
      );
    });
  </script>
</body>
</html>
```

- [ ] **Step 4: Add the routes**

In `backend/main.py`, add to the imports block (after `from fastapi.middleware.cors import CORSMiddleware`):

```python
from fastapi.responses import HTMLResponse
```

Add after the `health` endpoint:

```python
_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@app.get("/auth/config")
async def auth_config():
    """Public Firebase web-app config (not secrets) for the extension."""
    return {
        "apiKey": os.environ.get("FIREBASE_WEB_API_KEY", ""),
        "authDomain": os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
    }


@app.get("/auth/login", response_class=HTMLResponse)
async def auth_login():
    with open(os.path.join(_STATIC_DIR, "auth.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace("__FIREBASE_API_KEY__", os.environ.get("FIREBASE_WEB_API_KEY", ""))
    html = html.replace("__FIREBASE_AUTH_DOMAIN__", os.environ.get("FIREBASE_AUTH_DOMAIN", ""))
    return HTMLResponse(html)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_auth_page.py -v`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add backend/static/auth.html backend/main.py backend/tests/test_auth_page.py
git commit -m "Serve Firebase sign-in page and public auth config"
```

---

### Task 3: Require verified tokens on all data endpoints

**Files:**
- Modify: `backend/models.py` (drop `user_id` fields)
- Modify: `backend/main.py` (all data endpoints use `Depends(get_current_uid)`)
- Test: `backend/tests/test_api_auth.py`

**Interfaces:**
- Consumes: `auth.get_current_uid` from Task 1.
- Produces: the new API surface the extension (Task 7) targets — `POST /hint` (body: `code`, `question`, `hint_level`, `language`, `history`; **no** `user_id`), `POST /reset` (no body), `GET /badges` (no path param), `POST /scan` (body: `code`, `language`), `POST /line-hint` (body: `code`, `line`, `language`). All require `Authorization: Bearer <idToken>` and return `401` without it.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_api_auth.py`:

```python
import os

os.environ.setdefault("GROQ_API_KEY", "test-key")
os.environ.setdefault("FIREBASE_WEB_API_KEY", "test-web-key")
os.environ.setdefault("FIREBASE_AUTH_DOMAIN", "test-project.firebaseapp.com")

import pytest
from fastapi.testclient import TestClient

import auth
import main


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def signed_in(client):
    main.app.dependency_overrides[auth.get_current_uid] = lambda: "uid-1"
    yield client
    main.app.dependency_overrides.clear()


def test_hint_requires_auth(client):
    res = client.post("/hint", json={"code": "x=1", "question": "help"})
    assert res.status_code == 401


def test_reset_requires_auth(client):
    assert client.post("/reset").status_code == 401


def test_badges_requires_auth(client):
    assert client.get("/badges").status_code == 401


def test_scan_requires_auth(client):
    assert client.post("/scan", json={"code": "x=1"}).status_code == 401


def test_line_hint_requires_auth(client):
    assert client.post("/line-hint", json={"code": "x=1", "line": 1}).status_code == 401


def test_health_stays_public(client):
    assert client.get("/health").status_code == 200


def test_auth_config_stays_public(client):
    assert client.get("/auth/config").status_code == 200


def test_reset_uses_uid_from_token(signed_in):
    res = signed_in.post("/reset")
    assert res.status_code == 200
    assert res.json() == {"status": "reset", "user_id": "uid-1"}


def test_badges_returns_list_for_token_uid(signed_in):
    res = signed_in.get("/badges")
    assert res.status_code == 200
    assert isinstance(res.json(), list)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_auth.py -v`
Expected: FAIL — the `*_requires_auth` tests get `422`/`200` instead of `401`, and `/badges` (no param) gets `404`/`405`.

- [ ] **Step 3: Update the models**

In `backend/models.py`:
- Delete the `user_id` field from `HintRequest`, `ScanRequest`, and `LineHintRequest`.
- Delete the `ResetSessionRequest` class entirely (reset takes no body now).

Resulting `HintRequest` (the other two lose only their `user_id` line):

```python
class HintRequest(BaseModel):
    code: str = Field(default="", description="The student's current code")
    question: str = Field(..., description="The student's question or described error")
    hint_level: int = Field(default=1, ge=1, le=3)
    language: str = Field(default="python", description="VS Code languageId of the code")
    history: List[ChatTurn] = Field(
        default_factory=list,
        description="Prior conversation turns, oldest first",
    )
```

- [ ] **Step 4: Update the endpoints**

In `backend/main.py`:

Change the fastapi import line to:

```python
from fastapi import Depends, FastAPI, HTTPException
```

Add to the local imports:

```python
from auth import get_current_uid
```

Remove `ResetSessionRequest` from the `models` import list.

Replace every data endpoint signature and each use of `req.user_id`/path `user_id` with the injected `uid`:

```python
@app.post("/hint", response_model=HintResponse)
async def hint(req: HintRequest, uid: str = Depends(get_current_uid)) -> HintResponse:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question must not be empty")

    level = await asyncio.to_thread(
        store.next_hint_level, uid, code_fingerprint(req.code)
    )

    language = normalize_language(req.language)
    history = [turn.model_dump() for turn in req.history]
    try:
        hint_text, concept_tags = await asyncio.to_thread(
            engine.generate_hint, req.code, req.question, level, language, history
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    is_new_session = await asyncio.to_thread(store.begin_session, uid)

    firebase.fire_and_forget(
        user_id=uid,
        code_snippet=req.code,
        question=req.question,
        hint_level_used=level,
        concept_tags=concept_tags,
        new_session=is_new_session,
        language=language,
    )

    return HintResponse(hint=hint_text, hint_level=level, concept_tags=concept_tags)


@app.post("/reset")
async def reset_session(uid: str = Depends(get_current_uid)):
    await asyncio.to_thread(store.reset, uid)
    return {"status": "reset", "user_id": uid}


@app.get("/badges")
async def get_badges(uid: str = Depends(get_current_uid)) -> List[str]:
    return await asyncio.to_thread(firebase.get_user_badges_sync, uid)


@app.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest, uid: str = Depends(get_current_uid)) -> ScanResponse:
    if not req.code.strip():
        return ScanResponse(flags=[])
    try:
        raw_flags = await asyncio.to_thread(
            engine.scan_code, req.code, normalize_language(req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return ScanResponse(flags=[LineFlag(**f) for f in raw_flags])


@app.post("/line-hint", response_model=LineHintResponse)
async def line_hint(req: LineHintRequest, uid: str = Depends(get_current_uid)) -> LineHintResponse:
    if not req.code.strip():
        return LineHintResponse(hint="", concept="general")
    try:
        hint_text, concept = await asyncio.to_thread(
            engine.generate_line_hint, req.code, req.line, normalize_language(req.language)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")
    return LineHintResponse(hint=hint_text, concept=concept)
```

- [ ] **Step 5: Run the full backend suite**

First update `backend/tests/test_models.py` to match the new models:
- In `TestHintRequest`: remove `user_id="u1"` from every `HintRequest(...)` construction, delete the `assert req.user_id == "u1"` line, delete the `test_missing_user_id_raises` test, and change `test_missing_question_raises` to `HintRequest()` (no args).
- Delete the whole `TestResetSessionRequest` class and remove `ResetSessionRequest` from the file's imports.
- `TestUserBadges` is unchanged (`UserBadges` keeps its `user_id` field; it models a Firestore doc, not a request).

Run: `cd backend && python -m pytest tests/ -v`
Expected: all pass (including Tasks 1–2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/main.py backend/tests/test_api_auth.py backend/tests/test_models.py
git commit -m "Require verified Firebase tokens on all data endpoints"
```

---

### Task 4: Progress merge and `/auth/migrate` endpoint

**Files:**
- Modify: `backend/firebase_service.py` (add `_apply_badge_rules` helper + `merge_user_sync`)
- Modify: `backend/models.py` (add `MigrateRequest`)
- Modify: `backend/main.py` (add `POST /auth/migrate`)
- Test: `backend/tests/test_firebase_service.py` (new `TestMergeUser` class), `backend/tests/test_api_auth.py` (migrate endpoint tests)

**Interfaces:**
- Consumes: `auth.verify_token` and `auth.get_current_uid` from Task 1.
- Produces: `FirebaseService.merge_user_sync(source_uid: str, target_uid: str) -> bool` and `POST /auth/migrate` (body `{old_id_token?: str, legacy_user_id?: str}`, auth required, response `{"status": "ok", "merged": int}`). Task 5's extension calls this endpoint.

- [ ] **Step 1: Write the failing merge tests**

Append to `backend/tests/test_firebase_service.py`:

```python
class TestMergeUser:
    def setup_method(self):
        self.admin_mock, self.cred_mock, self.fs_mock = _patch_firebase_admin()

    def _svc_with_users(self, source_data, target_data):
        import os
        os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
        os.environ.setdefault("FIREBASE_PRIVATE_KEY", "test-key")
        os.environ.setdefault("FIREBASE_CLIENT_EMAIL", "test@test.iam.gserviceaccount.com")
        if "firebase_service" in sys.modules:
            del sys.modules["firebase_service"]

        def make_ref(data):
            snap = MagicMock()
            snap.exists = data is not None
            snap.to_dict.return_value = data or {}
            ref = MagicMock()
            ref.get.return_value = snap
            return ref

        self.source_ref = make_ref(source_data)
        self.target_ref = make_ref(target_data)
        refs = {"old-uid": self.source_ref, "new-uid": self.target_ref}

        collection_mock = MagicMock()
        collection_mock.return_value.document.side_effect = lambda uid: refs[uid]
        self.fs_mock.client.return_value.collection = collection_mock

        from firebase_service import FirebaseService
        svc = FirebaseService()
        svc._client = self.fs_mock.client.return_value
        return svc

    def test_counters_added_lists_unioned_badges_recomputed(self):
        svc = self._svc_with_users(
            {"total_interactions": 3, "sessions": 2, "solved_at_level_1": 1,
             "concept_tags_seen": ["loops", "strings"], "badges": ["First Question"]},
            {"total_interactions": 4, "sessions": 3, "solved_at_level_1": 2,
             "concept_tags_seen": ["strings", "recursion"], "badges": ["First Question"]},
        )
        assert svc.merge_user_sync("old-uid", "new-uid") is True
        data = self.target_ref.set.call_args[0][0]
        assert data["total_interactions"] == 7
        assert data["sessions"] == 5
        assert data["solved_at_level_1"] == 3
        assert sorted(data["concept_tags_seen"]) == ["loops", "recursion", "strings"]
        # merged stats cross new thresholds -> badges recomputed
        assert "Persistent Learner" in data["badges"]
        assert "Hint Minimiser" in data["badges"]
        assert data["badges"].count("First Question") == 1
        self.source_ref.delete.assert_called_once()

    def test_missing_source_doc_returns_false(self):
        svc = self._svc_with_users(None, {"total_interactions": 1})
        assert svc.merge_user_sync("old-uid", "new-uid") is False
        self.target_ref.set.assert_not_called()

    def test_same_uid_is_noop(self):
        svc = self._svc_with_users({"total_interactions": 1}, {"total_interactions": 1})
        assert svc.merge_user_sync("new-uid", "new-uid") is False

    def test_disabled_service_returns_false(self):
        from firebase_service import FirebaseService
        svc = FirebaseService.__new__(FirebaseService)
        svc._client = None
        assert svc.merge_user_sync("a", "b") is False
```

- [ ] **Step 2: Write the failing endpoint tests**

Append to `backend/tests/test_api_auth.py`:

```python
def test_migrate_merges_old_token_and_legacy_id(signed_in, monkeypatch):
    calls = []
    monkeypatch.setattr(
        main.firebase, "merge_user_sync",
        lambda old, new: calls.append((old, new)) or True,
    )

    def fake_verify(token):
        if token == "old-anon-token":
            return {"uid": "anon-uid"}
        raise ValueError("unknown token")

    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", fake_verify)
    res = signed_in.post(
        "/auth/migrate",
        json={"old_id_token": "old-anon-token", "legacy_user_id": "user-legacy1"},
    )
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "merged": 2}
    assert ("anon-uid", "uid-1") in calls
    assert ("user-legacy1", "uid-1") in calls


def test_migrate_rejects_invalid_old_token(signed_in, monkeypatch):
    def boom(_):
        raise ValueError("bad")

    monkeypatch.setattr(auth.firebase_auth, "verify_id_token", boom)
    res = signed_in.post("/auth/migrate", json={"old_id_token": "garbage"})
    assert res.status_code == 401


def test_migrate_requires_auth(client):
    assert client.post("/auth/migrate", json={}).status_code == 401


def test_migrate_with_no_sources_merges_nothing(signed_in):
    res = signed_in.post("/auth/migrate", json={})
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "merged": 0}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_firebase_service.py tests/test_api_auth.py -v`
Expected: `TestMergeUser` FAILS with `AttributeError: ... merge_user_sync`; migrate tests FAIL with 404.

- [ ] **Step 4: Implement the merge in `firebase_service.py`**

Add a module-level helper after the badge constants, and refactor the awarding block in `_update_user_and_award_badges_sync` to use it (replace the inline `def award` block and the four `if` checks):

```python
def _apply_badge_rules(badges, total_interactions, sessions, solved_at_level_1, concept_tags_seen):
    """Return the badge list with any newly-earned badges appended."""
    result = list(badges)

    def award(name: str):
        if name not in result:
            result.append(name)

    if total_interactions >= 1:
        award(BADGE_FIRST_QUESTION)
    if sessions >= 5:
        award(BADGE_PERSISTENT_LEARNER)
    if solved_at_level_1 >= 3:
        award(BADGE_HINT_MINIMISER)
    if len(concept_tags_seen) >= 5:
        award(BADGE_CONCEPT_EXPLORER)
    return result
```

In `_update_user_and_award_badges_sync`, the awarding section becomes:

```python
            badges = _apply_badge_rules(
                badges, total_interactions, sessions, solved_at_level_1, concept_tags_seen
            )
```

(keep the surrounding read/increment/`user_ref.set` logic unchanged, but assign the helper's return value to `badges` before the `set` call).

Add the merge method to `FirebaseService` (after `get_user_badges_sync`):

```python
    def merge_user_sync(self, source_uid: str, target_uid: str) -> bool:
        """Merge one user's stats/badges doc into another's, then delete the
        source doc. Returns True only when a merge actually happened."""
        if not self.enabled or source_uid == target_uid:
            return False
        try:
            users = self._client.collection("users")
            src_snap = users.document(source_uid).get()
            if not src_snap.exists:
                return False
            src: Dict[str, Any] = src_snap.to_dict() or {}
            tgt_ref = users.document(target_uid)
            tgt_snap = tgt_ref.get()
            tgt: Dict[str, Any] = tgt_snap.to_dict() if tgt_snap.exists else {}

            total = int(src.get("total_interactions", 0)) + int(tgt.get("total_interactions", 0))
            sessions = int(src.get("sessions", 0)) + int(tgt.get("sessions", 0))
            solved_1 = int(src.get("solved_at_level_1", 0)) + int(tgt.get("solved_at_level_1", 0))
            tags = list(set(list(src.get("concept_tags_seen", [])) + list(tgt.get("concept_tags_seen", []))))
            badges = list(set(list(src.get("badges", [])) + list(tgt.get("badges", []))))
            badges = _apply_badge_rules(badges, total, sessions, solved_1, tags)

            tgt_ref.set(
                {
                    "badges": badges,
                    "total_interactions": total,
                    "sessions": sessions,
                    "concept_tags_seen": tags,
                    "solved_at_level_1": solved_1,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                },
                merge=True,
            )
            users.document(source_uid).delete()
            return True
        except Exception as e:
            print(f"[firebase] merge failed: {e}")
            return False
```

- [ ] **Step 5: Add the model and endpoint**

In `backend/models.py`, add:

```python
class MigrateRequest(BaseModel):
    old_id_token: Optional[str] = None
    legacy_user_id: Optional[str] = None
```

In `backend/main.py`: add `MigrateRequest` to the `models` import list, change the `auth` import to `from auth import get_current_uid, verify_token`, and add after `/auth/login`:

```python
@app.post("/auth/migrate")
async def migrate(req: MigrateRequest, uid: str = Depends(get_current_uid)):
    """Merge progress from a previous identity into the signed-in account.

    old_id_token proves ownership of the previous (anonymous) Firebase
    account. legacy_user_id covers pre-auth random IDs, which were never
    verifiable, so merging them is best-effort by design.
    """
    sources: List[str] = []
    if req.old_id_token:
        old_uid = verify_token(req.old_id_token)
        if old_uid != uid:
            sources.append(old_uid)
    if req.legacy_user_id and req.legacy_user_id != uid:
        sources.append(req.legacy_user_id)

    merged = 0
    for source in sources:
        if await asyncio.to_thread(firebase.merge_user_sync, source, uid):
            merged += 1
    return {"status": "ok", "merged": merged}
```

Note: `merged` counts only merges that found data — the endpoint test mocks `merge_user_sync` to return `True`, giving `merged: 2`.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && python -m pytest tests/ -v`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add backend/firebase_service.py backend/models.py backend/main.py backend/tests/test_firebase_service.py backend/tests/test_api_auth.py
git commit -m "Add progress merge and /auth/migrate endpoint"
```

---

### Task 5: Extension AuthManager (tokens, anonymous bootstrap, migration)

**Files:**
- Create: `extension/src/authManager.ts`
- Test: `extension/src/__tests__/authManager.test.ts`

**Interfaces:**
- Consumes: `GET /auth/config` (Task 2), `POST /auth/migrate` (Task 4), Firebase REST endpoints (`accounts:signUp`, `securetoken.googleapis.com/v1/token`).
- Produces (used by Tasks 6–8):

```typescript
export interface AuthSession {
  uid: string; refreshToken: string; email?: string; displayName?: string; isAnonymous: boolean;
}
export interface SignInPayload {
  idToken: string; refreshToken: string; uid: string; email?: string; displayName?: string;
}
export interface SecretStore {           // structural subset of vscode.SecretStorage
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}
export interface StateStore {            // structural subset of vscode.Memento
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}
export class AuthManager {
  constructor(secrets: SecretStore, globalState: StateStore, baseUrl: string);
  setBaseUrl(url: string): void;
  initialize(): Promise<void>;                    // load persisted session
  getSession(): AuthSession | undefined;
  getIdToken(force?: boolean): Promise<string>;   // bootstraps anonymous if needed
  applySignIn(payload: SignInPayload): Promise<void>;
  runPendingMigration(): Promise<void>;
  signOut(): Promise<void>;
  onDidChange: vscode.Event<AuthSession | undefined>;
}
```

- [ ] **Step 1: Write the failing tests**

Create `extension/src/__tests__/authManager.test.ts`:

```typescript
import { AuthManager, SignInPayload } from "../authManager";

const BASE = "http://localhost:8000";

class FakeSecrets {
  map = new Map<string, string>();
  get = async (k: string) => this.map.get(k);
  store = async (k: string, v: string) => void this.map.set(k, v);
  delete = async (k: string) => void this.map.delete(k);
}

class FakeState {
  map = new Map<string, any>();
  get = <T,>(k: string) => this.map.get(k) as T | undefined;
  update = async (k: string, v: any) =>
    void (v === undefined ? this.map.delete(k) : this.map.set(k, v));
}

/** Routes fetch calls by URL substring; records every call. */
function mockFetchRoutes(routes: Array<[string, number, any]>): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    const match = routes.find(([frag]) => String(url).includes(frag));
    if (!match) throw new Error(`unmatched fetch: ${url}`);
    const [, status, body] = match;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  (global as any).fetch = mock;
  return mock;
}

const CONFIG = ["/auth/config", 200, { apiKey: "web-key", authDomain: "x.firebaseapp.com" }] as [string, number, any];
const SIGNUP = ["accounts:signUp", 200, { localId: "anon-1", idToken: "anon-id-token", refreshToken: "anon-refresh", expiresIn: "3600" }] as [string, number, any];
const REFRESH = ["securetoken", 200, { id_token: "refreshed-id", refresh_token: "refreshed-refresh", user_id: "anon-1", expires_in: "3600" }] as [string, number, any];
const MIGRATE = ["/auth/migrate", 200, { status: "ok", merged: 1 }] as [string, number, any];

afterEach(() => jest.restoreAllMocks());

function makeManager() {
  const secrets = new FakeSecrets();
  const state = new FakeState();
  const auth = new AuthManager(secrets, state, BASE);
  return { auth, secrets, state };
}

describe("anonymous bootstrap", () => {
  it("creates an anonymous account on first getIdToken and persists it", async () => {
    const fetchMock = mockFetchRoutes([CONFIG, SIGNUP]);
    const { auth, secrets } = makeManager();
    const token = await auth.getIdToken();
    expect(token).toBe("anon-id-token");
    expect(auth.getSession()).toMatchObject({ uid: "anon-1", isAnonymous: true });
    expect(secrets.map.get("edupeer.authSession")).toContain("anon-1");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("accounts:signUp"))).toBe(true);
  });

  it("reuses the cached idToken without another fetch", async () => {
    const fetchMock = mockFetchRoutes([CONFIG, SIGNUP]);
    const { auth } = makeManager();
    await auth.getIdToken();
    const callsAfterFirst = fetchMock.mock.calls.length;
    await auth.getIdToken();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("refreshes via securetoken when force=true", async () => {
    mockFetchRoutes([CONFIG, SIGNUP, REFRESH]);
    const { auth } = makeManager();
    await auth.getIdToken();
    const token = await auth.getIdToken(true);
    expect(token).toBe("refreshed-id");
  });
});

describe("applySignIn and migration", () => {
  const payload: SignInPayload = {
    idToken: "real-id", refreshToken: "real-refresh", uid: "real-1",
    email: "a@b.com", displayName: "Ada",
  };

  it("replaces the anonymous session and migrates its progress", async () => {
    const fetchMock = mockFetchRoutes([CONFIG, SIGNUP, REFRESH, MIGRATE]);
    const { auth, state } = makeManager();
    await state.update("edupeer.userId", "user-legacy1");
    await auth.getIdToken(); // become anonymous first
    await auth.applySignIn(payload);

    expect(auth.getSession()).toMatchObject({ uid: "real-1", isAnonymous: false });
    const migrateCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/auth/migrate"));
    expect(migrateCall).toBeDefined();
    const body = JSON.parse(migrateCall![1].body);
    expect(body.old_id_token).toBe("refreshed-id"); // old refresh token exchanged
    expect(body.legacy_user_id).toBe("user-legacy1");
    // migration succeeded -> pending record and legacy id cleared
    expect(state.get("edupeer.userId")).toBeUndefined();
  });

  it("keeps the pending migration when the migrate call fails", async () => {
    mockFetchRoutes([CONFIG, SIGNUP, REFRESH, ["/auth/migrate", 500, {}]]);
    const { auth, secrets } = makeManager();
    await auth.getIdToken();
    await auth.applySignIn(payload);
    expect(secrets.map.has("edupeer.pendingMigration")).toBe(true);
  });
});

describe("signOut", () => {
  it("clears the session and bootstraps a fresh anonymous account", async () => {
    mockFetchRoutes([CONFIG, SIGNUP]);
    const { auth } = makeManager();
    await auth.applySignIn({ idToken: "t", refreshToken: "r", uid: "real-1" });
    await auth.signOut();
    expect(auth.getSession()).toMatchObject({ isAnonymous: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx jest authManager`
Expected: FAIL — `Cannot find module '../authManager'`

- [ ] **Step 3: Write the implementation**

Create `extension/src/authManager.ts`:

```typescript
import * as vscode from "vscode";

export interface AuthSession {
  uid: string;
  refreshToken: string;
  email?: string;
  displayName?: string;
  isAnonymous: boolean;
}

export interface SignInPayload {
  idToken: string;
  refreshToken: string;
  uid: string;
  email?: string;
  displayName?: string;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

const SESSION_KEY = "edupeer.authSession";
const PENDING_MIGRATION_KEY = "edupeer.pendingMigration";
const LEGACY_USER_ID_KEY = "edupeer.userId";
// Refresh 60s before expiry so a token is never presented mid-expiry.
const EXPIRY_MARGIN_MS = 60_000;

interface PendingMigration {
  oldRefreshToken?: string;
  legacyUserId?: string;
}

export class AuthManager {
  private idToken?: string;
  private idTokenExpiresAt = 0;
  private session?: AuthSession;
  private apiKey?: string;
  private emitter = new vscode.EventEmitter<AuthSession | undefined>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly secrets: SecretStore,
    private readonly globalState: StateStore,
    private baseUrl: string
  ) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
    this.apiKey = undefined;
  }

  async initialize(): Promise<void> {
    const raw = await this.secrets.get(SESSION_KEY);
    if (raw) {
      this.session = JSON.parse(raw) as AuthSession;
      this.emitter.fire(this.session);
    }
  }

  getSession(): AuthSession | undefined {
    return this.session;
  }

  async getIdToken(force = false): Promise<string> {
    if (!this.session) {
      await this.bootstrapAnonymous();
      return this.idToken!;
    }
    if (!force && this.idToken && Date.now() < this.idTokenExpiresAt - EXPIRY_MARGIN_MS) {
      return this.idToken;
    }
    return this.refresh();
  }

  async applySignIn(payload: SignInPayload): Promise<void> {
    const pending: PendingMigration = {};
    if (this.session?.isAnonymous) {
      pending.oldRefreshToken = this.session.refreshToken;
    }
    const legacy = this.globalState.get<string>(LEGACY_USER_ID_KEY);
    if (legacy) {
      pending.legacyUserId = legacy;
    }
    if (pending.oldRefreshToken || pending.legacyUserId) {
      await this.secrets.store(PENDING_MIGRATION_KEY, JSON.stringify(pending));
    }

    this.session = {
      uid: payload.uid,
      refreshToken: payload.refreshToken,
      email: payload.email,
      displayName: payload.displayName,
      isAnonymous: false,
    };
    this.idToken = payload.idToken;
    this.idTokenExpiresAt = Date.now() + 55 * 60_000;
    await this.persist();
    this.emitter.fire(this.session);
    await this.runPendingMigration();
  }

  async runPendingMigration(): Promise<void> {
    const raw = await this.secrets.get(PENDING_MIGRATION_KEY);
    if (!raw || !this.session || this.session.isAnonymous) {
      return;
    }
    const pending = JSON.parse(raw) as PendingMigration;
    try {
      let oldIdToken: string | undefined;
      if (pending.oldRefreshToken) {
        oldIdToken = (await this.exchangeRefreshToken(pending.oldRefreshToken)).idToken;
      }
      const token = await this.getIdToken();
      const res = await fetch(`${this.baseUrl}/auth/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          old_id_token: oldIdToken ?? null,
          legacy_user_id: pending.legacyUserId ?? null,
        }),
      });
      if (!res.ok) {
        throw new Error(`migrate failed (${res.status})`);
      }
      await this.secrets.delete(PENDING_MIGRATION_KEY);
      await this.globalState.update(LEGACY_USER_ID_KEY, undefined);
    } catch (err) {
      // Non-fatal: the pending record stays and is retried on next activation.
      console.error("[edupeer] migration deferred:", err);
    }
  }

  async signOut(): Promise<void> {
    this.session = undefined;
    this.idToken = undefined;
    await this.secrets.delete(SESSION_KEY);
    await this.bootstrapAnonymous();
  }

  private async getApiKey(): Promise<string> {
    if (!this.apiKey) {
      const res = await fetch(`${this.baseUrl}/auth/config`);
      if (!res.ok) {
        throw new Error(`auth config failed (${res.status})`);
      }
      this.apiKey = ((await res.json()) as { apiKey: string }).apiKey;
    }
    return this.apiKey;
  }

  private async bootstrapAnonymous(): Promise<void> {
    const key = await this.getApiKey();
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
      }
    );
    if (!res.ok) {
      throw new Error(`anonymous sign-in failed (${res.status})`);
    }
    const data = (await res.json()) as any;
    this.session = { uid: data.localId, refreshToken: data.refreshToken, isAnonymous: true };
    this.idToken = data.idToken;
    this.idTokenExpiresAt = Date.now() + parseInt(data.expiresIn, 10) * 1000;
    await this.persist();
    this.emitter.fire(this.session);
  }

  private async exchangeRefreshToken(
    refreshToken: string
  ): Promise<{ idToken: string; refreshToken: string; uid: string; expiresInMs: number }> {
    const key = await this.getApiKey();
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    if (!res.ok) {
      throw new Error(`Session expired — sign in again (${res.status})`);
    }
    const data = (await res.json()) as any;
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      uid: data.user_id,
      expiresInMs: parseInt(data.expires_in, 10) * 1000,
    };
  }

  private async refresh(): Promise<string> {
    const exchanged = await this.exchangeRefreshToken(this.session!.refreshToken);
    this.idToken = exchanged.idToken;
    this.idTokenExpiresAt = Date.now() + exchanged.expiresInMs;
    this.session = { ...this.session!, refreshToken: exchanged.refreshToken, uid: exchanged.uid };
    await this.persist();
    return this.idToken;
  }

  private async persist(): Promise<void> {
    await this.secrets.store(SESSION_KEY, JSON.stringify(this.session));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx jest authManager`
Expected: all pass. (The vscode mock's `EventEmitter` is already a jest mock returning `{event, fire, dispose}` — `onDidChange` wiring is exercised, not asserted.)

- [ ] **Step 5: Commit**

```bash
git add extension/src/authManager.ts extension/src/__tests__/authManager.test.ts
git commit -m "Add extension AuthManager with anonymous bootstrap and migration"
```

---

### Task 6: Browser sign-in flow with localhost callback

**Files:**
- Create: `extension/src/signInFlow.ts`
- Modify: `extension/src/__mocks__/vscode.ts` (add `env.openExternal`, give `Uri.parse` a real `toString`)
- Test: `extension/src/__tests__/signInFlow.test.ts`

**Interfaces:**
- Consumes: `SignInPayload` from Task 5; the POST payload shape produced by Task 2's auth page.
- Produces: `signInViaBrowser(baseUrl: string, timeoutMs?: number): Promise<SignInPayload>` and `parseCallbackPayload(body: string): SignInPayload` (exported for tests). Task 8 wires `signInViaBrowser` to the `edupeer.signIn` command.

- [ ] **Step 1: Update the vscode mock**

In `extension/src/__mocks__/vscode.ts`, replace the `Uri` block and add `env` (keep everything else):

```typescript
  Uri: {
    joinPath: jest.fn((...parts: any[]) => ({ fsPath: parts.join("/"), toString: () => parts.join("/") })),
    parse: jest.fn((s: string) => ({ fsPath: s, toString: () => s })),
  },
  env: {
    openExternal: jest.fn(async () => true),
  },
```

- [ ] **Step 2: Write the failing tests**

Create `extension/src/__tests__/signInFlow.test.ts`:

```typescript
import { parseCallbackPayload, signInViaBrowser } from "../signInFlow";

const vscode = require("vscode");

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("parseCallbackPayload", () => {
  it("parses a valid payload", () => {
    const p = parseCallbackPayload(
      JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u", email: "e@x.com", displayName: "E" })
    );
    expect(p).toEqual({ idToken: "i", refreshToken: "r", uid: "u", email: "e@x.com", displayName: "E" });
  });

  it("treats empty email/displayName as undefined", () => {
    const p = parseCallbackPayload(
      JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u", email: "", displayName: "" })
    );
    expect(p.email).toBeUndefined();
    expect(p.displayName).toBeUndefined();
  });

  it("throws on a payload missing required fields", () => {
    expect(() => parseCallbackPayload(JSON.stringify({ uid: "u" }))).toThrow();
    expect(() => parseCallbackPayload("not json")).toThrow();
  });
});

describe("signInViaBrowser", () => {
  afterEach(() => jest.clearAllMocks());

  it("opens the browser and resolves with the payload POSTed to /callback", async () => {
    const promise = signInViaBrowser("http://localhost:8000");
    const uri = await waitFor(() => vscode.env.openExternal.mock.calls[0]?.[0]);
    const url = new URL(uri.toString());
    expect(url.pathname).toBe("/auth/login");
    const port = url.searchParams.get("port");
    expect(port).toBeTruthy();

    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      body: JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u1", email: "", displayName: "" }),
    });
    expect(res.ok).toBe(true);
    const payload = await promise;
    expect(payload.uid).toBe("u1");
  });

  it("rejects after the timeout when no callback arrives", async () => {
    await expect(signInViaBrowser("http://localhost:8000", 100)).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd extension && npx jest signInFlow`
Expected: FAIL — `Cannot find module '../signInFlow'`

- [ ] **Step 4: Write the implementation**

Create `extension/src/signInFlow.ts`:

```typescript
import * as http from "http";
import * as vscode from "vscode";
import { SignInPayload } from "./authManager";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function parseCallbackPayload(body: string): SignInPayload {
  const data = JSON.parse(body);
  if (!data.idToken || !data.refreshToken || !data.uid) {
    throw new Error("invalid sign-in payload");
  }
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.uid,
    email: data.email || undefined,
    displayName: data.displayName || undefined,
  };
}

/**
 * Opens the hosted auth page in the user's browser and waits for it to POST
 * the sign-in payload back to a one-shot localhost server.
 */
export function signInViaBrowser(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SignInPayload> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // The auth page runs on the backend's origin; allow it to POST here.
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method !== "POST" || req.url !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const payload = parseCallbackPayload(body);
          res.end("ok");
          cleanup();
          resolve(payload);
        } catch {
          res.statusCode = 400;
          res.end("bad payload");
        }
      });
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Sign-in timed out — no response from the browser."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const base = baseUrl.replace(/\/$/, "");
      void vscode.env.openExternal(vscode.Uri.parse(`${base}/auth/login?port=${port}`));
    });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd extension && npx jest signInFlow`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add extension/src/signInFlow.ts extension/src/__tests__/signInFlow.test.ts extension/src/__mocks__/vscode.ts
git commit -m "Add browser sign-in flow with localhost callback"
```

---

### Task 7: ApiClient — Bearer tokens, 401 retry, no more user_id

**Files:**
- Modify: `extension/src/apiClient.ts`
- Modify: `extension/src/firebaseClient.ts` (`getBadges()` loses its parameter)
- Test: `extension/src/__tests__/apiClient.test.ts` (rewrite), `extension/src/__tests__/firebaseClient.test.ts` (update)

**Interfaces:**
- Consumes: a token provider matching `{ getIdToken(force?: boolean): Promise<string> }` — `AuthManager` (Task 5) satisfies this structurally.
- Produces (Task 8 call sites use exactly these):

```typescript
export interface TokenProvider { getIdToken(force?: boolean): Promise<string>; }
export interface HintRequest { code: string; question: string; hint_level: number; language?: string; history?: ChatTurn[]; }  // no user_id
export class ApiClient {
  constructor(baseUrl: string, tokens: TokenProvider);
  setBaseUrl(url: string): void;
  health(): Promise<boolean>;
  getHint(req: HintRequest): Promise<HintResponse>;
  resetSession(): Promise<void>;
  scanCode(code: string, language?: string): Promise<ScanResponse>;
  getLineHint(code: string, line: number, language?: string): Promise<LineHintResponse>;
  getBadges(): Promise<string[]>;
}
```

- [ ] **Step 1: Rewrite the tests**

Replace `extension/src/__tests__/apiClient.test.ts` with:

```typescript
import { ApiClient } from "../apiClient";

const BASE = "http://localhost:8000";

function mockFetch(status: number, body: any): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  (global as any).fetch = mock;
  return mock;
}

function makeTokens() {
  return {
    getIdToken: jest.fn(async (force?: boolean) => (force ? "fresh-token" : "stale-token")),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ApiClient.health", () => {
  it("returns true when /health responds 200", async () => {
    mockFetch(200, { status: "ok" });
    expect(await new ApiClient(BASE, makeTokens()).health()).toBe(true);
  });

  it("returns false when fetch throws (backend down)", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await new ApiClient(BASE, makeTokens()).health()).toBe(false);
  });
});

describe("authenticated requests", () => {
  const validResponse = { hint: "Think!", hint_level: 1, concept_tags: ["operators"] };

  it("attaches the Bearer token to /hint", async () => {
    const fetchMock = mockFetch(200, validResponse);
    const tokens = makeTokens();
    const api = new ApiClient(BASE, tokens);
    const req = { code: "x=1", question: "help", hint_level: 1 };
    await api.getHint(req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/hint`);
    expect(init.headers.Authorization).toBe("Bearer stale-token");
    expect(JSON.parse(init.body)).toEqual(req);
  });

  it("retries once with a forced refresh on 401", async () => {
    const responses = [
      { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" },
      { ok: true, status: 200, json: async () => validResponse, text: async () => "" },
    ];
    const fetchMock = jest.fn(async () => responses.shift());
    (global as any).fetch = fetchMock;
    const tokens = makeTokens();
    const api = new ApiClient(BASE, tokens);
    const res = await api.getHint({ code: "x", question: "q", hint_level: 1 });
    expect(res).toEqual(validResponse);
    expect(tokens.getIdToken).toHaveBeenCalledWith(false);
    expect(tokens.getIdToken).toHaveBeenCalledWith(true);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("throws with backend detail on persistent failure", async () => {
    mockFetch(502, { detail: "LLM error" });
    const api = new ApiClient(BASE, makeTokens());
    await expect(api.getHint({ code: "x", question: "q", hint_level: 1 })).rejects.toThrow(/502/);
  });

  it("sends POST /reset with no body fields", async () => {
    const fetchMock = mockFetch(200, { status: "reset", user_id: "uid" });
    await new ApiClient(BASE, makeTokens()).resetSession();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/reset`);
    expect(init.method).toBe("POST");
  });

  it("fetches GET /badges with the Bearer token", async () => {
    const fetchMock = mockFetch(200, ["First Question"]);
    const badges = await new ApiClient(BASE, makeTokens()).getBadges();
    expect(badges).toEqual(["First Question"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/badges`);
    expect(init.headers.Authorization).toBe("Bearer stale-token");
  });

  it("getBadges returns [] on error", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("down"));
    expect(await new ApiClient(BASE, makeTokens()).getBadges()).toEqual([]);
  });

  it("scanCode posts code and language only", async () => {
    const fetchMock = mockFetch(200, { flags: [] });
    await new ApiClient(BASE, makeTokens()).scanCode("x=1", "javascript");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: "x=1", language: "javascript" });
  });

  it("getLineHint posts code, line and language only", async () => {
    const fetchMock = mockFetch(200, { hint: "h", concept: "general" });
    await new ApiClient(BASE, makeTokens()).getLineHint("x=1", 3, "java");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: "x=1", line: 3, language: "java" });
  });
});
```

Update `extension/src/__tests__/firebaseClient.test.ts`: wherever it constructs an `ApiClient`, pass `makeTokens()`-style stub as the second argument, and change `getBadges("u1")` calls to `getBadges()` (both on `FirebaseClient` and in `expect` assertions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx jest apiClient`
Expected: FAIL — compile errors (constructor arity) and missing methods

- [ ] **Step 3: Rewrite `apiClient.ts`**

Keep the interfaces `ChatTurn`, `HintResponse`, `LineFlag`, `ScanResponse`, `LineHintResponse` unchanged. Remove `user_id` from `HintRequest`. Replace the class with:

```typescript
export interface TokenProvider {
  getIdToken(force?: boolean): Promise<string>;
}

export class ApiClient {
  constructor(private baseUrl: string, private readonly tokens: TokenProvider) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Fetch with a Bearer token; on 401, refresh the token once and retry. */
  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await this.tokens.getIdToken(force);
      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    };
    let res = await attempt(false);
    if (res.status === 401) {
      res = await attempt(true);
    }
    return res;
  }

  private async authedJson(path: string, body: unknown): Promise<Response> {
    return this.authedFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async getHint(req: HintRequest): Promise<HintResponse> {
    const res = await this.authedJson("/hint", req);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend error (${res.status}): ${text}`);
    }
    return (await res.json()) as HintResponse;
  }

  async resetSession(): Promise<void> {
    await this.authedFetch("/reset", { method: "POST" });
  }

  async scanCode(code: string, language = "python"): Promise<ScanResponse> {
    const res = await this.authedJson("/scan", { code, language });
    if (!res.ok) {
      throw new Error(`scan failed (${res.status})`);
    }
    return (await res.json()) as ScanResponse;
  }

  async getLineHint(code: string, line: number, language = "python"): Promise<LineHintResponse> {
    const res = await this.authedJson("/line-hint", { code, line, language });
    if (!res.ok) {
      throw new Error(`line-hint failed (${res.status})`);
    }
    return (await res.json()) as LineHintResponse;
  }

  async getBadges(): Promise<string[]> {
    try {
      const res = await this.authedFetch("/badges");
      if (!res.ok) {
        return [];
      }
      return (await res.json()) as string[];
    } catch {
      return [];
    }
  }
}
```

In `extension/src/firebaseClient.ts`, change `getBadges(userId: string)` to `getBadges()` and the delegation to `this.api.getBadges()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx jest apiClient firebaseClient`
Expected: all pass. (`npx tsc --noEmit -p .` will still fail — `sidebarProvider.ts`, `inlineTutor.ts`, `extension.ts` are updated in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add extension/src/apiClient.ts extension/src/firebaseClient.ts extension/src/__tests__/apiClient.test.ts extension/src/__tests__/firebaseClient.test.ts
git commit -m "Send Bearer tokens from ApiClient and drop client-supplied user ids"
```

---

### Task 8: Wire auth into the extension UI

**Files:**
- Modify: `extension/src/extension.ts`
- Modify: `extension/src/sidebarProvider.ts`
- Modify: `extension/src/inlineTutor.ts`
- Modify: `extension/media/main.js`
- Modify: `extension/media/style.css`
- Modify: `extension/package.json` (commands)

**Interfaces:**
- Consumes: `AuthManager` (Task 5), `signInViaBrowser` (Task 6), new `ApiClient` signatures (Task 7).
- Produces: commands `edupeer.signIn` / `edupeer.signOut`; webview messages `{type: "authState", signedIn, label}` (extension → webview) and `{type: "signIn"} | {type: "signOut"}` (webview → extension).

- [ ] **Step 1: Update `extension.ts`**

Replace the activation body up to the health check with:

```typescript
import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import { AuthManager } from "./authManager";
import { signInViaBrowser } from "./signInFlow";
import { FirebaseClient } from "./firebaseClient";
import { EduPeerSidebarProvider } from "./sidebarProvider";
import { InlineTutor } from "./inlineTutor";

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("edupeer");
  const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");

  const auth = new AuthManager(context.secrets, context.globalState, backendUrl);
  await auth.initialize();
  const api = new ApiClient(backendUrl, auth);
  const firebase = new FirebaseClient(api);
  const provider = new EduPeerSidebarProvider(context.extensionUri, context, api, firebase, auth);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EduPeerSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const tutor = new InlineTutor(context, api);
  tutor.activate();
  context.subscriptions.push({ dispose: () => tutor.dispose() });

  // Retry any migration that failed on a previous run.
  void auth.runPendingMigration();
```

Remove the `provider.getUserId();` line. After the existing `edupeer.resetSession` registration, add:

```typescript
  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.signIn", async () => {
      try {
        const payload = await signInViaBrowser(
          vscode.workspace.getConfiguration("edupeer").get<string>("backendUrl", "http://localhost:8000")
        );
        await auth.applySignIn(payload);
        vscode.window.showInformationMessage(
          `EduPeer: signed in as ${payload.displayName || payload.email || payload.uid}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`EduPeer sign-in failed: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.signOut", async () => {
      await auth.signOut();
      vscode.window.showInformationMessage("EduPeer: signed out.");
    })
  );
```

In the `onDidChangeConfiguration` handler, add `auth.setBaseUrl(url);` next to `api.setBaseUrl(url);`.

- [ ] **Step 2: Update `sidebarProvider.ts`**

- Delete `USER_ID_KEY`, `randomUserId()`, and `getUserId()` (the legacy globalState key is read only by `AuthManager` for migration).
- Add constructor param: `private readonly auth: AuthManager` (import `AuthManager` from `./authManager`), after `firebase`.
- In `resolveWebviewView`, add to the message switch:

```typescript
        case "signIn":
          await vscode.commands.executeCommand("edupeer.signIn");
          return;
        case "signOut":
          await vscode.commands.executeCommand("edupeer.signOut");
          return;
```

  and in the `"ready"` case add `this.postAuthState();`. After the `onDidChangeTextDocument` subscription, add:

```typescript
    this.auth.onDidChange(() => {
      this.postAuthState();
      void this.sendBadges();
    });
```

- Add the method:

```typescript
  private postAuthState(): void {
    const s = this.auth.getSession();
    const signedIn = !!s && !s.isAnonymous;
    this.post({
      type: "authState",
      signedIn,
      label: signedIn ? (s!.displayName || s!.email || s!.uid) : "Not signed in",
    });
  }
```

- `resetSession()`: drop the `userId` local and call `this.api.resetSession()`.
- `handleAsk()`: drop the `userId` local and the `user_id` field from the `getHint` call.
- `sendBadges()`: drop the `userId` local and call `this.firebase.getBadges()`.
- In `getHtml`, inside the `<header class="header">` element, after the `<h2>`:

```html
    <div class="account">
      <span id="accountLabel">Not signed in</span>
      <button id="authBtn" class="small-btn">Sign in</button>
    </div>
```

- [ ] **Step 3: Update `inlineTutor.ts`**

- Remove the third constructor parameter `private readonly getUserId: () => string`.
- `this.api.getLineHint(doc.getText(), line + 1, this.getUserId(), doc.languageId)` → `this.api.getLineHint(doc.getText(), line + 1, doc.languageId)`.
- `this.api.scanCode(code, this.getUserId(), doc.languageId)` → `this.api.scanCode(code, doc.languageId)`.

- [ ] **Step 4: Update the webview script and styles**

In `extension/media/main.js`, add after the other element lookups at the top:

```javascript
  const accountLabelEl = document.getElementById("accountLabel");
  const authBtn = document.getElementById("authBtn");
  let signedIn = false;

  authBtn.addEventListener("click", () => {
    vscode.postMessage({ type: signedIn ? "signOut" : "signIn" });
  });
```

Add a case to the `switch (msg.type)` inside the `window.addEventListener("message", ...)` handler (alongside `case "badges"`):

```javascript
      case "authState":
        signedIn = !!msg.signedIn;
        accountLabelEl.textContent = msg.label;
        authBtn.textContent = signedIn ? "Sign out" : "Sign in";
        break;
```

In `extension/media/style.css`, add:

```css
.account {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.85;
}
```

- [ ] **Step 5: Register the commands**

In `extension/package.json` `contributes.commands`, add:

```json
      {
        "command": "edupeer.signIn",
        "title": "EduPeer: Sign In"
      },
      {
        "command": "edupeer.signOut",
        "title": "EduPeer: Sign Out"
      }
```

- [ ] **Step 6: Compile and run the full extension suite**

Run: `cd extension && npm run compile && npx jest`
Expected: compile clean, all tests pass

- [ ] **Step 7: Commit**

```bash
git add extension/src extension/media extension/package.json
git commit -m "Wire sign-in, sign-out and account state into the extension UI"
```

---

### Task 9: Documentation, env template, and full verification

**Files:**
- Modify: `.env.example` (add web config vars)
- Modify: `README.md` (auth section, endpoint table, commands table, setup step)

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs and the manual E2E checklist.

- [ ] **Step 1: Update `.env.example`**

Add (with the same comment style the file already uses):

```
# Firebase web-app config (public values) — Console > Project settings > Your apps > Web app
FIREBASE_WEB_API_KEY=
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
```

- [ ] **Step 2: Update `README.md`**

- In the env-var list under Setup step 3, add `FIREBASE_WEB_API_KEY` and `FIREBASE_AUTH_DOMAIN` with one-line descriptions.
- In the Commands table, add `edupeer.signIn` ("Opens the browser to sign in with Google, GitHub, or email.") and `edupeer.signOut` ("Signs out and switches to a fresh anonymous profile.").
- In the Endpoints table: change `GET /badges/{uid}` to `GET /badges` ("Badges for the authenticated user."), add `GET /auth/config`, `GET /auth/login`, `POST /auth/migrate`, and note that all data endpoints require `Authorization: Bearer <Firebase ID token>`.
- Add a new `## Accounts and sign-in` section after "How hinting works":

```markdown
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
```

- [ ] **Step 3: Run both full suites**

Run: `cd backend && python -m pytest tests/ -v` then `cd extension && npm run compile && npx jest`
Expected: everything passes

- [ ] **Step 4: Manual E2E checklist (requires Firebase Console setup done)**

With the backend running and the Extension Development Host open:
1. Fresh install (clear globalState/secrets): sidebar shows "Not signed in"; asking a question works anonymously and awards "First Question".
2. Click Sign in → browser opens → Google sign-in → page shows "You're signed in" → sidebar shows your name; badges carried over from the anonymous session.
3. `EduPeer: Sign Out` → sidebar returns to "Not signed in"; asking still works (new anonymous account).
4. Sign in with email+password (create account mode), then GitHub.
5. Kill the backend mid-session → sidebar shows a friendly error, no crash.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md
git commit -m "Document accounts, sign-in setup and new auth endpoints"
```
