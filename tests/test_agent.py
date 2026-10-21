"""The tex-copilot agent: tools on a staged workspace, the tool loop, and the
chat API around it (SSE turn, change review, truncate), with a scripted model."""

import json

import pytest
from fastapi.testclient import TestClient

import app.llm as llm_mod
from app import agent
from app.config import Provider
from app.main import app, provider_registry

MAIN = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{sec:intro}\nHello wrold.\n\\input{sec/a}\n\\end{document}\n"
A = "\\section{A}\nSee \\cite{knuth}.\n"


def ws():
    return agent.Workspace(files={"main.tex": MAIN, "sec/a.tex": A}, binary={"fig.png"}, main="main.tex")


# -- tools -------------------------------------------------------------------------
def test_read_list_search_outline():
    t = agent.Tools(ws())
    ok, text, summary = t.run("read_file", {"path": "main.tex", "start_line": 3, "end_line": 4})
    assert ok and text.splitlines()[0] == "3| \\section{Intro}\\label{sec:intro}" and "of 7" in summary
    ok, text, _ = t.run("list_files", {})
    assert "main.tex (" in text and "main" in text and "fig.png (binary)" in text
    ok, text, summary = t.run("search", {"query": "\\cite"})
    assert text == "sec/a.tex:2: See \\cite{knuth}." and "1 match" in summary
    ok, text, _ = t.run("search", {"query": "w.old", "regex": True})
    assert "main.tex:4" in text
    ok, text, _ = t.run("outline", {"path": "main.tex"})
    assert "3: \\section{Intro}" in text and "\\label{sec:intro}" in text and "\\input{sec/a}" in text


def test_tool_errors_are_returned_to_the_model():
    t = agent.Tools(ws())
    for name, args, needle in [
        ("read_file", {"path": "nope.tex"}, "no such file"),
        ("read_file", {"path": "a.tex"}, "did you mean sec/a.tex"),
        ("read_file", {"path": "fig.png"}, "binary"),
        ("read_file", {"path": "../etc/passwd"}, "invalid path"),
        ("edit_file", {"path": "main.tex", "old_text": "absent", "new_text": "x"}, "not found"),
        ("edit_file", {"path": "main.tex", "old_text": "\\", "new_text": "x"}, "matches"),
        ("write_file", {"path": "evil.sh", "content": "rm"}, "only text files"),
        ("search", {"query": "(", "regex": True}, "bad regular expression"),
        ("frobnicate", {}, "unknown tool"),
        ("read_file", {"_raw": "{"}, "not valid JSON"),
        ("check", {}, "not available"),
    ]:
        ok, text, _ = t.run(name, args)
        assert not ok and needle in text, (name, text)


def test_edits_are_staged_and_visible_to_later_reads():
    w = ws()
    t = agent.Tools(w, check=lambda ws: {"counts": {"warnings": 1, "errors": 0}, "summary": "ok",
                                         "entries": [{"severity": "warning", "construct": "cite", "message": "x"}]})
    ok, text, summary = t.run("edit_file", {"path": "main.tex", "old_text": "wrold", "new_text": "world"})
    assert ok and "line 4" in summary
    assert w.files["main.tex"] == MAIN                     # the project is untouched
    assert "Hello world." in t.run("read_file", {"path": "main.tex"})[1]
    ok, _, _ = t.run("write_file", {"path": "sec/b.tex", "content": "New."})
    ok, text, summary = t.run("check", {})
    assert "1 warning(s)" in text and summary == "1 warning, 0 errors"
    changes = w.changes()
    assert [(c["path"], c["before"] is None) for c in changes] == [("main.tex", False), ("sec/b.tex", True)]
    # a hint when line numbers were pasted into old_text
    ok, text, _ = t.run("edit_file", {"path": "main.tex", "old_text": "4| Hello world.", "new_text": "x"})
    assert not ok and "line-number prefixes" in text


# -- the loop with a scripted model ------------------------------------------------
PROVIDER = Provider("fake", "openai", "m", "", api_key="sk-fake")


def script(*turns):
    """A fake llm.chat that plays one list of events per call."""
    calls = []

    def fake_chat(provider, model, system, messages, *, tools=None, max_tokens=0):
        calls.append({"messages": [dict(m) for m in messages], "tools": tools})
        turn = turns[min(len(calls) - 1, len(turns) - 1)]
        if isinstance(turn, Exception):
            raise turn
        yield from turn
    return fake_chat, calls


def test_loop_runs_tools_until_the_model_stops(monkeypatch):
    fake, calls = script(
        [{"type": "text", "text": "Let me read it."},
         {"type": "tool_call", "id": "t1", "name": "read_file", "arguments": {"path": "main.tex"}},
         {"type": "usage", "input": 10, "output": 5}],
        [{"type": "tool_call", "id": "t2", "name": "edit_file",
          "arguments": {"path": "main.tex", "old_text": "wrold", "new_text": "world"}}],
        [{"type": "text", "text": "Fixed the typo."}, {"type": "usage", "input": 3, "output": 2}],
    )
    monkeypatch.setattr(llm_mod, "chat", fake)
    w = ws()
    evs = list(agent.run(PROVIDER, "m", "SYS", [{"role": "user", "content": "fix"}], agent.Tools(w)))
    kinds = [e["type"] for e in evs]
    assert kinds == ["text", "tool_start", "tool_end", "tool_start", "tool_end", "text", "usage", "changes"]
    assert evs[-2] == {"type": "usage", "input": 13, "output": 7}
    assert evs[-1]["changes"][0]["after"].count("world") == 1
    # the model saw the tool results, in order
    second = calls[1]["messages"]
    assert second[-2]["tool_calls"][0]["id"] == "t1" and second[-1]["role"] == "tool"
    assert "Hello wrold" in second[-1]["content"]
    assert calls[0]["tools"] is agent.TOOLS


def test_chat_mode_sends_no_tools_and_step_limit(monkeypatch):
    fake, calls = script([{"type": "text", "text": "Hi."}])
    monkeypatch.setattr(llm_mod, "chat", fake)
    evs = list(agent.run(PROVIDER, "m", "S", [{"role": "user", "content": "x"}], None))
    assert [e["type"] for e in evs] == ["text"] and calls[0]["tools"] is None
    loop, _ = script([{"type": "tool_call", "id": "t", "name": "list_files", "arguments": {}}])
    monkeypatch.setattr(llm_mod, "chat", loop)
    evs = list(agent.run(PROVIDER, "m", "S", [{"role": "user", "content": "x"}], agent.Tools(ws()), max_steps=3))
    assert evs[-1]["type"] == "notice" and "3 steps" in evs[-1]["text"]


def test_falls_back_when_the_model_rejects_tools(monkeypatch):
    fake, calls = script(llm_mod.LLMError("tools not supported", tools_unsupported=True),
                         [{"type": "text", "text": "Plain answer."}])
    monkeypatch.setattr(llm_mod, "chat", fake)
    evs = list(agent.run(PROVIDER, "m", "S", [{"role": "user", "content": "x"}], agent.Tools(ws())))
    assert evs[0]["type"] == "notice" and evs[1] == {"type": "text", "text": "Plain answer."}
    assert calls[1]["tools"] is None


# -- API ---------------------------------------------------------------------------
@pytest.fixture
def client():
    c = TestClient(app)
    provider_registry.save("fakeai", {"type": "openai", "api_base": "http://127.0.0.1:9/v1",
                                      "models": ["m1", "m2"], "api_key": "sk-fake-key-123456"}, create=True)
    yield c
    provider_registry.delete("fakeai")


def _sse(text):
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


def _setup(client):
    p = client.post("/api/projects", json={"name": "Agent", "main_path": "main.tex",
                                           "files": {"main.tex": MAIN, "sec/a.tex": A}}).json()
    conv = client.post(f"/api/projects/{p['id']}/conversations", json={"title": "Chat"}).json()
    return p, conv


def test_agent_turn_streams_persists_and_applies(client, monkeypatch):
    fake, calls = script(
        [{"type": "tool_call", "id": "t1", "name": "edit_file",
          "arguments": {"path": "main.tex", "old_text": "wrold", "new_text": "world"}}],
        [{"type": "text", "text": "I fixed **one** typo."}],
    )
    monkeypatch.setattr(llm_mod, "chat", fake)
    p, conv = _setup(client)
    r = client.post(f"/api/conversations/{conv['id']}/agent", json={
        "content": "fix typos", "provider": "fakeai", "model": "m2", "active_file": "main.tex",
        "selection": "Hello wrold.", "selection_lines": [4, 4], "cursor_line": 4, "files": ["sec/a.tex"]})
    assert r.status_code == 200, r.text
    evs = _sse(r.text)
    assert [e["type"] for e in evs] == ["start", "tool_start", "tool_end", "text", "changes", "done"]
    assert evs[0]["model"] == "m2" and evs[0]["mode"] == "agent"
    first = calls[0]["messages"][-1]["content"]
    assert "Open file: main.tex (cursor on line 4)" in first and "lines 4–4" in first and "sec/a.tex" in first
    msg = evs[-1]["message"]
    assert msg["meta"]["steps"][0]["ok"] and msg["meta"]["changes"][0]["status"] == "pending"
    assert "Proposed edits to: main.tex" in msg["content"]
    # nothing written yet
    files = {f["path"]: f["content"] for f in client.get(f"/api/projects/{p['id']}").json()["files"]}
    assert "wrold" in files["main.tex"]
    # the conversation took its title from the first message, and stores both turns
    got = client.get(f"/api/conversations/{conv['id']}").json()
    assert got["title"] == "fix typos" and [m["role"] for m in got["messages"]] == ["user", "assistant"]
    # apply
    r = client.post(f"/api/conversations/{conv['id']}/messages/{msg['id']}/changes", json={"action": "apply"}).json()
    assert r["changes"][0]["status"] == "applied" and r["written"][0]["path"] == "main.tex"
    files = {f["path"]: f["content"] for f in client.get(f"/api/projects/{p['id']}").json()["files"]}
    assert "Hello world." in files["main.tex"]


def test_conflicting_change_is_not_written(client, monkeypatch):
    fake, _ = script([{"type": "tool_call", "id": "t1", "name": "edit_file",
                       "arguments": {"path": "main.tex", "old_text": "wrold", "new_text": "world"}}],
                     [{"type": "text", "text": "Done."}])
    monkeypatch.setattr(llm_mod, "chat", fake)
    p, conv = _setup(client)
    msg = _sse(client.post(f"/api/conversations/{conv['id']}/agent",
                           json={"content": "fix", "provider": "fakeai"}).text)[-1]["message"]
    client.put(f"/api/projects/{p['id']}/files/main.tex", json={"content": "changed meanwhile"})
    r = client.post(f"/api/conversations/{conv['id']}/messages/{msg['id']}/changes", json={"action": "apply"}).json()
    assert r["changes"][0]["status"] == "conflict" and r["written"] == []
    r = client.post(f"/api/conversations/{conv['id']}/messages/{msg['id']}/changes", json={"action": "reject"}).json()
    assert r["changes"][0]["status"] == "rejected"


def test_errors_skills_chat_mode_and_truncate(client, monkeypatch):
    p, conv = _setup(client)
    cid = conv["id"]
    assert client.post(f"/api/conversations/{cid}/agent", json={"content": "", "provider": "fakeai"}).status_code == 422
    assert client.post(f"/api/conversations/{cid}/agent", json={"content": "x", "provider": "nope"}).status_code == 422
    assert client.post(f"/api/conversations/{cid}/agent",
                       json={"content": "x", "provider": "fakeai", "skill": "nope"}).status_code == 422
    # a model error ends the stream with an error event and still records the turn
    fail, _ = script(llm_mod.LLMError("rate limited"))
    monkeypatch.setattr(llm_mod, "chat", fail)
    evs = _sse(client.post(f"/api/conversations/{cid}/agent", json={"content": "hi", "provider": "fakeai"}).text)
    assert evs[-1]["type"] == "error" and "rate limited" in evs[-1]["error"]
    # /explain is a chat-mode skill: no tools, the open file's text inline
    fake, calls = script([{"type": "text", "text": "It greets."}])
    monkeypatch.setattr(llm_mod, "chat", fake)
    evs = _sse(client.post(f"/api/conversations/{cid}/agent", json={
        "content": "briefly", "skill": "explain", "provider": "fakeai", "active_file": "main.tex"}).text)
    assert evs[0]["mode"] == "chat" and calls[0]["tools"] is None
    sent = calls[0]["messages"][-1]["content"]
    assert "File `main.tex`" in sent and "Hello wrold" in sent and "briefly" in sent
    assert evs[0]["user_message"]["content"] == "/explain briefly"
    msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert len(msgs) == 4
    # edit & resend: drop a message and everything after it
    assert client.post(f"/api/conversations/{cid}/truncate", json={"message_id": msgs[2]["id"]}).json() == {"removed": 2}
    assert len(client.get(f"/api/conversations/{cid}").json()["messages"]) == 2


# -- skills & prompts CRUD -----------------------------------------------------------
def test_skills_and_prompts_crud(client):
    r = client.post("/api/skills", json={"name": "shorten", "title": "Shorten",
                                         "prompt": "Shorten {selection}. {input}", "mode": "agent"})
    assert r.status_code == 201 and r.json()["prompt"].startswith("Shorten")
    r = client.patch("/api/skills/shorten", json={"description": "Cut words", "mode": "chat"})
    assert r.json()["mode"] == "chat" and r.json()["description"] == "Cut words"
    listing = {s["name"]: s for s in client.get("/api/skills").json()}
    assert listing["fix"]["scope"] == "builtin" and "{file}" in listing["fix"]["prompt"]
    assert listing["shorten"]["scope"] == "custom"
    assert client.patch("/api/skills/fix", json={"title": "x"}).status_code == 422
    assert client.delete("/api/skills/fix").status_code == 422
    assert client.post("/api/skills", json={"name": "has space", "prompt": "x"}).status_code == 422
    assert client.delete("/api/skills/shorten").status_code == 204
    assert client.delete("/api/skills/shorten").status_code == 404

    pr = client.post("/api/prompts", json={"title": "Review", "body": "Review {file} for clarity."}).json()
    assert pr["id"] and client.get("/api/prompts").json()[0]["title"] == "Review"
    assert client.patch(f"/api/prompts/{pr['id']}", json={"title": "Review it"}).json()["title"] == "Review it"
    assert client.patch(f"/api/prompts/{pr['id']}", json={"body": " "}).status_code == 422
    assert client.patch("/api/prompts/nope", json={"title": "x"}).status_code == 404
    assert client.delete(f"/api/prompts/{pr['id']}").status_code == 204


def test_render_skill_fills_file_and_selection():
    from app import skills
    s = skills.BUILTINS["polish"]
    with_sel = skills.render_skill(s, file="a.tex", selection="Some text", user_input="formal")
    assert "this selection from `a.tex`" in with_sel and "Some text" in with_sel and with_sel.endswith("formal")
    assert "`a.tex`" in skills.render_skill(s, file="a.tex", selection=None, user_input="")
