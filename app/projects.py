"""Project store — CRUD over projects and their files, persisted in SQLite."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .db import Database

_KINDS = {"tex", "arxiv", "markdown"}


class ProjectError(Exception):
    """Invalid project operation (bad kind, unknown id, etc.)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(slots=True)
class ProjectFile:
    path: str
    content: str           # text content ("" for binary assets)
    updated_at: str
    is_binary: bool = False
    size: int = 0

    def public(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "path": self.path,
            "is_binary": self.is_binary,
            "size": self.size,
            "updated_at": self.updated_at,
        }
        if not self.is_binary:
            data["content"] = self.content
        return data


@dataclass(slots=True)
class Project:
    id: str
    name: str
    kind: str
    main_path: str
    created_at: str
    updated_at: str
    file_count: int = 0
    favourite: bool = False
    archived: bool = False
    settings: dict[str, Any] = field(default_factory=dict)
    files: list[ProjectFile] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "main_path": self.main_path,
            "file_count": self.file_count,
            "favourite": self.favourite,
            "archived": self.archived,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def detail(self) -> dict[str, Any]:
        data = self.summary()
        data["settings"] = self.settings
        data["files"] = [f.public() for f in self.files]
        return data

    def file_map(self) -> dict[str, str]:
        """Text files only (path → content); binary assets are excluded."""
        return {f.path: f.content for f in self.files if not f.is_binary}


class ProjectStore:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or Database()

    # -- projects -------------------------------------------------------------
    def create(
        self,
        name: str,
        *,
        kind: str = "tex",
        main_path: str = "main.tex",
        files: dict[str, str] | None = None,
        owner_id: str | None = None,
    ) -> Project:
        if not name or not name.strip():
            raise ProjectError("project name is required")
        if kind not in _KINDS:
            raise ProjectError(f"kind must be one of {sorted(_KINDS)}")
        pid = uuid.uuid4().hex
        ts = _now()
        with self.db.lock:
            self.db.conn.execute(
                "INSERT INTO projects (id, name, kind, main_path, owner_id, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (pid, name.strip(), kind, main_path, owner_id, ts, ts),
            )
            for path, content in (files or {}).items():
                self.db.conn.execute(
                    "INSERT INTO files (project_id, path, content, updated_at)"
                    " VALUES (?, ?, ?, ?)",
                    (pid, path, content, ts),
                )
            self.db.conn.commit()
        return self.get(pid)  # type: ignore[return-value]

    def list(self, owner_id: str | None = None) -> list[Project]:
        """All projects, or — when ``owner_id`` is given — that owner's plus any
        unowned (legacy / created while auth was off) projects."""
        sql = (
            "SELECT p.*, "
            "(SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS file_count "
            "FROM projects p "
        )
        params: tuple = ()
        if owner_id is not None:
            sql += "WHERE p.owner_id = ? OR p.owner_id IS NULL "
            params = (owner_id,)
        sql += "ORDER BY p.updated_at DESC"
        with self.db.lock:
            rows = self.db.conn.execute(sql, params).fetchall()
        return [self._row_to_project(r) for r in rows]

    def owner_info(self, project_id: str) -> tuple[bool, str | None]:
        """``(exists, owner_id)`` — ``owner_id`` is ``None`` for unowned projects."""
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT owner_id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        if row is None:
            return False, None
        return True, row["owner_id"]

    def get(self, project_id: str) -> Project | None:
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT p.*, "
                "(SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS file_count "
                "FROM projects p WHERE p.id = ?",
                (project_id,),
            ).fetchone()
            if row is None:
                return None
            files = self.db.conn.execute(
                "SELECT path, content, is_binary, updated_at, "
                "length(data) AS dlen FROM files "
                "WHERE project_id = ? ORDER BY path",
                (project_id,),
            ).fetchall()
        project = self._row_to_project(row)
        project.files = [
            ProjectFile(
                path=f["path"],
                content="" if f["is_binary"] else f["content"],
                updated_at=f["updated_at"],
                is_binary=bool(f["is_binary"]),
                size=(f["dlen"] or 0) if f["is_binary"] else len(f["content"] or ""),
            )
            for f in files
        ]
        return project

    def update(
        self,
        project_id: str,
        *,
        name: str | None = None,
        main_path: str | None = None,
        favourite: bool | None = None,
        archived: bool | None = None,
    ) -> Project:
        fields, values = [], []
        if name is not None:
            if not name.strip():
                raise ProjectError("project name cannot be empty")
            fields.append("name = ?")
            values.append(name.strip())
        if main_path is not None:
            fields.append("main_path = ?")
            values.append(main_path)
        if favourite is not None:
            fields.append("favourite = ?")
            values.append(1 if favourite else 0)
        if archived is not None:
            fields.append("archived = ?")
            values.append(1 if archived else 0)
        with self.db.lock:
            if not self._exists(project_id):
                raise ProjectError("project not found")
            if fields:
                fields.append("updated_at = ?")
                values.append(_now())
                values.append(project_id)
                self.db.conn.execute(
                    f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", values
                )
                self.db.conn.commit()
        return self.get(project_id)  # type: ignore[return-value]

    def delete(self, project_id: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            self.db.conn.commit()
            return cur.rowcount > 0

    # -- files ----------------------------------------------------------------
    def put_file(self, project_id: str, path: str, content: str) -> ProjectFile:
        if not path or not path.strip():
            raise ProjectError("file path is required")
        ts = _now()
        with self.db.lock:
            if not self._exists(project_id):
                raise ProjectError("project not found")
            self.db.conn.execute(
                "INSERT INTO files (project_id, path, content, data, is_binary, updated_at) "
                "VALUES (?, ?, ?, NULL, 0, ?) "
                "ON CONFLICT(project_id, path) DO UPDATE SET "
                "content = excluded.content, data = NULL, is_binary = 0, "
                "updated_at = excluded.updated_at",
                (project_id, path, content, ts),
            )
            self._touch(project_id, ts)
            self.db.conn.commit()
        return ProjectFile(path=path, content=content, updated_at=ts, size=len(content))

    def put_binary(self, project_id: str, path: str, data: bytes) -> ProjectFile:
        if not path or not path.strip():
            raise ProjectError("file path is required")
        ts = _now()
        with self.db.lock:
            if not self._exists(project_id):
                raise ProjectError("project not found")
            self.db.conn.execute(
                "INSERT INTO files (project_id, path, content, data, is_binary, updated_at) "
                "VALUES (?, ?, '', ?, 1, ?) "
                "ON CONFLICT(project_id, path) DO UPDATE SET "
                "content = '', data = excluded.data, is_binary = 1, "
                "updated_at = excluded.updated_at",
                (project_id, path, data, ts),
            )
            self._touch(project_id, ts)
            self.db.conn.commit()
        return ProjectFile(
            path=path, content="", updated_at=ts, is_binary=True, size=len(data)
        )

    def assets(self, project_id: str) -> dict[str, bytes]:
        """All binary files of a project as ``path → bytes``."""
        with self.db.lock:
            rows = self.db.conn.execute(
                "SELECT path, data FROM files WHERE project_id = ? AND is_binary = 1",
                (project_id,),
            ).fetchall()
        return {r["path"]: bytes(r["data"]) for r in rows if r["data"] is not None}

    def file_bytes(self, project_id: str, path: str) -> tuple[bool, bytes] | None:
        """Return ``(is_binary, bytes)`` for serving a file raw, or ``None``."""
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT content, data, is_binary FROM files "
                "WHERE project_id = ? AND path = ?",
                (project_id, path),
            ).fetchone()
        if row is None:
            return None
        if row["is_binary"]:
            return True, bytes(row["data"] or b"")
        return False, (row["content"] or "").encode("utf-8")

    def delete_file(self, project_id: str, path: str) -> bool:
        with self.db.lock:
            cur = self.db.conn.execute(
                "DELETE FROM files WHERE project_id = ? AND path = ?",
                (project_id, path),
            )
            if cur.rowcount:
                self.db.conn.execute(
                    "UPDATE projects SET updated_at = ? WHERE id = ?",
                    (_now(), project_id),
                )
            self.db.conn.commit()
            return cur.rowcount > 0

    # -- helpers --------------------------------------------------------------
    def _touch(self, project_id: str, ts: str) -> None:
        self.db.conn.execute(
            "UPDATE projects SET updated_at = ? WHERE id = ?", (ts, project_id)
        )

    def _exists(self, project_id: str) -> bool:
        return (
            self.db.conn.execute(
                "SELECT 1 FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
            is not None
        )

    def set_settings(self, project_id: str, settings: dict[str, Any]) -> Project:
        if not isinstance(settings, dict):
            raise ProjectError("settings must be an object")
        with self.db.lock:
            if not self._exists(project_id):
                raise ProjectError("project not found")
            self.db.conn.execute(
                "UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?",
                (json.dumps(settings), _now(), project_id),
            )
            self.db.conn.commit()
        return self.get(project_id)  # type: ignore[return-value]

    def get_memory(self, project_id: str) -> str:
        """Per-project assistant memory (free-text notes); '' if none/unknown."""
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT memory FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        return (row["memory"] if row and "memory" in row.keys() else "") or ""

    def set_memory(self, project_id: str, memory: str) -> bool:
        with self.db.lock:
            if not self._exists(project_id):
                raise ProjectError("project not found")
            self.db.conn.execute(
                "UPDATE projects SET memory = ?, updated_at = ? WHERE id = ?",
                (memory or "", _now(), project_id),
            )
            self.db.conn.commit()
        return True

    @staticmethod
    def _row_to_project(row: Any) -> Project:
        keys = row.keys()
        settings: dict[str, Any] = {}
        if "settings" in keys and row["settings"]:
            try:
                settings = json.loads(row["settings"])
            except (ValueError, TypeError):
                settings = {}
        return Project(
            id=row["id"],
            name=row["name"],
            kind=row["kind"],
            main_path=row["main_path"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            file_count=row["file_count"] if "file_count" in keys else 0,
            favourite=bool(row["favourite"]) if "favourite" in keys else False,
            archived=bool(row["archived"]) if "archived" in keys else False,
            settings=settings,
        )
