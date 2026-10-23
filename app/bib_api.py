"""HTTP API for the reference manager (left panel → References).

Project routes work on the project's ``.bib`` files through
:mod:`app.bibtex` and write them back with the project store, so the change
shows up like any other file edit. Global routes do the online lookups
(:mod:`app.bibfetch`) and hold the manager's preferences.

Ownership of ``/api/projects/{id}/…`` is enforced by ``main.auth_guard``.
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import bibtex
from .bibfetch import SCHOLAR, SOURCES, FetchError, Fetcher, identify

router = APIRouter()


class _Deps:
    projects: Any
    settings: Any
    fetcher: Fetcher
    authn: Any


deps = _Deps()


def bind(**kw: Any) -> None:
    for k, v in kw.items():
        setattr(deps, k, v)


DEFAULT_PREFS = {"key_pattern": bibtex.DEFAULT_KEY_PATTERN, "cite_command": "cite",
                 "search_sources": ["crossref", "arxiv", "dblp"]}
CITE_COMMANDS = ["cite", "citep", "citet", "parencite", "textcite", "autocite", "footcite", "nocite"]


def prefs() -> dict[str, Any]:
    raw = deps.settings.get("bib.prefs") or {}
    out = dict(DEFAULT_PREFS)
    out.update({k: raw[k] for k in DEFAULT_PREFS if k in raw})
    return out


def _can_manage(request: Request) -> bool:
    if not deps.authn.enabled:
        return True
    claims = getattr(request.state, "user", None)
    return bool(claims and claims.get("role") == "admin")


# ── helpers ────────────────────────────────────────────────────────────────
def _project(pid: str):
    p = deps.projects.get(pid)
    if p is None:
        raise HTTPException(status_code=404, detail="project not found")
    return p


def _bib_paths(files: dict[str, str]) -> list[str]:
    return sorted(p for p in files if p.lower().endswith(".bib"))


def _valid_bib_path(path: str) -> str:
    path = (path or "").strip().replace("\\", "/").lstrip("/")
    if not path.lower().endswith(".bib") or any(part in ("", ".", "..") for part in path.split("/")):
        raise HTTPException(status_code=422, detail="the bibliography file must be a relative path ending in .bib")
    return path


def _load(pid: str, file: str | None, *, create: bool = False):
    """(project, files, path, Database)."""
    project = _project(pid)
    files = project.file_map()
    if not file:
        used = bibtex.bib_resources(files)
        bibs = _bib_paths(files)
        file = (used or bibs or [None])[0]
        if file is None:
            raise HTTPException(status_code=404, detail="this project has no .bib file yet")
    path = _valid_bib_path(file)
    if path not in files:
        if not create:
            raise HTTPException(status_code=404, detail=f"no file {path}")
        files[path] = ""
    return project, files, path, bibtex.parse(files[path])


def _save(project, path: str, text: str) -> None:
    deps.projects.put_file(project.id, path, text)


def _err(exc: Exception, code: int = 422) -> HTTPException:
    return HTTPException(status_code=code, detail=str(exc))


def _entry_out(db: bibtex.Database, e: bibtex.Entry, cited: dict | None = None) -> dict[str, Any]:
    return bibtex.entry_public(e, db.text, cited, db.strings)


def _rename_in_tex(project, files: dict[str, str], renames: dict[str, str]) -> dict[str, str]:
    """Apply key renames to \\cite commands in the .tex files; return changed files."""
    changed: dict[str, str] = {}
    for path, src in files.items():
        if not path.lower().endswith((".tex", ".ltx")):
            continue
        new = src
        for old, nk in renames.items():
            if old != nk:
                new, _ = bibtex.rename_citations(new, old, nk)
        if new != src:
            deps.projects.put_file(project.id, path, new)
            changed[path] = new
    return changed


def _all_keys(files: dict[str, str]) -> set[str]:
    keys: set[str] = set()
    for p in _bib_paths(files):
        keys.update(bibtex.parse(files[p]).keys())
    for src in files.values():
        if isinstance(src, str):
            keys.update(re.findall(r"\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}", src))
    return keys


# ── read ───────────────────────────────────────────────────────────────────
@router.get("/api/projects/{pid}/bib")
def get_bibliography(pid: str, file: str | None = None) -> dict:
    project = _project(pid)
    files = project.file_map()
    bibs = _bib_paths(files)
    used = bibtex.bib_resources(files)
    cited = bibtex.citations(files)
    known = _all_keys(files)
    out: dict[str, Any] = {
        "files": [{"path": p, "used": p in used, "entries": len(bibtex.parse(files[p]).entries)} for p in bibs],
        "file": None, "entries": [], "strings": {}, "problems": [], "duplicates": [],
        "cited": {k: len(v) for k, v in cited.items()},
        "missing": [{"key": k, "uses": v[:5]} for k, v in sorted(cited.items()) if k not in known],
        "unused": [], "prefs": prefs(),
    }
    path = file if file in bibs else (used[0] if used else (bibs[0] if bibs else None))
    if path is None:
        return out
    db = bibtex.parse(files[path])
    out.update(file=path, strings=db.strings,
               entries=[_entry_out(db, e, cited) for e in db.entries],
               problems=bibtex.database_problems(db),
               duplicates=bibtex.find_duplicates(db),
               unused=[e.key for e in db.entries if e.key not in cited])
    return out


# ── entries CRUD ───────────────────────────────────────────────────────────
class EntryIn(BaseModel):
    file: str | None = None
    type: str = "misc"
    key: str | None = Field(default=None, max_length=200)
    fields: dict[str, str] = Field(default_factory=dict)
    generate_key: bool = False
    force: bool = False                    # add even if it looks like a duplicate
    rename_citations: bool = True          # PUT: follow a key change in \cite commands


def _with_key(db: bibtex.Database, req: EntryIn, taken: list[str]) -> str:
    key = (req.key or "").strip()
    if not key or req.generate_key:
        draft = bibtex.Entry(req.type, "", [bibtex.Field(k, v, "") for k, v in req.fields.items()])
        key = bibtex.unique_key(bibtex.make_key(draft, prefs()["key_pattern"]), taken)
    return key


@router.post("/api/projects/{pid}/bib/entries", status_code=201)
def create_entry(pid: str, req: EntryIn) -> dict:
    project, files, path, db = _load(pid, req.file, create=True)
    key = _with_key(db, req, db.keys())
    if db.find(key):
        raise HTTPException(status_code=409, detail=f"the key {key} is already in {path}")
    if not req.force:
        dups = [{"key": e.key, "reason": r} for e in db.entries
                if (r := bibtex.is_duplicate(req.fields, e.as_dict()))]
        if dups:
            raise HTTPException(status_code=409, detail={
                "message": f"looks like {dups[0]['key']} ({dups[0]['reason']})", "duplicates": dups})
    try:
        entry = bibtex.build_entry(db, req.type, key, req.fields)
    except bibtex.BibError as exc:
        raise _err(exc) from exc
    text = bibtex.append_entry(db, entry)
    _save(project, path, text)
    new = bibtex.parse(text)
    return {"file": path, "key": key, "content": text, "entry": _entry_out(new, new.find(key))}


@router.put("/api/projects/{pid}/bib/entries/{key}")
def update_entry(pid: str, key: str, req: EntryIn) -> dict:
    project, files, path, db = _load(pid, req.file)
    old = db.find(key)
    if old is None:
        raise HTTPException(status_code=404, detail=f"no entry {key} in {path}")
    new_key = _with_key(db, req, [k for k in db.keys() if k != old.key]) if (req.generate_key or req.key) else old.key
    if new_key != old.key and db.find(new_key) and db.find(new_key) is not old:
        raise HTTPException(status_code=409, detail=f"the key {new_key} is already in {path}")
    try:
        entry = bibtex.build_entry(db, req.type, new_key, req.fields, old=old)
        text = bibtex.replace_entry(db, old.key, entry)
    except bibtex.BibError as exc:
        raise _err(exc) from exc
    _save(project, path, text)
    changed = _rename_in_tex(project, files, {old.key: new_key}) if (new_key != old.key and req.rename_citations) else {}
    new = bibtex.parse(text)
    return {"file": path, "key": new_key, "content": text, "entry": _entry_out(new, new.find(new_key)),
            "changed_files": changed}


@router.delete("/api/projects/{pid}/bib/entries/{key}")
def delete_entry(pid: str, key: str, file: str | None = None) -> dict:
    project, files, path, db = _load(pid, file)
    try:
        text = bibtex.delete_entry(db, key)
    except bibtex.BibError as exc:
        raise _err(exc, 404) from exc
    _save(project, path, text)
    return {"file": path, "content": text}


class RawIn(BaseModel):
    file: str | None = None
    source: str = Field(max_length=200_000)
    rename_citations: bool = True


@router.put("/api/projects/{pid}/bib/entries/{key}/source")
def update_entry_source(pid: str, key: str, req: RawIn) -> dict:
    """Replace an entry with hand-written BibTeX (the editor's Source tab)."""
    project, files, path, db = _load(pid, req.file)
    old = db.find(key)
    if old is None:
        raise HTTPException(status_code=404, detail=f"no entry {key} in {path}")
    one = bibtex.parse(req.source)
    if one.errors:
        raise HTTPException(status_code=422, detail=f"line {one.errors[0]['line']}: {one.errors[0]['message']}")
    if len(one.entries) != 1:
        raise HTTPException(status_code=422, detail="the source must hold exactly one entry")
    e = one.entries[0]
    if e.key != old.key and db.find(e.key):
        raise HTTPException(status_code=409, detail=f"the key {e.key} is already in {path}")
    text = db.text[:old.start] + req.source[e.start:e.end] + db.text[old.end:]
    _save(project, path, text)
    changed = _rename_in_tex(project, files, {old.key: e.key}) if (e.key != old.key and req.rename_citations) else {}
    new = bibtex.parse(text)
    return {"file": path, "key": e.key, "content": text, "entry": _entry_out(new, new.find(e.key)),
            "changed_files": changed}


# ── bulk operations ────────────────────────────────────────────────────────
class ImportIn(BaseModel):
    file: str | None = None
    text: str | None = Field(default=None, max_length=2_000_000)    # pasted BibTeX
    candidates: list[dict[str, Any]] = Field(default_factory=list)  # from lookup / search
    duplicates: str = "skip"                                        # "skip" | "add"


@router.post("/api/projects/{pid}/bib/import")
def import_entries(pid: str, req: ImportIn) -> dict:
    project, files, path, db = _load(pid, req.file, create=True)
    incoming: list[tuple[str, str, dict[str, str]]] = []      # (type, key or "", values)
    errors: list[dict[str, Any]] = []
    if req.text:
        src = bibtex.parse(req.text)
        errors = src.errors
        for e in src.entries:
            vals = {f.name: (bibtex.resolve(f.value, src.strings) if f.name != "month" else f.value) for f in e.fields}
            incoming.append((e.type, e.key, vals))
    for c in req.candidates[:200]:
        vals = {str(k).lower(): str(v) for k, v in (c.get("fields") or {}).items() if v not in (None, "")}
        incoming.append((str(c.get("type") or "misc"), str(c.get("key") or ""), vals))
    if not incoming and not errors:
        raise HTTPException(status_code=422, detail="nothing to import")
    added, skipped = [], []
    existing = [e.as_dict() for e in db.entries]
    keys = db.keys()
    text = db.text
    pattern = prefs()["key_pattern"]
    for etype, key, vals in incoming:
        dup = next(((db.entries[i].key, r) for i, ex in enumerate(existing) if (r := bibtex.is_duplicate(vals, ex))), None)
        if dup and req.duplicates != "add":
            skipped.append({"key": key or "", "title": bibtex.latex_to_text(vals.get("title", "")),
                            "duplicate_of": dup[0], "reason": dup[1]})
            continue
        draft = bibtex.Entry(etype, key, [bibtex.Field(k, v, "") for k, v in vals.items()])
        base = key if key and bibtex.KEY_OK.match(key) else bibtex.make_key(draft, pattern)
        k = bibtex.unique_key(base, keys)
        try:
            entry = bibtex.build_entry(bibtex.parse(text), etype, k, vals)
        except bibtex.BibError as exc:
            errors.append({"line": 0, "message": f"{key or vals.get('title', '')[:40]}: {exc}"})
            continue
        text = bibtex.append_entry(bibtex.parse(text), entry)
        keys.append(k)
        existing.append(vals)
        added.append(k)
    if added:
        _save(project, path, text)
    return {"file": path, "added": added, "skipped": skipped, "errors": errors, "content": text}


class CleanupIn(BaseModel):
    file: str | None = None
    keys: list[str] | None = None
    actions: list[str] = Field(default_factory=lambda: list(bibtex.CLEANUPS))


@router.post("/api/projects/{pid}/bib/cleanup")
def cleanup(pid: str, req: CleanupIn) -> dict:
    project, files, path, db = _load(pid, req.file)
    bad = [a for a in req.actions if a not in bibtex.CLEANUPS]
    if bad:
        raise HTTPException(status_code=422, detail=f"unknown cleanup: {', '.join(bad)}")
    changed = []
    text = db.text
    for key in [e.key for e in db.entries if req.keys is None or e.key in req.keys]:
        cur = bibtex.parse(text)
        e = cur.find(key)
        vals = bibtex.cleanup_values(e, req.actions)
        if vals == e.as_dict():
            continue
        try:
            text = bibtex.replace_entry(cur, key, bibtex.build_entry(cur, e.type, e.key, vals, old=e))
        except bibtex.BibError:
            continue
        changed.append(key)
    if changed:
        _save(project, path, text)
    return {"file": path, "changed": changed, "content": text}


class KeysIn(BaseModel):
    file: str | None = None
    keys: list[str] | None = None
    pattern: str | None = Field(default=None, max_length=200)
    rename_citations: bool = True
    dry_run: bool = False                      # only report what would change


@router.post("/api/projects/{pid}/bib/keys")
def regenerate_keys(pid: str, req: KeysIn) -> dict:
    project, files, path, db = _load(pid, req.file)
    pattern = req.pattern or prefs()["key_pattern"]
    targets = [e for e in db.entries if req.keys is None or e.key in req.keys]
    target_keys = {e.key for e in targets}
    taken = [k for k in db.keys() if k not in target_keys]
    renames: dict[str, str] = {}
    for e in targets:
        nk = bibtex.unique_key(bibtex.make_key(e, pattern), taken)
        taken.append(nk)
        if nk != e.key:
            renames[e.key] = nk
    if req.dry_run:
        return {"file": path, "renamed": renames, "pattern": pattern}
    text = db.text
    for old, nk in renames.items():
        cur = bibtex.parse(text)
        e = cur.find(old)
        ne = bibtex.build_entry(cur, e.type, nk, e.as_dict(), old=e)
        text = bibtex.replace_entry(cur, old, ne)
    if renames:
        _save(project, path, text)
    changed = _rename_in_tex(project, files, renames) if (renames and req.rename_citations) else {}
    return {"file": path, "renamed": renames, "content": text, "changed_files": changed}


class MergeIn(BaseModel):
    file: str | None = None
    keep: str
    remove: list[str]
    fields: dict[str, str] | None = None       # the merged values; default: keep's, filled from the others


@router.post("/api/projects/{pid}/bib/merge")
def merge_entries(pid: str, req: MergeIn) -> dict:
    project, files, path, db = _load(pid, req.file)
    keep = db.find(req.keep)
    if keep is None:
        raise HTTPException(status_code=404, detail=f"no entry {req.keep}")
    others = [db.find(k) for k in req.remove if k != req.keep]
    if any(o is None for o in others):
        raise HTTPException(status_code=404, detail="an entry to merge is missing")
    vals = keep.as_dict()
    conflicts: list[str] = []
    for o in others:
        vals, c = bibtex.merge_values(vals, o.as_dict())
        conflicts += c
    if req.fields is not None:
        vals = req.fields
    try:
        text = bibtex.replace_entry(db, keep.key, bibtex.build_entry(db, keep.type, keep.key, vals, old=keep))
        for o in others:
            text = bibtex.delete_entry(bibtex.parse(text), o.key)
    except bibtex.BibError as exc:
        raise _err(exc) from exc
    _save(project, path, text)
    changed = _rename_in_tex(project, files, {o.key: keep.key for o in others})
    return {"file": path, "content": text, "conflicts": sorted(set(conflicts)), "changed_files": changed}


# ── online ─────────────────────────────────────────────────────────────────
def _fetch_error(exc: FetchError) -> HTTPException:
    msg = str(exc)
    return HTTPException(status_code=404 if msg.startswith(("not found", "no ")) else 502, detail=msg)


@router.get("/api/bib/sources")
def sources() -> dict:
    out = deps.fetcher.public()
    out.update(cleanups=bibtex.CLEANUPS, types=bibtex.type_specs(), field_order=bibtex.FIELD_ORDER,
               cite_commands=CITE_COMMANDS, prefs=prefs(),
               key_tokens=["auth", "authors", "authEtAl", "auth.etal", "authors2", "year", "shortyear",
                           "veryshorttitle", "shorttitle", "title", "firstpage", "journal", "entrytype", "eprint"])
    return out


@router.get("/api/bib/lookup")
def lookup(q: str = Query(max_length=500)) -> dict:
    ident = identify(q)
    if ident is None:
        raise HTTPException(status_code=422, detail="enter a DOI, an arXiv id or an ISBN (or use Search)")
    try:
        return {"identifier": ident, "results": deps.fetcher.lookup(q)}
    except FetchError as exc:
        raise _fetch_error(exc) from exc


@router.get("/api/bib/search")
def search(q: str = Query(max_length=500), source: str = "crossref", limit: int = 10) -> dict:
    ident = identify(q)
    try:
        if ident is not None:
            return {"identifier": ident, "results": deps.fetcher.lookup(q)}
        return {"source": source, "results": deps.fetcher.search(source, q, limit),
                "scholar": SCHOLAR["url"].replace("{q}", re.sub(r"\s+", "+", q.strip()))}
    except FetchError as exc:
        raise _fetch_error(exc) from exc


@router.get("/api/projects/{pid}/bib/entries/{key}/fetch")
def fetch_for_entry(pid: str, key: str, file: str | None = None) -> dict:
    """Online data for an entry (by its DOI / arXiv id / ISBN, else its title),
    as a field-by-field comparison the UI can merge from."""
    project, files, path, db = _load(pid, file)
    e = db.find(key)
    if e is None:
        raise HTTPException(status_code=404, detail=f"no entry {key}")
    cur = e.as_dict()
    try:
        if bibtex.clean_doi(cur.get("doi", "")):
            found = deps.fetcher.lookup(bibtex.clean_doi(cur["doi"]))
        elif bibtex.arxiv_id(e):
            found = deps.fetcher.lookup("arXiv:" + bibtex.arxiv_id(e))
        elif cur.get("isbn") and identify(cur["isbn"]):
            found = deps.fetcher.lookup(cur["isbn"])
        elif cur.get("title"):
            hits = deps.fetcher.search("crossref", bibtex.latex_to_text(cur["title"]), 5)
            found = [h for h in hits if bibtex.is_duplicate(cur, h["fields"])][:1]
            if not found:
                raise FetchError("no confident match for this title on Crossref")
        else:
            raise FetchError("no DOI, arXiv id, ISBN or title to look up")
    except FetchError as exc:
        raise _fetch_error(exc) from exc
    best = found[0]
    diff = []
    for name, value in best["fields"].items():
        mine = cur.get(name, "")
        if bibtex.latex_to_text(mine).strip().lower() != bibtex.latex_to_text(value).strip().lower():
            diff.append({"field": name, "current": mine, "fetched": value})
    return {"candidate": best, "diff": diff, "type": best["type"], "current_type": e.type}


class PrefsIn(BaseModel):
    key_pattern: str | None = Field(default=None, max_length=200)
    cite_command: str | None = None
    search_sources: list[str] | None = None


@router.put("/api/bib/prefs")
def set_prefs(req: PrefsIn, request: Request) -> dict:
    if not _can_manage(request):
        raise HTTPException(status_code=403, detail="only an admin can change the reference manager's settings")
    cur = prefs()
    if req.key_pattern is not None:
        if not re.search(r"\[[^\]]+\]", req.key_pattern):
            raise HTTPException(status_code=422, detail="the key pattern needs at least one [field], e.g. [auth][year]")
        cur["key_pattern"] = req.key_pattern.strip()
    if req.cite_command is not None:
        if req.cite_command not in CITE_COMMANDS:
            raise HTTPException(status_code=422, detail=f"cite command must be one of {', '.join(CITE_COMMANDS)}")
        cur["cite_command"] = req.cite_command
    if req.search_sources is not None:
        cur["search_sources"] = [s for s in req.search_sources if s in SOURCES and SOURCES[s]["search"]]
    deps.settings.set("bib.prefs", cur)
    return cur
