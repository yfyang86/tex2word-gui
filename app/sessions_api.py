"""HTTP API for assistant sessions (chat or agent conversations).

- CRUD: create (with settings), list (search), read, update (title, pin,
  settings), delete, duplicate, export as Markdown.
- Branches: pick the version of a message to show (``select``), split a branch
  into a new session (``fork``), delete a message and everything below it.
- ``switch-check``: what changing the session's model costs (prompt / KV
  cache, the rolling summary, context size, tool support) so the UI can warn
  before it happens.

Ownership is enforced by ``main.auth_guard`` for every ``/api/conversations``
and ``/api/projects/{id}`` path; this module shares the stores bound in
:mod:`app.assistant_api`.
"""

from __future__ import annotations

import re
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from .assistant_api import deps
from .chat import ChatError
from .providers import ProviderError

router = APIRouter()

# Above this, a smaller model's context window may not hold the chat.
LARGE_CHAT_TOKENS = 24_000


class SessionSettings(BaseModel):
    provider: str | None = Field(default=None, max_length=200)
    model: str | None = Field(default=None, max_length=200)
    mode: str | None = None


class SessionCreate(BaseModel):
    title: str = Field(default="New chat", max_length=200)
    settings: SessionSettings | None = None


class SessionUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    pinned: bool | None = None
    settings: SessionSettings | None = None


class Fork(BaseModel):
    message_id: str | None = None        # default: the whole branch on screen (a duplicate)
    title: str | None = Field(default=None, max_length=200)
    settings: SessionSettings | None = None


class Select(BaseModel):
    message_id: str


def _settings(s: SessionSettings | None) -> dict | None:
    if s is None:
        return None
    data = s.model_dump()
    if data.get("mode") not in (None, "", "agent", "chat"):
        raise HTTPException(status_code=422, detail="mode must be 'agent' or 'chat'")
    return data


def _conv_or_404(cid: str):
    conv = deps.chats.get(cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return conv


@router.post("/api/projects/{project_id}/conversations", status_code=201)
def create_session(project_id: str, req: SessionCreate) -> dict:
    if deps.projects.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    conv = deps.chats.create(project_id, title=req.title, settings=_settings(req.settings) or {})
    return deps.chats.get(conv.id).detail()


@router.get("/api/projects/{project_id}/conversations")
def list_sessions(project_id: str, q: str | None = Query(default=None, max_length=200)) -> list[dict]:
    return [c.brief() for c in deps.chats.list(project_id, q=q)]


@router.get("/api/conversations/{cid}")
def get_session(cid: str) -> dict:
    return _conv_or_404(cid).detail()


@router.patch("/api/conversations/{cid}")
def update_session(cid: str, req: SessionUpdate) -> dict:
    settings = _settings(req.settings)
    if settings is not None:
        settings = {k: v for k, v in settings.items() if k in req.settings.model_fields_set}
    if not deps.chats.update(cid, title=req.title, pinned=req.pinned, settings=settings,
                             touch=req.title is not None):
        raise HTTPException(status_code=404, detail="conversation not found")
    return deps.chats.get(cid).detail()


@router.delete("/api/conversations/{cid}", status_code=204)
def delete_session(cid: str) -> Response:
    if not deps.chats.delete(cid):
        raise HTTPException(status_code=404, detail="conversation not found")
    return Response(status_code=204)


@router.post("/api/conversations/{cid}/fork", status_code=201)
def fork_session(cid: str, req: Fork) -> dict:
    _conv_or_404(cid)
    try:
        conv = deps.chats.fork(cid, req.message_id, title=req.title, settings=_settings(req.settings))
    except ChatError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return conv.detail()


@router.post("/api/conversations/{cid}/select")
def select_branch(cid: str, req: Select) -> dict:
    _conv_or_404(cid)
    try:
        return deps.chats.select(cid, req.message_id).detail()
    except ChatError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/api/conversations/{cid}/messages/{mid}")
def delete_message(cid: str, mid: str) -> dict:
    _conv_or_404(cid)
    removed = deps.chats.delete_message(cid, mid)
    if not removed:
        raise HTTPException(status_code=404, detail="message not found")
    return {"removed": removed, "conversation": deps.chats.get(cid).detail()}


class Truncate(BaseModel):
    message_id: str


@router.post("/api/conversations/{cid}/truncate")
def truncate_session(cid: str, req: Truncate) -> dict:
    """Older name for deleting a message and what follows it."""
    _conv_or_404(cid)
    return {"removed": deps.chats.delete_message(cid, req.message_id)}


@router.get("/api/conversations/{cid}/export")
def export_session(cid: str) -> Response:
    conv = _conv_or_404(cid)
    # an ASCII name for old clients, the real one (RFC 5987) for the rest
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "-", conv.title).strip("-")[:60] or "chat"
    utf8_name = quote((re.sub(r"[\\/:*?\"<>|\s]+", "-", conv.title).strip("-")[:60] or "chat") + ".md")
    return Response(deps.chats.export_markdown(cid), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition":
                             f"attachment; filename=\"{ascii_name}.md\"; filename*=UTF-8''{utf8_name}"})


# ── model switch ───────────────────────────────────────────────────────────
def _last_used(conv) -> tuple[str | None, str | None]:
    s = conv.settings or {}
    if s.get("model"):
        return s.get("provider"), s.get("model")
    for m in reversed(conv.messages):
        if m.role == "assistant" and m.meta.get("model"):
            return m.meta.get("provider"), m.meta.get("model")
    return None, None


def _fmt_tokens(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def switch_report(conv, provider: str | None, model: str | None, mode: str | None = None) -> dict:
    """What moving ``conv`` to ``provider``/``model`` would cost, as warnings."""
    try:
        to_p, to_m = deps.registry.resolve(provider, model)
    except ProviderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    from_p, from_m = _last_used(conv)
    known = next((p for p in deps.registry.list() if p.name == from_p), None)   # enabled ones
    available = bool(known and known.has_key and from_m in known.model_list())
    path = conv.messages
    mode = mode or (conv.settings or {}).get("mode") or "agent"
    chars = sum(len(m.content) for m in path) + len(conv.summary or "")
    last_in = next((m.meta["usage"].get("input", 0) for m in reversed(path)
                    if m.role == "assistant" and isinstance(m.meta.get("usage"), dict)), 0)
    tokens = max(chars // 4, int(last_in or 0))
    out = {
        "same": (from_p, from_m) == (to_p.name, to_m) or not from_m,
        "from": {"provider": from_p, "model": from_m, "available": available},
        "to": {"provider": to_p.name, "model": to_m, "tools": to_p.tools},
        "messages": len(path), "tokens": tokens, "warnings": [],
    }
    if out["same"] or not path:
        out["same"] = True
        return out
    w = out["warnings"]
    if not available:
        w.append({"kind": "missing", "level": "warn",
                  "text": f"This session ran on {from_m} ({from_p}), which is no longer set up, so it can't stay on it."})
    w.append({"kind": "cache", "level": "warn",
              "text": f"{to_m} can't reuse the prompt cache (KV cache) built while chatting with {from_m}. "
                      f"Its next reply re-reads the whole chat — about {_fmt_tokens(tokens)} tokens — so that "
                      "turn is slower and costs more than a cached one."})
    budget = deps.config.assistant.history_budget_turns
    if budget > 0 and len(path) > budget:
        w.append({"kind": "memory", "level": "warn",
                  "text": f"Only the last {budget} of {len(path)} messages are sent word for word; earlier ones "
                          f"reach {to_m} as a summary written for {from_m}. Details from early in the chat may be lost."})
    if tokens >= LARGE_CHAT_TOKENS:
        w.append({"kind": "context", "level": "warn",
                  "text": f"The chat is about {_fmt_tokens(tokens)} tokens. If {to_m}'s context window is smaller, "
                          "the request fails or must drop older turns — a new session starts lighter."})
    if mode == "agent" and not to_p.tools:
        w.append({"kind": "tools", "level": "warn",
                  "text": f"Tool use is off for {to_p.name}, so Agent turns run as plain chat (no file reads or edits)."})
    if from_p and from_p != to_p.name:
        w.append({"kind": "provider", "level": "info",
                  "text": "Different provider: thinking traces and provider-side caches don't carry over, and token "
                          "counts come from a different tokenizer, so usage isn't comparable."})
    return out


class SwitchCheck(BaseModel):
    provider: str | None = None
    model: str | None = None
    mode: str | None = None


@router.post("/api/conversations/{cid}/switch-check")
def switch_check(cid: str, req: SwitchCheck) -> dict:
    return switch_report(_conv_or_404(cid), req.provider, req.model, req.mode)
