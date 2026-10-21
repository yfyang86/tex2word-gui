"""HTTP API for the assistant: providers, skills, prompts, settings, and the
agent chat turn (server-sent events).

Mounted by :mod:`app.main`, which hands over the shared stores via
:func:`bind`. Global assistant configuration (providers and their keys,
skills, prompts, settings) is writable by anyone when auth is off — a single
user's local app — and by admins only when ``[auth]`` is enabled.
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import agent, chat, llm, service, skills
from .prompts import PromptError, PromptStore
from .providers import PRESETS, ProviderError, ProviderRegistry, Settings

router = APIRouter()


class _Deps:
    registry: ProviderRegistry
    projects: Any
    chats: Any
    skills: Any
    prompts: PromptStore
    settings: Settings
    authn: Any
    config: Any


deps = _Deps()


def bind(**kw: Any) -> None:
    for k, v in kw.items():
        setattr(deps, k, v)


DEFAULT_PREFS = {"instructions": "", "max_steps": agent.MAX_STEPS, "default_mode": "agent"}


def prefs() -> dict[str, Any]:
    raw = deps.settings.get("assistant.prefs") or {}
    out = dict(DEFAULT_PREFS)
    out.update({k: raw[k] for k in DEFAULT_PREFS if k in raw})
    return out


def _can_manage(request: Request) -> bool:
    if not deps.authn.enabled:
        return True
    claims = getattr(request.state, "user", None)
    return bool(claims and claims.get("role") == "admin")


def _require_manager(request: Request) -> None:
    if not _can_manage(request):
        raise HTTPException(status_code=403, detail="only an admin can change the assistant's configuration")


def _422(exc: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


# ── providers ──────────────────────────────────────────────────────────────
class ProviderFields(BaseModel):
    name: str | None = None
    type: str | None = None
    api_base: str | None = None
    models: list[str] | None = None
    default_model: str | None = None
    tools: bool | None = None
    enabled: bool | None = None
    api_key: str | None = None        # write-only: "" clears a stored key
    api_key_env: str | None = None


def _providers_payload(request: Request) -> dict[str, Any]:
    manager = _can_manage(request)
    return {
        "providers": [p.public(manager=manager) for p in deps.registry.list(include_disabled=manager)],
        "default": deps.registry.defaults(),
        "presets": PRESETS if manager else [],
        "can_manage": manager,
    }


@router.get("/api/providers")
def list_providers(request: Request) -> dict:
    return _providers_payload(request)


@router.post("/api/providers", status_code=201)
def create_provider(req: ProviderFields, request: Request) -> dict:
    _require_manager(request)
    try:
        p = deps.registry.save(req.name or "", req.model_dump(exclude={"name"}, exclude_none=True), create=True)
    except ProviderError as exc:
        raise _422(exc) from exc
    return p.public(manager=True)


@router.patch("/api/providers/{name}")
def update_provider(name: str, req: ProviderFields, request: Request) -> dict:
    _require_manager(request)
    try:
        p = deps.registry.save(name, req.model_dump(exclude={"name"}, exclude_none=True))
    except ProviderError as exc:
        raise _422(exc) from exc
    return p.public(manager=True)


@router.delete("/api/providers/{name}")
def delete_provider(name: str, request: Request) -> dict:
    _require_manager(request)
    try:
        result = deps.registry.delete(name)
    except ProviderError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"result": result}


class ProviderTest(BaseModel):
    model: str | None = None


@router.post("/api/providers/{name}/test")
def test_provider(name: str, req: ProviderTest, request: Request) -> dict:
    _require_manager(request)
    try:
        p = deps.registry.get(name)
    except ProviderError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    model = (req.model or p.model or "").strip()
    t0 = time.monotonic()
    try:
        out = []
        for ev in llm.chat(p, model, "", [{"role": "user", "content": "Reply with the single word OK."}],
                           max_tokens=64):
            if ev["type"] == "text":
                out.append(ev["text"])
    except llm.LLMError as exc:
        return {"ok": False, "error": str(exc), "model": model, "ms": round((time.monotonic() - t0) * 1000)}
    return {"ok": True, "reply": "".join(out).strip()[:200], "model": model,
            "ms": round((time.monotonic() - t0) * 1000)}


@router.get("/api/providers/{name}/remote-models")
def remote_models(name: str, request: Request) -> dict:
    _require_manager(request)
    try:
        p = deps.registry.get(name)
    except ProviderError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        return {"models": llm.list_models(p)}
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class Defaults(BaseModel):
    provider: str | None = None
    model: str | None = None


@router.put("/api/assistant/defaults")
def set_defaults(req: Defaults, request: Request) -> dict:
    _require_manager(request)
    try:
        return deps.registry.set_defaults(req.provider, req.model)
    except ProviderError as exc:
        raise _422(exc) from exc


# ── settings ───────────────────────────────────────────────────────────────
class Prefs(BaseModel):
    instructions: str | None = Field(default=None, max_length=20_000)
    max_steps: int | None = Field(default=None, ge=1, le=40)
    default_mode: str | None = None


@router.get("/api/assistant/settings")
def get_settings(request: Request) -> dict:
    return {**prefs(), "system_prompt": agent.SYSTEM, "chat_system_prompt": agent.CHAT_SYSTEM,
            "can_manage": _can_manage(request)}


@router.put("/api/assistant/settings")
def put_settings(req: Prefs, request: Request) -> dict:
    _require_manager(request)
    cur = prefs()
    data = req.model_dump(exclude_none=True)
    if "default_mode" in data and data["default_mode"] not in ("agent", "chat"):
        raise HTTPException(status_code=422, detail="default_mode must be 'agent' or 'chat'")
    cur.update(data)
    deps.settings.set("assistant.prefs", cur)
    return get_settings(request)


# ── skills ─────────────────────────────────────────────────────────────────
class SkillFields(BaseModel):
    name: str | None = None
    title: str | None = None
    description: str | None = None
    prompt: str | None = None
    mode: str | None = None


@router.get("/api/skills")
def list_skills() -> list[dict]:
    """Built-in + custom skills (slash commands in the chat)."""
    return [s.public() for s in skills.all_skills(deps.skills)]


@router.post("/api/skills", status_code=201)
def create_skill(req: SkillFields, request: Request) -> dict:
    _require_manager(request)
    try:
        s = deps.skills.create(req.name or "", req.title or req.name or "", req.prompt or "",
                               description=req.description or "", mode=req.mode or "agent")
    except skills.SkillError as exc:
        raise _422(exc) from exc
    return s.public()


@router.patch("/api/skills/{name}")
def update_skill(name: str, req: SkillFields, request: Request) -> dict:
    _require_manager(request)
    if name in skills.BUILTINS:
        raise HTTPException(status_code=422, detail="built-in skills can't be edited; duplicate it instead")
    try:
        s = deps.skills.update(name, title=req.title, prompt=req.prompt, description=req.description,
                               mode=req.mode)
    except skills.SkillError as exc:
        raise _422(exc) from exc
    return s.public()


@router.delete("/api/skills/{name}", status_code=204)
def delete_skill(name: str, request: Request):
    _require_manager(request)
    if name in skills.BUILTINS:
        raise HTTPException(status_code=422, detail="built-in skills can't be deleted")
    if not deps.skills.delete(name):
        raise HTTPException(status_code=404, detail="skill not found")
    from fastapi import Response
    return Response(status_code=204)


# ── prompts ────────────────────────────────────────────────────────────────
class PromptFields(BaseModel):
    title: str | None = None
    body: str | None = None
    description: str | None = None


@router.get("/api/prompts")
def list_prompts() -> list[dict]:
    return deps.prompts.list()


@router.post("/api/prompts", status_code=201)
def create_prompt(req: PromptFields, request: Request) -> dict:
    _require_manager(request)
    try:
        return deps.prompts.create(req.title or "", req.body or "", req.description or "")
    except PromptError as exc:
        raise _422(exc) from exc


@router.patch("/api/prompts/{pid}")
def update_prompt(pid: str, req: PromptFields, request: Request) -> dict:
    _require_manager(request)
    try:
        return deps.prompts.update(pid, title=req.title, body=req.body, description=req.description)
    except PromptError as exc:
        status = 404 if "not found" in str(exc) else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.delete("/api/prompts/{pid}", status_code=204)
def delete_prompt(pid: str, request: Request):
    _require_manager(request)
    if not deps.prompts.delete(pid):
        raise HTTPException(status_code=404, detail="prompt not found")
    from fastapi import Response
    return Response(status_code=204)


# ── the agent chat turn ────────────────────────────────────────────────────
class AgentTurn(BaseModel):
    content: str = Field(default="", max_length=100_000)
    skill: str | None = None
    provider: str | None = None
    model: str | None = None
    mode: str | None = None              # "agent" | "chat" (default: skill's, else settings)
    active_file: str | None = None
    selection: str | None = Field(default=None, max_length=100_000)
    selection_lines: list[int] | None = None   # [first, last], 1-based
    cursor_line: int | None = None
    files: list[str] = Field(default_factory=list)   # @-mentioned paths
    # Branching: where the new user message goes. None = the end of the branch
    # on screen; "root" = a new first message; else the id of the message to
    # answer under (edit & resend passes the edited message's parent).
    parent_id: str | None = None
    # Regenerate: reply again to this existing user message (no new message).
    regenerate: str | None = None


CHAT_FILE_CHARS = 60_000


def _context_block(turn: AgentTurn, project, mode: str) -> str:
    """What the user is looking at, prepended to the model's copy of the message."""
    fm = project.file_map()
    lines: list[str] = []
    if turn.active_file:
        where = f" (cursor on line {turn.cursor_line})" if turn.cursor_line else ""
        lines.append(f"Open file: {turn.active_file}{where}")
    if turn.selection:
        span = ""
        if turn.selection_lines and len(turn.selection_lines) == 2:
            span = f" (lines {turn.selection_lines[0]}–{turn.selection_lines[1]})"
        lines.append(f"Selected text{span}:\n```latex\n{turn.selection}\n```")
    mentioned = [p for p in dict.fromkeys(turn.files) if p in fm]
    if mode == "chat":
        include = ([turn.active_file] if turn.active_file in fm and not turn.selection else []) + mentioned
        for path in dict.fromkeys(include):
            body = fm[path]
            cut = "\n… (truncated)" if len(body) > CHAT_FILE_CHARS else ""
            lines.append(f"File `{path}`:\n```latex\n{body[:CHAT_FILE_CHARS]}{cut}\n```")
    elif mentioned:
        lines.append("Files the user mentioned: " + ", ".join(mentioned) + " (use read_file)")
    return ("<context>\n" + "\n".join(lines) + "\n</context>\n\n") if lines else ""


def _system(mode: str, project, memory: str, summary: str) -> str:
    parts = [agent.SYSTEM if mode == "agent" else agent.CHAT_SYSTEM]
    if project is not None:
        parts.append(f"Project: “{project.name}”. Main file: {project.main_path}.")
    extra = (prefs().get("instructions") or "").strip()
    if extra:
        parts.append("Instructions from the user (follow them):\n" + extra)
    if memory and memory.strip():
        parts.append("Project memory (durable facts about this document — honour these):\n" + memory.strip())
    if summary and summary.strip():
        parts.append("Summary of the earlier conversation:\n" + summary.strip())
    return "\n\n".join(parts)


def _check_project(project, projects):
    def check(ws: agent.Workspace) -> dict:
        try:
            options = service.ConvertOptions.from_payload(project.settings or {})
            main = ws.main if ws.main in ws.view() else project.main_path
            _, report = service.convert_project(ws.view(), main, options, projects.assets(project.id))
            return report
        except Exception as exc:  # ConversionError or engine failure
            return {"error": str(exc)}
    return check


def _history(cid: str, project_id: str | None, provider, model: str,
             upto: str | None = chat.HEAD) -> tuple[list, str, str]:
    cfg = deps.config.assistant
    memory = deps.projects.get_memory(project_id) if (cfg.project_memory and project_id) else ""
    summarize = None
    if cfg.rolling_summary:
        sp, sm = provider, model
        if cfg.summary_provider:
            try:
                sp, sm = deps.registry.resolve(cfg.summary_provider)
            except ProviderError:
                pass

        def summarize(prior, msgs):
            from .assistant import SUMMARY_SYSTEM
            convo = "\n".join(f"{m['role']}: {m['content']}" for m in msgs)
            user = (f"Summary so far:\n{prior}\n\n" if prior else "") + f"New messages to fold in:\n{convo}"
            return llm.complete(sp, SUMMARY_SYSTEM, user, max_tokens=512, model=sm)
    try:
        summary, history = deps.chats.history_for_model(cid, budget=cfg.history_budget_turns,
                                                        summarize=summarize, upto=upto)
    except llm.LLMError:
        summary, history = deps.chats.history_for_model(cid, budget=cfg.history_budget_turns,
                                                        summarize=None, upto=upto)
    return history, memory, summary


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


@router.post("/api/conversations/{cid}/agent")
def agent_turn(cid: str, turn: AgentTurn) -> StreamingResponse:
    conv = deps.chats.get(cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    project = deps.projects.get(conv.project_id) if conv.project_id else None
    if project is None:
        raise HTTPException(status_code=404, detail="the conversation's project no longer exists")
    try:
        provider, model = deps.registry.resolve(turn.provider, turn.model)
    except ProviderError as exc:
        raise _422(exc) from exc
    if not provider.has_key:
        raise HTTPException(status_code=422, detail=(
            f"provider {provider.name!r} has no API key — add one in Assistant settings"
            + (f" or set {provider.api_key_env}" if provider.api_key_env else "")))
    regen = None
    if turn.regenerate:
        regen = deps.chats.get_message(cid, turn.regenerate)
        if regen is None or regen.role != "user":
            raise HTTPException(status_code=404, detail="no such user message to regenerate")
    skill_name = regen.skill if regen else turn.skill
    skill = None
    if skill_name:
        skill = skills.resolve(deps.skills, skill_name)
        if skill is None:
            raise HTTPException(status_code=422, detail=f"unknown skill: /{skill_name}")
    mode = turn.mode or (skill.mode if skill else None) or prefs()["default_mode"]
    if mode not in ("agent", "chat"):
        raise HTTPException(status_code=422, detail="mode must be 'agent' or 'chat'")
    if regen:
        text = regen.content
        if regen.skill and text.startswith("/" + regen.skill):
            text = text[len(regen.skill) + 1:]
        text = text.strip()
    else:
        text = turn.content.strip()
    if not text and skill is None:
        raise HTTPException(status_code=422, detail="the message is empty")

    # where this turn sits in the conversation tree
    if regen:
        parent: str | None = regen.parent_id
    elif turn.parent_id == "root":
        parent = None
    elif turn.parent_id:
        if deps.chats.get_message(cid, turn.parent_id) is None:
            raise HTTPException(status_code=404, detail="message to branch from not found")
        parent = turn.parent_id
    else:
        parent = conv.head_id

    request_text = skills.render_skill(skill, file=turn.active_file, selection=turn.selection,
                                       user_input=text) if skill else text
    model_message = _context_block(turn, project, mode) + request_text
    history, memory, summary = _history(cid, conv.project_id, provider, model, upto=parent)
    if regen:
        user_msg = regen
    else:
        shown = (f"/{skill.name} {text}".strip() if skill else text)
        user_msg = deps.chats.add_message(
            cid, "user", shown, skill=skill.name if skill else None, parent_id=parent,
            meta={"active_file": turn.active_file, "selection_lines": turn.selection_lines})
        if conv.title in ("Chat", "New chat") and conv.message_count == 0:
            deps.chats.rename(cid, (shown.splitlines() or ["Chat"])[0][:60])

    # the session remembers its model (and mode, when chosen explicitly)
    prev_p, prev_m = (conv.settings or {}).get("provider"), (conv.settings or {}).get("model")
    switched = bool(prev_m) and (prev_p, prev_m) != (provider.name, model)
    remembered = {"provider": provider.name, "model": model}
    if turn.mode:
        remembered["mode"] = turn.mode
    deps.chats.update(cid, settings=remembered, touch=False)

    workspace = agent.Workspace(files=project.file_map(), main=project.main_path,
                                binary={f.path for f in project.files if f.is_binary})
    tools = agent.Tools(workspace, check=_check_project(project, deps.projects)) if mode == "agent" else None
    system = _system(mode, project, memory, summary)
    messages = history + [{"role": "user", "content": model_message}]
    max_steps = int(prefs().get("max_steps") or agent.MAX_STEPS)

    def events():
        out: list[str] = []
        meta: dict[str, Any] = {"provider": provider.name, "model": model, "mode": mode,
                                "skill": skill.name if skill else None, "steps": [], "reasoning": ""}
        if switched:
            meta["switched_from"] = {"provider": prev_p, "model": prev_m}
        state: dict[str, Any] = {"error": None, "msg": None}
        t0 = time.monotonic()
        try:
            yield _sse({"type": "start", "user_message": user_msg.public(), "provider": provider.name,
                        "model": model, "mode": mode,
                        "switched_from": meta.get("switched_from")})
            for ev in agent.run(provider, model, system, messages, tools, max_steps=max_steps,
                                max_tokens=deps.config.llm.max_tokens):
                t = ev["type"]
                if t == "text":
                    out.append(ev["text"])
                elif t == "reasoning":
                    meta["reasoning"] += ev["text"]
                elif t == "tool_start":
                    meta["steps"].append({"id": ev["id"], "name": ev["name"], "args": ev["args"]})
                elif t == "tool_end":
                    for s in meta["steps"]:
                        if s["id"] == ev["id"]:
                            s.update(ok=ev["ok"], summary=ev["summary"])
                elif t == "notice":
                    meta.setdefault("notices", []).append(ev["text"])
                elif t == "usage":
                    meta["usage"] = {"input": ev["input"], "output": ev["output"]}
                elif t == "changes":
                    meta["changes"] = ev["changes"]
                yield _sse(ev)
        except llm.LLMError as exc:
            state["error"] = str(exc)
        except GeneratorExit:
            meta["stopped"] = True
            raise
        finally:
            meta["ms"] = round((time.monotonic() - t0) * 1000)
            if state["error"]:
                meta["error"] = state["error"]
            if not meta["reasoning"]:
                meta.pop("reasoning")
            content = "".join(out)
            if meta.get("changes"):
                content += ("\n\n" if content else "") + "_(Proposed edits to: " + \
                    ", ".join(c["path"] for c in meta["changes"]) + ")_"
            state["msg"] = deps.chats.add_message(cid, "assistant", content, meta=meta,
                                                  parent_id=user_msg.id)
        if state["error"]:
            yield _sse({"type": "error", "error": state["error"], "message": state["msg"].public()})
        else:
            yield _sse({"type": "done", "message": state["msg"].public()})

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ChangeAction(BaseModel):
    action: str                         # "apply" | "reject"
    paths: list[str] | None = None      # default: every pending change


@router.post("/api/conversations/{cid}/messages/{mid}/changes")
def act_on_changes(cid: str, mid: str, req: ChangeAction) -> dict:
    conv = deps.chats.get(cid)
    msg = deps.chats.get_message(cid, mid) if conv else None
    if msg is None:
        raise HTTPException(status_code=404, detail="message not found")
    if req.action not in ("apply", "reject"):
        raise HTTPException(status_code=422, detail="action must be 'apply' or 'reject'")
    meta = dict(msg.meta)
    changes = meta.get("changes") or []
    project = deps.projects.get(conv.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    current = project.file_map()
    written: list[dict[str, str]] = []
    for ch in changes:
        if req.paths is not None and ch["path"] not in req.paths:
            continue
        if ch.get("status") not in ("pending", "conflict"):
            continue
        if req.action == "reject":
            ch["status"] = "rejected"
            continue
        now = current.get(ch["path"])
        if now == ch["after"]:
            ch["status"] = "applied"
        elif now == ch.get("before") or (now is None and ch.get("before") is None):
            deps.projects.put_file(project.id, ch["path"], ch["after"])
            ch["status"] = "applied"
            written.append({"path": ch["path"], "content": ch["after"]})
        else:
            ch["status"] = "conflict"   # the file changed since the assistant read it
    meta["changes"] = changes
    deps.chats.set_meta(cid, mid, meta)
    return {"changes": changes, "written": written}
