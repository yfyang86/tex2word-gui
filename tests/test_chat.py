import pytest
from fastapi.testclient import TestClient

import app.llm as llm_mod
from app.chat import ChatError, ConversationStore
from app.db import Database
from app.main import app

MAIN = r"\documentclass{article}\begin{document}\section{Intro}Hi.\end{document}"


@pytest.fixture
def store(tmp_path):
    from app.projects import ProjectStore

    db = Database(str(tmp_path / "c.db"))
    store = ConversationStore(db)
    store.pid = ProjectStore(db).create("P", files={"main.tex": MAIN}).id
    return store


@pytest.fixture
def client():
    return TestClient(app)


# -- store -------------------------------------------------------------------
def test_create_list_get(store):
    c = store.create(store.pid, title="My chat")
    assert c.title == "My chat" and c.project_id == store.pid
    assert [x.id for x in store.list(store.pid)] == [c.id]
    assert store.list("other") == []
    got = store.get(c.id)
    assert got is not None and got.messages == []


def test_messages_and_history_order(store):
    c = store.create(store.pid)
    store.add_message(c.id, "user", "hello")
    store.add_message(c.id, "assistant", "hi there")
    store.add_message(c.id, "user", "more")
    hist = store.history(c.id)
    assert [m["role"] for m in hist] == ["user", "assistant", "user"]
    assert hist[0]["content"] == "hello"
    assert len(store.get(c.id).messages) == 3


def test_history_is_trimmed(store):
    c = store.create(store.pid)
    for i in range(30):
        store.add_message(c.id, "user", f"m{i}")
    hist = store.history(c.id, turns=5)
    assert len(hist) == 5 and hist[-1]["content"] == "m29"


def test_bad_role_and_unknown_conversation(store):
    c = store.create(store.pid)
    with pytest.raises(ChatError):
        store.add_message(c.id, "system", "x")
    with pytest.raises(ChatError):
        store.add_message("nope", "user", "x")


def test_delete_cascades_messages(store):
    c = store.create(store.pid)
    store.add_message(c.id, "user", "x")
    assert store.delete(c.id) is True
    rows = store.db.conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", (c.id,)
    ).fetchone()
    assert rows["n"] == 0


def test_project_delete_cascades_conversations(tmp_path):
    from app.projects import ProjectStore

    db = Database(str(tmp_path / "p.db"))
    projects = ProjectStore(db)
    chats = ConversationStore(db)
    pid = projects.create("P", files={"main.tex": MAIN}).id
    cid = chats.create(pid).id
    chats.add_message(cid, "user", "x")
    assert projects.delete(pid) is True
    assert chats.get(cid) is None  # cascaded away


# -- API ---------------------------------------------------------------------
def _project(client):
    return client.post("/api/projects", json={"name": "Chat", "files": {"main.tex": MAIN}}).json()["id"]


def test_conversation_api_lifecycle(client, monkeypatch):
    seen = []
    monkeypatch.setattr(llm_mod, "complete",
                        lambda p, s, u, **k: seen.append(k.get("history")) or "answer")
    pid = _project(client)
    try:
        cid = client.post(f"/api/projects/{pid}/conversations",
                          json={"title": "Q&A"}).json()["id"]
        assert any(c["id"] == cid for c in client.get(f"/api/projects/{pid}/conversations").json())

        # first turn → empty history
        r1 = client.post(f"/api/conversations/{cid}/message",
                         json={"content": "what is this?", "source": MAIN})
        assert r1.status_code == 200 and r1.json()["reply"] == "answer"
        # second turn → history carries the first exchange
        r2 = client.post(f"/api/conversations/{cid}/message", json={"content": "and now?"})
        assert r2.status_code == 200
        assert seen[0] == []
        assert [m["role"] for m in seen[1]] == ["user", "assistant"]
        assert seen[1][0]["content"] == "what is this?"

        # persisted transcript: 2 user + 2 assistant
        msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
        assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    finally:
        client.delete(f"/api/projects/{pid}")


def test_conversation_unknown_404(client):
    assert client.get("/api/conversations/nope").status_code == 404
    assert client.post("/api/conversations/nope/message",
                       json={"content": "x"}).status_code == 404
    assert client.post("/api/projects/ghost/conversations", json={}).status_code == 404


def test_chat_stream_persists_reply(client, monkeypatch):
    monkeypatch.setattr(llm_mod, "stream", lambda *a, **k: iter(["par", "tial"]))
    pid = _project(client)
    try:
        cid = client.post(f"/api/projects/{pid}/conversations", json={}).json()["id"]
        r = client.post(f"/api/conversations/{cid}/message/stream",
                        json={"content": "hi", "source": MAIN})
        assert r.status_code == 200
        assert '"delta": "par"' in r.text and '"done": true' in r.text
        msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
        assert msgs[-1]["role"] == "assistant" and msgs[-1]["content"] == "partial"
    finally:
        client.delete(f"/api/projects/{pid}")


def test_chat_with_custom_skill(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(llm_mod, "complete",
                        lambda p, s, u, **k: captured.setdefault("u", u) or "ok")
    from app.main import skill_store
    skill_store.delete("recap")
    skill_store.create("recap", "Recap", "Recap:{source}")
    pid = _project(client)
    try:
        cid = client.post(f"/api/projects/{pid}/conversations", json={}).json()["id"]
        r = client.post(f"/api/conversations/{cid}/message",
                        json={"content": "go", "source": MAIN, "skill": "recap"})
        assert r.status_code == 200
        assert "Recap:" in captured["u"]
    finally:
        skill_store.delete("recap")
        client.delete(f"/api/projects/{pid}")
