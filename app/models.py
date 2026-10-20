"""Pydantic request/response schemas for the API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ConvertOptionsIn(BaseModel):
    number_by_section: bool = False
    columns: int = Field(default=1, ge=1, le=4)
    language: str | None = None
    frontend: str = "pure"
    citation_mode: str = "static"
    csl: str | None = None
    math_image_fallback: bool = False
    reference_doc: str | None = None


class ConvertRequest(BaseModel):
    source: str
    filename: str = "document.docx"
    options: ConvertOptionsIn = Field(default_factory=ConvertOptionsIn)


class ConvertResponse(BaseModel):
    artifact_id: str
    filename: str
    download_url: str
    report: dict[str, Any]


class ToLatexResponse(BaseModel):
    latex: str


class MarkdownToTex(BaseModel):
    markdown: str
    title: str | None = None


class PreviewRequest(BaseModel):
    source: str
    options: ConvertOptionsIn = Field(default_factory=ConvertOptionsIn)


class PreviewResponse(BaseModel):
    # Full document HTML. ``None`` only when the request carried a ``base_rev``
    # the server still holds — then rebuild it from ``segments``.
    html: str | None
    outline: list[dict[str, Any]]
    statistics: dict[str, Any]
    report: dict[str, Any]
    title: str | None = None
    # [[key, html | None], …] — one keyed top-level element each; html is None
    # for a key the client already has (from revision ``base_rev``).
    segments: list[list[Any]] = Field(default_factory=list)
    rev: int | None = None
    mode: str = "full"            # the mode actually used ("quick" may fall back)
    reason: str | None = None     # why a quick request ran as full
    main_path: str | None = None  # the render root that was used
    source_map: dict[str, Any] | None = None  # {files: [...], includes: [[f, line, target]]}
    timings: dict[str, Any] | None = None
    chunks: dict[str, Any] | None = None


class ContextFile(BaseModel):
    path: str
    content: str = ""


class AssistantRequest(BaseModel):
    action: str
    source: str = ""
    instruction: str | None = None
    report: dict[str, Any] | None = None
    provider: str | None = None
    context: list[ContextFile] = Field(default_factory=list)


class AssistantResponse(BaseModel):
    reply: str
    provider: str
    model: str
    action: str
    is_code: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class ConversationCreate(BaseModel):
    title: str = "New chat"


class ConversationRename(BaseModel):
    title: str


class ChatRequest(BaseModel):
    content: str
    source: str = ""
    provider: str | None = None
    skill: str | None = None
    context: list[ContextFile] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    tex2word_version: str
    app_version: str


class ErrorResponse(BaseModel):
    detail: str


# -- projects -----------------------------------------------------------------
class ProjectCreate(BaseModel):
    name: str
    kind: str = "tex"
    main_path: str = "main.tex"
    files: dict[str, str] = Field(default_factory=dict)


class ProjectUpdate(BaseModel):
    name: str | None = None
    main_path: str | None = None
    favourite: bool | None = None
    archived: bool | None = None


class SettingsUpdate(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class MemoryUpdate(BaseModel):
    memory: str = ""


class FilePut(BaseModel):
    content: str = ""


class ProjectConvertRequest(BaseModel):
    options: ConvertOptionsIn = Field(default_factory=ConvertOptionsIn)
    filename: str | None = None
    # render this file as the document root; falls back to the detected main
    main_path: str | None = None


class ProjectPreviewRequest(ProjectConvertRequest):
    # "full" re-parses everything; "quick" re-parses only the changed chunks
    # (falling back to full when that could be inaccurate — see ``reason``).
    mode: Literal["full", "quick"] = "full"
    # the ``rev`` of the last preview the client applied: unchanged segments
    # then come back with html=None
    base_rev: int | None = None


class MarkdownImport(BaseModel):
    name: str
    markdown: str


class ArxivImport(BaseModel):
    arxiv_id: str
