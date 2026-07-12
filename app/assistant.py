"""tex-copilot — build prompts per action and run them through a provider."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

from . import llm
from .config import Provider

ACTIONS = {"fix", "polish", "explain", "ask"}
_CODE_ACTIONS = {"fix", "polish"}


def is_code(action: str) -> bool:
    """Whether an action returns LaTeX to apply back to the file."""
    return action in _CODE_ACTIONS

SYSTEM = (
    "You are tex-copilot, an expert LaTeX assistant embedded in Tex Word Studio, "
    "a tool that converts LaTeX into Microsoft Word (.docx) with the tex2word "
    "engine. You help authors write clean LaTeX that converts faithfully to Word. "
    "Be precise and concise. When asked to rewrite LaTeX, return ONLY the LaTeX "
    "with no markdown code fences and no commentary."
)


def system_prompt(memory: str | None = None, summary: str | None = None) -> str:
    """The base persona plus optional per-project memory and a chat summary."""
    parts = [SYSTEM]
    if memory and memory.strip():
        parts.append("Project memory (durable facts about this document — honour these):\n"
                     + memory.strip())
    if summary and summary.strip():
        parts.append("Summary of the earlier conversation:\n" + summary.strip())
    return "\n\n".join(parts)


SUMMARY_SYSTEM = (
    "You compress a LaTeX-assistant conversation into a brief running summary. "
    "Keep durable facts, decisions, and the user's preferences; drop pleasantries. "
    "Return only the summary prose."
)


def summarize(provider: Provider, prior_summary: str,
              messages: list[dict[str, str]]) -> str:
    """Fold ``messages`` into ``prior_summary`` via a cheap completion."""
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
    user = ((f"Summary so far:\n{prior_summary}\n\n" if prior_summary else "")
            + f"New messages to fold in:\n{convo}")
    return llm.complete(provider, SUMMARY_SYSTEM, user, max_tokens=512)


@dataclass(slots=True)
class AssistantResult:
    reply: str
    is_code: bool


def _report_note(report: dict[str, Any] | None) -> str:
    """Render the conversion report's diagnostics as context for a fix."""
    if not report:
        return ""
    entries = report.get("entries") or []
    if not entries:
        return "The converter reported no warnings.\n"
    lines = [
        f"- [{e.get('severity')}] {e.get('construct')}: {e.get('message')}"
        for e in entries
    ]
    return "The tex2word conversion reported these issues:\n" + "\n".join(lines) + "\n"


def _context_note(context: list[dict[str, str]] | None) -> str:
    """Render @-mentioned project files as reference context."""
    if not context:
        return ""
    blocks = []
    for f in context:
        path = f.get("path", "")
        content = f.get("content", "")
        if not path:
            continue
        blocks.append(f"File `{path}`:\n```\n{content}\n```")
    if not blocks:
        return ""
    return "Referenced project files (for context):\n" + "\n\n".join(blocks) + "\n\n"


def build_prompt(
    action: str,
    source: str,
    *,
    instruction: str | None = None,
    report: dict[str, Any] | None = None,
    context: list[dict[str, str]] | None = None,
    skill: Any = None,
) -> str:
    """Build the user prompt for an action; the system prompt is constant.

    A custom ``skill`` (with a prompt template) overrides the built-in actions.
    """
    src = f"\n```latex\n{source}\n```\n"
    ctx = _context_note(context)
    if skill is not None:
        from .skills import render_custom
        body = render_custom(skill, source=source, instruction=instruction, context_note=ctx)
        # if the template didn't place the source itself, append it for grounding
        return body if "```" in body else body + src
    if action == "fix":
        return (
            ctx
            + _report_note(report)
            + "Rewrite the LaTeX below to fix those issues so it converts cleanly "
            "to Word, preserving the author's meaning and structure. Return only "
            "the corrected LaTeX." + src
        )
    if action == "polish":
        return (
            ctx
            + "Improve the writing quality (grammar, clarity, academic tone) of the "
            "prose in the LaTeX below. Do not change the math, labels, structure, "
            "or meaning. Return only the revised LaTeX." + src
        )
    if action == "explain":
        return ctx + "Explain what the following LaTeX does, in clear prose." + src
    if action == "ask":
        q = (instruction or "").strip() or "Answer questions about this LaTeX."
        return f"{ctx}{q}\n\nFor reference, the current file is:{src}"
    raise ValueError(f"unknown action: {action!r}")


def run(
    provider: Provider,
    action: str,
    source: str,
    *,
    instruction: str | None = None,
    report: dict[str, Any] | None = None,
    context: list[dict[str, str]] | None = None,
    skill: Any = None,
    history: list[dict[str, str]] | None = None,
    memory: str | None = None,
    summary: str | None = None,
    max_tokens: int = 8192,
) -> AssistantResult:
    if skill is None and action not in ACTIONS:
        raise ValueError(f"action must be one of {sorted(ACTIONS)}")
    user = build_prompt(
        action, source, instruction=instruction, report=report,
        context=context, skill=skill,
    )
    reply = llm.complete(provider, system_prompt(memory, summary), user, history=history, max_tokens=max_tokens)
    code = skill.is_code if skill is not None else is_code(action)
    return AssistantResult(reply=reply, is_code=code)


def stream_run(
    provider: Provider,
    action: str,
    source: str,
    *,
    instruction: str | None = None,
    report: dict[str, Any] | None = None,
    context: list[dict[str, str]] | None = None,
    skill: Any = None,
    history: list[dict[str, str]] | None = None,
    memory: str | None = None,
    summary: str | None = None,
    max_tokens: int = 8192,
) -> Iterator[str]:
    """Stream the assistant's reply as text chunks (same prompt as :func:`run`)."""
    if skill is None and action not in ACTIONS:
        raise ValueError(f"action must be one of {sorted(ACTIONS)}")
    user = build_prompt(
        action, source, instruction=instruction, report=report,
        context=context, skill=skill,
    )
    yield from llm.stream(provider, system_prompt(memory, summary), user, history=history, max_tokens=max_tokens)
