"""SQLite persistence bootstrap (stdlib ``sqlite3``).

Holds one connection guarded by a lock — FastAPI runs these handlers
synchronously and uvicorn defaults to a single worker, so a shared connection
with ``check_same_thread=False`` is sufficient and avoids per-call open cost.
"""

from __future__ import annotations

import os
import sqlite3
import threading

from .config import get_config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'tex',
    main_path  TEXT NOT NULL DEFAULT 'main.tex',
    settings   TEXT NOT NULL DEFAULT '{}',
    memory     TEXT NOT NULL DEFAULT '',
    owner_id   TEXT,
    favourite  INTEGER NOT NULL DEFAULT 0,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    project_id TEXT NOT NULL,
    path       TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    data       BLOB,
    is_binary  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, path),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    name        TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prompt      TEXT NOT NULL,
    is_code     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    project_id   TEXT,
    title        TEXT NOT NULL DEFAULT 'New chat',
    summary      TEXT NOT NULL DEFAULT '',
    summary_upto INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    skill           TEXT,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS providers (
    name          TEXT PRIMARY KEY,   -- a config.toml provider's name = an override
    type          TEXT,               -- NULL fields inherit from config.toml
    api_base      TEXT,
    models        TEXT,               -- JSON list of model names
    default_model TEXT,
    api_key_enc   TEXT,               -- AES-GCM ciphertext (secretbox.py), never the key
    key_hint      TEXT NOT NULL DEFAULT '',
    api_key_env   TEXT,
    tools         INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
    id           TEXT PRIMARY KEY,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    project_id  TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',
    filename    TEXT NOT NULL DEFAULT '',
    artifact_id TEXT,
    report      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"""

# Columns added after the initial release, applied to pre-existing DBs.
_MIGRATIONS = {
    "files": [
        ("data", "ALTER TABLE files ADD COLUMN data BLOB"),
        ("is_binary", "ALTER TABLE files ADD COLUMN is_binary INTEGER NOT NULL DEFAULT 0"),
    ],
    "projects": [
        ("settings", "ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'"),
        ("favourite", "ALTER TABLE projects ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0"),
        ("archived", "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"),
        ("memory", "ALTER TABLE projects ADD COLUMN memory TEXT NOT NULL DEFAULT ''"),
        ("owner_id", "ALTER TABLE projects ADD COLUMN owner_id TEXT"),
    ],
    "conversations": [
        ("summary", "ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''"),
        ("summary_upto", "ALTER TABLE conversations ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0"),
        ("summary_anchor", "ALTER TABLE conversations ADD COLUMN summary_anchor TEXT"),
        ("head_id", "ALTER TABLE conversations ADD COLUMN head_id TEXT"),
        ("settings", "ALTER TABLE conversations ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'"),
        ("pinned", "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"),
        ("forked_from", "ALTER TABLE conversations ADD COLUMN forked_from TEXT NOT NULL DEFAULT '{}'"),
    ],
    "messages": [
        ("meta", "ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'"),
        ("parent_id", "ALTER TABLE messages ADD COLUMN parent_id TEXT"),
    ],
    "skills": [
        ("mode", "ALTER TABLE skills ADD COLUMN mode TEXT NOT NULL DEFAULT 'agent'"),
    ],
}


def default_db_path() -> str:
    """DB path: ``TEX2WORD_DB`` env var, else ``config.backend.metasqlite_db``."""
    return os.environ.get("TEX2WORD_DB") or get_config().backend.metasqlite_db


class Database:
    """A thin connection holder with schema bootstrap."""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or default_db_path()
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(_SCHEMA)
        self._migrate()
        self._conn.commit()

    def _migrate(self) -> None:
        added: set[tuple[str, str]] = set()
        for table, cols in _MIGRATIONS.items():
            existing = {
                row["name"]
                for row in self._conn.execute(f"PRAGMA table_info({table})")
            }
            for name, ddl in cols:
                if name not in existing:
                    self._conn.execute(ddl)
                    added.add((table, name))
        if ("messages", "parent_id") in added:
            self._chain_messages()
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS messages_by_parent ON messages (conversation_id, parent_id)")

    def _chain_messages(self) -> None:
        """Chats from before branching were flat lists: link each message to the
        one before it and put the head at the last one."""
        convs = [r["id"] for r in self._conn.execute("SELECT id FROM conversations")]
        for cid in convs:
            ids = [r["id"] for r in self._conn.execute(
                "SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (cid,))]
            self._conn.executemany(
                "UPDATE messages SET parent_id = ? WHERE id = ?",
                [(ids[i - 1], ids[i]) for i in range(1, len(ids))])
            if ids:
                self._conn.execute("UPDATE conversations SET head_id = ? WHERE id = ?", (ids[-1], cid))

    @property
    def lock(self) -> threading.Lock:
        return self._lock

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def close(self) -> None:
        self._conn.close()
