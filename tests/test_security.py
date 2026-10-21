import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app

MAIN = r"\documentclass{article}\begin{document}\section{Intro}Hi.\end{document}"


@pytest.fixture
def client():
    return TestClient(app)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


# -- body-size limit ---------------------------------------------------------
def test_body_too_large_is_413(client, monkeypatch):
    from app import main as m

    monkeypatch.setattr(m.config.security, "max_body_mb", 0)  # any body is too big
    r = client.post("/api/projects", json={"name": "x", "files": {"main.tex": "hi"}})
    assert r.status_code == 413
    assert "too large" in r.json()["detail"]


# -- rate limiting -----------------------------------------------------------
def test_rate_limit_returns_429(client, monkeypatch):
    from app import main as m

    monkeypatch.setattr(m.config.security, "login_rate_limit_per_min", 2)
    m.rate_limiter.enabled = True
    m.rate_limiter.reset()
    try:
        codes = [client.post("/api/auth/login",
                             json={"username": "x", "password": "y"}).status_code
                 for _ in range(4)]
    finally:
        m.rate_limiter.enabled = False
    # auth is off → login itself is 400, but the limiter still counts the hits
    assert codes[0] == 400 and codes[1] == 400
    assert 429 in codes[2:]


# -- authorization / ownership ----------------------------------------------
@pytest.fixture
def authctx():
    from app import main as m

    priv, pub = auth.generate_keypair()
    prev = (m.authn.enabled, m.authn.private_key, m.authn.public_key)
    m.authn.enabled, m.authn.private_key, m.authn.public_key = True, priv, pub
    for u in ("alice", "bob", "root"):
        m.users.delete(u)
    m.users.create("alice", "pw_alice1")
    m.users.create("bob", "pw_bob1234")
    m.users.create("root", "pw_root1234", role="admin")
    ctx = {
        "m": m,
        "alice": m.authn.issue_token(subject="alice", role="user"),
        "bob": m.authn.issue_token(subject="bob", role="user"),
        "root": m.authn.issue_token(subject="root", role="admin"),
    }
    yield ctx
    m.authn.enabled, m.authn.private_key, m.authn.public_key = prev
    for u in ("alice", "bob", "root"):
        m.users.delete(u)


def test_projects_are_owner_scoped(client, authctx):
    ha, hb, hr = _h(authctx["alice"]), _h(authctx["bob"]), _h(authctx["root"])
    pid = client.post("/api/projects",
                      json={"name": "alice doc", "files": {"main.tex": MAIN}},
                      headers=ha).json()["id"]
    try:
        # owner: listed + full access
        assert any(p["id"] == pid for p in client.get("/api/projects", headers=ha).json())
        assert client.get(f"/api/projects/{pid}", headers=ha).status_code == 200
        # other user: not listed, and 403 on read + mutate
        assert all(p["id"] != pid for p in client.get("/api/projects", headers=hb).json())
        assert client.get(f"/api/projects/{pid}", headers=hb).status_code == 403
        assert client.delete(f"/api/projects/{pid}", headers=hb).status_code == 403
        assert client.put(f"/api/projects/{pid}/memory",
                          json={"memory": "x"}, headers=hb).status_code == 403
        # admin: sees and accesses everything
        assert any(p["id"] == pid for p in client.get("/api/projects", headers=hr).json())
        assert client.get(f"/api/projects/{pid}", headers=hr).status_code == 200
    finally:
        client.delete(f"/api/projects/{pid}", headers=ha)


def test_conversation_inherits_project_scope(client, authctx):
    ha, hb = _h(authctx["alice"]), _h(authctx["bob"])
    pid = client.post("/api/projects",
                      json={"name": "ac", "files": {"main.tex": MAIN}},
                      headers=ha).json()["id"]
    try:
        cid = client.post(f"/api/projects/{pid}/conversations", json={}, headers=ha).json()["id"]
        assert client.get(f"/api/conversations/{cid}", headers=ha).status_code == 200
        assert client.get(f"/api/conversations/{cid}", headers=hb).status_code == 403
    finally:
        client.delete(f"/api/projects/{pid}", headers=ha)


def test_unowned_project_is_shared(client, authctx):
    # a legacy project created while auth was off (owner_id NULL) stays visible
    m = authctx["m"]
    pid = m.projects.create("legacy", files={"main.tex": MAIN}).id
    try:
        assert client.get(f"/api/projects/{pid}", headers=_h(authctx["bob"])).status_code == 200
    finally:
        m.projects.delete(pid)


def test_creating_user_owns_the_project(client, authctx):
    # with auth on, a created project is stamped with the caller and not shared
    ha, hb = _h(authctx["alice"]), _h(authctx["bob"])
    pid = client.post("/api/projects",
                      json={"name": "owned", "files": {"main.tex": MAIN}},
                      headers=ha).json()["id"]
    try:
        exists, owner = authctx["m"].projects.owner_info(pid)
        assert exists and owner == "alice"
        assert client.get(f"/api/projects/{pid}", headers=hb).status_code == 403
    finally:
        client.delete(f"/api/projects/{pid}", headers=ha)


def test_assistant_configuration_is_admin_only(client, authctx):
    ha, hr = _h(authctx["alice"]), _h(authctx["root"])
    body = {"name": "secured", "models": ["m"], "api_key": "sk-admin-only-123456"}
    # a regular user can use the assistant's lists but not change them
    assert client.get("/api/providers", headers=ha).json()["can_manage"] is False
    assert client.post("/api/providers", json=body, headers=ha).status_code == 403
    assert client.post("/api/skills", json={"name": "x-skill", "prompt": "p"}, headers=ha).status_code == 403
    assert client.post("/api/prompts", json={"title": "t", "body": "b"}, headers=ha).status_code == 403
    assert client.put("/api/assistant/settings", json={"max_steps": 3}, headers=ha).status_code == 403
    assert client.put("/api/assistant/defaults", json={}, headers=ha).status_code == 403
    try:
        assert client.post("/api/providers", json=body, headers=hr).status_code == 201
        listed = client.get("/api/providers", headers=ha).json()
        mine = next(p for p in listed["providers"] if p["name"] == "secured")
        assert mine["has_key"] and "key_hint" not in mine and listed["presets"] == []
        assert client.post("/api/providers/secured/test", json={}, headers=ha).status_code == 403
        assert client.patch("/api/providers/secured", json={"api_key": "x"}, headers=ha).status_code == 403
    finally:
        client.delete("/api/providers/secured", headers=hr)
