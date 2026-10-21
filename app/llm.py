"""LLM provider client — dispatches by ``provider.type``.

``claude`` providers use the official Anthropic SDK; ``openai`` providers use the
OpenAI SDK pointed at the provider's ``api_base`` (works for any
OpenAI-compatible endpoint: DeepSeek, Kimi, OpenRouter, Ollama, vLLM, …). All
provider/auth failures surface as :class:`LLMError`, never bare SDK tracebacks.

Two levels:

* :func:`complete` / :func:`stream` — one system + user prompt, text out
  (the original assistant actions).
* :func:`chat` — a provider-neutral, tool-calling, streaming turn used by the
  agent (:mod:`app.agent`). Messages use one normalized shape::

      {"role": "user", "content": str}
      {"role": "assistant", "content": str, "tool_calls": [{"id", "name", "arguments": dict}]}
      {"role": "tool", "tool_call_id": str, "name": str, "content": str}

  and it yields events::

      {"type": "text", "text": str}          # reply text, streamed
      {"type": "reasoning", "text": str}     # "thinking" text some models stream
      {"type": "tool_call", "id", "name", "arguments": dict}
      {"type": "usage", "input": int, "output": int}
      {"type": "done", "stop": str}
"""

from __future__ import annotations

import json
from typing import Any, Iterator

from .config import Provider

TIMEOUT_S = 120.0


class LLMError(Exception):
    """A provider call could not be completed."""

    def __init__(self, message: str, *, tools_unsupported: bool = False) -> None:
        super().__init__(message)
        self.tools_unsupported = tools_unsupported


def _require_key(provider: Provider) -> None:
    if not provider.api_key:
        raise LLMError(
            f"provider {provider.name!r} has no API key — add one in Assistant settings "
            f"or set {provider.api_key_env or 'api_key'} in config.toml"
        )


def _openai_client(provider: Provider):
    import openai

    return openai.OpenAI(api_key=provider.api_key, base_url=provider.api_base or None,
                         timeout=TIMEOUT_S, max_retries=1)


def _claude_client(provider: Provider):
    import anthropic

    return anthropic.Anthropic(api_key=provider.api_key, base_url=provider.api_base or None,
                               timeout=TIMEOUT_S, max_retries=1)


# ── one-shot text (original actions) ──────────────────────────────────────
def complete(
    provider: Provider, system: str, user: str, *,
    history: list[dict] | None = None, max_tokens: int = 8192, model: str | None = None,
) -> str:
    """Run a completion (with optional prior ``history``) and return the reply."""
    _require_key(provider)
    msgs = _messages(history, user)
    out = []
    for ev in chat(provider, model or provider.model, system, msgs, max_tokens=max_tokens):
        if ev["type"] == "text":
            out.append(ev["text"])
    return "".join(out).strip()


def stream(
    provider: Provider, system: str, user: str, *,
    history: list[dict] | None = None, max_tokens: int = 8192, model: str | None = None,
) -> Iterator[str]:
    """Yield the reply (with optional prior ``history``) as text chunks."""
    _require_key(provider)
    msgs = _messages(history, user)
    return (ev["text"] for ev in chat(provider, model or provider.model, system, msgs, max_tokens=max_tokens)
            if ev["type"] == "text")


def _messages(history: list[dict] | None, user: str) -> list[dict]:
    """Prior turns (oldest first) plus the new user message."""
    return list(history or []) + [{"role": "user", "content": user}]


# ── tool-calling chat ─────────────────────────────────────────────────────
def chat(
    provider: Provider, model: str, system: str, messages: list[dict], *,
    tools: list[dict] | None = None, max_tokens: int = 8192,
) -> Iterator[dict]:
    """Stream one model turn; see the module docstring for shapes."""
    _require_key(provider)
    if provider.type not in ("openai", "claude"):
        raise LLMError(f"unsupported provider type: {provider.type!r}")
    if not model:
        raise LLMError(f"provider {provider.name!r} has no model selected")
    tools = tools if (tools and provider.tools) else None
    if provider.type == "claude":
        return _claude_chat(provider, model, system, messages, tools, max_tokens)
    return _openai_chat(provider, model, system, messages, tools, max_tokens)


def _tools_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(k in text for k in ("tool", "function call", "function_call", "functions are not supported"))


# OpenAI-compatible ---------------------------------------------------------
def to_openai_messages(system: str, messages: list[dict]) -> list[dict]:
    out: list[dict] = [{"role": "system", "content": system}] if system else []
    for m in messages:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            out.append({
                "role": "assistant",
                "content": m.get("content") or None,
                "tool_calls": [
                    {"id": c["id"], "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {})}}
                    for c in m["tool_calls"]
                ],
            })
        elif role == "tool":
            out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m.get("content") or ""})
        else:
            out.append({"role": role, "content": m.get("content") or ""})
    return out


def to_openai_tools(tools: list[dict]) -> list[dict]:
    return [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""),
                                               "parameters": t.get("parameters") or {"type": "object", "properties": {}}}}
            for t in tools]


def _parse_args(raw: str) -> dict:
    if not raw or not raw.strip():
        return {}
    try:
        val = json.loads(raw)
        return val if isinstance(val, dict) else {"_value": val}
    except ValueError:
        return {"_raw": raw}


def _openai_chat(provider, model, system, messages, tools, max_tokens) -> Iterator[dict]:
    try:
        client = _openai_client(provider)
    except Exception as exc:
        raise LLMError(f"could not create the OpenAI client: {exc}") from exc
    kwargs: dict[str, Any] = {
        "model": model, "max_tokens": max_tokens, "stream": True,
        "messages": to_openai_messages(system, messages),
    }
    if tools:
        kwargs["tools"] = to_openai_tools(tools)
    try:
        try:
            resp = client.chat.completions.create(stream_options={"include_usage": True}, **kwargs)
        except Exception as exc:  # some compatible servers reject stream_options
            if "stream_options" not in str(exc):
                raise
            resp = client.chat.completions.create(**kwargs)
        calls: dict[int, dict] = {}
        stop = "stop"
        for chunk in resp:
            usage = getattr(chunk, "usage", None)
            if usage is not None and getattr(usage, "prompt_tokens", None) is not None:
                yield {"type": "usage", "input": usage.prompt_tokens or 0,
                       "output": getattr(usage, "completion_tokens", 0) or 0}
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            choice = choices[0]
            delta = choice.delta
            reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            if reasoning:
                yield {"type": "reasoning", "text": reasoning}
            if getattr(delta, "content", None):
                yield {"type": "text", "text": delta.content}
            for tc in getattr(delta, "tool_calls", None) or []:
                idx = getattr(tc, "index", 0) or 0
                acc = calls.setdefault(idx, {"id": "", "name": "", "args": ""})
                if getattr(tc, "id", None):
                    acc["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    if getattr(fn, "name", None):
                        acc["name"] += fn.name
                    if getattr(fn, "arguments", None):
                        acc["args"] += fn.arguments
            if getattr(choice, "finish_reason", None):
                stop = choice.finish_reason
        for idx in sorted(calls):
            c = calls[idx]
            yield {"type": "tool_call", "id": c["id"] or f"call_{idx}", "name": c["name"],
                   "arguments": _parse_args(c["args"])}
        yield {"type": "done", "stop": stop}
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(f"{provider.name}: request failed: {exc}",
                       tools_unsupported=bool(tools) and _tools_error(exc)) from exc


# Anthropic -----------------------------------------------------------------
def to_anthropic_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "assistant":
            blocks: list[dict] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for c in m.get("tool_calls") or []:
                blocks.append({"type": "tool_use", "id": c["id"], "name": c["name"], "input": c.get("arguments") or {}})
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
        elif role == "tool":
            block = {"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m.get("content") or ""}
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list) \
                    and all(b.get("type") == "tool_result" for b in out[-1]["content"]):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
        else:
            out.append({"role": "user", "content": m.get("content") or ""})
    return out


def to_anthropic_tools(tools: list[dict]) -> list[dict]:
    return [{"name": t["name"], "description": t.get("description", ""),
             "input_schema": t.get("parameters") or {"type": "object", "properties": {}}} for t in tools]


def _claude_chat(provider, model, system, messages, tools, max_tokens) -> Iterator[dict]:
    try:
        client = _claude_client(provider)
    except Exception as exc:
        raise LLMError(f"could not create the Anthropic client: {exc}") from exc
    kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens,
                              "messages": to_anthropic_messages(messages)}
    if system:
        kwargs["system"] = system
    if tools:
        kwargs["tools"] = to_anthropic_tools(tools)
    try:
        with client.messages.stream(**kwargs) as s:
            for event in s:
                if getattr(event, "type", None) != "content_block_delta":
                    continue
                d = event.delta
                if getattr(d, "type", None) == "text_delta" and d.text:
                    yield {"type": "text", "text": d.text}
                elif getattr(d, "type", None) == "thinking_delta" and getattr(d, "thinking", None):
                    yield {"type": "reasoning", "text": d.thinking}
            final = s.get_final_message()
        for block in final.content:
            if getattr(block, "type", None) == "tool_use":
                yield {"type": "tool_call", "id": block.id, "name": block.name,
                       "arguments": dict(block.input or {})}
        usage = getattr(final, "usage", None)
        if usage is not None:
            yield {"type": "usage", "input": getattr(usage, "input_tokens", 0) or 0,
                   "output": getattr(usage, "output_tokens", 0) or 0}
        yield {"type": "done", "stop": getattr(final, "stop_reason", None) or "end_turn"}
    except LLMError:
        raise
    except Exception as exc:
        raise LLMError(f"{provider.name}: request failed: {exc}",
                       tools_unsupported=bool(tools) and _tools_error(exc)) from exc


# ── provider utilities ────────────────────────────────────────────────────
def list_models(provider: Provider) -> list[str]:
    """The model ids the provider's API offers (for "Fetch models")."""
    _require_key(provider)
    try:
        client = _claude_client(provider) if provider.type == "claude" else _openai_client(provider)
        page = client.models.list()
        ids = [getattr(m, "id", None) for m in getattr(page, "data", None) or list(page)]
    except Exception as exc:
        raise LLMError(f"{provider.name}: could not list models: {exc}") from exc
    return sorted({i for i in ids if i})
