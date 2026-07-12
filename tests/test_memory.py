import pytest
from fastapi.testclient import TestClient

import app.llm as llm_mod
from app import assistant
from app.chat import ConversationStore
from app.db import Database
from app.main import app
from app.projects import ProjectStore

MAIN = r"\documentclass{article}\begin{document}\section{Intro}Hi.\end{document}"


@pytest.fixture
def client():
    return TestClient(app)


def _project(client):
    return client.post("/api/projects",
                       json={"name": "Mem", "files": {"main.tex": MAIN}}).json()["id"]


# -- project memory store ----------------------------------------------------
def test_project_memory_roundtrip(tmp_path):
    s = ProjectStore(Database(str(tmp_path / "p.db")))
    pid = s.create("P", files={"main.tex": MAIN}).id
    assert s.get_memory(pid) == ""
    assert s.set_memory(pid, "uses biblatex; journal = IEEE") is True
    assert s.get_memory(pid) == "uses biblatex; journal = IEEE"
    assert s.get_memory("ghost") == ""


def test_memory_endpoints(client):
    pid = _project(client)
    try:
        assert client.get(f"/api/projects/{pid}/memory").json()["memory"] == ""
        r = client.put(f"/api/projects/{pid}/memory", json={"memory": "prefers \\citet"})
        assert r.status_code == 200
        assert client.get(f"/api/projects/{pid}/memory").json()["memory"] == "prefers \\citet"
        assert client.put("/api/projects/ghost/memory", json={"memory": "x"}).status_code == 404
    finally:
        client.delete(f"/api/projects/{pid}")


def test_memory_injected_into_chat_system(client, monkeypatch):
    captured = []
    monkeypatch.setattr(llm_mod, "complete", lambda p, s, u, **k: captured.append(s) or "ok")
    pid = _project(client)
    try:
        client.put(f"/api/projects/{pid}/memory", json={"memory": "TARGET=IEEE template"})
        cid = client.post(f"/api/projects/{pid}/conversations", json={}).json()["id"]
        client.post(f"/api/conversations/{cid}/message",
                    json={"content": "hello", "source": MAIN})
        assert any("TARGET=IEEE template" in s for s in captured)
    finally:
        client.delete(f"/api/projects/{pid}")


# -- rolling summary (store level) -------------------------------------------
@pytest.fixture
def store(tmp_path):
    db = Database(str(tmp_path / "c.db"))
    s = ConversationStore(db)
    s.pid = ProjectStore(db).create("P", files={"main.tex": MAIN}).id
    return s


def test_history_for_model_folds_overflow(store):
    c = store.create(store.pid)
    for i in range(6):
        store.add_message(c.id, "user" if i % 2 == 0 else "assistant", f"m{i}")
    calls = []

    def summarize(prior, msgs):
        calls.append((prior, [m["content"] for m in msgs]))
        return "S1"

    summary, recent = store.history_for_model(c.id, budget=2, summarize=summarize)
    assert summary == "S1"
    assert [m["content"] for m in recent] == ["m4", "m5"]
    assert calls[0][1] == ["m0", "m1", "m2", "m3"]  # older turns folded in once

    # no new messages → no re-summarisation, summary reused
    calls.clear()
    summary2, recent2 = store.history_for_model(c.id, budget=2, summarize=summarize)
    assert calls == [] and summary2 == "S1"


def test_history_for_model_under_budget_no_summary(store):
    c = store.create(store.pid)
    store.add_message(c.id, "user", "only")
    summary, recent = store.history_for_model(
        c.id, budget=12, summarize=lambda p, m: pytest.fail("should not summarise"))
    assert summary == "" and [m["content"] for m in recent] == ["only"]


# -- rolling summary (end to end through the chat endpoint) -------------------
def test_summary_injected_when_history_exceeds_budget(client, monkeypatch):
    from app import main as m

    systems = []

    def fake(provider, system, user, **k):
        systems.append(system)
        return "SUMMARY-TEXT" if system == assistant.SUMMARY_SYSTEM else "reply"

    monkeypatch.setattr(llm_mod, "complete", fake)
    monkeypatch.setattr(m.config.assistant, "history_budget_turns", 2)
    pid = _project(client)
    try:
        cid = client.post(f"/api/projects/{pid}/conversations", json={}).json()["id"]
        for i in range(3):  # 3 turns → 6 messages, over the budget of 2
            client.post(f"/api/conversations/{cid}/message", json={"content": f"q{i}"})
        client.post(f"/api/conversations/{cid}/message", json={"content": "final"})
        # the summariser ran and the rolling summary reached a reply's system prompt
        assert any(s == assistant.SUMMARY_SYSTEM for s in systems)
        assert any("SUMMARY-TEXT" in s for s in systems if s != assistant.SUMMARY_SYSTEM)
    finally:
        client.delete(f"/api/projects/{pid}")
