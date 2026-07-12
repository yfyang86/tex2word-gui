"""LLM provider client — dispatches a chat completion by ``provider.type``.

``claude`` providers use the official Anthropic SDK; ``openai`` providers use the
OpenAI SDK pointed at the provider's ``base_url`` (works for any
OpenAI-compatible endpoint: DeepSeek, Kimi, Minimax, vLLM, …). All provider/auth
failures surface as :class:`LLMError`, never bare SDK tracebacks.
"""

from __future__ import annotations

from typing import Iterator

from .config import Provider


class LLMError(Exception):
    """A provider call could not be completed."""


def _require_key(provider: Provider) -> None:
    if not provider.api_key:
        raise LLMError(
            f"provider {provider.name!r} has no API key — set the "
            f"{provider.api_key_env or 'api_key'} value in config.toml"
        )


def complete(
    provider: Provider, system: str, user: str, *,
    history: list[dict] | None = None, max_tokens: int = 8192,
) -> str:
    """Run a completion (with optional prior ``history``) and return the reply."""
    _require_key(provider)
    msgs = _messages(history, user)
    if provider.type == "claude":
        return _claude(provider, system, msgs, max_tokens)
    if provider.type == "openai":
        return _openai(provider, system, msgs, max_tokens)
    raise LLMError(f"unsupported provider type: {provider.type!r}")


def stream(
    provider: Provider, system: str, user: str, *,
    history: list[dict] | None = None, max_tokens: int = 8192,
) -> Iterator[str]:
    """Yield the reply (with optional prior ``history``) as text chunks."""
    _require_key(provider)
    msgs = _messages(history, user)
    if provider.type == "claude":
        return _claude_stream(provider, system, msgs, max_tokens)
    if provider.type == "openai":
        return _openai_stream(provider, system, msgs, max_tokens)
    raise LLMError(f"unsupported provider type: {provider.type!r}")


def _messages(history: list[dict] | None, user: str) -> list[dict]:
    """Prior turns (oldest first) plus the new user message."""
    return list(history or []) + [{"role": "user", "content": user}]


def _claude(provider: Provider, system: str, messages: list[dict], max_tokens: int) -> str:
    import anthropic

    try:
        client = anthropic.Anthropic(
            api_key=provider.api_key, base_url=provider.api_base or None
        )
        msg = client.messages.create(
            model=provider.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
    except Exception as exc:
        raise LLMError(f"Anthropic request failed: {exc}") from exc
    return "".join(b.text for b in msg.content if getattr(b, "type", None) == "text").strip()


def _claude_stream(
    provider: Provider, system: str, messages: list[dict], max_tokens: int
) -> Iterator[str]:
    import anthropic

    try:
        client = anthropic.Anthropic(
            api_key=provider.api_key, base_url=provider.api_base or None
        )
        with client.messages.stream(
            model=provider.model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                if text:
                    yield text
    except Exception as exc:
        raise LLMError(f"Anthropic request failed: {exc}") from exc


def _openai(provider: Provider, system: str, messages: list[dict], max_tokens: int) -> str:
    import openai

    try:
        client = openai.OpenAI(
            api_key=provider.api_key, base_url=provider.api_base or None
        )
        resp = client.chat.completions.create(
            model=provider.model,
            max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, *messages],
        )
    except Exception as exc:
        raise LLMError(f"OpenAI-compatible request failed: {exc}") from exc
    return (resp.choices[0].message.content or "").strip()


def _openai_stream(
    provider: Provider, system: str, messages: list[dict], max_tokens: int
) -> Iterator[str]:
    import openai

    try:
        client = openai.OpenAI(
            api_key=provider.api_key, base_url=provider.api_base or None
        )
        resp = client.chat.completions.create(
            model=provider.model,
            max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, *messages],
            stream=True,
        )
        for chunk in resp:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    except Exception as exc:
        raise LLMError(f"OpenAI-compatible request failed: {exc}") from exc
