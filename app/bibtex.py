"""BibTeX databases: parse, edit in place, and the reference-manager tools.

Modelled on what JabRef does for a ``.bib`` file:

- **Parse** ``@entry``, ``@string``, ``@preamble`` and ``@comment`` blocks
  with their exact source spans, so an edit rewrites only the entry it touches
  and the rest of a hand-written file stays byte-for-byte the same.
- **Field values** use JabRef's convention for the editor: the text inside the
  outer braces/quotes, with a macro (``@string`` or a month) written ``#jan#``.
- **Citation keys** from patterns such as ``[auth][year]`` or
  ``[authEtAl:lower][shortyear]``, made unique with ``a``, ``b``, …
- **Integrity checks** (required fields per entry type, key characters, year,
  page ranges, DOI form, duplicate keys), **cleanup** actions (page dashes,
  DOI, months, arXiv fields, whitespace, protecting acronyms in titles) and
  **duplicate detection** (same DOI / arXiv id / near-identical title).

No third-party parser: the format is small, and keeping spans needs our own.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

# ── entry types (BibTeX + common biblatex) ─────────────────────────────────
# "a/b" means either field satisfies the requirement.
TYPES: dict[str, dict[str, list[str]]] = {
    "article": {"required": ["author", "title", "journal", "year/date"],
                "optional": ["volume", "number", "pages", "month", "doi", "url", "note", "issn"]},
    "book": {"required": ["author/editor", "title", "publisher", "year/date"],
             "optional": ["volume", "number", "series", "address", "edition", "month", "isbn", "doi", "url", "note"]},
    "inproceedings": {"required": ["author", "title", "booktitle", "year/date"],
                      "optional": ["editor", "volume", "number", "series", "pages", "address", "month",
                                   "organization", "publisher", "doi", "url", "note"]},
    "incollection": {"required": ["author", "title", "booktitle", "publisher", "year/date"],
                     "optional": ["editor", "volume", "number", "series", "type", "chapter", "pages",
                                  "address", "edition", "month", "doi", "url", "note"]},
    "inbook": {"required": ["author/editor", "title", "chapter/pages", "publisher", "year/date"],
               "optional": ["volume", "number", "series", "type", "address", "edition", "month", "doi", "url", "note"]},
    "phdthesis": {"required": ["author", "title", "school", "year/date"],
                  "optional": ["type", "address", "month", "doi", "url", "note"]},
    "mastersthesis": {"required": ["author", "title", "school", "year/date"],
                      "optional": ["type", "address", "month", "doi", "url", "note"]},
    "techreport": {"required": ["author", "title", "institution", "year/date"],
                   "optional": ["type", "number", "address", "month", "doi", "url", "note"]},
    "proceedings": {"required": ["title", "year/date"],
                    "optional": ["editor", "volume", "number", "series", "address", "month",
                                 "organization", "publisher", "doi", "url", "note"]},
    "booklet": {"required": ["title"],
                "optional": ["author", "howpublished", "address", "month", "year", "doi", "url", "note"]},
    "manual": {"required": ["title"],
               "optional": ["author", "organization", "address", "edition", "month", "year", "doi", "url", "note"]},
    "misc": {"required": [],
             "optional": ["author", "title", "howpublished", "month", "year", "eprint", "archiveprefix",
                          "primaryclass", "doi", "url", "note"]},
    "unpublished": {"required": ["author", "title", "note"], "optional": ["month", "year", "doi", "url"]},
    "online": {"required": ["author/editor", "title", "url", "year/date"],
               "optional": ["subtitle", "urldate", "organization", "note"]},
    "thesis": {"required": ["author", "title", "type", "institution", "year/date"],
               "optional": ["address", "month", "doi", "url", "note"]},
    "report": {"required": ["author", "title", "type", "institution", "year/date"],
               "optional": ["number", "address", "month", "doi", "url", "note"]},
    "software": {"required": ["author/editor", "title", "url/doi", "year/date"],
                 "optional": ["version", "publisher", "note"]},
    "dataset": {"required": ["author/editor", "title", "year/date"],
                "optional": ["publisher", "version", "doi", "url", "note"]},
}
ALIASES = {"conference": "inproceedings", "electronic": "online", "www": "online"}
# Order used when writing an entry (others follow in their own order).
FIELD_ORDER = ["author", "editor", "title", "subtitle", "journal", "journaltitle", "booktitle", "series",
               "edition", "volume", "number", "chapter", "pages", "school", "institution", "organization",
               "publisher", "address", "howpublished", "type", "month", "year", "date", "isbn", "issn",
               "doi", "eprint", "archiveprefix", "primaryclass", "url", "urldate", "keywords", "note",
               "abstract", "file"]
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
MONTH_NAMES = {m: i + 1 for i, m in enumerate(MONTHS)}
for _i, _full in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                            "september", "october", "november", "december"]):
    MONTH_NAMES[_full] = _i + 1
DEFAULT_KEY_PATTERN = "[auth][year]"
KEY_OK = re.compile(r"^[A-Za-z0-9_:./+\-]+$")
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>{}]+)", re.I)


class BibError(ValueError):
    """Malformed BibTeX, or an edit that would produce it."""


# ── data model ─────────────────────────────────────────────────────────────
@dataclass(slots=True)
class Field:
    name: str        # lowercase
    value: str       # editor form: inner text, macros as #name#
    raw: str         # exactly as in the file (or as it will be written)
    name_raw: str = ""


@dataclass(slots=True)
class Entry:
    type: str
    key: str
    fields: list[Field] = field(default_factory=list)
    start: int = -1   # span in the source text ('@' … closing delimiter)
    end: int = -1
    line: int = 0     # 1-based line of the '@'
    type_raw: str = ""

    def get(self, name: str, default: str = "") -> str:
        name = name.lower()
        for f in self.fields:
            if f.name == name:
                return f.value
        return default

    def has(self, name: str) -> bool:
        return any(f.name == name.lower() and f.value.strip() for f in self.fields)

    def as_dict(self) -> dict[str, str]:
        return {f.name: f.value for f in self.fields}


@dataclass(slots=True)
class Database:
    text: str
    entries: list[Entry] = field(default_factory=list)
    strings: dict[str, str] = field(default_factory=dict)    # name (lower) → value
    preambles: list[str] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)

    def find(self, key: str) -> Entry | None:
        for e in self.entries:
            if e.key == key:
                return e
        lower = key.lower()
        return next((e for e in self.entries if e.key.lower() == lower), None)

    def keys(self) -> list[str]:
        return [e.key for e in self.entries]


# ── parsing ────────────────────────────────────────────────────────────────
class _Scanner:
    def __init__(self, text: str) -> None:
        self.t = text
        self.i = 0
        self.n = len(text)

    def ws(self) -> None:
        while self.i < self.n and self.t[self.i].isspace():
            self.i += 1

    def peek(self) -> str:
        return self.t[self.i] if self.i < self.n else ""

    def ident(self) -> str:
        start = self.i
        while self.i < self.n and (self.t[self.i].isalnum() or self.t[self.i] in "_-:.+/'!$&*?^`|~"):
            self.i += 1
        return self.t[start:self.i]

    def braced(self) -> str:
        """Read a {balanced} group starting at '{'; return it including braces."""
        start, depth = self.i, 0
        while self.i < self.n:
            c = self.t[self.i]
            if c == "\\":
                self.i += 2
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    self.i += 1
                    return self.t[start:self.i]
            self.i += 1
        raise BibError("unbalanced braces")

    def quoted(self) -> str:
        start, depth = self.i, 0
        self.i += 1
        while self.i < self.n:
            c = self.t[self.i]
            if c == "\\":
                self.i += 2
                continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth < 0:
                    raise BibError("unbalanced braces in a quoted value")
            elif c == '"' and depth == 0:
                self.i += 1
                return self.t[start:self.i]
            self.i += 1
        raise BibError("unterminated quoted value")

    def value(self, close: str) -> str:
        """Raw text of a field value: part (# part)*. Stops before ',' or close."""
        start = self.i
        while True:
            self.ws()
            c = self.peek()
            if c == "{":
                self.braced()
            elif c == '"':
                self.quoted()
            elif c and (c.isalnum() or c in "_-:.+/"):
                self.ident()
            else:
                raise BibError("expected a value")
            end = self.i
            self.ws()
            if self.peek() == "#":
                self.i += 1
                continue
            return self.t[start:end].strip()


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _split_parts(raw: str) -> list[tuple[str, str]]:
    """Raw value → [(kind, text)], kind in {'str', 'num', 'macro'}."""
    s = _Scanner(raw)
    parts: list[tuple[str, str]] = []
    while True:
        s.ws()
        c = s.peek()
        if not c:
            break
        if c == "{":
            g = s.braced()
            parts.append(("str", g[1:-1]))
        elif c == '"':
            g = s.quoted()
            parts.append(("str", g[1:-1]))
        else:
            word = s.ident()
            if not word:
                raise BibError(f"unexpected {c!r} in a value")
            parts.append(("num" if word.isdigit() else "macro", word))
        s.ws()
        if s.peek() == "#":
            s.i += 1
    return parts


def decode_value(raw: str) -> str:
    """Raw field text → editor form (JabRef style: macros as #name#)."""
    out = []
    for kind, text in _split_parts(raw):
        out.append(f"#{text}#" if kind == "macro" else text)
    return "".join(out)


_MACRO_IN_VALUE = re.compile(r"#([A-Za-z][\w:.+-]*)#")


def encode_value(value: str, known_macros: Iterable[str] = ()) -> str:
    """Editor form → raw BibTeX. ``#name#`` becomes a bare macro when ``name``
    is a defined @string or a month; everything else is a {braced} string."""
    check_braces(value)
    known = {m.lower() for m in known_macros} | set(MONTHS)
    pieces: list[str] = []
    pos = 0
    for m in _MACRO_IN_VALUE.finditer(value):
        if m.group(1).lower() not in known:
            continue
        if m.start() > pos:
            pieces.append("{" + value[pos:m.start()] + "}")
        pieces.append(m.group(1))
        pos = m.end()
    if pos < len(value) or not pieces:
        pieces.append("{" + value[pos:] + "}")
    return " # ".join(pieces)


def check_braces(value: str) -> None:
    depth = 0
    i = 0
    while i < len(value):
        c = value[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth < 0:
                raise BibError("a '}' has no matching '{'")
        i += 1
    if depth:
        raise BibError("a '{' is never closed")


def parse(text: str) -> Database:
    """Parse a .bib file. Errors are collected, not raised; the parser skips to
    the next '@' at the start of a line after a malformed block."""
    db = Database(text=text)
    s = _Scanner(text)
    while True:
        at = text.find("@", s.i)
        if at < 0:
            break
        s.i = at + 1
        kind_raw = s.ident()
        kind = kind_raw.lower()
        s.ws()
        opener = s.peek()
        if not kind or opener not in "{(":
            # stray '@' (e.g. an e-mail address in a comment between entries)
            continue
        close = "}" if opener == "{" else ")"
        try:
            if kind == "comment":
                if opener == "{":
                    s.braced()
                else:
                    end = text.find(")", s.i)
                    s.i = (end + 1) if end >= 0 else s.n
                continue
            s.i += 1
            s.ws()
            if kind == "preamble":
                raw = s.value(close)
                db.preambles.append(raw)
                s.ws()
                if s.peek() != close:
                    raise BibError("expected the end of @preamble")
                s.i += 1
                continue
            if kind == "string":
                name = s.ident()
                s.ws()
                if s.peek() != "=":
                    raise BibError("expected '=' in @string")
                s.i += 1
                raw = s.value(close)
                db.strings[name.lower()] = decode_value(raw)
                s.ws()
                if s.peek() != close:
                    raise BibError("expected the end of @string")
                s.i += 1
                continue
            # a regular entry: key, then fields
            kstart = s.i
            while s.i < s.n and s.t[s.i] not in ",\n\r\t " + close:
                s.i += 1
            key = text[kstart:s.i].strip()
            s.ws()
            entry = Entry(type=ALIASES.get(kind, kind), key=key, start=at, line=_line_of(text, at),
                          type_raw=kind_raw)
            if s.peek() == ",":
                s.i += 1
            while True:
                s.ws()
                if s.peek() == close:
                    s.i += 1
                    break
                if not s.peek():
                    raise BibError(f"entry {key or '(no key)'} is never closed")
                fname = s.ident()
                if not fname:
                    raise BibError(f"expected a field name in {key or 'an entry'}")
                s.ws()
                if s.peek() != "=":
                    raise BibError(f"expected '=' after {fname} in {key}")
                s.i += 1
                raw = s.value(close)
                entry.fields.append(Field(fname.lower(), decode_value(raw), raw, fname))
                s.ws()
                if s.peek() == ",":
                    s.i += 1
                elif s.peek() != close:
                    raise BibError(f"expected ',' or the end of {key} after {fname}")
            entry.end = s.i
            if not key:
                db.errors.append({"line": entry.line, "message": f"an @{kind_raw} entry has no citation key"})
            db.entries.append(entry)
        except BibError as exc:
            db.errors.append({"line": _line_of(text, at), "message": str(exc)})
            nxt = re.compile(r"^\s*@", re.M).search(text, at + 1)
            s.i = nxt.start() if nxt else s.n
    return db


# ── writing ────────────────────────────────────────────────────────────────
def _ordered(fields: list[Field]) -> list[Field]:
    rank = {n: i for i, n in enumerate(FIELD_ORDER)}
    return sorted(fields, key=lambda f: (rank.get(f.name, len(FIELD_ORDER)), fields.index(f)))


def format_entry(entry: Entry, *, order: bool = True) -> str:
    fields = _ordered(entry.fields) if order else entry.fields
    lines = [f"@{entry.type_raw or entry.type}{{{entry.key},"]
    for f in fields:
        lines.append(f"  {f.name_raw or f.name} = {f.raw},")
    lines.append("}")
    return "\n".join(lines)


def build_entry(db: Database, etype: str, key: str, values: dict[str, str],
                old: Entry | None = None) -> Entry:
    """An Entry from editor values. Fields whose value is unchanged keep their
    original raw text and spelling."""
    etype = (etype or "misc").strip().lower()
    etype = ALIASES.get(etype, etype)
    if not re.fullmatch(r"[a-z]+", etype):
        raise BibError(f"invalid entry type: {etype!r}")
    key = (key or "").strip()
    if not key:
        raise BibError("the citation key is empty")
    if not KEY_OK.match(key):
        raise BibError(f"the citation key {key!r} may only use letters, digits and _ : . / + -")
    prev = {f.name: f for f in old.fields} if old else {}
    fields: list[Field] = []
    seen = set()
    for name, value in values.items():
        name = name.strip().lower()
        if not name or name in seen:
            continue
        if not re.fullmatch(r"[a-z][a-z0-9_\-:.+]*", name):
            raise BibError(f"invalid field name: {name!r}")
        seen.add(name)
        value = "" if value is None else str(value)
        if not value.strip():
            continue
        p = prev.get(name)
        if p is not None and p.value == value:
            fields.append(Field(name, value, p.raw, p.name_raw))
        else:
            try:
                fields.append(Field(name, value, encode_value(value, db.strings), name))
            except BibError as exc:
                raise BibError(f"{name}: {exc}") from exc
    keep_type_raw = old.type_raw if old and old.type == etype else ""
    return Entry(type=etype, key=key, fields=fields, type_raw=keep_type_raw)


def replace_entry(db: Database, key: str, new: Entry) -> str:
    """The file text with entry ``key`` rewritten (only its span changes)."""
    old = db.find(key)
    if old is None:
        raise BibError(f"no entry {key!r}")
    keep_order = [f.name for f in old.fields]
    names = {f.name for f in new.fields}
    if set(keep_order) & names:
        # keep the file's field order for fields that stay; new ones go after
        idx = {n: i for i, n in enumerate(keep_order)}
        new.fields.sort(key=lambda f: (idx.get(f.name, len(idx)), FIELD_ORDER.index(f.name)
                                       if f.name in FIELD_ORDER else len(FIELD_ORDER)))
        body = format_entry(new, order=False)
    else:
        body = format_entry(new)
    return db.text[:old.start] + body + db.text[old.end:]


def append_entry(db: Database, entry: Entry) -> str:
    text = db.text
    sep = "" if not text.strip() else ("\n" if text.endswith("\n\n") else ("\n\n" if not text.endswith("\n") else "\n"))
    return (text if text.strip() else "") + sep + format_entry(entry) + "\n"


def delete_entry(db: Database, key: str) -> str:
    old = db.find(key)
    if old is None:
        raise BibError(f"no entry {key!r}")
    start, end = old.start, old.end
    text = db.text
    # swallow the blank line the entry leaves behind
    while end < len(text) and text[end] in " \t":
        end += 1
    if end < len(text) and text[end] == "\n":
        end += 1
    if start >= 2 and text[start - 1] == "\n" and text[start - 2] == "\n" and (end >= len(text) or text[end] == "\n"):
        start -= 1
    return text[:start] + text[end:]


# ── LaTeX → plain text (display, keys, comparisons) ────────────────────────
_ACCENTS = {"'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304",
            ".": "\u0307", "u": "\u0306", "v": "\u030c", "H": "\u030b", "c": "\u0327", "k": "\u0328",
            "r": "\u030a", "d": "\u0323", "b": "\u0331"}
_SPECIAL = {"ss": "ß", "ae": "æ", "AE": "Æ", "oe": "œ", "OE": "Œ", "o": "ø", "O": "Ø", "aa": "å",
            "AA": "Å", "l": "ł", "L": "Ł", "i": "ı", "j": "ȷ", "dh": "ð", "DH": "Ð", "th": "þ", "TH": "Þ",
            "&": "&", "%": "%", "$": "$", "_": "_", "#": "#", "{": "{", "}": "}", "textendash": "–",
            "textemdash": "—", "ldots": "…", "dots": "…", "textquoteright": "’", "textquoteleft": "‘",
            "S": "§", "P": "¶", "copyright": "©", "textregistered": "®", "texttrademark": "™"}


def latex_to_text(s: str) -> str:
    """Best-effort LaTeX → Unicode for display: accents, special letters,
    text-style commands, dashes, ties; braces removed. Math is left as is."""
    if not s:
        return ""
    s = re.sub(r"\\([" + re.escape("'`^\"~=.") + r"])\s*\{?\\?([A-Za-z])\}?",
               lambda m: m.group(2) + _ACCENTS[m.group(1)], s)
    s = re.sub(r"\\([uvHckrdb])\s*\{\\?([A-Za-z])\}|\\([uvHckrdb]) ([A-Za-z])",
               lambda m: (m.group(2) or m.group(4)) + _ACCENTS[m.group(1) or m.group(3)], s)
    s = re.sub(r"\\(ss|ae|AE|oe|OE|aa|AA|dh|DH|th|TH|o|O|l|L|i|j|textendash|textemdash|ldots|dots|"
               r"textquoteright|textquoteleft|copyright|textregistered|texttrademark|S|P)(?![A-Za-z])\s?(\{\})?",
               lambda m: _SPECIAL[m.group(1)], s)
    s = re.sub(r"\\([&%$_#{}])", lambda m: _SPECIAL[m.group(1)], s)
    s = re.sub(r"\\(?:textit|textbf|emph|textsc|texttt|textrm|textsf|mbox|text|url|href\{[^}]*\})\s*", "", s)
    s = re.sub(r"\\(?:LaTeXe|LaTeX|TeX|BibTeX)\b", lambda m: m.group(0)[1:], s)
    s = s.replace("---", "—").replace("--", "–").replace("~", " ").replace("``", "“").replace("''", "”")
    s = re.sub(r"(?<!\\)[{}]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return unicodedata.normalize("NFC", s)


def ascii_fold(s: str) -> str:
    s = latex_to_text(s)
    s = s.translate(str.maketrans({"ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ø": "o",
                                   "Ø": "O", "ł": "l", "Ł": "L", "ı": "i", "ð": "d", "þ": "th"}))
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


# ── names ──────────────────────────────────────────────────────────────────
def _split_top(s: str, sep_re: str) -> list[str]:
    """Split ``s`` on a regex separator outside braces."""
    out, depth, last = [], 0, 0
    pat = re.compile(sep_re, re.I)
    i = 0
    while i < len(s):
        c = s[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif depth == 0:
            m = pat.match(s, i)
            if m and m.end() > i:
                out.append(s[last:i])
                last = i = m.end()
                continue
        i += 1
    out.append(s[last:])
    return [p.strip() for p in out if p.strip()]


def split_names(value: str) -> list[str]:
    return _split_top(value, r"\s+and\s+")


def parse_name(name: str) -> dict[str, str]:
    """BibTeX name → {first, von, last, jr}. Handles "First von Last",
    "von Last, First" and "von Last, Jr, First"; {Braced Corporate Names}."""
    parts = _split_top(name, r",")
    def words(s: str) -> list[str]:
        return _split_top(s, r"\s+")
    def is_von(w: str) -> bool:
        t = latex_to_text(w)
        return bool(t) and t[0].islower() and not w.startswith("{")
    if len(parts) >= 2:
        vl = words(parts[0])
        k = 0
        while k < len(vl) - 1 and is_von(vl[k]):
            k += 1
        return {"first": parts[-1], "von": " ".join(vl[:k]), "last": " ".join(vl[k:]),
                "jr": parts[1] if len(parts) == 3 else ""}
    ws = words(name)
    if len(ws) <= 1:
        return {"first": "", "von": "", "last": name.strip(), "jr": ""}
    last_i = len(ws) - 1
    von_i = next((i for i, w in enumerate(ws[:-1]) if is_von(w)), None)
    if von_i is None:
        return {"first": " ".join(ws[:last_i]), "von": "", "last": ws[last_i], "jr": ""}
    j = von_i
    while j < last_i and is_von(ws[j]):
        j += 1
    return {"first": " ".join(ws[:von_i]), "von": " ".join(ws[von_i:j]), "last": " ".join(ws[j:]), "jr": ""}


def last_names(value: str) -> list[str]:
    out = []
    for n in split_names(value):
        if n.lower() == "others":
            out.append("others")
            continue
        p = parse_name(n)
        out.append(latex_to_text(p["last"]))
    return out


def authors_short(value: str) -> str:
    """"Vaswani", "Vaswani and Shazeer", "Vaswani et al."."""
    names = [n for n in last_names(value) if n]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) == 2 and names[1] != "others":
        return f"{names[0]} and {names[1]}"
    return f"{names[0]} et al."


def year_of(e: Entry) -> str:
    y = e.get("year") or e.get("date")
    m = re.search(r"\d{4}", y)
    return m.group(0) if m else ""


_MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
               "October", "November", "December"]


def resolve(value: str, strings: dict[str, str] | None = None) -> str:
    """Editor form with macros expanded (@string values, month names)."""
    def sub(m: re.Match) -> str:
        name = m.group(1).lower()
        if strings and name in strings:
            return strings[name]
        if name in MONTHS:
            return _MONTH_FULL[MONTHS.index(name)]
        return m.group(1)
    return _MACRO_IN_VALUE.sub(sub, value or "")


def display(e: Entry, strings: dict[str, str] | None = None) -> dict[str, str]:
    e = Entry(e.type, e.key, [Field(f.name, resolve(f.value, strings), f.raw) for f in e.fields])
    who = e.get("author") or e.get("editor")
    venue = (e.get("journal") or e.get("journaltitle") or e.get("booktitle") or e.get("publisher")
             or e.get("school") or e.get("institution") or e.get("howpublished")
             or (f"arXiv:{e.get('eprint')}" if e.get("eprint") else ""))
    return {"authors": authors_short(who), "author_list": ", ".join(n for n in last_names(who) if n != "others"),
            "title": latex_to_text(e.get("title")), "year": year_of(e),
            "venue": latex_to_text(venue)}


def links(e: Entry) -> dict[str, str]:
    out = {}
    doi = clean_doi(e.get("doi"))
    if doi:
        out["doi"] = f"https://doi.org/{doi}"
    ax = arxiv_id(e)
    if ax:
        out["arxiv"] = f"https://arxiv.org/abs/{ax}"
    url = e.get("url").strip()
    if url.startswith(("http://", "https://")):
        out["url"] = url
    return out


# ── citation keys ──────────────────────────────────────────────────────────
STOP_WORDS = {"a", "an", "the", "of", "on", "in", "at", "to", "for", "and", "or", "with", "from", "by",
              "is", "are", "as", "via", "towards", "toward", "into", "its", "their", "der", "die", "das",
              "le", "la", "les", "de", "des", "du", "un", "une", "et"}


def _words(title: str) -> list[str]:
    return [w for w in re.findall(r"[A-Za-z0-9]+", ascii_fold(title))]


def _clean_key_part(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", ascii_fold(s))


def _key_field(e: Entry, token: str) -> str:
    who = e.get("author") or e.get("editor")
    lasts = [_clean_key_part(n) for n in last_names(who) if n and n != "others"]
    etal = "others" in last_names(who)
    t = token.lower()
    if t == "auth":
        return lasts[0] if lasts else ""
    if t == "authors":
        return "".join(lasts)
    if t == "authetal":
        if not lasts:
            return ""
        if len(lasts) == 1 and not etal:
            return lasts[0]
        if len(lasts) == 2 and not etal:
            return lasts[0] + "And" + lasts[1]
        return lasts[0] + "EtAl"
    if t == "auth.etal":
        if not lasts:
            return ""
        if len(lasts) == 1 and not etal:
            return lasts[0]
        if len(lasts) == 2 and not etal:
            return lasts[0] + "." + lasts[1]
        return lasts[0] + ".etal"
    if t in ("authors2", "authorsalpha"):
        return "".join(lasts[:2]) + ("EtAl" if len(lasts) > 2 or etal else "")
    if t == "year":
        return year_of(e)
    if t == "shortyear":
        y = year_of(e)
        return y[-2:] if y else ""
    if t in ("veryshorttitle", "shorttitle", "title", "camel"):
        ws = _words(e.get("title"))
        content = [w for w in ws if w.lower() not in STOP_WORDS] or ws
        if t == "veryshorttitle":
            return content[0].capitalize() if content else ""
        if t == "shorttitle":
            return "".join(w.capitalize() for w in content[:3])
        return "".join(w.capitalize() for w in ws)
    if t == "firstpage":
        m = re.match(r"\s*([A-Za-z0-9]+)", e.get("pages"))
        return m.group(1) if m else ""
    if t in ("journal", "booktitle", "venue"):
        v = e.get("journal") or e.get("booktitle")
        return "".join(w[0].upper() for w in _words(v) if w.lower() not in STOP_WORDS)
    if t == "entrytype":
        return e.type.capitalize()
    if t == "eprint":
        return re.sub(r"[^A-Za-z0-9.]", "", e.get("eprint"))
    return ""


def make_key(e: Entry, pattern: str = DEFAULT_KEY_PATTERN) -> str:
    """Expand a JabRef-style pattern: ``[token]`` or ``[token:lower|upper|capitalize]``;
    other text is copied."""
    def sub(m: re.Match) -> str:
        token, _, mod = m.group(1).partition(":")
        val = _key_field(e, token)
        if mod == "lower":
            val = val.lower()
        elif mod == "upper":
            val = val.upper()
        elif mod == "capitalize":
            val = val[:1].upper() + val[1:]
        return val
    key = re.sub(r"\[([^\]]+)\]", sub, pattern or DEFAULT_KEY_PATTERN)
    key = re.sub(r"[^A-Za-z0-9_:./+\-]", "", key)
    return key or "ref"


def unique_key(base: str, taken: Iterable[str]) -> str:
    used = {k.lower() for k in taken}
    if base.lower() not in used:
        return base
    for i in range(26 * 27):
        suffix = chr(97 + i) if i < 26 else chr(96 + i // 26) + chr(97 + i % 26)
        if (base + suffix).lower() not in used:
            return base + suffix
    raise BibError("could not make a unique key")


# ── checks ─────────────────────────────────────────────────────────────────
def clean_doi(s: str) -> str:
    s = (s or "").strip()
    m = DOI_RE.search(s)
    return m.group(1).rstrip(".,;") if m else ""


_ARXIV_NEW = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")
_ARXIV_OLD = re.compile(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?")


def arxiv_id(e: Entry) -> str:
    eprint = e.get("eprint").strip()
    prefix = e.get("archiveprefix").lower() or e.get("eprinttype").lower()
    if eprint and (prefix in ("arxiv", "") and (_ARXIV_NEW.fullmatch(eprint) or _ARXIV_OLD.fullmatch(eprint))):
        return eprint
    for f in ("url", "journal", "note", "howpublished"):
        v = e.get(f)
        m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s}?#]+?)(?:\.pdf)?(?:[?#\s}]|$)", v, re.I) or \
            re.search(r"arXiv[:\s]+(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+/\d{7})", v, re.I)
        if m:
            return m.group(1)
    return ""


def _requirement_met(e: Entry, req: str) -> bool:
    return any(e.has(alt) for alt in req.split("/"))


def entry_problems(e: Entry) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    spec = TYPES.get(e.type)
    if spec is None:
        out.append({"level": "info", "code": "unknown_type", "field": "",
                    "message": f"@{e.type} is not a standard entry type; styles may print it as @misc"})
    else:
        for req in spec["required"]:
            if not _requirement_met(e, req):
                out.append({"level": "error", "code": "missing_required", "field": req.split("/")[0],
                            "message": f"missing required field {req.replace('/', ' or ')}"})
    if e.key and not KEY_OK.match(e.key):
        out.append({"level": "error", "code": "key_chars", "field": "",
                    "message": "the key has characters BibTeX/biber may reject (spaces, braces, commas…)"})
    for f in e.fields:
        if not f.value.strip():
            out.append({"level": "warn", "code": "empty_field", "field": f.name, "message": f"{f.name} is empty"})
    y = e.get("year").strip()
    if y and not re.fullmatch(r"\d{4}", y) and not _MACRO_IN_VALUE.fullmatch(y):
        out.append({"level": "warn", "code": "year_format", "field": "year",
                    "message": f"year should be four digits (got “{y}”)"})
    pages = e.get("pages")
    if re.search(r"\d\s*(?:-|–|—)\s*\d", pages) and "--" not in pages:
        out.append({"level": "warn", "code": "page_range", "field": "pages", "fix": "pages",
                    "message": "page ranges use a double hyphen (12--15)"})
    doi = e.get("doi").strip()
    if doi and (doi != clean_doi(doi) or not clean_doi(doi)):
        out.append({"level": "warn", "code": "doi_format", "field": "doi", "fix": "doi",
                    "message": "doi should be the bare identifier (10.xxxx/…)" if clean_doi(doi)
                    else "doi doesn't look like a DOI"})
    if not doi and clean_doi(e.get("url")) and "doi.org" in e.get("url"):
        out.append({"level": "info", "code": "doi_in_url", "field": "url", "fix": "doi",
                    "message": "the url is a DOI link — it belongs in the doi field"})
    month = e.get("month").strip()
    if month and not _MACRO_IN_VALUE.fullmatch(month) and (month.isdigit() or month.lower() in MONTH_NAMES):
        out.append({"level": "info", "code": "month_format", "field": "month", "fix": "month",
                    "message": "use a month macro (jan, feb, …) so styles can format it"})
    if arxiv_id(e) and not e.get("eprint"):
        out.append({"level": "info", "code": "arxiv_fields", "field": "eprint", "fix": "arxiv",
                    "message": "an arXiv id is in the entry but not in eprint / archiveprefix"})
    title = e.get("title")
    if _unprotected_acronyms(title):
        out.append({"level": "info", "code": "acronyms", "field": "title", "fix": "acronyms",
                    "message": "acronyms in the title aren't in braces, so styles may lowercase them: "
                               + ", ".join(_unprotected_acronyms(title)[:4])})
    return out


def _unprotected_acronyms(title: str) -> list[str]:
    found = []
    depth = 0
    for m in re.finditer(r"[{}]|\\[A-Za-z]+|[A-Za-z0-9\-]+", title):
        tok = m.group(0)
        if tok == "{":
            depth += 1
        elif tok == "}":
            depth -= 1
        elif depth == 0 and not tok.startswith("\\") and _is_acronym(tok):
            found.append(tok)
    return found


def _is_acronym(w: str) -> bool:
    letters = [c for c in w if c.isalpha()]
    if len(letters) < 2:
        return False
    uppers = sum(c.isupper() for c in letters)
    # BERT, GPT-3, ResNet, iPhone: capitals after the first letter
    return uppers >= 2 and (uppers == len(letters) or any(c.isupper() for c in w[1:]))


def database_problems(db: Database) -> list[dict[str, Any]]:
    out = [{"level": "error", "code": "parse", "line": e["line"], "key": "", "message": e["message"]}
           for e in db.errors]
    seen: dict[str, int] = {}
    for e in db.entries:
        k = e.key.lower()
        if k in seen:
            out.append({"level": "error", "code": "duplicate_key", "line": e.line, "key": e.key,
                        "message": f"the key {e.key} is used twice (lines {seen[k]} and {e.line})"})
        else:
            seen[k] = e.line
    return out


# ── cleanup ────────────────────────────────────────────────────────────────
CLEANUPS = {
    "pages": "Page ranges: 12-15 → 12--15",
    "doi": "DOI: bare identifier; a doi.org url moves to doi",
    "month": "Months: 3, March → mar",
    "arxiv": "arXiv: eprint, archiveprefix and primaryclass from the url or journal",
    "whitespace": "Trim and collapse spaces; drop empty fields",
    "acronyms": "Protect acronyms in the title with braces: BERT → {BERT}",
}


def cleanup_values(e: Entry, actions: Iterable[str]) -> dict[str, str]:
    """The entry's editor values after the cleanup ``actions``."""
    v = e.as_dict()
    acts = set(actions)
    if "whitespace" in acts:
        for k in list(v):
            if k == "abstract":
                v[k] = v[k].strip()
            else:
                v[k] = re.sub(r"\s+", " ", v[k]).strip()
            if not v[k]:
                del v[k]
    if "pages" in acts and v.get("pages"):
        v["pages"] = re.sub(r"(\w)\s*(?:–|—|-{1,3})\s*(\w)", r"\1--\2", v["pages"])
    if "doi" in acts:
        if v.get("doi"):
            d = clean_doi(v["doi"])
            if d:
                v["doi"] = d
        elif v.get("url") and "doi.org" in v["url"] and clean_doi(v["url"]):
            v["doi"] = clean_doi(v.pop("url"))
    if "month" in acts and v.get("month"):
        m = v["month"].strip().lower().rstrip(".")
        if m.isdigit() and 1 <= int(m) <= 12:
            v["month"] = f"#{MONTHS[int(m) - 1]}#"
        elif m in MONTH_NAMES:
            v["month"] = f"#{MONTHS[MONTH_NAMES[m] - 1]}#"
        elif m[:3] in MONTHS and len(m) <= 4:
            v["month"] = f"#{m[:3]}#"
    if "arxiv" in acts:
        ax = arxiv_id(e)
        if ax and not v.get("eprint"):
            v["eprint"] = re.sub(r"v\d+$", "", ax)
            v["archiveprefix"] = "arXiv"
            j = v.get("journal", "")
            if re.fullmatch(r"\s*arXiv(?: preprint)?(?: arXiv)?[:\s]*[\w./\-]+\s*", j, re.I):
                del v["journal"]
    if "acronyms" in acts and v.get("title"):
        v["title"] = protect_acronyms(v["title"])
    return v


def protect_acronyms(title: str) -> str:
    out, depth, pos = [], 0, 0
    for m in re.finditer(r"[{}]|\\[A-Za-z]+|[A-Za-z0-9\-]+", title):
        tok = m.group(0)
        if tok == "{":
            depth += 1
        elif tok == "}":
            depth -= 1
        elif depth == 0 and not tok.startswith("\\") and _is_acronym(tok):
            out.append(title[pos:m.start()] + "{" + tok + "}")
            pos = m.end()
    out.append(title[pos:])
    return "".join(out)


# ── duplicates ─────────────────────────────────────────────────────────────
def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", ascii_fold(t).lower()).strip()


def is_duplicate(a: dict[str, str], b: dict[str, str]) -> str:
    """Why two entries (editor values) look like the same work, or ''."""
    da, db_ = clean_doi(a.get("doi", "")).lower(), clean_doi(b.get("doi", "")).lower()
    if da and db_:
        return "same DOI" if da == db_ else ""
    ea = re.sub(r"v\d+$", "", a.get("eprint", "").strip().lower())
    eb = re.sub(r"v\d+$", "", b.get("eprint", "").strip().lower())
    if ea and eb and ea == eb:
        return "same arXiv id"
    ta, tb = norm_title(a.get("title", "")), norm_title(b.get("title", ""))
    if not ta or not tb or min(len(ta), len(tb)) < 12:
        return ""
    ya = re.search(r"\d{4}", a.get("year", "") or a.get("date", ""))
    yb = re.search(r"\d{4}", b.get("year", "") or b.get("date", ""))
    if ya and yb and abs(int(ya.group(0)) - int(yb.group(0))) > 1:
        return ""
    if ta == tb:
        return "same title"
    if difflib.SequenceMatcher(None, ta, tb).ratio() >= 0.93:
        return "nearly the same title"
    return ""


def find_duplicates(db: Database) -> list[dict[str, Any]]:
    entries = db.entries
    vals = [e.as_dict() for e in entries]
    groups: list[dict[str, Any]] = []
    used: set[int] = set()
    for i in range(len(entries)):
        if i in used:
            continue
        group, why = [i], ""
        for j in range(i + 1, len(entries)):
            if j in used:
                continue
            r = is_duplicate(vals[i], vals[j])
            if r:
                group.append(j)
                why = why or r
        if len(group) > 1:
            used.update(group)
            groups.append({"keys": [entries[k].key for k in group], "reason": why})
    return groups


def merge_values(base: dict[str, str], other: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Fill ``base``'s missing fields from ``other``; return (merged, conflicting field names)."""
    merged = dict(base)
    conflicts = []
    for k, v in other.items():
        if not v.strip():
            continue
        if not merged.get(k, "").strip():
            merged[k] = v
        elif norm_title(merged[k]) != norm_title(v):
            conflicts.append(k)
    return merged, conflicts


# ── citations in LaTeX sources ─────────────────────────────────────────────
CITE_RE = re.compile(r"\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}")


def _strip_comments(src: str) -> str:
    return re.sub(r"(?<!\\)%.*", lambda m: " " * len(m.group(0)), src)


def citations(files: dict[str, str]) -> dict[str, list[dict[str, Any]]]:
    """key → [{file, line}] for every \\cite-family command in .tex files."""
    out: dict[str, list[dict[str, Any]]] = {}
    for path, src in files.items():
        if not path.lower().endswith((".tex", ".ltx")):
            continue
        clean = _strip_comments(src)
        for m in CITE_RE.finditer(clean):
            line = clean.count("\n", 0, m.start()) + 1
            for key in m.group(1).split(","):
                key = key.strip()
                if key and key != "*":
                    out.setdefault(key, []).append({"file": path, "line": line})
    return out


def rename_citations(src: str, old: str, new: str) -> tuple[str, int]:
    """Replace citation key ``old`` by ``new`` inside \\cite-family commands."""
    count = 0
    mask = _strip_comments(src)

    def fix(m: re.Match) -> str:
        nonlocal count
        if mask[m.start()] == " " and src[m.start()] != " ":   # inside a comment
            return m.group(0)
        whole = m.group(0)
        brace = whole.rfind("{")
        keys = whole[brace + 1:-1].split(",")
        changed = False
        for i, k in enumerate(keys):
            if k.strip() == old:
                keys[i] = k.replace(old, new)
                changed = True
                count += 1
        return whole[:brace + 1] + ",".join(keys) + "}" if changed else whole
    return CITE_RE.sub(fix, src), count


def bib_resources(files: dict[str, str]) -> list[str]:
    """.bib files named by \\bibliography / \\addbibresource (resolved to project paths)."""
    names: list[str] = []
    for path, src in files.items():
        if not path.lower().endswith(".tex"):
            continue
        clean = _strip_comments(src)
        for m in re.finditer(r"\\(?:bibliography|addbibresource|addglobalbib)\s*(?:\[[^\]]*\])?\{([^}]*)\}", clean):
            for n in m.group(1).split(","):
                n = n.strip()
                if n:
                    names.append(n if n.lower().endswith(".bib") else n + ".bib")
    paths = [p for p in files if p.lower().endswith(".bib")]
    out = []
    for n in names:
        hit = next((p for p in paths if p == n or p.endswith("/" + n) or p.split("/")[-1] == n.split("/")[-1]), None)
        if hit and hit not in out:
            out.append(hit)
    return out


# ── API shapes ─────────────────────────────────────────────────────────────
def entry_public(e: Entry, text: str = "", cited: dict[str, list] | None = None,
                 strings: dict[str, str] | None = None) -> dict[str, Any]:
    uses = (cited or {}).get(e.key, [])
    return {
        "key": e.key, "type": e.type, "line": e.line,
        "fields": [{"name": f.name, "value": f.value} for f in e.fields],
        "display": display(e, strings), "links": links(e),
        "problems": entry_problems(e), "cited": len(uses),
        "source": text[e.start:e.end] if text and e.start >= 0 else format_entry(e, order=False),
    }


def type_specs() -> dict[str, Any]:
    return {t: {"required": s["required"], "optional": s["optional"]} for t, s in TYPES.items()}
