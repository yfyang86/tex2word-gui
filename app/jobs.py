"""Async conversion jobs.

Large conversions can outlast an HTTP request, so they run in a background
thread pool and the client polls a job for status. ``JobStore`` persists job
rows in the ``jobs`` table (durable across restarts — though an in-flight job is
*not* resumed); ``JobQueue`` is the thin executor wrapper that runs the work.
"""

from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .db import Database

STATUSES = ("queued", "running", "done", "error")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(slots=True)
class Job:
    id: str
    kind: str
    project_id: str | None
    status: str
    filename: str
    artifact_id: str | None
    report: dict[str, Any] | None
    error: str | None
    created_at: str
    updated_at: str

    def public(self) -> dict[str, Any]:
        data = {
            "id": self.id, "kind": self.kind, "project_id": self.project_id,
            "status": self.status, "filename": self.filename,
            "artifact_id": self.artifact_id, "error": self.error,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }
        if self.status == "done":
            data["report"] = self.report
            data["download_url"] = f"/api/artifacts/{self.artifact_id}"
        return data


class JobStore:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    def create(self, kind: str, *, project_id: str | None = None,
               filename: str = "") -> Job:
        jid = uuid.uuid4().hex
        ts = _now()
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO jobs (id, kind, project_id, status, filename, created_at, updated_at)"
                " VALUES (?, ?, ?, 'queued', ?, ?, ?)",
                (jid, kind, project_id, filename, ts, ts),
            )
            self.db.conn.commit()
        return self.get(jid)  # type: ignore[return-value]

    def get(self, jid: str) -> Job | None:
        with self.db.lock:
            row = self.db.conn.execute("SELECT * FROM jobs WHERE id = ?", (jid,)).fetchone()
        if row is None:
            return None
        return Job(
            id=row["id"], kind=row["kind"], project_id=row["project_id"],
            status=row["status"], filename=row["filename"],
            artifact_id=row["artifact_id"],
            report=json.loads(row["report"]) if row["report"] else None,
            error=row["error"], created_at=row["created_at"], updated_at=row["updated_at"],
        )

    def set_running(self, jid: str) -> None:
        self._update(jid, status="running")

    def set_done(self, jid: str, artifact_id: str, report: dict[str, Any]) -> None:
        self._update(jid, status="done", artifact_id=artifact_id,
                     report=json.dumps(report))

    def set_error(self, jid: str, message: str) -> None:
        self._update(jid, status="error", error=message)

    def _update(self, jid: str, **fields: Any) -> None:
        fields["updated_at"] = _now()
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self.db.lock:
            self.db.conn.execute(
                f"UPDATE jobs SET {cols} WHERE id = ?", (*fields.values(), jid)
            )
            self.db.conn.commit()


class JobQueue:
    """Runs a job callable in a background thread (override ``submit`` in tests)."""

    def __init__(self, max_workers: int = 2) -> None:
        self._pool = ThreadPoolExecutor(max_workers=max_workers,
                                        thread_name_prefix="tex2word-job")

    def submit(self, fn: Callable[[], None]) -> None:
        self._pool.submit(fn)
