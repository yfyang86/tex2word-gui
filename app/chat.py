"""Persisted multi-turn chat sessions for the assistant.

A ``Conversation`` belongs to a project and holds ordered ``Message`` rows
(``user`` / ``assistant``). The store also produces the trimmed message
``history`` handed to the model so replies are continuous across turns.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .db import Database

# Keep the model prompt bounded: only the most recent turns are replayed.
_HISTORY_TURNS = 20


class ChatError(Exception):
    """Unknown conversation, or invalid message role."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(slots=True)
class Message:
    id: str
    role: str
    content: str
    skill: str | None
    created_at: str

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "role": self.role, "content": self.content,
            "skill": self.skill, "created_at": self.created_at,
        }


@dataclass(slots=True)
class Conversation:
    id: str
    project_id: str | None
    title: str
    created_at: str
    updated_at: str
    summary: str = ""
    summary_upto: int = 0
    messages: list[Message] = field(default_factory=list)

    def brief(self) -> dict[str, Any]:
        return {
            "id": self.id, "project_id": self.project_id, "title": self.title,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }

    def detail(self) -> dict[str, Any]:
        data = self.brief()
        data["messages"] = [m.public() for m in self.messages]
        return data


class ConversationStore:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    def create(self, project_id: str | None, *, title: str = "New chat") -> Conversation:
        cid = uuid.uuid4().hex
        ts = _now()
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO conversations (id, project_id, title, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (cid, project_id, (title or "New chat").strip()[:120], ts, ts),
            )
            self.db.conn.commit()
        return Conversation(cid, project_id, title, ts, ts)

    def _conv(self, row: Any) -> Conversation:
        keys = row.keys()
        return Conversation(
            id=row["id"], project_id=row["project_id"], title=row["title"],
            created_at=row["created_at"], updated_at=row["updated_at"],
            summary=row["summary"] if "summary" in keys else "",
            summary_upto=row["summary_upto"] if "summary_upto" in keys else 0,
        )

    def list(self, project_id: str | None) -> list[Conversation]:
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT * FROM conversations WHERE project_id IS ? ORDER BY updated_at DESC",
                (project_id,),
            ).fetchall()
        return [self._conv(r) for r in rows]

    def get(self, cid: str) -> Conversation | None:
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (cid,)
            ).fetchone()
            if row is None:
                return None
            msgs = self.db.conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                (cid,),
            ).fetchall()
        conv = self._conv(row)
        conv.messages = [Message(m["id"], m["role"], m["content"], m["skill"],
                                 m["created_at"]) for m in msgs]
        return conv

    def add_message(self, cid: str, role: str, content: str,
                    *, skill: str | None = None) -> Message:
        if role not in ("user", "assistant"):
            raise ChatError("role must be 'user' or 'assistant'")
        mid = uuid.uuid4().hex
        ts = _now()
        with self.db.lock:
            exists = self.db.conn.execute(
                "SELECT 1 FROM conversations WHERE id = ?", (cid,)
            ).fetchone()
            if exists is None:
                raise ChatError(f"unknown conversation: {cid!r}")
            self.db.conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, skill, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (mid, cid, role, content, skill, ts),
            )
            self.db.conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?", (ts, cid)
            )
            self.db.conn.commit()
        return Message(mid, role, content, skill, ts)

    def history(self, cid: str, *, turns: int = _HISTORY_TURNS) -> list[dict[str, str]]:
        """The recent messages as ``[{role, content}]`` for the model (oldest first)."""
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT role, content FROM messages WHERE conversation_id = ?"
                " ORDER BY created_at, rowid",
                (cid,),
            ).fetchall()
        msgs = [{"role": r["role"], "content": r["content"]} for r in rows]
        return msgs[-turns:]

    def set_summary(self, cid: str, summary: str, upto: int) -> None:
        with self.db.lock:
            self.db.conn.execute(
                "UPDATE conversations SET summary = ?, summary_upto = ? WHERE id = ?",
                (summary or "", upto, cid),
            )
            self.db.conn.commit()

    def history_for_model(self, cid: str, *, budget: int,
                          summarize: Any = None) -> tuple[str, list[dict[str, str]]]:
        """Return ``(summary, recent_turns)`` for the model.

        Keeps the last ``budget`` messages verbatim. When older messages exist and
        a ``summarize(prior_summary, new_messages) -> str`` callable is given, the
        newly-overflowed messages are folded into a rolling summary (persisted, so
        each message is summarised once). Without a callable, history is just
        trimmed to ``budget``.
        """
        conv = self.get(cid)
        if conv is None:
            raise ChatError(f"unknown conversation: {cid!r}")
        msgs = [{"role": m.role, "content": m.content} for m in conv.messages]
        if budget <= 0 or len(msgs) <= budget or summarize is None:
            return conv.summary, (msgs[-budget:] if budget > 0 else msgs)
        older_count = len(msgs) - budget
        summary = conv.summary
        if older_count > conv.summary_upto:
            new_older = msgs[conv.summary_upto:older_count]
            summary = summarize(conv.summary, new_older) or conv.summary
            self.set_summary(cid, summary, older_count)
        return summary, msgs[older_count:]

    def rename(self, cid: str, title: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                ((title or "").strip()[:120] or "New chat", _now(), cid),
            )
            self.db.conn.commit()
        return cur.rowcount > 0

    def delete(self, cid: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))
            self.db.conn.commit()
        return cur.rowcount > 0
