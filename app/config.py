"""Application configuration loaded from ``config.toml``.

Loads ``config.toml`` if present, otherwise falls back to the committed
``config.sample.toml``. Provider API keys may be given inline (``api_key``) or,
preferred, via the name of an environment variable (``api_key_env``). Secrets
are never included in the :meth:`Config.public` / :meth:`Provider.public`
projections used by the API.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
# Real config first, then the committed sample as a fallback.
_CANDIDATES = ("config.toml", "config.sample.toml")

_PROVIDER_TYPES = {"openai", "claude"}


@dataclass(slots=True)
class Provider:
    name: str
    type: str
    model: str                      # the default model
    api_base: str
    # Resolved secret — present in memory only, never serialized.
    api_key: str | None = None
    # Name of the env var the key came from (if any), for diagnostics.
    api_key_env: str | None = None
    models: list[str] = field(default_factory=list)   # selectable models
    tools: bool = True              # the endpoint supports function calling
    source: str = "config"          # "config" (config.toml) | "custom" (added in the app)
    overridden: bool = False        # a config provider with in-app changes
    key_source: str | None = None   # "stored" | "env" | "config" | None
    key_hint: str = ""              # last 4 characters of a stored key

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)

    def model_list(self) -> list[str]:
        out = [m for m in self.models if m]
        if self.model and self.model not in out:
            out.insert(0, self.model)
        return out

    def public(self, *, manager: bool = False) -> dict[str, Any]:
        """Redacted projection safe to return over the API (never the key)."""
        data = {
            "name": self.name,
            "type": self.type,
            "model": self.model,
            "models": self.model_list(),
            "api_base": self.api_base,
            "has_key": self.has_key,
            "api_key_env": self.api_key_env,
            "tools": self.tools,
            "source": self.source,
            "overridden": self.overridden,
            "key_source": self.key_source,
        }
        if manager:
            data["key_hint"] = self.key_hint
        return data


@dataclass(slots=True)
class BackendConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    metasqlite_db: str = "tex2word.db"
    redis_port: int = 6379
    redis_table: str = "0"


@dataclass(slots=True)
class FrontendConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    cors: str = ""
    nginx_enable: bool = False
    nginx_config_filepath: str = ""

    def cors_origins(self) -> list[str]:
        """Parsed CORS allowlist; an empty setting means allow-all (dev)."""
        origins = [o.strip() for o in self.cors.split(",") if o.strip()]
        return origins or ["*"]


@dataclass(slots=True)
class AuthConfig:
    """Optional account-based auth (RSA-signed JWT sessions, scrypt passwords)."""

    enabled: bool = False
    private_key_path: str = "auth_private.pem"
    public_key_path: str = "auth_public.pem"
    token_ttl_hours: int = 12
    issuer: str = "tex2word-web"


@dataclass(slots=True)
class AssistantConfig:
    """Chat memory tuning. ``summary_provider`` falls back to the default provider."""

    history_budget_turns: int = 12   # recent turns kept verbatim; older → summary
    rolling_summary: bool = True     # fold older turns into a running summary
    project_memory: bool = True      # inject per-project memory notes
    summary_provider: str | None = None


@dataclass(slots=True)
class SecurityConfig:
    """Request hardening: body-size cap and per-IP rate limits."""

    max_body_mb: int = 50
    rate_limit_enabled: bool = True
    rate_limit_per_min: int = 240        # general /api requests per IP
    heavy_rate_limit_per_min: int = 60   # convert / assistant / chat / import
    login_rate_limit_per_min: int = 10   # POST /api/auth/login
    # master key for secrets stored in the database (provider API keys);
    # TEX2WORD_SECRET_KEY overrides it. Created with mode 0600 on first use.
    secret_key_path: str = "tex2word_secret.key"

    @property
    def max_body_bytes(self) -> int:
        return self.max_body_mb * 1024 * 1024


@dataclass(slots=True)
class ImportConfig:
    """Limits for imported source bundles (arXiv e-prints, uploaded archives).

    ``max_archive_mb`` caps the downloaded/uploaded archive *and* the total size
    of the files extracted from it (archive-bomb guard); ``max_archive_files``
    caps the number of extracted files.
    """

    max_archive_mb: int = 100
    max_archive_files: int = 500

    @property
    def max_archive_bytes(self) -> int:
        return self.max_archive_mb * 1024 * 1024


@dataclass(slots=True)
class LLMConfig:
    """LLM generation defaults applied when callers don't override."""

    max_tokens: int = 8192


@dataclass(slots=True)
class Config:
    default_provider: str | None
    providers: dict[str, Provider] = field(default_factory=dict)
    backend: BackendConfig = field(default_factory=BackendConfig)
    frontend: FrontendConfig = field(default_factory=FrontendConfig)
    auth: AuthConfig = field(default_factory=AuthConfig)
    assistant: AssistantConfig = field(default_factory=AssistantConfig)
    security: SecurityConfig = field(default_factory=SecurityConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    imports: ImportConfig = field(default_factory=ImportConfig)
    source_path: str | None = None

    def provider(self, name: str | None = None) -> Provider:
        """Return a provider by name, or the default. Raises ``KeyError``."""
        key = name or self.default_provider
        if not key:
            raise KeyError("no provider requested and no default configured")
        if key not in self.providers:
            raise KeyError(f"unknown provider: {key!r}")
        return self.providers[key]

    def public(self) -> dict[str, Any]:
        return {
            "default_provider": self.default_provider,
            "providers": [p.public() for p in self.providers.values()],
            "backend": {
                "host": self.backend.host,
                "port": self.backend.port,
            },
            "frontend": {
                "cors_origins": self.frontend.cors_origins(),
                "nginx_enable": self.frontend.nginx_enable,
            },
            # only the on/off flag is public; key paths stay server-side
            "auth": {"enabled": self.auth.enabled},
            "import": {
                "max_archive_mb": self.imports.max_archive_mb,
                "max_archive_files": self.imports.max_archive_files,
            },
        }


def _resolve_key(raw: dict[str, Any]) -> tuple[str | None, str | None]:
    """Resolve a provider's API key from ``api_key`` or ``api_key_env``."""
    if raw.get("api_key"):
        return str(raw["api_key"]), None
    env_name = raw.get("api_key_env")
    if env_name:
        return os.environ.get(str(env_name)) or None, str(env_name)
    return None, None


def _parse(data: dict[str, Any], source_path: str | None) -> Config:
    providers: dict[str, Provider] = {}
    for name, raw in (data.get("providers") or {}).items():
        ptype = str(raw.get("type", "openai"))
        if ptype not in _PROVIDER_TYPES:
            raise ValueError(
                f"provider {name!r}: type must be one of {sorted(_PROVIDER_TYPES)}"
            )
        api_key, api_key_env = _resolve_key(raw)
        models = raw.get("models") or []
        if not isinstance(models, list):
            raise ValueError(f"provider {name!r}: models must be a list of names")
        providers[name] = Provider(
            name=name,
            type=ptype,
            model=str(raw.get("model", "") or (models[0] if models else "")),
            api_base=str(raw.get("api_base", "")),
            api_key=api_key,
            api_key_env=api_key_env,
            models=[str(m) for m in models],
            tools=bool(raw.get("tools", True)),
            key_source=("config" if raw.get("api_key") else "env" if api_key else None),
        )

    be = data.get("backend") or {}
    backend = BackendConfig(
        host=str(be.get("host", "0.0.0.0")),
        port=int(be.get("port", 8000)),
        metasqlite_db=str(be.get("metasqlite_db", "tex2word.db")),
        redis_port=int(be.get("redis_port", 6379)),
        redis_table=str(be.get("redis_table", "0")),
    )

    fe = data.get("frontend") or {}
    frontend = FrontendConfig(
        host=str(fe.get("host", "0.0.0.0")),
        port=int(fe.get("port", 8000)),
        cors=str(fe.get("CORS", fe.get("cors", "")) or ""),
        nginx_enable=bool(fe.get("nginx_enable", False)),
        nginx_config_filepath=str(fe.get("nginx_config_filepath", "")),
    )

    au = data.get("auth") or {}
    auth = AuthConfig(
        enabled=bool(au.get("enabled", False)),
        private_key_path=str(au.get("private_key_path", "auth_private.pem")),
        public_key_path=str(au.get("public_key_path", "auth_public.pem")),
        token_ttl_hours=int(au.get("token_ttl_hours", 12)),
        issuer=str(au.get("issuer", "tex2word-web")),
    )

    asst = data.get("assistant") or {}
    assistant_cfg = AssistantConfig(
        history_budget_turns=int(asst.get("history_budget_turns", 12)),
        rolling_summary=bool(asst.get("rolling_summary", True)),
        project_memory=bool(asst.get("project_memory", True)),
        summary_provider=asst.get("summary_provider") or None,
    )

    sec = data.get("security") or {}
    security = SecurityConfig(
        max_body_mb=int(sec.get("max_body_mb", 50)),
        rate_limit_enabled=bool(sec.get("rate_limit_enabled", True)),
        rate_limit_per_min=int(sec.get("rate_limit_per_min", 240)),
        heavy_rate_limit_per_min=int(sec.get("heavy_rate_limit_per_min", 60)),
        login_rate_limit_per_min=int(sec.get("login_rate_limit_per_min", 10)),
        secret_key_path=str(sec.get("secret_key_path", "tex2word_secret.key")),
    )

    imp = data.get("import") or {}
    imports = ImportConfig(
        max_archive_mb=int(imp.get("max_archive_mb", 100)),
        max_archive_files=int(imp.get("max_archive_files", 500)),
    )
    if imports.max_archive_mb < 1 or imports.max_archive_files < 1:
        raise ValueError("[import] max_archive_mb and max_archive_files must be >= 1")

    llm_data = data.get("llm") or {}
    llm_cfg = LLMConfig(
        max_tokens=int(llm_data.get("max_tokens", 8192)),
    )

    default_provider = (data.get("default") or {}).get("provider")
    return Config(
        default_provider=default_provider,
        providers=providers,
        backend=backend,
        frontend=frontend,
        auth=auth,
        assistant=assistant_cfg,
        security=security,
        llm=llm_cfg,
        imports=imports,
        source_path=source_path,
    )


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load configuration from ``path`` (or the first existing candidate).

    Returns a default :class:`Config` if no file is found, so the app still runs.
    """
    if path is not None:
        chosen: Path | None = Path(path)
    else:
        chosen = next((ROOT / c for c in _CANDIDATES if (ROOT / c).exists()), None)
    if chosen is None or not chosen.exists():
        return Config(default_provider=None, source_path=None)
    with open(chosen, "rb") as fh:
        data = tomllib.load(fh)
    return _parse(data, str(chosen))


@lru_cache(maxsize=1)
def get_config() -> Config:
    """Process-wide cached configuration."""
    return load_config()
