import pytest
from fastapi.testclient import TestClient

import app.llm as llm_mod
from app import assistant
from app.config import Provider
from app.main import app

SRC = r"\section{Intro}Energy is $E=mc^2$ and \notARealMacro{x}."
REPORT = {"entries": [{"severity": "warning", "construct": "math",
                       "message": r"fell back to raw LaTeX for \notARealMacro"}]}


@pytest.fixture
def client():
    return TestClient(app)


# -- prompt building --------------------------------------------------------
def test_fix_prompt_injects_report():
    p = assistant.build_prompt("fix", SRC, report=REPORT)
    assert "notARealMacro" in p          # the report entry is included
    assert "corrected LaTeX" in p
    assert SRC in p


def test_action_prompts_differ():
    assert "Explain" in assistant.build_prompt("explain", SRC)
    assert "writing quality" in assistant.build_prompt("polish", SRC)
    ask = assistant.build_prompt("ask", SRC, instruction="Is this valid?")
    assert "Is this valid?" in ask


def test_unknown_action_raises():
    with pytest.raises(ValueError):
        assistant.build_prompt("nope", SRC)


# -- llm dispatch -----------------------------------------------------------
def test_complete_without_key_raises():
    p = Provider(name="x", type="claude", model="m", api_base="", api_key=None)
    with pytest.raises(llm_mod.LLMError):
        llm_mod.complete(p, "sys", "user")


# -- endpoint ---------------------------------------------------------------
def test_assistant_success(client, monkeypatch):
    seen = {}

    def fake_complete(provider, system, user, **kw):
        seen["provider"] = provider.name
        seen["user"] = user
        return "Here is the explanation."

    monkeypatch.setattr(llm_mod, "complete", fake_complete)
    r = client.post("/api/assistant",
                    json={"action": "explain", "source": SRC, "provider": "deepseek"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reply"] == "Here is the explanation."
    assert body["provider"] == "deepseek"
    assert body["model"] == "deepseek-chat"
    assert body["is_code"] is False
    assert seen["provider"] == "deepseek"


def test_assistant_fix_is_code_and_uses_report(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(llm_mod, "complete",
                        lambda p, s, u, **k: captured.setdefault("u", u) or "\\section{Intro}fixed")
    r = client.post("/api/assistant",
                    json={"action": "fix", "source": SRC, "report": REPORT})
    assert r.status_code == 200, r.text
    assert r.json()["is_code"] is True
    assert "notARealMacro" in captured["u"]  # report flowed into the prompt


def test_assistant_no_key_is_422(client):
    # the 'openai' provider has no key (OPENAI_API_KEY unset)
    r = client.post("/api/assistant",
                    json={"action": "explain", "source": SRC, "provider": "openai"})
    assert r.status_code == 422
    assert "no API key" in r.json()["detail"]


def test_assistant_unknown_provider_422(client):
    r = client.post("/api/assistant",
                    json={"action": "explain", "source": SRC, "provider": "ghost"})
    assert r.status_code == 422


def test_assistant_unknown_action_422(client):
    r = client.post("/api/assistant", json={"action": "destroy", "source": SRC})
    assert r.status_code == 422


def test_assistant_llm_error_is_502(client, monkeypatch):
    def boom(*a, **k):
        raise llm_mod.LLMError("upstream down")

    monkeypatch.setattr(llm_mod, "complete", boom)
    r = client.post("/api/assistant",
                    json={"action": "explain", "source": SRC, "provider": "deepseek"})
    assert r.status_code == 502
    assert "upstream down" in r.json()["detail"]


# -- @-context --------------------------------------------------------------
def test_context_files_flow_into_prompt():
    p = assistant.build_prompt(
        "ask", SRC, instruction="Does it match?",
        context=[{"path": "refs.bib", "content": "@book{x, title={Algebra}}"}],
    )
    assert "refs.bib" in p and "Algebra" in p


def test_assistant_endpoint_passes_context(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(llm_mod, "complete",
                        lambda p, s, u, **k: captured.setdefault("u", u) or "ok")
    r = client.post("/api/assistant", json={
        "action": "ask", "source": SRC, "instruction": "?",
        "context": [{"path": "sections/two.tex", "content": "\\section{Two}"}],
    })
    assert r.status_code == 200, r.text
    assert "sections/two.tex" in captured["u"]


# -- streaming --------------------------------------------------------------
def test_assistant_stream_emits_deltas_and_done(client, monkeypatch):
    monkeypatch.setattr(llm_mod, "stream",
                        lambda *a, **k: iter(["Hel", "lo ", "world"]))
    r = client.post("/api/assistant/stream",
                    json={"action": "explain", "source": SRC, "provider": "deepseek"})
    assert r.status_code == 200, r.text
    assert "text/event-stream" in r.headers["content-type"]
    body = r.text
    assert '"delta": "Hel"' in body
    assert '"delta": "world"' in body
    assert '"done": true' in body
    assert '"is_code": false' in body


def test_assistant_stream_fix_is_code(client, monkeypatch):
    monkeypatch.setattr(llm_mod, "stream", lambda *a, **k: iter(["\\section{x}"]))
    r = client.post("/api/assistant/stream",
                    json={"action": "fix", "source": SRC})
    assert r.status_code == 200
    assert '"is_code": true' in r.text


def test_assistant_stream_llm_error_is_event(client, monkeypatch):
    def boom(*a, **k):
        raise llm_mod.LLMError("boom")
        yield  # pragma: no cover  (make it a generator)

    monkeypatch.setattr(llm_mod, "stream", boom)
    r = client.post("/api/assistant/stream",
                    json={"action": "explain", "source": SRC, "provider": "deepseek"})
    # validation passed → 200, the error surfaces as an SSE event, not an HTTP code
    assert r.status_code == 200
    assert '"error": "boom"' in r.text


def test_assistant_stream_unknown_provider_422(client):
    r = client.post("/api/assistant/stream",
                    json={"action": "explain", "source": SRC, "provider": "ghost"})
    assert r.status_code == 422


def test_assistant_stream_no_key_is_422(client):
    r = client.post("/api/assistant/stream",
                    json={"action": "explain", "source": SRC, "provider": "openai"})
    assert r.status_code == 422
