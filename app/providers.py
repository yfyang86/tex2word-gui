"""LLM providers: the ones in ``config.toml`` plus the ones managed in the app.

A row in the ``providers`` table either adds a *custom* provider or, when its
name matches a ``config.toml`` provider, *overrides* it field by field (NULL
fields inherit), so a deployment's config stays the baseline and "reset"
deletes the override.

API keys entered in the app are encrypted with :mod:`app.secretbox` before
they reach the database and are never returned by the API; only whether a key
is set, where it comes from, and (to managers) its last four characters.
Precedence: a stored key, else the row's ``api_key_env``, else config.toml.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

from .config import Config, Provider
from .db import Database
from .secretbox import SecretBox, SecretError, hint

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,39}$")
_ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
TYPES = ("openai", "claude")
MAX_MODELS = 60

# Starting points for "Add provider"; model lists are editable and can be
# fetched live from the provider ("Fetch models").
PRESETS: list[dict[str, Any]] = [
    {"id": "openai", "label": "OpenAI", "type": "openai", "api_base": "https://api.openai.com/v1",
     "api_key_env": "OPENAI_API_KEY", "models": []},
    {"id": "anthropic", "label": "Anthropic (Claude)", "type": "claude", "api_base": "https://api.anthropic.com",
     "api_key_env": "ANTHROPIC_API_KEY", "models": []},
    {"id": "deepseek", "label": "DeepSeek", "type": "openai", "api_base": "https://api.deepseek.com",
     "api_key_env": "DEEPSEEK_API_KEY", "models": ["deepseek-flash", "deepseek-pro"]},
    {"id": "openrouter", "label": "OpenRouter", "type": "openai", "api_base": "https://openrouter.ai/api/v1",
     "api_key_env": "OPENROUTER_API_KEY", "models": []},
    {"id": "kimi", "label": "Moonshot (Kimi)", "type": "openai", "api_base": "https://api.moonshot.cn/v1",
     "api_key_env": "MOONSHOT_API_KEY", "models": []},
    {"id": "ollama", "label": "Ollama (local)", "type": "openai", "api_base": "http://localhost:11434/v1",
     "api_key_env": None, "models": []},
    {"id": "vllm", "label": "vLLM / OpenAI-compatible", "type": "openai", "api_base": "http://localhost:8000/v1",
     "api_key_env": None, "models": []},
]


class ProviderError(Exception):
    """Invalid provider definition or unknown provider."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean_models(models: Any) -> list[str]:
    if models is None:
        return []
    if not isinstance(models, list):
        raise ProviderError("models must be a list of model names")
    out: list[str] = []
    for m in models:
        name = str(m).strip()
        if not name:
            continue
        if len(name) > 120 or any(c.isspace() for c in name):
            raise ProviderError(f"invalid model name: {name!r}")
        if name not in out:
            out.append(name)
    if len(out) > MAX_MODELS:
        raise ProviderError(f"at most {MAX_MODELS} models per provider")
    return out


def _check_base(url: str | None) -> str | None:
    if url is None:
        return None
    url = url.strip()
    if url and not re.match(r"^https?://[^\s/]+", url):
        raise ProviderError("api_base must be an http(s) URL")
    return url


class ProviderRegistry:
    """Merged view of config.toml providers and the ``providers`` table."""

    def __init__(self, config: Config, db: Database, box: SecretBox | None = None) -> None:
        self.config = config
        self.db = db
        self._box = box

    # -- secrets ---------------------------------------------------------
    @property
    def box(self) -> SecretBox:
        if self._box is None:
            from .secretbox import load_key
            self._box = SecretBox(load_key(self.config.security.secret_key_path))
        return self._box

    # -- reads -----------------------------------------------------------
    def _rows(self) -> dict[str, Any]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT * FROM providers").fetchall()
        return {r["name"]: r for r in rows}

    def _merge(self, base: Provider | None, row: Any) -> Provider:
        if base is None:
            p = Provider(name=row["name"], type=row["type"] or "openai", model="", api_base="",
                         source="custom")
        else:
            p = replace(base, models=list(base.models))
        if row is None:
            return p
        if base is not None:
            p.overridden = True
        if row["type"]:
            p.type = row["type"]
        if row["api_base"] is not None:
            p.api_base = row["api_base"]
        if row["models"] is not None:
            p.models = json.loads(row["models"])
        if row["default_model"]:
            p.model = row["default_model"]
        elif p.models and p.model not in p.models:
            p.model = p.models[0]
        if row["tools"] is not None:
            p.tools = bool(row["tools"])
        if row["api_key_enc"]:
            try:
                p.api_key = self.box.decrypt(row["api_key_enc"], p.name)
                p.key_source, p.key_hint = "stored", row["key_hint"] or ""
            except SecretError:
                p.api_key, p.key_source = None, None
        elif row["api_key_env"]:
            p.api_key_env = row["api_key_env"]
            p.api_key = os.environ.get(row["api_key_env"]) or None
            p.key_source = "env" if p.api_key else None
        return p

    def list(self, *, include_disabled: bool = False) -> list[Provider]:
        rows = self._rows()
        out = []
        for name, base in self.config.providers.items():
            row = rows.get(name)
            if row is not None and not row["enabled"] and not include_disabled:
                continue
            out.append(self._merge(base, row))
        for name, row in sorted(rows.items()):
            if name in self.config.providers:
                continue
            if not row["enabled"] and not include_disabled:
                continue
            out.append(self._merge(None, row))
        return out

    def get(self, name: str) -> Provider:
        for p in self.list(include_disabled=True):
            if p.name == name:
                return p
        raise ProviderError(f"unknown provider: {name!r}")

    def defaults(self) -> dict[str, str | None]:
        """The default provider and model (app setting, else config.toml)."""
        raw = Settings(self.db).get("assistant.default") or {}
        names = [p.name for p in self.list()]
        prov = raw.get("provider") if raw.get("provider") in names else None
        if prov is None:
            prov = self.config.default_provider if self.config.default_provider in names else (names[0] if names else None)
        model = raw.get("model") if prov == raw.get("provider") else None
        if prov and not model:
            model = self.get(prov).model or None
        return {"provider": prov, "model": model}

    def resolve(self, name: str | None, model: str | None = None) -> tuple[Provider, str]:
        """The provider to call and the model to use (defaults filled in)."""
        d = self.defaults()
        pname = name or d["provider"]
        if not pname:
            raise ProviderError("no provider configured — add one in Assistant settings")
        p = self.get(pname)
        m = (model or "").strip() or (d["model"] if pname == d["provider"] else None) or p.model
        if not m:
            raise ProviderError(f"provider {pname!r} has no model — add one in Assistant settings")
        return p, m

    # -- writes ----------------------------------------------------------
    def save(self, name: str, fields: dict[str, Any], *, create: bool = False) -> Provider:
        """Create a custom provider, or update (override) an existing one.

        ``fields`` may hold: type, api_base, models, default_model, tools,
        enabled, api_key (str: store it; "" clears it), api_key_env.
        """
        name = (name or "").strip()
        if not _NAME_RE.match(name):
            raise ProviderError("name must be lowercase letters, digits, '.', '_' or '-' (max 40)")
        in_config = name in self.config.providers
        rows = self._rows()
        exists = in_config or name in rows
        if create and exists:
            raise ProviderError(f"provider {name!r} already exists")
        if not create and not exists:
            raise ProviderError(f"unknown provider: {name!r}")
        row = dict(rows[name]) if name in rows else {
            "type": None, "api_base": None, "models": None, "default_model": None,
            "api_key_enc": None, "key_hint": "", "api_key_env": None, "tools": None, "enabled": 1,
        }
        if "type" in fields and fields["type"] is not None:
            if fields["type"] not in TYPES:
                raise ProviderError(f"type must be one of {list(TYPES)}")
            row["type"] = fields["type"]
        if create and not in_config and not row["type"]:
            row["type"] = "openai"
        if "api_base" in fields and fields["api_base"] is not None:
            row["api_base"] = _check_base(fields["api_base"])
        if "models" in fields and fields["models"] is not None:
            row["models"] = json.dumps(_clean_models(fields["models"]))
        if "default_model" in fields and fields["default_model"] is not None:
            dm = str(fields["default_model"]).strip()
            row["default_model"] = dm or None
        if "tools" in fields and fields["tools"] is not None:
            row["tools"] = 1 if fields["tools"] else 0
        if "enabled" in fields and fields["enabled"] is not None:
            row["enabled"] = 1 if fields["enabled"] else 0
        if "api_key_env" in fields and fields["api_key_env"] is not None:
            env = str(fields["api_key_env"]).strip()
            if env and not _ENV_RE.match(env):
                raise ProviderError("api_key_env must be an environment variable name")
            row["api_key_env"] = env or None
        if "api_key" in fields and fields["api_key"] is not None:
            key = str(fields["api_key"]).strip()
            if key:
                if len(key) > 4096 or any(c.isspace() for c in key):
                    raise ProviderError("that does not look like an API key")
                row["api_key_enc"] = self.box.encrypt(key, name)
                row["key_hint"] = hint(key)
            else:
                row["api_key_enc"], row["key_hint"] = None, ""
        # the default model must be one of the models
        models = json.loads(row["models"]) if row["models"] else None
        if row["default_model"] and models is not None and row["default_model"] not in models:
            models.insert(0, row["default_model"])
            row["models"] = json.dumps(models)
        ts = _now()
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO providers (name, type, api_base, models, default_model, api_key_enc, key_hint,"
                " api_key_env, tools, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(name) DO UPDATE SET type=excluded.type, api_base=excluded.api_base,"
                " models=excluded.models, default_model=excluded.default_model, api_key_enc=excluded.api_key_enc,"
                " key_hint=excluded.key_hint, api_key_env=excluded.api_key_env, tools=excluded.tools,"
                " enabled=excluded.enabled, updated_at=excluded.updated_at",
                (name, row["type"], row["api_base"], row["models"], row["default_model"], row["api_key_enc"],
                 row["key_hint"], row["api_key_env"], row["tools"], row["enabled"], ts, ts),
            )
            self.db.conn.commit()
        return self.get(name)

    def delete(self, name: str) -> str:
        """Delete a custom provider or reset a config provider's override.
        Returns "deleted", "reset" or raises."""
        in_config = name in self.config.providers
        with self.db.lock:
            cur = self.db.conn.execute("DELETE FROM providers WHERE name = ?", (name,))
            self.db.conn.commit()
        if in_config:
            return "reset"
        if cur.rowcount:
            return "deleted"
        raise ProviderError(f"unknown provider: {name!r}")

    def set_defaults(self, provider: str | None, model: str | None) -> dict[str, str | None]:
        if provider:
            p = self.get(provider)
            if model and model not in p.model_list():
                raise ProviderError(f"{model!r} is not one of {provider!r}'s models")
        Settings(self.db).set("assistant.default", {"provider": provider, "model": model})
        return self.defaults()


class Settings:
    """Small JSON key/value store for app-wide settings."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, key: str, default: Any = None) -> Any:
        with self.db.lock:
            row = self.db.conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except ValueError:
            return default

    def set(self, key: str, value: Any) -> None:
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, json.dumps(value), _now()),
            )
            self.db.conn.commit()
