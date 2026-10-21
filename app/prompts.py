"""Saved prompts: reusable messages the user inserts into the chat composer.

A prompt is plain text (Markdown allowed) with optional placeholders the
composer fills when it is inserted: ``{file}`` (the open file's path) and
``{selection}`` (the selected text). Nothing is executed.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from .db import Database

MAX_TITLE = 80
MAX_BODY = 20_000


class PromptError(Exception):
    """Invalid prompt (empty title/body, too long) or unknown id."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row(r: Any) -> dict[str, Any]:
    return {"id": r["id"], "title": r["title"], "body": r["body"], "description": r["description"],
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


def _check(title: str | None, body: str | None) -> None:
    if title is not None and not title.strip():
        raise PromptError("title must not be empty")
    if body is not None and not body.strip():
        raise PromptError("prompt text must not be empty")
    if title and len(title) > MAX_TITLE:
        raise PromptError(f"title is longer than {MAX_TITLE} characters")
    if body and len(body) > MAX_BODY:
        raise PromptError(f"prompt is longer than {MAX_BODY} characters")


class PromptStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    def list(self) -> list[dict[str, Any]]:
        with self.db.lock:
            rows = self.db.conn.execute("SELECT * FROM prompts ORDER BY lower(title)").fetchall()
        return [_row(r) for r in rows]

    def get(self, pid: str) -> dict[str, Any] | None:
        with self.db.lock:
            r = self.db.conn.execute("SELECT * FROM prompts WHERE id = ?", (pid,)).fetchone()
        return _row(r) if r else None

    def create(self, title: str, body: str, description: str = "") -> dict[str, Any]:
        _check(title or "", body or "")
        pid, ts = uuid.uuid4().hex, _now()
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO prompts (id, title, body, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (pid, title.strip(), body, (description or "").strip(), ts, ts))
            self.db.conn.commit()
        return self.get(pid)  # type: ignore[return-value]

    def update(self, pid: str, *, title: str | None = None, body: str | None = None,
               description: str | None = None) -> dict[str, Any]:
        cur = self.get(pid)
        if cur is None:
            raise PromptError("prompt not found")
        _check(title, body)
        with self.db.lock:
            self.db.conn.execute(
                "UPDATE prompts SET title = ?, body = ?, description = ?, updated_at = ? WHERE id = ?",
                ((title if title is not None else cur["title"]).strip(), body if body is not None else cur["body"],
                 (description if description is not None else cur["description"]).strip(), _now(), pid))
            self.db.conn.commit()
        return self.get(pid)  # type: ignore[return-value]

    def delete(self, pid: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute("DELETE FROM prompts WHERE id = ?", (pid,))
            self.db.conn.commit()
        return cur.rowcount > 0
