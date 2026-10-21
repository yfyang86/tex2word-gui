"""Provider registry, encrypted key storage, and the provider/settings API."""

import os
import stat

import pytest
from fastapi.testclient import TestClient

from app import secretbox
from app.config import Config, Provider, SecurityConfig
from app.db import Database
from app.main import app, provider_registry
from app.providers import ProviderError, ProviderRegistry

KEY = secretbox.SecretBox(b"k" * 32)


@pytest.fixture
def reg(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_TEST_KEY", "sk-from-env-0000")
    cfg = Config(default_provider="deepseek", providers={
        "deepseek": Provider("deepseek", "openai", "deepseek-chat", "https://api.deepseek.com",
                             api_key="sk-from-env-0000", api_key_env="DEEPSEEK_TEST_KEY", key_source="env"),
    })
    db = Database(str(tmp_path / "p.db"))
    return ProviderRegistry(cfg, db, KEY)


# -- secret box ------------------------------------------------------------------
def test_secretbox_round_trip_bound_to_context():
    tok = KEY.encrypt("sk-secret-value-1234", "openai")
    assert tok.startswith("v1:") and "sk-secret" not in tok
    assert KEY.decrypt(tok, "openai") == "sk-secret-value-1234"
    with pytest.raises(secretbox.SecretError):
        KEY.decrypt(tok, "other")                       # moved to another row
    with pytest.raises(secretbox.SecretError):
        secretbox.SecretBox(b"x" * 32).decrypt(tok, "openai")   # different master key


def test_key_file_created_private(tmp_path, monkeypatch):
    monkeypatch.delenv(secretbox.ENV_VAR, raising=False)
    path = tmp_path / "sub" / "secret.key"
    k1 = secretbox.load_key(path)
    assert len(k1) == 32 and stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert secretbox.load_key(path) == k1               # stable across loads
    monkeypatch.setenv(secretbox.ENV_VAR, secretbox.generate_key())
    assert secretbox.load_key(path) != k1               # the env var wins


def test_hint_only_for_long_keys():
    assert secretbox.hint("sk-abcdefghijkl1234") == "1234"
    assert secretbox.hint("short") == ""


# -- registry ----------------------------------------------------------------------
def test_config_provider_listed_with_env_key(reg):
    [p] = reg.list()
    assert (p.name, p.source, p.key_source, p.overridden) == ("deepseek", "config", "env", False)
    assert p.model_list() == ["deepseek-chat"]


def test_override_models_and_stored_key_never_in_db_plaintext(reg):
    p = reg.save("deepseek", {"models": ["deepseek-flash", "deepseek-pro"], "default_model": "deepseek-pro",
                              "api_key": "sk-typed-in-the-app-9999"})
    assert p.overridden and p.model == "deepseek-pro" and p.model_list() == ["deepseek-flash", "deepseek-pro"]
    assert p.api_key == "sk-typed-in-the-app-9999" and p.key_source == "stored" and p.key_hint == "9999"
    raw = reg.db.conn.execute("SELECT * FROM providers").fetchone()
    assert "sk-typed" not in (raw["api_key_enc"] or "") and raw["api_key_enc"].startswith("v1:")
    pub = p.public(manager=True)
    assert "api_key" not in pub and pub["key_hint"] == "9999"
    assert "key_hint" not in p.public()                 # non-managers don't see the hint
    # clearing the stored key falls back to config.toml's env var
    p = reg.save("deepseek", {"api_key": ""})
    assert p.key_source == "env" and p.api_key == "sk-from-env-0000"
    # reset removes the override
    assert reg.delete("deepseek") == "reset"
    assert reg.get("deepseek").model == "deepseek-chat" and not reg.get("deepseek").overridden


def test_custom_provider_crud_and_validation(reg):
    p = reg.save("luna", {"type": "openai", "api_base": "https://api.example.com/v1",
                          "models": ["luna", "astra", "luna"], "api_key": "sk-test-abcdefgh1234"}, create=True)
    assert p.source == "custom" and p.models == ["luna", "astra"] and p.model == "luna"
    with pytest.raises(ProviderError):
        reg.save("luna", {}, create=True)               # duplicate
    for bad in ({"type": "gemini"}, {"api_base": "ftp://x"}, {"models": ["has space"]},
                {"api_key_env": "1BAD"}, {"api_key": "with space"}):
        with pytest.raises(ProviderError):
            reg.save("luna", bad)
    with pytest.raises(ProviderError):
        reg.save("Bad Name", {}, create=True)
    reg.save("luna", {"enabled": False})
    assert "luna" not in [x.name for x in reg.list()]
    assert "luna" in [x.name for x in reg.list(include_disabled=True)]
    assert reg.delete("luna") == "deleted"
    with pytest.raises(ProviderError):
        reg.delete("luna")


def test_defaults_and_resolve(reg):
    reg.save("deepseek", {"models": ["deepseek-flash", "deepseek-pro"]})
    assert reg.defaults() == {"provider": "deepseek", "model": "deepseek-flash"}
    reg.set_defaults("deepseek", "deepseek-pro")
    p, m = reg.resolve(None)
    assert (p.name, m) == ("deepseek", "deepseek-pro")
    assert reg.resolve("deepseek", "deepseek-flash")[1] == "deepseek-flash"
    with pytest.raises(ProviderError):
        reg.set_defaults("deepseek", "not-a-model")
    with pytest.raises(ProviderError):
        reg.resolve("nope")


def test_tampered_ciphertext_reads_as_no_key(reg):
    reg.save("deepseek", {"api_key": "sk-typed-in-the-app-9999"})
    reg.db.conn.execute("UPDATE providers SET api_key_enc = 'v1:AAAA'")
    p = reg.get("deepseek")
    assert p.api_key is None and p.key_source is None


# -- API -----------------------------------------------------------------------------
@pytest.fixture
def client():
    yield TestClient(app)
    for p in provider_registry.list(include_disabled=True):
        if p.source == "custom" or p.overridden:
            provider_registry.delete(p.name)


def test_api_crud_keys_are_write_only(client):
    r = client.post("/api/providers", json={"name": "astra-test", "type": "openai",
                                            "api_base": "https://api.example.com/v1",
                                            "models": ["luna", "astra"], "api_key": "sk-live-secret-0042"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["has_key"] and body["key_source"] == "stored" and body["key_hint"] == "0042"
    assert "sk-live-secret" not in r.text
    listing = client.get("/api/providers")
    assert listing.status_code == 200 and "sk-live-secret" not in listing.text
    assert any(p["name"] == "astra-test" for p in listing.json()["providers"])
    assert listing.json()["can_manage"] is True and listing.json()["presets"]
    assert "sk-live-secret" not in client.get("/api/config").text
    r = client.patch("/api/providers/astra-test", json={"models": ["astra"], "default_model": "astra"})
    assert r.json()["model"] == "astra"
    assert client.put("/api/assistant/defaults", json={"provider": "astra-test", "model": "astra"}).json() == \
        {"provider": "astra-test", "model": "astra"}
    assert client.patch("/api/providers/astra-test", json={"type": "nope"}).status_code == 422
    assert client.delete("/api/providers/astra-test").json() == {"result": "deleted"}
    assert client.delete("/api/providers/astra-test").status_code == 404


def test_api_test_endpoint_reports_failure_without_raising(client, monkeypatch):
    import app.llm as llm_mod

    client.post("/api/providers", json={"name": "probe", "models": ["m1"], "api_key": "sk-probe-key-123456"})

    def fake_chat(provider, model, system, messages, **kw):
        if model == "bad":
            raise llm_mod.LLMError("401 unauthorized")
        yield {"type": "text", "text": "OK"}

    monkeypatch.setattr(llm_mod, "chat", fake_chat)
    ok = client.post("/api/providers/probe/test", json={}).json()
    assert ok["ok"] and ok["reply"] == "OK" and ok["model"] == "m1"
    bad = client.post("/api/providers/probe/test", json={"model": "bad"}).json()
    assert not bad["ok"] and "401" in bad["error"]


def test_settings_round_trip(client):
    r = client.put("/api/assistant/settings", json={"instructions": "Use British spelling.", "max_steps": 6})
    assert r.status_code == 200 and r.json()["instructions"] == "Use British spelling."
    got = client.get("/api/assistant/settings").json()
    assert got["max_steps"] == 6 and "tex-copilot" in got["system_prompt"]
    assert client.put("/api/assistant/settings", json={"default_mode": "wild"}).status_code == 422
    assert client.put("/api/assistant/settings", json={"max_steps": 0}).status_code == 422
    client.put("/api/assistant/settings", json={"instructions": "", "max_steps": 12})
