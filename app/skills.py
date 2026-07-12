"""Skill registry for the tex-copilot assistant.

A *skill* is a named, slash-invocable action (``/fix``, ``/polish``, …). The
built-ins (`fix`/`polish`/`explain`) are defined in code — their prompts live in
:mod:`app.assistant`. Custom skills are stored in the ``skills`` table and carry
a **prompt template** filled from a fixed allow-list of variables (``{source}``,
``{input}``, ``{context}``) — never executed, never `eval`'d.

``GET /api/skills`` serves the merged list so the frontend autocomplete and the
model share one source of truth.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .db import Database

_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
_ALLOWED_VARS = ("source", "input", "context")


class SkillError(Exception):
    """Invalid skill definition (bad name, reserved name, duplicate)."""


@dataclass(frozen=True)
class Skill:
    name: str
    title: str
    description: str = ""
    is_code: bool = False
    needs_report: bool = False
    prompt: str | None = None      # template (custom skills) or None (built-in)
    scope: str = "builtin"          # "builtin" | "custom"

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "is_code": self.is_code,
            "scope": self.scope,
        }


# Built-ins — metadata only; their prompts are produced by assistant.build_prompt.
BUILTINS: dict[str, Skill] = {
    "fix": Skill("fix", "Fix", "Fix conversion warnings in this file",
                 is_code=True, needs_report=True),
    "polish": Skill("polish", "Polish", "Improve the writing quality", is_code=True),
    "explain": Skill("explain", "Explain", "Explain what this LaTeX does"),
}
# Reserved: built-ins + the free-form default.
RESERVED = set(BUILTINS) | {"ask"}


def render_custom(skill: Skill, *, source: str = "", instruction: str | None = None,
                  context_note: str = "") -> str:
    """Fill a custom skill's template from the allow-listed variables only."""
    body = skill.prompt or ""
    values = {"source": source, "input": instruction or "", "context": context_note}
    for var in _ALLOWED_VARS:
        body = body.replace("{" + var + "}", values[var])
    return body


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SkillStore:
    """Custom skills persisted in the ``skills`` table (built-ins stay in code)."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    def create(self, name: str, title: str, prompt: str, *,
               description: str = "", is_code: bool = False) -> Skill:
        name = (name or "").strip().lower()
        if not _NAME_RE.match(name):
            raise SkillError("name must be lowercase letters/digits/hyphens (2–31 chars)")
        if name in RESERVED:
            raise SkillError(f"{name!r} is a reserved built-in skill name")
        if not (prompt or "").strip():
            raise SkillError("prompt template must not be empty")
        ts = _now()
        with self.db.lock:
            try:
                self.db.conn.execute(
                    "INSERT INTO skills (name, title, description, prompt, is_code, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (name, title or name, description, prompt, 1 if is_code else 0, ts, ts),
                )
                self.db.conn.commit()
            except Exception as exc:  # UNIQUE(name)
                raise SkillError(f"skill {name!r} already exists") from exc
        return self.get_custom(name)  # type: ignore[return-value]

    def get_custom(self, name: str) -> Skill | None:
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT * FROM skills WHERE name = ?", ((name or "").strip().lower(),)
            ).fetchone()
        return self._row(row) if row else None

    def list_custom(self) -> list[Skill]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT * FROM skills ORDER BY name").fetchall()
        return [self._row(r) for r in rows]

    def delete(self, name: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute(
                "DELETE FROM skills WHERE name = ?", ((name or "").strip().lower(),)
            )
            self.db.conn.commit()
        return cur.rowcount > 0

    @staticmethod
    def _row(row: Any) -> Skill:
        return Skill(
            name=row["name"], title=row["title"], description=row["description"],
            is_code=bool(row["is_code"]), prompt=row["prompt"], scope="custom",
        )


def all_skills(store: SkillStore) -> list[Skill]:
    """Built-ins first, then custom skills."""
    return list(BUILTINS.values()) + store.list_custom()


def resolve(store: SkillStore, name: str) -> Skill | None:
    """Look up a skill by name (built-in or custom)."""
    if name in BUILTINS:
        return BUILTINS[name]
    return store.get_custom(name)
