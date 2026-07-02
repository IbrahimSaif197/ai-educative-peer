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
