"""Assistant sessions: the message tree (branches), session settings, forks,
the sessions API and the model-switch warnings."""

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

import app.llm as llm_mod
from app.chat import HEAD, ConversationStore
from app.db import Database
from app.main import app, provider_registry
from app.projects import ProjectStore

MAIN = "\\documentclass{article}\n\\begin{document}\nHello wrold.\n\\end{document}\n"


@pytest.fixture
def store(tmp_path):
    db = Database(str(tmp_path / "s.db"))
    s = ConversationStore(db)
    s.pid = ProjectStore(db).create("P", files={"main.tex": MAIN}).id
    return s


def contents(conv):
    return [m.content for m in conv.messages]


# -- the tree -------------------------------------------------------------------
def test_branches_from_edit_and_regenerate(store):
    c = store.create(store.pid)
    u1 = store.add_message(c.id, "user", "q1")
    a1 = store.add_message(c.id, "assistant", "a1")
    u2 = store.add_message(c.id, "user", "q2")
    store.add_message(c.id, "assistant", "a2")
    # regenerate a1: a sibling under u1
    a1b = store.add_message(c.id, "assistant", "a1 again", parent_id=u1.id)
    conv = store.get(c.id)
    assert contents(conv) == ["q1", "a1 again"]
    assert conv.messages[1].public()["branch"] == {"index": 1, "count": 2, "ids": [a1.id, a1b.id]}
    assert conv.message_count == 5 and conv.branch_count == 2
    # choose the first version again: its newest continuation comes back
    conv = store.select(c.id, a1.id)
    assert contents(conv) == ["q1", "a1", "q2", "a2"]
    assert [b["current"] for b in conv.branches] == [True, False]
    # edit the first message: a new root
    store.add_message(c.id, "user", "q1 edited", parent_id=None)
    conv = store.get(c.id)
    assert contents(conv) == ["q1 edited"] and conv.messages[0].public()["branch"]["count"] == 2
    # the model sees only the branch it answers
    assert store.history_for_model(c.id, budget=10, upto=u2.id)[1] == [
        {"role": "user", "content": "q1"}, {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "q2"}]
    assert store.history_for_model(c.id, budget=10, upto=None)[1] == []
    assert "q1" not in [m["content"] for m in store.history(c.id)]


def test_delete_message_removes_the_subtree_and_moves_the_head(store):
    c = store.create(store.pid)
    u1 = store.add_message(c.id, "user", "q1")
    a1 = store.add_message(c.id, "assistant", "a1")
    store.add_message(c.id, "user", "q2")
    a1b = store.add_message(c.id, "assistant", "a1b", parent_id=u1.id)
    assert store.delete_message(c.id, a1b.id) == 1
    assert contents(store.get(c.id)) == ["q1", "a1", "q2"]      # back to the other version
    assert store.delete_message(c.id, a1.id) == 2
    assert contents(store.get(c.id)) == ["q1"]
    assert store.delete_message(c.id, "nope") == 0


def test_summary_is_per_branch(store):
    c = store.create(store.pid)
    ids = []
    for i in range(6):
        ids.append(store.add_message(c.id, "user" if i % 2 == 0 else "assistant", f"m{i}").id)
    folded = []

    def summarize(prior, msgs):
        folded.append([m["content"] for m in msgs])
        return (prior + " " if prior else "") + "+".join(m["content"] for m in msgs)

    summary, recent = store.history_for_model(c.id, budget=2, summarize=summarize)
    assert summary == "m0+m1+m2+m3" and [m["content"] for m in recent] == ["m4", "m5"]
    # same branch: nothing re-summarised
    store.history_for_model(c.id, budget=2, summarize=summarize)
    assert len(folded) == 1
    # a branch that leaves before the summarised part doesn't inherit it
    store.add_message(c.id, "assistant", "alt", parent_id=ids[0])
    summary, recent = store.history_for_model(c.id, budget=4, summarize=summarize)
    assert summary == "" and [m["content"] for m in recent] == ["m0", "alt"]


def test_fork_settings_pin_search_and_export(store):
    c = store.create(store.pid, title="Typos", settings={"provider": "p", "model": "m1", "mode": "agent", "x": 1})
    assert c.settings == {"provider": "p", "model": "m1", "mode": "agent"}
    u1 = store.add_message(c.id, "user", "fix the typo")
    store.add_message(c.id, "assistant", "Fixed **wrold**.", meta={"model": "m1"})
    store.add_message(c.id, "user", "and more")
    f = store.fork(c.id, u1.id, settings={"model": "m2"})
    assert contents(f) == ["fix the typo"] and f.title == "Typos (split)"
    assert f.settings == {"provider": "p", "model": "m2", "mode": "agent"}
    assert f.forked_from["conversation_id"] == c.id and f.forked_from["messages"] == 1
    dup = store.fork(c.id)
    assert contents(dup) == ["fix the typo", "Fixed **wrold**.", "and more"] and dup.title == "Typos (copy)"
    assert store.get(c.id).message_count == 3                       # the source is untouched
    store.update(c.id, pinned=True, settings={"mode": "chat", "model": None})
    got = store.get(c.id)
    assert got.pinned and got.settings == {"provider": "p", "mode": "chat"}
    listing = store.list(store.pid)
    assert listing[0].id == c.id and listing[0].message_count == 3 and listing[0].preview == "and more"
    assert {x.id for x in store.list(store.pid, q="wrold")} == {c.id, dup.id}
    assert [x.id for x in store.list(store.pid, q="100%")] == []
    md = store.export_markdown(c.id)
    assert md.startswith("# Typos\n") and "## Assistant (m1)" in md and "Fixed **wrold**." in md


def test_old_flat_chats_are_linked_on_upgrade(tmp_path):
    path = str(tmp_path / "old.db")
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL DEFAULT 'New chat',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, skill TEXT, created_at TEXT NOT NULL);
        INSERT INTO conversations VALUES ('c1', NULL, 'Old', '2025-01-01', '2025-01-01');
        INSERT INTO messages VALUES ('a', 'c1', 'user', 'hi', NULL, '2025-01-01T00:00:00');
        INSERT INTO messages VALUES ('b', 'c1', 'assistant', 'hello', NULL, '2025-01-01T00:00:00');
        INSERT INTO messages VALUES ('c', 'c1', 'user', 'again', NULL, '2025-01-01T00:00:01');
    """)
    con.commit()
    con.close()
    s = ConversationStore(Database(path))
    conv = s.get("c1")
    assert contents(conv) == ["hi", "hello", "again"] and conv.head_id == "c"
    assert [m.parent_id for m in conv.messages] == [None, "a", "b"]
    assert s.add_message("c1", "assistant", "ok", parent_id=HEAD).parent_id == "c"


# -- API --------------------------------------------------------------------------
@pytest.fixture
def client():
    c = TestClient(app)
    provider_registry.save("fakeai", {"type": "openai", "api_base": "http://127.0.0.1:9/v1",
                                      "models": ["m1", "m2"], "api_key": "sk-fake-key-123456"}, create=True)
    provider_registry.save("notools", {"type": "openai", "api_base": "http://127.0.0.1:9/v1", "tools": False,
                                       "models": ["n1"], "api_key": "sk-fake-key-654321"}, create=True)
    yield c
    provider_registry.delete("fakeai")
    provider_registry.delete("notools")


def _sse(text):
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


def replies(*texts):
    calls = []

    def fake_chat(provider, model, system, messages, *, tools=None, max_tokens=0):
        calls.append({"model": model, "messages": [dict(m) for m in messages]})
        yield {"type": "text", "text": texts[min(len(calls) - 1, len(texts) - 1)]}
    return fake_chat, calls


def _session(client, **settings):
    p = client.post("/api/projects", json={"name": "S", "main_path": "main.tex", "files": {"main.tex": MAIN}}).json()
    conv = client.post(f"/api/projects/{p['id']}/conversations",
                       json={"title": "New chat", "settings": settings or None}).json()
    return p, conv


def test_sessions_crud_api(client):
    p, conv = _session(client, provider="fakeai", model="m1", mode="chat")
    cid = conv["id"]
    assert conv["settings"] == {"provider": "fakeai", "model": "m1", "mode": "chat"} and conv["messages"] == []
    assert client.post(f"/api/projects/{p['id']}/conversations",
                       json={"settings": {"mode": "bogus"}}).status_code == 422
    r = client.patch(f"/api/conversations/{cid}", json={"title": "Renamed", "pinned": True,
                                                         "settings": {"mode": "agent"}}).json()
    assert r["title"] == "Renamed" and r["pinned"] and r["settings"]["mode"] == "agent" and r["settings"]["model"] == "m1"
    r = client.patch(f"/api/conversations/{cid}", json={"settings": {"model": None}}).json()
    assert "model" not in r["settings"] and r["settings"]["provider"] == "fakeai"
    other = client.post(f"/api/projects/{p['id']}/conversations", json={"title": "Second"}).json()
    listing = client.get(f"/api/projects/{p['id']}/conversations").json()
    assert [c["title"] for c in listing] == ["Renamed", "Second"]          # pinned first
    assert [c["title"] for c in client.get(f"/api/projects/{p['id']}/conversations?q=second").json()] == ["Second"]
    r = client.get(f"/api/conversations/{cid}/export")
    assert r.status_code == 200 and r.text.startswith("# Renamed") and "Renamed.md" in r.headers["content-disposition"]
    client.patch(f"/api/conversations/{other['id']}", json={"title": "论文 摘要"})
    r = client.get(f"/api/conversations/{other['id']}/export")
    assert r.status_code == 200 and "filename*=UTF-8''%E8%AE%BA%E6%96%87-%E6%91%98%E8%A6%81.md" in r.headers["content-disposition"]
    assert client.delete(f"/api/conversations/{other['id']}").status_code == 204
    assert client.get(f"/api/conversations/{other['id']}").status_code == 404
    for path in ("select", "fork"):
        assert client.post(f"/api/conversations/nope/{path}", json={"message_id": "x"}).status_code == 404
    assert client.post(f"/api/conversations/{cid}/select", json={"message_id": "x"}).status_code == 404


def test_edit_regenerate_select_and_split_over_the_api(client, monkeypatch):
    fake, calls = replies("A1", "A2", "A1-again", "A1-edited")
    monkeypatch.setattr(llm_mod, "chat", fake)
    _, conv = _session(client)
    cid = conv["id"]
    turn = lambda **kw: _sse(client.post(f"/api/conversations/{cid}/agent",
                                         json={"provider": "fakeai", "mode": "chat", **kw}).text)
    turn(content="first question")
    turn(content="second question")
    msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert [m["content"] for m in msgs] == ["first question", "A1", "second question", "A2"]
    # regenerate the first reply: same user message, a second version
    evs = turn(regenerate=msgs[0]["id"])
    assert evs[0]["user_message"]["id"] == msgs[0]["id"]
    assert [m["content"] for m in calls[2]["messages"]] == ["first question"]
    got = client.get(f"/api/conversations/{cid}").json()
    assert [m["content"] for m in got["messages"]] == ["first question", "A1-again"]
    assert got["messages"][1]["branch"]["count"] == 2 and got["branch_count"] == 2
    # edit the first message: a new first message, answered without the old history
    turn(content="first, edited", parent_id="root")
    assert [m["content"] for m in calls[3]["messages"]] == ["first, edited"]
    got = client.get(f"/api/conversations/{cid}").json()
    assert got["messages"][0]["branch"] == {"index": 1, "count": 2, "ids": [msgs[0]["id"], got["messages"][0]["id"]]}
    # choose the original first message again → its latest branch (A1-again)
    got = client.post(f"/api/conversations/{cid}/select", json={"message_id": msgs[0]["id"]}).json()
    assert [m["content"] for m in got["messages"]] == ["first question", "A1-again"]
    got = client.post(f"/api/conversations/{cid}/select", json={"message_id": msgs[3]["id"]}).json()
    assert [m["content"] for m in got["messages"]] == ["first question", "A1", "second question", "A2"]
    assert len(got["branches"]) == 3 and sum(b["current"] for b in got["branches"]) == 1
    # split at A1 into a new session
    r = client.post(f"/api/conversations/{cid}/fork", json={"message_id": msgs[1]["id"]})
    assert r.status_code == 201
    new = r.json()
    assert [m["content"] for m in new["messages"]] == ["first question", "A1"]
    assert new["forked_from"]["conversation_id"] == cid and new["id"] != cid
    # delete a message and what follows it
    r = client.delete(f"/api/conversations/{cid}/messages/{msgs[2]['id']}").json()
    assert r["removed"] == 2 and [m["content"] for m in r["conversation"]["messages"]] == ["first question", "A1"]
    assert client.delete(f"/api/conversations/{cid}/messages/{msgs[2]['id']}").status_code == 404
    assert client.post(f"/api/conversations/{cid}/agent",
                       json={"provider": "fakeai", "content": "x", "parent_id": "ghost"}).status_code == 404
    assert client.post(f"/api/conversations/{cid}/agent",
                       json={"provider": "fakeai", "regenerate": msgs[1]["id"]}).status_code == 404


def test_session_remembers_its_model_and_warns_on_switch(client, monkeypatch):
    fake, _ = replies("ok")
    monkeypatch.setattr(llm_mod, "chat", fake)
    _, conv = _session(client)
    cid = conv["id"]
    check = lambda **kw: client.post(f"/api/conversations/{cid}/switch-check", json=kw).json()
    # an empty session switches freely
    assert check(provider="fakeai", model="m2")["warnings"] == []
    _sse(client.post(f"/api/conversations/{cid}/agent",
                     json={"provider": "fakeai", "model": "m1", "mode": "agent", "content": "hello " * 200}).text)
    got = client.get(f"/api/conversations/{cid}").json()
    assert got["settings"] == {"provider": "fakeai", "model": "m1", "mode": "agent"}
    same = check(provider="fakeai", model="m1")
    assert same["same"] and same["warnings"] == []
    r = check(provider="fakeai", model="m2")
    assert not r["same"] and r["from"] == {"provider": "fakeai", "model": "m1", "available": True}
    assert [w["kind"] for w in r["warnings"]] == ["cache"] and "KV cache" in r["warnings"][0]["text"]
    assert r["tokens"] >= 300
    r = check(provider="notools", model="n1")
    assert [w["kind"] for w in r["warnings"]] == ["cache", "tools", "provider"]
    assert client.post(f"/api/conversations/{cid}/switch-check", json={"provider": "ghost"}).status_code == 422
    # sending on another model records the switch on the reply and in the session
    evs = _sse(client.post(f"/api/conversations/{cid}/agent",
                           json={"provider": "fakeai", "model": "m2", "content": "next"}).text)
    assert evs[0]["switched_from"] == {"provider": "fakeai", "model": "m1"}
    assert evs[-1]["message"]["meta"]["switched_from"]["model"] == "m1"
    got = client.get(f"/api/conversations/{cid}").json()
    assert got["settings"]["model"] == "m2" and got["settings"]["mode"] == "agent"
    # the model it ran on disappears → a "missing" warning
    client.patch(f"/api/conversations/{cid}", json={"settings": {"provider": "gone", "model": "x"}})
    assert check(provider="fakeai", model="m1")["warnings"][0]["kind"] == "missing"


def test_long_chat_warns_about_memory_and_context(client, monkeypatch):
    from app.main import config
    monkeypatch.setattr(config.assistant, "history_budget_turns", 2)
    _, conv = _session(client, provider="fakeai", model="m1")
    cid = conv["id"]
    from app.main import chats
    for i in range(4):
        chats.add_message(cid, "user" if i % 2 == 0 else "assistant", "x" * 30_000,
                          meta={"usage": {"input": 30_000, "output": 10}} if i % 2 else None)
    r = client.post(f"/api/conversations/{cid}/switch-check", json={"provider": "fakeai", "model": "m2"}).json()
    kinds = [w["kind"] for w in r["warnings"]]
    assert kinds == ["cache", "memory", "context"] and r["tokens"] >= 30_000
