import textwrap

import pytest
from fastapi.testclient import TestClient

from app import config as config_mod
from app.main import app


@pytest.fixture
def sample_toml(tmp_path, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek-secret")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent(
            """
            [default]
            provider = "deepseek"

            [backend]
            host = "127.0.0.1"
            port = 9001

            [frontend]
            CORS = "https://a.example, https://b.example"

            [providers.deepseek]
            type = "openai"
            api_base = "https://api.deepseek.com"
            api_key_env = "DEEPSEEK_API_KEY"
            model = "deepseek-chat"

            [providers.claude]
            type = "claude"
            api_base = "https://api.anthropic.com"
            api_key_env = "ANTHROPIC_API_KEY"
            model = "claude-opus-4-8"

            [providers.local]
            type = "openai"
            api_base = "http://localhost:8000/v1"
            api_key = "dummy"
            model = "qwen"
            """
        )
    )
    return p


def test_loads_providers_and_default(sample_toml):
    cfg = config_mod.load_config(sample_toml)
    assert cfg.default_provider == "deepseek"
    assert set(cfg.providers) == {"deepseek", "claude", "local"}
    assert cfg.backend.port == 9001
    assert cfg.provider().name == "deepseek"  # default
    assert cfg.provider("claude").model == "claude-opus-4-8"


def test_api_key_resolution(sample_toml):
    cfg = config_mod.load_config(sample_toml)
    assert cfg.provider("deepseek").api_key == "sk-deepseek-secret"  # from env
    assert cfg.provider("local").api_key == "dummy"  # inline
    assert cfg.provider("claude").api_key is None  # env not set
    assert cfg.provider("claude").has_key is False


def test_cors_parsing(sample_toml):
    cfg = config_mod.load_config(sample_toml)
    assert cfg.frontend.cors_origins() == ["https://a.example", "https://b.example"]


def test_empty_cors_means_allow_all(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('[frontend]\nCORS = ""\n')
    cfg = config_mod.load_config(p)
    assert cfg.frontend.cors_origins() == ["*"]


def test_public_projection_redacts_secrets(sample_toml):
    cfg = config_mod.load_config(sample_toml)
    pub = cfg.public()
    blob = repr(pub)
    assert "sk-deepseek-secret" not in blob
    assert "dummy" not in blob
    # but it does report key presence + the env var name
    deepseek = next(p for p in pub["providers"] if p["name"] == "deepseek")
    assert deepseek["has_key"] is True
    assert deepseek["api_key_env"] == "DEEPSEEK_API_KEY"


def test_unknown_provider_type_rejected(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('[providers.x]\ntype = "bogus"\nmodel = "m"\n')
    with pytest.raises(ValueError):
        config_mod.load_config(p)


def test_missing_file_returns_default_config(tmp_path):
    cfg = config_mod.load_config(tmp_path / "does-not-exist.toml")
    assert cfg.default_provider is None
    assert cfg.providers == {}


def test_sample_config_in_repo_is_valid():
    # config.sample.toml is committed and must always parse.
    cfg = config_mod.load_config(config_mod.ROOT / "config.sample.toml")
    assert "claude" in cfg.providers
    assert cfg.provider("claude").model == "claude-opus-4-8"


def test_config_endpoint_redacted():
    client = TestClient(app)
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert "default_provider" in body
    assert "tex2word_version" in body
    assert isinstance(body["providers"], list)
    # no provider entry should ever carry a raw key field
    for p in body["providers"]:
        assert "api_key" not in p
        assert set(p) >= {"name", "type", "model", "has_key"}


def test_import_limits_parse_and_default(tmp_path):
    p = tmp_path / "c.toml"
    p.write_text("[import]\nmax_archive_mb = 250\nmax_archive_files = 2000\n")
    cfg = config_mod.load_config(p)
    assert cfg.imports.max_archive_mb == 250 and cfg.imports.max_archive_files == 2000
    assert cfg.imports.max_archive_bytes == 250 * 1024 * 1024
    assert cfg.public()["import"] == {"max_archive_mb": 250, "max_archive_files": 2000}
    p.write_text("[default]\n")
    assert config_mod.load_config(p).imports.max_archive_mb == 100
    p.write_text("[import]\nmax_archive_mb = 0\n")
    with pytest.raises(ValueError):
        config_mod.load_config(p)
