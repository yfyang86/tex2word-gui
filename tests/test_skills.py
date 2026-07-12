import pytest
from fastapi.testclient import TestClient

import app.llm as llm_mod
from app import skills
from app.db import Database
from app.main import app
from app.skills import SkillError, SkillStore

SRC = r"\section{Intro}Energy is $E=mc^2$."


@pytest.fixture
def store(tmp_path):
    return SkillStore(Database(str(tmp_path / "s.db")))


@pytest.fixture
def client():
    return TestClient(app)


# -- store -------------------------------------------------------------------
def test_create_and_list_custom(store):
    s = store.create("summarize", "Summarize", "TL;DR:{source}", description="d")
    assert s.scope == "custom" and s.is_code is False
    assert [x.name for x in store.list_custom()] == ["summarize"]
    assert store.get_custom("summarize").prompt == "TL;DR:{source}"


def test_reserved_and_bad_names_rejected(store):
    for name in ("fix", "polish", "explain", "ask"):
        with pytest.raises(SkillError):
            store.create(name, "X", "p{source}")
    with pytest.raises(SkillError):
        store.create("Bad Name", "X", "p")           # spaces/caps
    with pytest.raises(SkillError):
        store.create("ok", "X", "   ")               # empty prompt


def test_duplicate_rejected_and_delete(store):
    store.create("tighten", "Tighten", "p{source}")
    with pytest.raises(SkillError):
        store.create("tighten", "Tighten", "p{source}")
    assert store.delete("tighten") is True
    assert store.get_custom("tighten") is None


def test_all_skills_merges_builtins_first(store):
    store.create("summarize", "Summarize", "p{source}")
    names = [s.name for s in skills.all_skills(store)]
    assert names[:3] == ["fix", "polish", "explain"]
    assert "summarize" in names


def test_render_custom_fills_allowed_vars_only():
    sk = skills.Skill("x", "X", prompt="Do {input} with {source}. {context}{bogus}",
                      scope="custom")
    out = skills.render_custom(sk, source="SRC", instruction="IN", context_note="CTX ")
    assert "Do IN with SRC. CTX" in out
    assert "{bogus}" in out  # unknown placeholders are left untouched, not filled


# -- API + assistant integration ---------------------------------------------
def test_skills_endpoint_lists_builtins(client):
    body = client.get("/api/skills").json()
    names = [s["name"] for s in body]
    assert {"fix", "polish", "explain"} <= set(names)
    fix = next(s for s in body if s["name"] == "fix")
    assert fix["is_code"] is True and fix["scope"] == "builtin"


def test_custom_skill_runs_through_assistant(client, monkeypatch):
    captured = {}
    monkeypatch.setattr(llm_mod, "complete",
                        lambda p, s, u, **k: captured.setdefault("u", u) or "ok")
    # register a custom skill in the app's store
    from app.main import skill_store
    skill_store.delete("summarize")
    skill_store.create("summarize", "Summarize",
                       "Summarize this LaTeX:\n{source}", description="tl;dr")
    try:
        assert any(s["name"] == "summarize" for s in client.get("/api/skills").json())
        r = client.post("/api/assistant",
                        json={"action": "summarize", "source": SRC})
        assert r.status_code == 200, r.text
        assert "Summarize this LaTeX" in captured["u"] and SRC in captured["u"]
    finally:
        skill_store.delete("summarize")


def test_unknown_skill_is_422(client):
    r = client.post("/api/assistant", json={"action": "ghost", "source": SRC})
    assert r.status_code == 422
    assert "unknown skill" in r.json()["detail"]


def test_custom_code_skill_streams_is_code(client, monkeypatch):
    monkeypatch.setattr(llm_mod, "stream", lambda *a, **k: iter(["\\section{x}"]))
    from app.main import skill_store
    skill_store.delete("tighten")
    skill_store.create("tighten", "Tighten", "Tighten:{source}", is_code=True)
    try:
        r = client.post("/api/assistant/stream",
                        json={"action": "tighten", "source": SRC})
        assert r.status_code == 200
        assert '"is_code": true' in r.text
    finally:
        skill_store.delete("tighten")


# -- CLI ---------------------------------------------------------------------
def test_manage_skill_cli(tmp_path, monkeypatch, capsys):
    import manage

    monkeypatch.setenv("TEX2WORD_DB", str(tmp_path / "m.db"))
    manage.main(["add-skill", "--name", "outline", "--title", "Outline",
                 "--prompt", "Outline:{source}", "--description", "structure"])
    manage.main(["list-skills"])
    out = capsys.readouterr().out
    assert "/outline" in out and "/fix" in out  # custom + built-in listed
    manage.main(["delete-skill", "--name", "outline"])
    assert "deleted" in capsys.readouterr().out
