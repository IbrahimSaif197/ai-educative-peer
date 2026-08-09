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


def test_auth_page_keeps_the_editor_scheme_allow_list():
    res = client.get("/auth/login")
    for scheme in ["vscode", "vscode-insiders", "vscodium", "cursor", "windsurf"]:
        assert f'"{scheme}"' in res.text


def test_auth_page_keeps_the_port_and_state_gate():
    res = client.get("/auth/login")
    assert "/^\\d{1,5}$/" in res.text
    assert "/^[a-f0-9]{32}$/" in res.text


def test_auth_page_ships_both_provider_marks():
    res = client.get("/auth/login")
    # The four-colour Google G and the Octocat, inline rather than hotlinked.
    assert "#EA4335" in res.text
    assert "#4285F4" in res.text
    assert 'viewBox="0 0 16 16"' in res.text


def test_auth_page_translates_firebase_codes_into_sentences():
    res = client.get("/auth/login")
    assert "auth/wrong-password" in res.text
    assert "That password doesn't match this email." in res.text
    assert "No account for that email yet" in res.text


def test_auth_page_respects_reduced_motion():
    res = client.get("/auth/login")
    assert "prefers-reduced-motion" in res.text


def test_auth_page_labels_every_input():
    res = client.get("/auth/login")
    assert 'for="email"' in res.text
    assert 'for="password"' in res.text
    assert 'aria-live="polite"' in res.text


def test_auth_page_invalid_card_still_shows_without_a_port():
    res = client.get("/auth/login")
    # #done and #invalid hide via the native `hidden` attribute rather than a
    # CSS class, so only one of the three <main> cards is ever visible even
    # if the page's own stylesheet fails to load.
    assert 'id="done" hidden' in res.text
    assert 'id="invalid" hidden' in res.text
    assert 'document.getElementById("invalid").hidden = false;' in res.text
