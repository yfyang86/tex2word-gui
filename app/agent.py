"""tex-copilot's agent: a small tool-using loop over the open project.

Modelled on minimal coding agents (pi and friends): a short system prompt, a
handful of sharp tools, edits by exact-text replacement. Unlike a coding agent
it has no shell. It works on a :class:`Workspace`, an overlay over the
project's text files, so every edit is *staged*: later reads, searches and
conversion checks see it, but nothing reaches the project until the user
reviews the change set and applies it.

Tools: list_files, read_file, search, outline, check (run the tex2word
conversion and report diagnostics), edit_file, write_file.

:func:`run` yields events for the UI (see ``EVENTS``) and is driven by
:func:`app.llm.chat`, which tests replace with a scripted model.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from . import llm

MAX_STEPS = 12
READ_LINES = 400
READ_CHARS = 40_000
SEARCH_LIMIT = 60
MAX_FILE_CHARS = 2_000_000
TEXT_EXTS = (".tex", ".bib", ".sty", ".cls", ".tikz", ".md", ".txt", ".bbl", ".csv", ".tsv", ".dat")

EVENTS = """
  {"type": "text", "text"}                       reply text (streamed)
  {"type": "reasoning", "text"}                  model "thinking", streamed
  {"type": "tool_start", "id", "name", "args"}   a tool call begins
  {"type": "tool_end", "id", "name", "ok", "summary"}
  {"type": "notice", "text"}                     e.g. tools unsupported, step limit
  {"type": "usage", "input", "output"}           summed over the turn
  {"type": "changes", "changes": [...]}          staged edits for review
"""

SYSTEM = """You are tex-copilot, the assistant in Tex Word Studio, a web app that converts \
LaTeX projects into editable Word documents with the tex2word engine. You help authors write, \
fix and restructure LaTeX that converts cleanly to Word.

How you work:
- You can use tools to look at the project: list_files, read_file, search, outline. Read the \
relevant files before answering questions about them or changing them; don't guess file contents.
- To change files use edit_file (replace an exact snippet — copy old_text exactly from \
read_file, including whitespace, and keep it short but unique) or write_file (new files). Your \
edits are staged: the user reviews a diff and applies it. Never claim a change is applied.
- After edits that could affect conversion, call check to run the converter and look at its \
warnings. Fix what you caused.
- Keep changes minimal and faithful to the author's intent; don't reformat unrelated text.

Answer in Markdown. Put LaTeX in fenced ```latex blocks. Be concise: lead with the answer, then \
the details that matter."""

CHAT_SYSTEM = """You are tex-copilot, the assistant in Tex Word Studio, a web app that converts \
LaTeX projects into editable Word documents with the tex2word engine. Help the author write and \
fix LaTeX that converts cleanly to Word. Answer in Markdown; put LaTeX in fenced ```latex blocks. \
Be concise: lead with the answer."""

TOOLS: list[dict[str, Any]] = [
    {"name": "list_files", "description": "List the project's files (text and binary) and which is the main file.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "read_file",
     "description": f"Read a text file with line numbers. At most {READ_LINES} lines per call; use start_line to page.",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string", "description": "Project-relative path, e.g. sections/intro.tex"},
         "start_line": {"type": "integer", "description": "First line (1-based)", "minimum": 1},
         "end_line": {"type": "integer", "description": "Last line (inclusive)", "minimum": 1}},
         "required": ["path"]}},
    {"name": "search",
     "description": f"Find text across the project's text files; returns up to {SEARCH_LIMIT} 'path:line: text' matches.",
     "parameters": {"type": "object", "properties": {
         "query": {"type": "string"},
         "regex": {"type": "boolean", "description": "Treat query as a regular expression"},
         "path": {"type": "string", "description": "Only this file or folder"}},
         "required": ["query"]}},
    {"name": "outline", "description": "Sections, floats, labels and \\input files of one file, with line numbers.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "check",
     "description": "Convert the project (with your staged edits) using tex2word and return the conversion warnings and errors.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "edit_file",
     "description": "Replace old_text with new_text in a file. old_text must match exactly once unless replace_all.",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"},
         "old_text": {"type": "string", "description": "Exact text to replace (copied from read_file, without line numbers)"},
         "new_text": {"type": "string"},
         "replace_all": {"type": "boolean"}},
         "required": ["path", "old_text", "new_text"]}},
    {"name": "write_file", "description": "Create a new text file (or replace a file's whole content).",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
]


class ToolError(Exception):
    """A tool call that failed in a way the model should see and recover from."""


def norm_path(path: Any) -> str:
    p = str(path or "").strip().replace("\\", "/")
    p = posixpath.normpath(p.lstrip("/")) if p else ""
    if not p or p == "." or p.startswith("../") or p == ".." or "\0" in p:
        raise ToolError(f"invalid path: {path!r}")
    return p


@dataclass
class Workspace:
    """The project's files with staged edits layered on top."""

    files: dict[str, str]                       # text files: path → content
    binary: set[str] = field(default_factory=set)
    main: str = "main.tex"
    staged: dict[str, str] = field(default_factory=dict)

    def exists(self, path: str) -> bool:
        return path in self.staged or path in self.files

    def read(self, path: str) -> str:
        path = norm_path(path)
        if path in self.staged:
            return self.staged[path]
        if path in self.files:
            return self.files[path]
        if path in self.binary:
            raise ToolError(f"{path} is a binary file (image/PDF); it can't be read as text")
        near = [p for p in self.paths() if p.split("/")[-1] == path.split("/")[-1]]
        raise ToolError(f"no such file: {path}" + (f" (did you mean {', '.join(near)}?)" if near else ""))

    def write(self, path: str, content: str) -> None:
        path = norm_path(path)
        if path in self.binary:
            raise ToolError(f"{path} is a binary file and can't be written")
        if not path.lower().endswith(TEXT_EXTS):
            raise ToolError(f"only text files can be written ({', '.join(TEXT_EXTS)})")
        if len(content) > MAX_FILE_CHARS:
            raise ToolError("file too large")
        self.staged[path] = content

    def paths(self) -> list[str]:
        return sorted(set(self.files) | set(self.staged))

    def view(self) -> dict[str, str]:
        out = dict(self.files)
        out.update(self.staged)
        return out

    def changes(self) -> list[dict[str, Any]]:
        out = []
        for path in sorted(self.staged):
            before = self.files.get(path)
            after = self.staged[path]
            if before != after:
                out.append({"path": path, "before": before, "after": after, "status": "pending"})
        return out


# ── tools ──────────────────────────────────────────────────────────────────
def _size(n: int) -> str:
    return f"{n} B" if n < 1024 else f"{n / 1024:.1f} KB"


def tool_list_files(ws: Workspace, args: dict) -> tuple[str, str]:
    lines = []
    for p in ws.paths():
        tags = []
        if p == ws.main:
            tags.append("main")
        if p in ws.staged:
            tags.append("edited" if p in ws.files else "new")
        lines.append(f"{p} ({_size(len(ws.read(p)))}{', ' + ', '.join(tags) if tags else ''})")
    for p in sorted(ws.binary):
        lines.append(f"{p} (binary)")
    return "\n".join(lines) or "(no files)", f"{len(lines)} files"


def tool_read_file(ws: Workspace, args: dict) -> tuple[str, str]:
    path = norm_path(args.get("path"))
    text = ws.read(path)
    rows = text.split("\n")
    start = max(1, int(args.get("start_line") or 1))
    end = int(args.get("end_line") or (start + READ_LINES - 1))
    end = min(len(rows), end, start + READ_LINES - 1)
    if start > len(rows):
        raise ToolError(f"{path} has only {len(rows)} lines")
    width = len(str(end))
    out, chars = [], 0
    for i in range(start, end + 1):
        line = f"{str(i).rjust(width)}| {rows[i - 1]}"
        chars += len(line) + 1
        if chars > READ_CHARS:
            end = i - 1
            break
        out.append(line)
    more = f"\n(lines {start}-{end} of {len(rows)}; read on with start_line={end + 1})" if end < len(rows) else ""
    return "\n".join(out) + more, f"{path} · lines {start}–{end} of {len(rows)}"


def tool_search(ws: Workspace, args: dict) -> tuple[str, str]:
    query = str(args.get("query") or "")
    if not query:
        raise ToolError("query is empty")
    try:
        rx = re.compile(query if args.get("regex") else re.escape(query))
    except re.error as exc:
        raise ToolError(f"bad regular expression: {exc}") from exc
    scope = str(args.get("path") or "").strip().strip("/")
    hits, total = [], 0
    for p in ws.paths():
        if scope and not (p == scope or p.startswith(scope + "/")):
            continue
        for n, line in enumerate(ws.read(p).split("\n"), 1):
            if rx.search(line):
                total += 1
                if len(hits) < SEARCH_LIMIT:
                    hits.append(f"{p}:{n}: {line.strip()[:200]}")
    if not hits:
        return "no matches", f"“{query}” · no matches"
    extra = f"\n({total - len(hits)} more matches not shown)" if total > len(hits) else ""
    return "\n".join(hits) + extra, f"“{query}” · {total} match{'es' if total != 1 else ''}"


_OUTLINE_RE = re.compile(
    r"\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}"
    r"|\\begin\{(figure\*?|table\*?|equation\*?|align\*?|theorem|lemma|definition|proof)\}"
    r"|\\label\{([^}]*)\}|\\(?:input|include|subfile)\{([^}]*)\}")


def tool_outline(ws: Workspace, args: dict) -> tuple[str, str]:
    path = norm_path(args.get("path"))
    out = []
    for n, line in enumerate(ws.read(path).split("\n"), 1):
        code = line.split("%")[0] if "%" in line and "\\%" not in line else line
        for m in _OUTLINE_RE.finditer(code):
            if m.group(1):
                out.append(f"{n}: \\{m.group(1)}{{{m.group(2)}}}")
            elif m.group(3):
                out.append(f"{n}: \\begin{{{m.group(3)}}}")
            elif m.group(4):
                out.append(f"{n}:   \\label{{{m.group(4)}}}")
            elif m.group(5):
                out.append(f"{n}: \\input{{{m.group(5)}}}")
    return "\n".join(out) or "(no sections, floats or labels)", f"{path} · {len(out)} items"


def tool_edit_file(ws: Workspace, args: dict) -> tuple[str, str]:
    path = norm_path(args.get("path"))
    old = args.get("old_text")
    new = args.get("new_text")
    if not isinstance(old, str) or not isinstance(new, str):
        raise ToolError("old_text and new_text must be strings")
    if not old:
        raise ToolError("old_text is empty; use write_file to create a file")
    text = ws.read(path)
    count = text.count(old)
    if count == 0:
        # a common slip: trailing whitespace or line-number prefixes copied in
        hint = ""
        if re.search(r"^\s*\d+\| ", old, re.M):
            hint = " (remove the 'N| ' line-number prefixes)"
        elif old.strip() and text.count(old.strip()) == 1:
            hint = " (it matches once without the surrounding whitespace)"
        raise ToolError(f"old_text was not found in {path}{hint}; read the file again and copy the text exactly")
    if count > 1 and not args.get("replace_all"):
        raise ToolError(f"old_text matches {count} times in {path}; include more context or set replace_all")
    ws.write(path, text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1))
    line = text[: text.find(old)].count("\n") + 1
    n = count if args.get("replace_all") else 1
    return f"Edited {path} ({n} replacement{'s' if n > 1 else ''}, first at line {line}). Staged for review.", \
        f"{path} · line {line}" + (f" · {n}×" if n > 1 else "")


def tool_write_file(ws: Workspace, args: dict) -> tuple[str, str]:
    path = norm_path(args.get("path"))
    content = args.get("content")
    if not isinstance(content, str):
        raise ToolError("content must be a string")
    existed = ws.exists(path)
    ws.write(path, content)
    lines = content.count("\n") + 1
    return f"{'Replaced' if existed else 'Created'} {path} ({lines} lines). Staged for review.", \
        f"{path} · {'replaced' if existed else 'new'} · {lines} lines"


@dataclass
class Tools:
    """Tool dispatch; ``check`` needs the converter, injected by the caller."""

    workspace: Workspace
    check: Callable[[Workspace], dict] | None = None

    def run(self, name: str, args: dict) -> tuple[bool, str, str]:
        """→ (ok, result text for the model, one-line summary for the UI)."""
        try:
            if "_raw" in args:
                raise ToolError("the arguments were not valid JSON")
            fn = {
                "list_files": tool_list_files, "read_file": tool_read_file, "search": tool_search,
                "outline": tool_outline, "edit_file": tool_edit_file, "write_file": tool_write_file,
            }.get(name)
            if name == "check":
                return (True, *self._check())
            if fn is None:
                raise ToolError(f"unknown tool: {name}")
            text, summary = fn(self.workspace, args)
            return True, text, summary
        except ToolError as exc:
            return False, f"Error: {exc}", str(exc)
        except Exception as exc:  # a tool bug must not kill the turn
            return False, f"Error: {type(exc).__name__}: {exc}", f"failed: {exc}"

    def _check(self) -> tuple[str, str]:
        if self.check is None:
            raise ToolError("checking is not available here")
        report = self.check(self.workspace)
        if report.get("error"):
            return f"The conversion failed: {report['error']}", "conversion failed"
        entries = report.get("entries") or []
        counts = report.get("counts") or {}
        w, e = counts.get("warnings", 0), counts.get("errors", 0)
        lines = [f"{report.get('summary') or ''}".strip(), f"{w} warning(s), {e} error(s)."]
        for item in entries[:40]:
            lines.append(f"- [{item.get('severity')}] {item.get('construct')}: {item.get('message')}")
        if len(entries) > 40:
            lines.append(f"({len(entries) - 40} more)")
        return "\n".join(x for x in lines if x), f"{w} warning{'s' if w != 1 else ''}, {e} error{'s' if e != 1 else ''}"


def _args_preview(name: str, args: dict) -> dict:
    """Arguments for the UI, with long text trimmed."""
    out = {}
    for k, v in (args or {}).items():
        if isinstance(v, str) and len(v) > 160:
            v = v[:157] + "…"
        out[k] = v
    return out


# ── the loop ───────────────────────────────────────────────────────────────
def run(
    provider, model: str, system: str, messages: list[dict], tools: Tools | None, *,
    max_steps: int = MAX_STEPS, max_tokens: int = 8192,
) -> Iterator[dict]:
    """Drive the model until it stops calling tools (or ``max_steps``)."""
    msgs = list(messages)
    use_tools = tools is not None and provider.tools
    usage = {"input": 0, "output": 0}
    for step in range(max_steps):
        text: list[str] = []
        calls: list[dict] = []
        try:
            for ev in llm.chat(provider, model, system, msgs, tools=TOOLS if use_tools else None,
                               max_tokens=max_tokens):
                t = ev["type"]
                if t == "text":
                    text.append(ev["text"])
                    yield ev
                elif t == "reasoning":
                    yield ev
                elif t == "tool_call":
                    calls.append(ev)
                elif t == "usage":
                    usage["input"] += ev.get("input", 0)
                    usage["output"] += ev.get("output", 0)
        except llm.LLMError as exc:
            if use_tools and exc.tools_unsupported and step == 0 and not text:
                use_tools = False
                yield {"type": "notice", "text": f"{model} does not accept tools here; answering without them."}
                continue
            raise
        msgs.append({"role": "assistant", "content": "".join(text), "tool_calls": calls} if calls
                    else {"role": "assistant", "content": "".join(text)})
        if not calls:
            break
        for call in calls:
            yield {"type": "tool_start", "id": call["id"], "name": call["name"],
                   "args": _args_preview(call["name"], call.get("arguments") or {})}
            ok, result, summary = tools.run(call["name"], call.get("arguments") or {})
            yield {"type": "tool_end", "id": call["id"], "name": call["name"], "ok": ok, "summary": summary}
            msgs.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"], "content": result})
    else:
        yield {"type": "notice", "text": f"Stopped after {max_steps} steps; ask me to continue if needed."}
    if usage["input"] or usage["output"]:
        yield {"type": "usage", **usage}
    if tools is not None:
        changes = tools.workspace.changes()
        if changes:
            yield {"type": "changes", "changes": changes}
