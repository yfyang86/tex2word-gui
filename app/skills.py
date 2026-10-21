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
_ALLOWED_VARS = ("source", "input", "context", "file", "selection")
MODES = ("agent", "chat")


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
    mode: str = "agent"             # "agent" (may use tools / stage edits) | "chat"
    instructions: str = ""          # the agent-mode prompt template
    updated_at: str = ""

    def template(self) -> str:
        """The prompt the chat agent runs for this skill."""
        return self.instructions or self.prompt or ""

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "is_code": self.is_code,
            "scope": self.scope,
            "mode": self.mode,
            "prompt": self.template(),
            "updated_at": self.updated_at,
        }


# Built-ins — metadata only; their prompts are produced by assistant.build_prompt.
# ``instructions`` is what the chat agent runs ({file}, {selection}, {input}
# are filled in); the legacy one-shot endpoint keeps assistant.build_prompt.
BUILTINS: dict[str, Skill] = {
    "fix": Skill("fix", "Fix", "Fix conversion warnings in this file",
                 is_code=True, needs_report=True, instructions=(
                     "Run check to see how the project converts. Then fix the warnings and errors that come "
                     "from {file} with minimal edit_file changes, preserving the author's meaning and "
                     "structure, and run check again to confirm. Summarise what you changed and anything "
                     "you could not fix.\n\n{input}")),
    "polish": Skill("polish", "Polish", "Improve the writing quality", is_code=True, instructions=(
        "Improve the prose of {selection} — grammar, clarity, concision, academic tone — without changing "
        "math, commands, labels, citations, structure or meaning. Make the changes with edit_file in small "
        "hunks, then list the main improvements.\n\n{input}")),
    "explain": Skill("explain", "Explain", "Explain what this LaTeX does", mode="chat", instructions=(
        "Explain what {selection} does and how it will look in Word: structure, macros, anything unusual "
        "or likely to convert poorly.\n\n{input}")),
}
# Reserved: built-ins + the free-form default.
RESERVED = set(BUILTINS) | {"ask"}


def render_custom(skill: Skill, *, source: str = "", instruction: str | None = None,
                  context_note: str = "", file: str = "", selection: str = "") -> str:
    """Fill a custom skill's template from the allow-listed variables only."""
    body = skill.prompt or ""
    values = {"source": source, "input": instruction or "", "context": context_note,
              "file": file, "selection": selection}
    for var in _ALLOWED_VARS:
        body = body.replace("{" + var + "}", values[var])
    return body


def render_skill(skill: Skill, *, file: str | None, selection: str | None, user_input: str) -> str:
    """The chat agent's prompt for a skill.

    ``{file}`` → the open file's path; ``{selection}`` → a description of what
    to work on (the selected lines, else the open file); ``{input}`` → what the
    user typed after the command. Other braces are left alone.
    """
    target = f"`{file}`" if file else "the open file"
    sel = (f"this selection from {target}:\n```latex\n{selection}\n```" if selection else target)
    body = skill.template()
    for var, val in (("file", target), ("selection", sel), ("input", user_input or ""),
                     ("source", sel), ("context", "")):
        body = body.replace("{" + var + "}", val)
    return body.strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SkillStore:
    """Custom skills persisted in the ``skills`` table (built-ins stay in code)."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    def create(self, name: str, title: str, prompt: str, *,
               description: str = "", is_code: bool = False, mode: str = "agent") -> Skill:
        name = (name or "").strip().lower()
        if not _NAME_RE.match(name):
            raise SkillError("name must be lowercase letters/digits/hyphens (2–31 chars)")
        if name in RESERVED:
            raise SkillError(f"{name!r} is a reserved built-in skill name")
        if not (prompt or "").strip():
            raise SkillError("prompt template must not be empty")
        if mode not in MODES:
            raise SkillError(f"mode must be one of {list(MODES)}")
        ts = _now()
        with self.db.lock:
            try:
                self.db.conn.execute(
                    "INSERT INTO skills (name, title, description, prompt, is_code, mode, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (name, title or name, description, prompt, 1 if is_code else 0, mode, ts, ts),
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

    def update(self, name: str, *, title: str | None = None, prompt: str | None = None,
               description: str | None = None, mode: str | None = None) -> Skill:
        current = self.get_custom(name)
        if current is None:
            raise SkillError(f"no custom skill named {name!r}")
        if prompt is not None and not prompt.strip():
            raise SkillError("prompt template must not be empty")
        if mode is not None and mode not in MODES:
            raise SkillError(f"mode must be one of {list(MODES)}")
        with self.db.lock:
            self.db.conn.execute(
                "UPDATE skills SET title = ?, prompt = ?, description = ?, mode = ?, updated_at = ? WHERE name = ?",
                ((title if title is not None else current.title).strip() or current.name,
                 prompt if prompt is not None else current.prompt,
                 description if description is not None else current.description,
                 mode or current.mode, _now(), current.name),
            )
            self.db.conn.commit()
        return self.get_custom(name)  # type: ignore[return-value]

    def delete(self, name: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute(
                "DELETE FROM skills WHERE name = ?", ((name or "").strip().lower(),)
            )
            self.db.conn.commit()
        return cur.rowcount > 0

    @staticmethod
    def _row(row: Any) -> Skill:
        keys = row.keys()
        return Skill(
            name=row["name"], title=row["title"], description=row["description"],
            is_code=bool(row["is_code"]), prompt=row["prompt"], scope="custom",
            mode=(row["mode"] if "mode" in keys and row["mode"] else "agent"),
            updated_at=row["updated_at"],
        )


def all_skills(store: SkillStore) -> list[Skill]:
    """Built-ins first, then custom skills."""
    return list(BUILTINS.values()) + store.list_custom()


def resolve(store: SkillStore, name: str) -> Skill | None:
    """Look up a skill by name (built-in or custom)."""
    if name in BUILTINS:
        return BUILTINS[name]
    return store.get_custom(name)
