"""Persisted assistant sessions (chat or agent) for a project.

A ``Conversation`` belongs to a project. Its messages form a **tree**: each
message has a ``parent_id`` (``None`` for a first message). Editing a message
or regenerating a reply adds a sibling instead of deleting anything, so the
earlier version stays reachable. The conversation's ``head_id`` is the last
message of the branch on screen; ``Conversation.messages`` is that branch
(root → head), which is also what the model sees.

Each session also keeps its own ``settings`` (provider, model, mode), a
``pinned`` flag and, for a session split off another one, ``forked_from``.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .db import Database

# Keep the model prompt bounded: only the most recent turns are replayed.
_HISTORY_TURNS = 20
# add_message(parent_id=HEAD): attach to the end of the branch on screen.
HEAD = "__head__"
SETTING_KEYS = ("provider", "model", "mode")


class ChatError(Exception):
    """Unknown conversation or message, or invalid message role."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(text: Any, default: Any) -> Any:
    if not text:
        return default
    try:
        val = json.loads(text)
    except (TypeError, ValueError):
        return default
    return val if isinstance(val, type(default)) else default


@dataclass(slots=True)
class Message:
    id: str
    role: str
    content: str
    skill: str | None
    created_at: str
    # assistant turns: {"steps", "changes", "usage", "provider", "model", "mode", "error", ...}
    meta: dict[str, Any] = field(default_factory=dict)
    parent_id: str | None = None
    # versions of this message (siblings under the same parent), oldest first
    siblings: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        data = {
            "id": self.id, "role": self.role, "content": self.content,
            "skill": self.skill, "created_at": self.created_at, "meta": self.meta,
            "parent_id": self.parent_id,
        }
        if len(self.siblings) > 1:
            data["branch"] = {"index": self.siblings.index(self.id), "count": len(self.siblings),
                              "ids": list(self.siblings)}
        return data


def _message(row: Any) -> Message:
    return Message(row["id"], row["role"], row["content"], row["skill"], row["created_at"],
                   _json(row["meta"], {}), row["parent_id"])


@dataclass(slots=True)
class Conversation:
    id: str
    project_id: str | None
    title: str
    created_at: str
    updated_at: str
    summary: str = ""
    summary_upto: int = 0
    summary_anchor: str | None = None
    head_id: str | None = None
    settings: dict[str, Any] = field(default_factory=dict)
    pinned: bool = False
    forked_from: dict[str, Any] = field(default_factory=dict)
    messages: list[Message] = field(default_factory=list)       # the branch on screen
    message_count: int = 0                                      # in every branch
    branches: list[dict[str, Any]] = field(default_factory=list)
    branch_count: int = 0                                       # leaves of the tree
    preview: str = ""

    def brief(self) -> dict[str, Any]:
        return {
            "id": self.id, "project_id": self.project_id, "title": self.title,
            "created_at": self.created_at, "updated_at": self.updated_at,
            "settings": self.settings, "pinned": self.pinned,
            "forked_from": self.forked_from or None,
            "message_count": self.message_count, "branch_count": self.branch_count,
            "preview": self.preview,
        }

    def detail(self) -> dict[str, Any]:
        data = self.brief()
        data["head_id"] = self.head_id
        data["messages"] = [m.public() for m in self.messages]
        data["branches"] = self.branches
        return data


class _Tree:
    """Every message of one conversation, indexed by id and by parent."""

    def __init__(self, rows: list[Any]) -> None:
        self.order = [_message(r) for r in rows]           # created_at, rowid
        self.by_id = {m.id: m for m in self.order}
        self.children: dict[str | None, list[Message]] = {}
        for m in self.order:
            parent = m.parent_id if m.parent_id in self.by_id else None
            m.parent_id = parent
            self.children.setdefault(parent, []).append(m)
        for kids in self.children.values():
            ids = [k.id for k in kids]
            for k in kids:
                k.siblings = ids

    def path(self, head: str | None) -> list[Message]:
        out: list[Message] = []
        seen: set[str] = set()
        cur = self.by_id.get(head) if head else None
        while cur is not None and cur.id not in seen:
            seen.add(cur.id)
            out.append(cur)
            cur = self.by_id.get(cur.parent_id) if cur.parent_id else None
        out.reverse()
        return out

    def leaf(self, mid: str | None) -> str | None:
        """The newest message at the end of the branch through ``mid``."""
        cur = self.by_id.get(mid) if mid else None
        if cur is None:
            roots = self.children.get(None) or []
            if not roots:
                return None
            cur = roots[-1]
        while self.children.get(cur.id):
            cur = self.children[cur.id][-1]
        return cur.id

    def leaves(self) -> list[Message]:
        return [m for m in self.order if not self.children.get(m.id)]

    def subtree(self, mid: str) -> list[str]:
        out, stack = [], [mid]
        while stack:
            cur = stack.pop()
            out.append(cur)
            stack.extend(k.id for k in self.children.get(cur, []))
        return out


def _first_line(text: str, n: int = 80) -> str:
    return (text.strip().splitlines() or [""])[0][:n]


def _branch_label(path: list[Message]) -> tuple[str, str]:
    """A branch's newest question and its last reply (first lines)."""
    ask = next((m for m in reversed(path) if m.role == "user" and m.content.strip()), None)
    reply = next((m for m in reversed(path) if m.role == "assistant"), None)
    return (_first_line(ask.content) if ask else "(no question)"), (_first_line(reply.content) if reply else "")


class ConversationStore:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    # ── sessions ───────────────────────────────────────────────────────
    def create(self, project_id: str | None, *, title: str = "New chat",
               settings: dict[str, Any] | None = None,
               forked_from: dict[str, Any] | None = None) -> Conversation:
        cid = uuid.uuid4().hex
        ts = _now()
        title = (title or "New chat").strip()[:120] or "New chat"
        clean = _clean_settings(settings or {})
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO conversations (id, project_id, title, created_at, updated_at, settings, forked_from)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (cid, project_id, title, ts, ts, json.dumps(clean), json.dumps(forked_from or {})),
            )
            self.db.conn.commit()
        return Conversation(cid, project_id, title, ts, ts, settings=clean, forked_from=forked_from or {})

    def _conv(self, row: Any) -> Conversation:
        keys = row.keys()
        return Conversation(
            id=row["id"], project_id=row["project_id"], title=row["title"],
            created_at=row["created_at"], updated_at=row["updated_at"],
            summary=row["summary"] if "summary" in keys else "",
            summary_upto=row["summary_upto"] if "summary_upto" in keys else 0,
            summary_anchor=row["summary_anchor"] if "summary_anchor" in keys else None,
            head_id=row["head_id"] if "head_id" in keys else None,
            settings=_json(row["settings"], {}) if "settings" in keys else {},
            pinned=bool(row["pinned"]) if "pinned" in keys else False,
            forked_from=_json(row["forked_from"], {}) if "forked_from" in keys else {},
        )

    def list(self, project_id: str | None, *, q: str | None = None) -> list[Conversation]:
        sql = "SELECT * FROM conversations WHERE project_id IS ?"
        args: list[Any] = [project_id]
        if q and q.strip():
            like = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            sql += (" AND (title LIKE ? ESCAPE '\\' OR id IN (SELECT conversation_id FROM messages"
                    " WHERE content LIKE ? ESCAPE '\\'))")
            args += [like, like]
        sql += " ORDER BY pinned DESC, updated_at DESC, rowid DESC"
        with self.db.lock:
            rows = self.db.conn.execute(sql, args).fetchall()
            stats = {
                r["conversation_id"]: (r["n"], r["leaves"])
                for r in self.db.conn.execute(
                    "SELECT conversation_id, COUNT(*) AS n,"
                    " SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM messages c"
                    " WHERE c.conversation_id = m.conversation_id AND c.parent_id = m.id)"
                    " THEN 1 ELSE 0 END) AS leaves"
                    " FROM messages m WHERE conversation_id IN"
                    " (SELECT id FROM conversations WHERE project_id IS ?) GROUP BY conversation_id",
                    (project_id,),
                )
            }
            previews = {}
            for r in rows:
                head = r["head_id"]
                p = self.db.conn.execute(
                    "SELECT content FROM messages WHERE id = ?", (head,)
                ).fetchone() if head else None
                previews[r["id"]] = (p["content"] if p else "")
        out = []
        for r in rows:
            c = self._conv(r)
            n, leaves = stats.get(c.id, (0, 0))
            c.message_count = n
            c.branch_count = leaves or 0
            c.preview = " ".join(previews.get(c.id, "").split())[:140]
            out.append(c)
        return out

    def get(self, cid: str) -> Conversation | None:
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (cid,)
            ).fetchone()
            if row is None:
                return None
            rows = self.db.conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
                (cid,),
            ).fetchall()
        conv = self._conv(row)
        tree = _Tree(rows)
        if conv.head_id not in tree.by_id:
            conv.head_id = tree.leaf(None)
        conv.messages = tree.path(conv.head_id)
        conv.message_count = len(tree.order)
        on_screen = {m.id for m in conv.messages}
        branches = []
        for leaf in tree.leaves():
            path = tree.path(leaf.id)
            fork_at = next((i for i, m in enumerate(path) if m.id not in on_screen), len(path))
            label, reply = _branch_label(path)
            branches.append({
                "head_id": leaf.id, "messages": len(path), "updated_at": leaf.created_at,
                "label": label, "reply": reply, "current": leaf.id == conv.head_id,
                "fork_at": fork_at,        # index of the first message not on screen
            })
        conv.branches = branches
        conv.branch_count = len(branches)
        conv.preview = " ".join((conv.messages[-1].content if conv.messages else "").split())[:140]
        return conv

    def update(self, cid: str, *, title: str | None = None, pinned: bool | None = None,
               settings: dict[str, Any] | None = None, touch: bool = True) -> bool:
        """Partial update. ``settings`` is merged (a ``None`` value removes a key)."""
        sets, args = [], []
        with self.db.lock:
            row = self.db.conn.execute("SELECT settings FROM conversations WHERE id = ?", (cid,)).fetchone()
            if row is None:
                return False
            if title is not None:
                sets.append("title = ?")
                args.append(title.strip()[:120] or "New chat")
            if pinned is not None:
                sets.append("pinned = ?")
                args.append(1 if pinned else 0)
            if settings is not None:
                merged = _json(row["settings"], {})
                for k, v in settings.items():
                    if k not in SETTING_KEYS:
                        continue
                    if v is None or v == "":
                        merged.pop(k, None)
                    else:
                        merged[k] = str(v)[:200]
                sets.append("settings = ?")
                args.append(json.dumps(_clean_settings(merged)))
            if touch:
                sets.append("updated_at = ?")
                args.append(_now())
            if sets:
                self.db.conn.execute(f"UPDATE conversations SET {', '.join(sets)} WHERE id = ?", (*args, cid))
                self.db.conn.commit()
        return True

    def rename(self, cid: str, title: str) -> bool:
        return self.update(cid, title=title or "")

    def delete(self, cid: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))
            self.db.conn.commit()
        return cur.rowcount > 0

    def fork(self, cid: str, upto: str | None = None, *, title: str | None = None,
             settings: dict[str, Any] | None = None) -> Conversation:
        """A new session holding a copy of the branch root → ``upto`` (default:
        the branch on screen, i.e. a duplicate). ``settings`` override the source's."""
        src = self.get(cid)
        if src is None:
            raise ChatError(f"unknown conversation: {cid!r}")
        if upto is not None:
            with self.db.lock:
                rows = self.db.conn.execute(
                    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,)
                ).fetchall()
            tree = _Tree(rows)
            if upto not in tree.by_id:
                raise ChatError(f"unknown message: {upto!r}")
            path = tree.path(upto)
        else:
            path = src.messages
        merged = dict(src.settings)
        for k, v in (settings or {}).items():
            if k in SETTING_KEYS and v:
                merged[k] = v
        base = src.title if src.title not in ("Chat", "New chat") else "Chat"
        new = self.create(
            src.project_id,
            title=title or (f"{base} (copy)" if upto is None else f"{base} (split)"),
            settings=merged,
            forked_from={"conversation_id": src.id, "title": src.title,
                         "message_id": path[-1].id if path else None, "messages": len(path)},
        )
        parent = None
        ts = _now()
        with self.db.lock:
            for m in path:
                mid = uuid.uuid4().hex
                self.db.conn.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, skill, created_at, meta, parent_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (mid, new.id, m.role, m.content, m.skill, m.created_at, json.dumps(m.meta), parent),
                )
                parent = mid
            self.db.conn.execute(
                "UPDATE conversations SET head_id = ?, updated_at = ? WHERE id = ?", (parent, ts, new.id))
            self.db.conn.commit()
        return self.get(new.id)  # type: ignore[return-value]

    # ── messages ───────────────────────────────────────────────────────
    def add_message(self, cid: str, role: str, content: str,
                    *, skill: str | None = None, meta: dict[str, Any] | None = None,
                    parent_id: str | None = HEAD) -> Message:
        """Append a message. ``parent_id`` defaults to the end of the branch on
        screen; pass another message's id to start a new branch below it, or
        ``None`` for a new first message. The new message becomes the head."""
        if role not in ("user", "assistant"):
            raise ChatError("role must be 'user' or 'assistant'")
        conv = self.get(cid)
        if conv is None:
            raise ChatError(f"unknown conversation: {cid!r}")
        if parent_id == HEAD:
            parent_id = conv.head_id
        elif parent_id is not None:
            with self.db.lock:
                ok = self.db.conn.execute(
                    "SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?", (parent_id, cid)
                ).fetchone()
            if ok is None:
                raise ChatError(f"unknown message: {parent_id!r}")
        mid = uuid.uuid4().hex
        ts = _now()
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, skill, created_at, meta, parent_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (mid, cid, role, content, skill, ts, json.dumps(meta or {}), parent_id),
            )
            self.db.conn.execute(
                "UPDATE conversations SET updated_at = ?, head_id = ? WHERE id = ?", (ts, mid, cid)
            )
            self.db.conn.commit()
        return Message(mid, role, content, skill, ts, dict(meta or {}), parent_id)

    def get_message(self, cid: str, mid: str) -> Message | None:
        with self.db.lock:
            m = self.db.conn.execute(
                "SELECT * FROM messages WHERE id = ? AND conversation_id = ?", (mid, cid)
            ).fetchone()
        return _message(m) if m else None

    def set_meta(self, cid: str, mid: str, meta: dict[str, Any]) -> None:
        with self.db.lock:
            self.db.conn.execute(
                "UPDATE messages SET meta = ? WHERE id = ? AND conversation_id = ?",
                (json.dumps(meta), mid, cid),
            )
            self.db.conn.commit()

    def select(self, cid: str, mid: str) -> Conversation:
        """Show the branch through ``mid`` (its newest continuation)."""
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,)
            ).fetchall()
        tree = _Tree(rows)
        if mid not in tree.by_id:
            raise ChatError(f"unknown message: {mid!r}")
        with self.db.lock:
            self.db.conn.execute("UPDATE conversations SET head_id = ? WHERE id = ?", (tree.leaf(mid), cid))
            self.db.conn.commit()
        return self.get(cid)  # type: ignore[return-value]

    def delete_message(self, cid: str, mid: str) -> int:
        """Delete message ``mid`` and everything below it (in every branch).
        Returns how many were removed; 0 if ``mid`` is not in the conversation."""
        if self.get(cid) is None:
            raise ChatError(f"unknown conversation: {cid!r}")
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,)
            ).fetchall()
        tree = _Tree(rows)
        if mid not in tree.by_id:
            return 0
        doomed = tree.subtree(mid)
        parent = tree.by_id[mid].parent_id
        with self.db.lock:
            self.db.conn.executemany("DELETE FROM messages WHERE id = ?", [(i,) for i in doomed])
            self.db.conn.commit()
            rest = self.db.conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,)
            ).fetchall()
            left = _Tree(rest)
            head = left.leaf(parent) if parent else left.leaf(None)
            self.db.conn.execute(
                "UPDATE conversations SET head_id = ?, updated_at = ? WHERE id = ?", (head, _now(), cid))
            self.db.conn.commit()
        return len(doomed)

    # Edit & resend used to truncate; the name stays for the API.
    truncate = delete_message

    # ── what the model sees ────────────────────────────────────────────
    def _branch(self, cid: str, upto: str | None = HEAD) -> tuple[Conversation, list[Message]]:
        conv = self.get(cid)
        if conv is None:
            raise ChatError(f"unknown conversation: {cid!r}")
        if upto == HEAD:
            return conv, conv.messages
        if upto is None:
            return conv, []
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,)
            ).fetchall()
        tree = _Tree(rows)
        if upto not in tree.by_id:
            raise ChatError(f"unknown message: {upto!r}")
        return conv, tree.path(upto)

    def history(self, cid: str, *, turns: int = _HISTORY_TURNS) -> list[dict[str, str]]:
        """The recent messages of the branch on screen as ``[{role, content}]``."""
        _, path = self._branch(cid)
        return [{"role": m.role, "content": m.content} for m in path][-turns:]

    def set_summary(self, cid: str, summary: str, upto: int, anchor: str | None = None) -> None:
        with self.db.lock:
            self.db.conn.execute(
                "UPDATE conversations SET summary = ?, summary_upto = ?, summary_anchor = ? WHERE id = ?",
                (summary or "", upto, anchor, cid),
            )
            self.db.conn.commit()

    def history_for_model(self, cid: str, *, budget: int, summarize: Any = None,
                          upto: str | None = HEAD) -> tuple[str, list[dict[str, str]]]:
        """Return ``(summary, recent_turns)`` for the branch ending at ``upto``
        (default: the branch on screen).

        Keeps the last ``budget`` messages verbatim. When older messages exist and
        a ``summarize(prior_summary, new_messages) -> str`` callable is given, the
        newly-overflowed messages are folded into a rolling summary. The summary
        remembers the last message it covers, so it is reused only on a branch
        that contains that message; another branch gets its own.
        """
        conv, path = self._branch(cid, upto)
        msgs = [{"role": m.role, "content": m.content} for m in path]
        ids = [m.id for m in path]
        covered, summary = 0, ""
        anchor = conv.summary_anchor
        if anchor is None and conv.summary_upto and conv.summary:      # before branches existed
            anchor = ids[conv.summary_upto - 1] if conv.summary_upto <= len(ids) else None
        if anchor and anchor in ids:
            covered, summary = ids.index(anchor) + 1, conv.summary
        if budget <= 0 or len(msgs) <= budget or summarize is None:
            if budget > 0 and len(msgs) > budget and covered:
                return summary, msgs[-budget:]
            return (summary if covered else ""), (msgs[-budget:] if budget > 0 else msgs)
        older_count = len(msgs) - budget
        if older_count > covered:
            summary = summarize(summary, msgs[covered:older_count]) or summary
            self.set_summary(cid, summary, older_count, ids[older_count - 1])
        return summary, msgs[older_count:]

    def export_markdown(self, cid: str) -> str:
        conv = self.get(cid)
        if conv is None:
            raise ChatError(f"unknown conversation: {cid!r}")
        lines = [f"# {conv.title}", ""]
        s = conv.settings
        if s:
            lines += ["_" + " · ".join(str(s[k]) for k in SETTING_KEYS if s.get(k)) + "_", ""]
        for m in conv.messages:
            who = "You" if m.role == "user" else "Assistant"
            extra = f" ({m.meta.get('model')})" if m.role == "assistant" and m.meta.get("model") else ""
            lines += [f"## {who}{extra}", "", m.content.strip() or "_(empty)_", ""]
        return "\n".join(lines).rstrip() + "\n"


def _clean_settings(settings: dict[str, Any]) -> dict[str, str]:
    out = {k: str(settings[k])[:200] for k in SETTING_KEYS if settings.get(k)}
    if out.get("mode") not in (None, "agent", "chat"):
        out.pop("mode")
    return out
