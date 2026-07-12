"""User accounts store (over the shared SQLite ``Database``).

Holds usernames, scrypt password hashes and a role. Used by the auth endpoints
and the ``manage.py`` admin script. Passwords are hashed via :mod:`app.auth`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import auth
from .db import Database

_ROLES = {"admin", "user"}


class UserError(Exception):
    """Invalid user input (bad role, duplicate username, missing user)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(slots=True)
class User:
    id: str
    username: str
    role: str
    created_at: str
    updated_at: str

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class UserStore:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    def create(self, username: str, password: str, *, role: str = "user") -> User:
        username = (username or "").strip()
        if not username:
            raise UserError("username is required")
        if role not in _ROLES:
            raise UserError(f"role must be one of {sorted(_ROLES)}")
        uid = uuid.uuid4().hex
        ts = _now()
        pwd_hash = auth.hash_password(password)
        with self.db.lock:
            try:
                self.db.conn.execute(
                    "INSERT INTO users (id, username, password_hash, role, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (uid, username, pwd_hash, role, ts, ts),
                )
                self.db.conn.commit()
            except Exception as exc:  # sqlite3.IntegrityError on the UNIQUE username
                raise UserError(f"username {username!r} already exists") from exc
        return User(uid, username, role, ts, ts)

    def authenticate(self, username: str, password: str) -> User | None:
        """Return the user iff the password matches; else ``None``."""
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT * FROM users WHERE username = ?", ((username or "").strip(),)
            ).fetchone()
        if row is None or not auth.verify_password(password, row["password_hash"]):
            return None
        return self._row(row)

    def get_by_username(self, username: str) -> User | None:
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT * FROM users WHERE username = ?", ((username or "").strip(),)
            ).fetchone()
        return self._row(row) if row else None

    def list(self) -> list[User]:
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT * FROM users ORDER BY created_at"
            ).fetchall()
        return [self._row(r) for r in rows]

    def count(self) -> int:
        with self.db.lock:
            return self.db.conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]

    def set_password(self, username: str, password: str) -> bool:
        pwd_hash = auth.hash_password(password)
        with self.db.lock:
            cur = self.db.conn.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?",
                (pwd_hash, _now(), (username or "").strip()),
            )
            self.db.conn.commit()
        return cur.rowcount > 0

    def set_role(self, username: str, role: str) -> bool:
        if role not in _ROLES:
            raise UserError(f"role must be one of {sorted(_ROLES)}")
        with self.db.lock:
            cur = self.db.conn.execute(
                "UPDATE users SET role = ?, updated_at = ? WHERE username = ?",
                (role, _now(), (username or "").strip()),
            )
            self.db.conn.commit()
        return cur.rowcount > 0

    def delete(self, username: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute(
                "DELETE FROM users WHERE username = ?", ((username or "").strip(),)
            )
            self.db.conn.commit()
        return cur.rowcount > 0

    @staticmethod
    def _row(row: Any) -> User:
        return User(
            id=row["id"], username=row["username"], role=row["role"],
            created_at=row["created_at"], updated_at=row["updated_at"],
        )
