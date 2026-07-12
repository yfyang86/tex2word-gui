"""Durable artifact store (SQLite-backed).

Holds converted ``.docx`` bytes between conversion and the browser's download
request. Persisted in the ``artifacts`` table so artifacts survive a restart and
are shared by every worker on the same database (replacing the original
process-local TTL map). Old artifacts are swept on access via a TTL.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .db import Database

_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class Artifact:
    filename: str
    data: bytes
    content_type: str
    created_at: str


class ArtifactStore:
    def __init__(self, db: Database | None = None, ttl_seconds: float = 86400.0) -> None:
        self.db = db or Database()
        self._ttl = ttl_seconds

    def put(self, data: bytes, filename: str, content_type: str = _DOCX) -> str:
        self._evict_expired()
        artifact_id = uuid.uuid4().hex
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO artifacts (id, filename, content_type, data, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (artifact_id, filename, content_type, data, _now().isoformat()),
            )
            self.db.conn.commit()
        return artifact_id

    def get(self, artifact_id: str) -> Artifact | None:
        self._evict_expired()
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
            ).fetchone()
        if row is None:
            return None
        return Artifact(
            filename=row["filename"],
            data=bytes(row["data"]),
            content_type=row["content_type"],
            created_at=row["created_at"],
        )

    def _evict_expired(self) -> None:
        cutoff = (_now() - timedelta(seconds=self._ttl)).isoformat()
        with self.db.lock:
            self.db.conn.execute("DELETE FROM artifacts WHERE created_at < ?", (cutoff,))
            self.db.conn.commit()
