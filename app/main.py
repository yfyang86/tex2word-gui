"""FastAPI application for Tex Word Studio."""

from __future__ import annotations

import json
import mimetypes
import re
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, assistant, ingest, llm, service, skills, sourcemap, tikzeditor
from .livepreview import PreviewEngine, PreviewError
from .auth import AuthError, Authenticator
from .chat import ChatError, ConversationStore
from .config import get_config
from .models import (
    ArxivImport,
    AssistantRequest,
    AssistantResponse,
    ChatRequest,
    ConversationCreate,
    ConversationRename,
    ConvertRequest,
    ConvertResponse,
    FilePut,
    LoginRequest,
    MarkdownImport,
    MarkdownToTex,
    MemoryUpdate,
    PreviewRequest,
    PreviewResponse,
    ProjectConvertRequest,
    ProjectPreviewRequest,
    ProjectCreate,
    ProjectUpdate,
    SettingsUpdate,
    HealthResponse,
    ToLatexResponse,
)
from .jobs import JobQueue, JobStore
from .projects import ProjectError, ProjectStore
from .security import RateLimiter
from .skills import SkillStore
from .store import ArtifactStore
from .users import UserStore

STATIC_DIR = Path(__file__).parent / "static"

config = get_config()

app = FastAPI(title="Tex Word Studio", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.frontend.cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)

projects = ProjectStore()
store = ArtifactStore(projects.db)        # durable artifacts in the shared DB
users = UserStore(projects.db)  # share the one SQLite connection
skill_store = SkillStore(projects.db)
chats = ConversationStore(projects.db)
job_store = JobStore(projects.db)
job_queue = JobQueue()
preview_engine = PreviewEngine()  # cached parses for full/quick live preview
rate_limiter = RateLimiter(enabled=config.security.rate_limit_enabled)

# Optional account auth (opt-in via [auth].enabled). Building it never fails the
# import: if enabled but the keys are missing, routes stay locked (503) until the
# admin script generates them.
_auth_init_error: str | None = None
try:
    authn = Authenticator.from_config(config.auth)
except AuthError as exc:
    _auth_init_error = str(exc)
    authn = Authenticator(
        enabled=config.auth.enabled,
        ttl_hours=config.auth.token_ttl_hours,
        issuer=config.auth.issuer,
    )

# /api paths reachable without a session when auth is on.
_OPEN_PATHS = {"/api/health", "/api/config", "/api/auth/login"}


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # GETs for <img>/<a download> can't set headers — accept a query token too.
    return request.query_params.get("access_token")


@app.middleware("http")
async def tikz_editor_csp(request: Request, call_next):
    """Serve the embedded TikZ editor's pages under a strict CSP (see tikzeditor.py)."""
    response = await call_next(request)
    if tikzeditor.is_bundle_path(request.url.path):
        response.headers["Content-Security-Policy"] = tikzeditor.CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.middleware("http")
async def body_limit(request: Request, call_next):
    """Reject over-large requests up front (by Content-Length) with a 413."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            size = int(cl)
        except ValueError:
            size = 0
        limit_mb = config.security.max_body_mb
        if request.url.path == "/api/projects/import/archive":
            # archive uploads may go up to the import limit ([import].max_archive_mb)
            limit_mb = max(limit_mb, config.imports.max_archive_mb)
        if size > limit_mb * 1024 * 1024:
            return JSONResponse(
                {"detail": f"request body too large (max {limit_mb} MB)"},
                status_code=413,
            )
    return await call_next(request)


def _rate_bucket(path: str) -> str:
    if path == "/api/auth/login":
        return "login"
    if any(s in path for s in ("/convert", "/assistant", "/message", "/import/")):
        return "heavy"
    return "gen"


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """Per-IP fixed-window rate limiting on /api (tighter on login + heavy ops)."""
    path = request.url.path
    if not rate_limiter.enabled or not path.startswith("/api/"):
        return await call_next(request)
    ip = request.client.host if request.client else "anon"
    bucket = _rate_bucket(path)
    limits = {
        "login": config.security.login_rate_limit_per_min,
        "heavy": config.security.heavy_rate_limit_per_min,
        "gen": config.security.rate_limit_per_min,
    }
    if not rate_limiter.allow(f"{bucket}:{ip}", limits[bucket]):
        return JSONResponse(
            {"detail": "rate limit exceeded — slow down and retry shortly"},
            status_code=429,
        )
    return await call_next(request)


def _scoped_project_id(path: str) -> str | None:
    """The project a request touches (for ownership checks), or None if it isn't
    project-scoped / the resource is unknown (let the handler 404)."""
    parts = path.strip("/").split("/")  # e.g. ['api','projects','{id}', ...]
    if len(parts) < 3 or parts[0] != "api":
        return None
    if parts[1] == "projects" and parts[2] != "import":
        return parts[2]
    if parts[1] == "conversations":
        conv = chats.get(parts[2])
        return conv.project_id if conv else None
    if parts[1] == "jobs":
        job = job_store.get(parts[2])
        return job.project_id if job else None
    return None


def _project_visible(project_id: str, claims: dict | None) -> bool:
    exists, owner = projects.owner_info(project_id)
    if not exists:
        return True  # unknown project → let the handler return 404
    if claims and claims.get("role") == "admin":
        return True
    sub = claims.get("sub") if claims else None
    return owner is None or owner == sub  # unowned (legacy) is shared


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    """Authenticate (RSA-JWT) and authorize (project ownership) /api routes when
    auth is enabled. A no-op when auth is off."""
    if not authn.enabled:
        return await call_next(request)
    path = request.url.path
    if request.method == "OPTIONS" or path in _OPEN_PATHS or not path.startswith("/api/"):
        return await call_next(request)
    if authn.public_key is None:
        return JSONResponse(
            {"detail": "auth is enabled but signing keys are missing — "
             "run `python manage.py init-keys`"},
            status_code=503,
        )
    token = _bearer(request)
    if not token:
        return JSONResponse({"detail": "authentication required"}, status_code=401)
    try:
        request.state.user = authn.verify_token(token)
    except AuthError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=401)
    pid = _scoped_project_id(path)
    if pid is not None and not _project_visible(pid, request.state.user):
        return JSONResponse({"detail": "you do not have access to this project"},
                            status_code=403)
    return await call_next(request)


def _safe_filename(name: str, default: str = "document.docx") -> str:
    name = (name or "").strip() or default
    name = Path(name).name  # strip any path components
    if not name.lower().endswith(".docx"):
        name += ".docx"
    # keep it conservative for the Content-Disposition header
    return re.sub(r'[^A-Za-z0-9._-]+', "_", name)


def _effective_main(project, override: str | None) -> str:
    """The document root for a render/convert.

    A requested file that can stand on its own (``\\documentclass`` /
    ``\\begin{document}``) is used as-is — the "several mains" case. A requested
    *fragment* (a chapter pulled in by ``\\input``) resolves to the root that
    includes it, so editing a sub-file still previews the whole document.
    Anything else falls back to the project's detected main file."""
    files = project.file_map()
    if override and override in files:
        if sourcemap.is_root_source(files[override]):
            return override
        root = sourcemap.including_root(files, override, prefer=project.main_path)
        if root:
            return root
    return project.main_path


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        tex2word_version=service.engine_version(),
        app_version=__version__,
    )


@app.get("/api/config")
def get_app_config() -> dict:
    """Redacted runtime configuration (no API keys are ever returned)."""
    data = config.public()
    data["tex2word_version"] = service.engine_version()
    data["app_version"] = __version__
    data["auth"] = {"enabled": authn.enabled}  # the live authenticator state
    data["tools"] = {"tikz_editor": tikzeditor.info(STATIC_DIR)}
    return data


@app.post("/api/auth/login")
def login(req: LoginRequest) -> dict:
    if not authn.enabled:
        raise HTTPException(status_code=400, detail="authentication is disabled")
    user = users.authenticate(req.username, req.password)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid username or password")
    try:
        token = authn.issue_token(subject=user.username, role=user.role)
    except AuthError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"token": token, "user": user.public()}


@app.get("/api/auth/me")
def whoami(request: Request) -> dict:
    """The current session's user (reachable only past the auth middleware)."""
    claims = getattr(request.state, "user", None)
    if not claims:
        raise HTTPException(status_code=401, detail="not authenticated")
    return {"username": claims.get("sub"), "role": claims.get("role")}


@app.post("/api/convert", response_model=ConvertResponse)
def convert(req: ConvertRequest) -> ConvertResponse:
    try:
        options = service.ConvertOptions.from_payload(req.options.model_dump())
        docx, report = service.convert(req.source, options)
    except service.ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    filename = _safe_filename(req.filename)
    artifact_id = store.put(docx, filename)
    return ConvertResponse(
        artifact_id=artifact_id,
        filename=filename,
        download_url=f"/api/artifacts/{artifact_id}",
        report=report,
    )


@app.get("/api/artifacts/{artifact_id}")
def download_artifact(artifact_id: str) -> Response:
    artifact = store.get(artifact_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="artifact not found or expired")
    return Response(
        content=artifact.data,
        media_type=artifact.content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{artifact.filename}"'
        },
    )


@app.post("/api/preview", response_model=PreviewResponse)
def preview(req: PreviewRequest) -> PreviewResponse:
    try:
        options = service.ConvertOptions.from_payload(req.options.model_dump())
        doc, report = service.parse_source(req.source, options)
        data = service.preview(
            _Parsed(doc, report), number_by_section=options.number_by_section,
            fig_html=service.make_figure_html(),  # inline TikZ → rasterised
        )
    except service.ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # render bug → readable message, not a raw 500
        raise HTTPException(status_code=500, detail=f"preview failed: {exc}") from exc
    return PreviewResponse(**data)


class _Parsed:
    """A parse-only stand-in for ``ConversionResult`` (no .docx built)."""

    def __init__(self, document, report) -> None:
        self.document, self.report = document, report


@app.post("/api/projects/{project_id}/preview", response_model=PreviewResponse)
def preview_project(project_id: str, req: ProjectPreviewRequest) -> PreviewResponse:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        options = service.ConvertOptions.from_payload(req.options.model_dump())
        main = _effective_main(project, req.main_path)
        asset_url = lambda p: f"/api/projects/{project_id}/files/{quote(p)}/raw"
        assets = service.LazyAssets(lambda: projects.assets(project_id))
        fig_html = service.make_figure_html(assets, asset_url=asset_url)
        files = project.file_map()
        if options.frontend != "pure":  # LaTeXML: whole pipeline, no source map
            result = service.run_project(files, main, options, projects.assets(project_id))
            data = service.preview(result, number_by_section=options.number_by_section,
                                   asset_url=asset_url, fig_html=fig_html)
            data["main_path"] = main
            return PreviewResponse(**data)
        csl = options.csl if (options.csl in files and options.csl.lower().endswith(".csl")) else None
        data = preview_engine.render(
            (project_id, main, csl), files, main,
            number_by_section=options.number_by_section, csl=csl,
            mode=req.mode, base_rev=req.base_rev, asset_url=asset_url, fig_html=fig_html,
        )
        data["report"] = service.report_to_dict(data["report"])
    except (service.ConversionError, PreviewError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # render bug → readable message, not a raw 500
        raise HTTPException(status_code=500, detail=f"preview failed: {exc}") from exc
    return PreviewResponse(**data)


@app.post("/api/to-latex", response_model=ToLatexResponse)
async def to_latex(file: UploadFile = File(...)) -> ToLatexResponse:
    data = await file.read()
    try:
        latex = service.recover_latex(data)
    except service.ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ToLatexResponse(latex=latex)


@app.post("/api/markdown/to-tex", response_model=ToLatexResponse)
def markdown_to_tex(req: MarkdownToTex) -> ToLatexResponse:
    """Convert a Markdown document to a LaTeX document (mistune AST → LaTeX)."""
    if not req.markdown.strip():
        raise HTTPException(status_code=422, detail="markdown is empty")
    try:
        latex = ingest.markdown_to_latex(req.markdown, title=req.title)
    except ingest.IngestError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ToLatexResponse(latex=latex)


# -- projects ----------------------------------------------------------------
def _owner_id(request: Request) -> str | None:
    """The creating user's id (when auth is on), to stamp on new projects."""
    if not authn.enabled:
        return None
    claims = getattr(request.state, "user", None)
    return claims.get("sub") if claims else None


def _list_owner(request: Request) -> str | None:
    """Owner filter for listing: a non-admin user sees only their own (+ unowned);
    admins and the auth-off case see everything (None = no filter)."""
    if not authn.enabled:
        return None
    claims = getattr(request.state, "user", None)
    if not claims or claims.get("role") == "admin":
        return None
    return claims.get("sub")


@app.post("/api/projects", status_code=201)
def create_project(req: ProjectCreate, request: Request) -> dict:
    try:
        project = projects.create(
            req.name, kind=req.kind, main_path=req.main_path, files=req.files,
            owner_id=_owner_id(request),
        )
    except ProjectError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return project.detail()


@app.get("/api/projects")
def list_projects(request: Request) -> list[dict]:
    return [p.summary() for p in projects.list(owner_id=_list_owner(request))]


@app.post("/api/projects/import/markdown", status_code=201)
def import_markdown(req: MarkdownImport, request: Request) -> dict:
    try:
        files = ingest.from_markdown(req.name, req.markdown)
    except ingest.IngestError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    project = projects.create(req.name, kind="markdown", main_path="main.tex",
                              files=files, owner_id=_owner_id(request))
    return project.detail()


def _store_assets(project_id: str, assets: dict[str, bytes]) -> None:
    for path, blob in assets.items():
        projects.put_binary(project_id, path, blob)


@app.post("/api/projects/import/arxiv", status_code=201)
def import_arxiv(req: ArxivImport, request: Request) -> dict:
    try:
        arxiv_id, files, assets, main_path = ingest.from_arxiv(
            req.arxiv_id, max_bytes=config.imports.max_archive_bytes,
            max_files=config.imports.max_archive_files,
        )
    except ingest.IngestTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except ingest.IngestError as exc:
        # bad id is the caller's fault (422); a download/unpack failure is upstream (502)
        msg = str(exc)
        code = 422 if "valid arXiv id" in msg else 502
        raise HTTPException(status_code=code, detail=msg) from exc
    project = projects.create(
        f"arXiv:{arxiv_id}", kind="arxiv", main_path=main_path, files=files,
        owner_id=_owner_id(request),
    )
    _store_assets(project.id, assets)
    return projects.get(project.id).detail()


@app.post("/api/projects/import/archive", status_code=201)
async def import_archive(
    request: Request, file: UploadFile = File(...), name: str | None = Form(None)
) -> dict:
    data = await file.read()
    try:
        proj_name, files, assets, main_path = ingest.from_archive(
            name, file.filename, data, max_bytes=config.imports.max_archive_bytes,
            max_files=config.imports.max_archive_files,
        )
    except ingest.IngestTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except ingest.IngestError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    project = projects.create(proj_name, kind="tex", main_path=main_path,
                              files=files, owner_id=_owner_id(request))
    _store_assets(project.id, assets)
    return projects.get(project.id).detail()


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project.detail()


@app.patch("/api/projects/{project_id}")
def update_project(project_id: str, req: ProjectUpdate) -> dict:
    try:
        project = projects.update(
            project_id, name=req.name, main_path=req.main_path,
            favourite=req.favourite, archived=req.archived,
        )
    except ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return project.detail()


@app.put("/api/projects/{project_id}/settings")
def put_settings(project_id: str, req: SettingsUpdate) -> dict:
    try:
        project = projects.set_settings(project_id, req.settings)
    except ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return project.detail()


@app.get("/api/projects/{project_id}/memory")
def get_memory(project_id: str) -> dict:
    if projects.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return {"memory": projects.get_memory(project_id)}


@app.put("/api/projects/{project_id}/memory")
def put_memory(project_id: str, req: MemoryUpdate) -> dict:
    try:
        projects.set_memory(project_id, req.memory)
    except ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"memory": req.memory}


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> Response:
    if not projects.delete(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    preview_engine.forget(lambda key: key[0] == project_id)
    return Response(status_code=204)


@app.put("/api/projects/{project_id}/files/{path:path}")
def put_file(project_id: str, path: str, req: FilePut) -> dict:
    try:
        file = projects.put_file(project_id, path, req.content)
    except ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return file.public()


@app.post("/api/projects/{project_id}/assets/{path:path}", status_code=201)
async def upload_asset(
    project_id: str, path: str, file: UploadFile = File(...)
) -> dict:
    data = await file.read()
    try:
        stored = projects.put_binary(project_id, path, data)
    except ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return stored.public()


@app.get("/api/projects/{project_id}/files/{path:path}/raw")
def file_raw(project_id: str, path: str) -> Response:
    found = projects.file_bytes(project_id, path)
    if found is None:
        raise HTTPException(status_code=404, detail="file not found")
    is_binary, data = found
    media = mimetypes.guess_type(path)[0] or (
        "application/octet-stream" if is_binary else "text/plain; charset=utf-8"
    )
    return Response(content=data, media_type=media)


@app.delete("/api/projects/{project_id}/files/{path:path}", status_code=204)
def delete_file(project_id: str, path: str) -> Response:
    if not projects.delete_file(project_id, path):
        raise HTTPException(status_code=404, detail="file not found")
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/convert", response_model=ConvertResponse)
def convert_project(project_id: str, req: ProjectConvertRequest) -> ConvertResponse:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        options = service.ConvertOptions.from_payload(req.options.model_dump())
        main = _effective_main(project, req.main_path)
        docx, report = service.convert_project(
            project.file_map(), main, options, projects.assets(project_id)
        )
    except service.ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    filename = _safe_filename(req.filename or project.name)
    artifact_id = store.put(docx, filename)
    return ConvertResponse(
        artifact_id=artifact_id,
        filename=filename,
        download_url=f"/api/artifacts/{artifact_id}",
        report=report,
    )


# ── Async conversion jobs ──────────────────────────────────────────────────
def _run_source_convert(job_id: str, source: str, options, filename: str) -> None:
    job_store.set_running(job_id)
    try:
        docx, report = service.convert(source, options)
    except Exception as exc:  # ConversionError or anything the engine raises
        job_store.set_error(job_id, str(exc))
        return
    job_store.set_done(job_id, store.put(docx, filename), report)


def _run_project_convert(job_id: str, files: dict, main: str, options,
                         assets: dict, filename: str) -> None:
    job_store.set_running(job_id)
    try:
        docx, report = service.convert_project(files, main, options, assets)
    except Exception as exc:
        job_store.set_error(job_id, str(exc))
        return
    job_store.set_done(job_id, store.put(docx, filename), report)


@app.post("/api/convert/async", status_code=202)
def convert_async(req: ConvertRequest) -> dict:
    try:
        options = service.ConvertOptions.from_payload(req.options.model_dump())
    except service.ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    filename = _safe_filename(req.filename)
    job = job_store.create("convert", filename=filename)
    job_queue.submit(lambda: _run_source_convert(job.id, req.source, options, filename))
    return {"job_id": job.id, "status": "queued", "status_url": f"/api/jobs/{job.id}"}


@app.post("/api/projects/{project_id}/convert/async", status_code=202)
def convert_project_async(project_id: str, req: ProjectConvertRequest) -> dict:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        options = service.ConvertOptions.from_payload(req.options.model_dump())
        main = _effective_main(project, req.main_path)
    except service.ConversionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    filename = _safe_filename(req.filename or project.name)
    files, assets = project.file_map(), projects.assets(project_id)
    job = job_store.create("convert_project", project_id=project_id, filename=filename)
    job_queue.submit(
        lambda: _run_project_convert(job.id, files, main, options, assets, filename)
    )
    return {"job_id": job.id, "status": "queued", "status_url": f"/api/jobs/{job.id}"}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.public()


def _all_project_items(owner_id: str | None = None) -> list:
    items = []
    for summary in projects.list(owner_id=owner_id):
        p = projects.get(summary.id)
        if p is not None:
            items.append((p.name, p.file_map(), p.main_path, projects.assets(p.id)))
    return items


@app.get("/api/coverage")
def coverage(request: Request) -> dict:
    """Aggregate tex2word conversion metrics across the caller's projects."""
    return service.coverage_report(_all_project_items(_list_owner(request)))


@app.get("/api/coverage.html")
def coverage_html(request: Request) -> Response:
    """tex2word's native coverage dashboard (HTML) across the caller's projects."""
    return Response(
        content=service.engine_coverage_html(_all_project_items(_list_owner(request))),
        media_type="text/html",
    )


@app.get("/api/skills")
def list_skills() -> list[dict]:
    """Built-in + custom skills (drives the assistant's slash-command autocomplete)."""
    return [s.public() for s in skills.all_skills(skill_store)]


def _resolve_assistant(req: AssistantRequest):
    """Validate the skill/action + provider for an assistant request (raises 422).

    Returns ``(provider, skill_or_None, is_code)``. A built-in action keeps the
    in-code prompt (skill is ``None``); a custom skill name resolves to its record.
    """
    skill = None
    if req.action in assistant.ACTIONS:
        code = assistant.is_code(req.action)
    else:
        skill = skill_store.get_custom(req.action)
        if skill is None:
            raise HTTPException(
                status_code=422, detail=f"unknown skill or action: {req.action!r}"
            )
        code = skill.is_code
    try:
        provider = config.provider(req.provider)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not provider.has_key:
        raise HTTPException(
            status_code=422,
            detail=(
                f"provider {provider.name!r} has no API key — set "
                f"{provider.api_key_env or 'api_key'} in config.toml"
            ),
        )
    return provider, skill, code


@app.post("/api/assistant", response_model=AssistantResponse)
def run_assistant(req: AssistantRequest) -> AssistantResponse:
    provider, skill, _ = _resolve_assistant(req)
    context = [c.model_dump() for c in req.context]
    try:
        result = assistant.run(
            provider, req.action, req.source,
            instruction=req.instruction, report=req.report, context=context, skill=skill,
            max_tokens=config.llm.max_tokens,
        )
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return AssistantResponse(
        reply=result.reply,
        provider=provider.name,
        model=provider.model,
        action=req.action,
        is_code=result.is_code,
    )


@app.post("/api/assistant/stream")
def stream_assistant(req: AssistantRequest) -> StreamingResponse:
    """Server-sent events: each `data:` line carries a JSON delta or the final
    metadata event. Validation errors are raised before streaming begins."""
    provider, skill, code = _resolve_assistant(req)
    context = [c.model_dump() for c in req.context]

    def events():
        def sse(obj: dict) -> str:
            return f"data: {json.dumps(obj)}\n\n"

        try:
            for chunk in assistant.stream_run(
                provider, req.action, req.source,
                instruction=req.instruction, report=req.report,
                context=context, skill=skill,
                max_tokens=config.llm.max_tokens,
            ):
                yield sse({"delta": chunk})
        except llm.LLMError as exc:
            yield sse({"error": str(exc)})
            return
        yield sse({
            "done": True,
            "is_code": code,
            "provider": provider.name,
            "model": provider.model,
            "action": req.action,
        })

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Chat sessions (multi-turn, persisted) ──────────────────────────────────
@app.post("/api/projects/{project_id}/conversations", status_code=201)
def create_conversation(project_id: str, req: ConversationCreate) -> dict:
    if projects.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return chats.create(project_id, title=req.title).detail()


@app.get("/api/projects/{project_id}/conversations")
def list_conversations(project_id: str) -> list[dict]:
    return [c.brief() for c in chats.list(project_id)]


@app.get("/api/conversations/{cid}")
def get_conversation(cid: str) -> dict:
    conv = chats.get(cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return conv.detail()


@app.patch("/api/conversations/{cid}")
def rename_conversation(cid: str, req: ConversationRename) -> dict:
    if not chats.rename(cid, req.title):
        raise HTTPException(status_code=404, detail="conversation not found")
    return chats.get(cid).detail()  # type: ignore[union-attr]


@app.delete("/api/conversations/{cid}", status_code=204)
def delete_conversation(cid: str) -> Response:
    if not chats.delete(cid):
        raise HTTPException(status_code=404, detail="conversation not found")
    return Response(status_code=204)


def _chat_assistant_request(req: ChatRequest) -> AssistantRequest:
    return AssistantRequest(
        action=req.skill or "ask", source=req.source or "",
        instruction=req.content, provider=req.provider, context=req.context,
    )


def _chat_memory(cid: str, project_id: str | None, provider) -> tuple[list, str, str]:
    """Return (recent_history, project_memory, rolling_summary) for a chat turn."""
    cfg = config.assistant
    memory = projects.get_memory(project_id) if (cfg.project_memory and project_id) else ""
    summarize = None
    if cfg.rolling_summary:
        try:
            sp = config.provider(cfg.summary_provider) if cfg.summary_provider else provider
        except KeyError:
            sp = provider
        summarize = lambda prior, msgs: assistant.summarize(sp, prior, msgs)
    summary, history = chats.history_for_model(
        cid, budget=cfg.history_budget_turns, summarize=summarize
    )
    return history, memory, summary


@app.post("/api/conversations/{cid}/message")
def post_chat_message(cid: str, req: ChatRequest) -> dict:
    conv = chats.get(cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    provider, skill, _ = _resolve_assistant(_chat_assistant_request(req))
    history, memory, summary = _chat_memory(cid, conv.project_id, provider)
    chats.add_message(cid, "user", req.content, skill=req.skill)
    context = [c.model_dump() for c in req.context]
    try:
        result = assistant.run(
            provider, req.skill or "ask", req.source or "",
            instruction=req.content, context=context, skill=skill,
            history=history, memory=memory, summary=summary,
            max_tokens=config.llm.max_tokens,
        )
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    msg = chats.add_message(cid, "assistant", result.reply)
    return {"reply": result.reply, "is_code": result.is_code, "message_id": msg.id,
            "provider": provider.name, "model": provider.model}


@app.post("/api/conversations/{cid}/message/stream")
def stream_chat_message(cid: str, req: ChatRequest) -> StreamingResponse:
    conv = chats.get(cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    provider, skill, code = _resolve_assistant(_chat_assistant_request(req))
    history, memory, summary = _chat_memory(cid, conv.project_id, provider)
    chats.add_message(cid, "user", req.content, skill=req.skill)
    context = [c.model_dump() for c in req.context]

    def events():
        def sse(obj: dict) -> str:
            return f"data: {json.dumps(obj)}\n\n"

        acc: list[str] = []
        try:
            for chunk in assistant.stream_run(
                provider, req.skill or "ask", req.source or "",
                instruction=req.content, context=context, skill=skill,
                history=history, memory=memory, summary=summary,
                max_tokens=config.llm.max_tokens,
            ):
                acc.append(chunk)
                yield sse({"delta": chunk})
        except llm.LLMError as exc:
            yield sse({"error": str(exc)})
            return
        msg = chats.add_message(cid, "assistant", "".join(acc))
        yield sse({"done": True, "is_code": code, "message_id": msg.id,
                   "provider": provider.name, "model": provider.model})

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Static assets (css/js). Mounted last so it doesn't shadow the API routes.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
