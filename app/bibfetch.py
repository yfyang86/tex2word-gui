"""Online bibliographic lookups for the reference manager (all optional).

Like JabRef's "web search" and "new entry from identifier":

- **Identifiers**: a DOI (Crossref, falling back to doi.org content
  negotiation for DataCite and others), an arXiv id (arXiv API) or an ISBN
  (Open Library).
- **Search** by free text in arXiv, Crossref, DBLP, Semantic Scholar and
  OpenAlex.
- **Google Scholar** has no public API and blocks automated requests, so it
  is offered as a link: search there, then paste its "Cite → BibTeX" text.

Every result is a *candidate*: ``{source, type, fields: {name: value}, title,
authors, year, venue, doi, arxiv, url}`` with BibTeX field values in the
editor form used by :mod:`app.bibtex`.

The server makes the requests (the services don't allow browser CORS
everywhere, and keys stay server-side). ``[bibliography]`` in config.toml
turns lookups off or limits the sources.
"""

from __future__ import annotations

import html
import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Callable

from . import bibtex

SOURCES: dict[str, dict[str, Any]] = {
    "crossref": {"label": "Crossref", "search": True, "about": "DOIs for journals, conferences and books",
                 "home": "https://search.crossref.org/?q={q}"},
    "arxiv": {"label": "arXiv", "search": True, "about": "Preprints in physics, maths, CS, …",
              "home": "https://arxiv.org/a/search?query={q}"},
    "dblp": {"label": "DBLP", "search": True, "about": "Computer science venues",
             "home": "https://dblp.org/search?q={q}"},
    "semanticscholar": {"label": "Semantic Scholar", "search": True, "about": "All fields (rate-limited without a key)",
                        "home": "https://www.semanticscholar.org/search?q={q}"},
    "openalex": {"label": "OpenAlex", "search": True, "about": "All fields (rate-limited without a key)",
                 "home": "https://openalex.org/works?search={q}"},
    "openlibrary": {"label": "Open Library", "search": False, "about": "Books by ISBN",
                    "home": "https://openlibrary.org/search?q={q}"},
}
SCHOLAR = {"label": "Google Scholar", "url": "https://scholar.google.com/scholar?q={q}",
           "note": "No public API — search there, click Cite → BibTeX and paste the result."}

USER_AGENT = "TexWordStudio/0.3 (reference manager; https://github.com/yfyang86/tex2word-gui)"


class FetchError(Exception):
    """A lookup failed (network, rate limit, nothing found)."""


HttpGet = Callable[[str, dict[str, str], float], tuple[int, str]]


def _http_get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https hosts
            return resp.status, resp.read(4 * 1024 * 1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read(64 * 1024).decode("utf-8", "replace") if exc.fp else ""
        return exc.code, body
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, http.client.HTTPException) as exc:
        raise FetchError(f"could not reach {urllib.parse.urlsplit(url).netloc}: "
                         f"{getattr(exc, 'reason', exc)}") from exc


# ── identifiers ────────────────────────────────────────────────────────────
ARXIV_ID = re.compile(r"(?:arxiv[:\s/]*|arxiv\.org/(?:abs|pdf)/)?"
                      r"\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?)\b", re.I)


def _isbn_ok(digits: str) -> bool:
    if len(digits) == 10:
        total = sum((10 - i) * (10 if c in "Xx" else int(c)) for i, c in enumerate(digits))
        return total % 11 == 0
    if len(digits) == 13 and digits.isdigit():
        total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(digits))
        return total % 10 == 0
    return False


def identify(text: str) -> dict[str, str] | None:
    """The identifier in ``text`` (DOI, arXiv id or ISBN), or None for a free-text query."""
    t = (text or "").strip()
    if not t:
        return None
    doi = bibtex.clean_doi(t)
    if doi and (t.lower().startswith(("10.", "doi:", "https://doi.org", "http://doi.org", "https://dx.doi.org"))
                or len(t) <= len(doi) + 12):
        return {"kind": "doi", "id": doi}
    m = ARXIV_ID.search(t)
    if m and (len(t) <= len(m.group(0)) + 8 or "arxiv" in t.lower()):
        return {"kind": "arxiv", "id": m.group(1)}
    digits = re.sub(r"(?i)^isbn[:\s]*|[\s\-]", "", t)
    if re.fullmatch(r"\d{9}[\dXx]|\d{13}", digits) and _isbn_ok(digits):
        return {"kind": "isbn", "id": digits.upper()}
    return None


# ── helpers ────────────────────────────────────────────────────────────────
_PARTICLES = {"van", "von", "der", "den", "de", "del", "della", "di", "da", "dos", "du", "la", "le", "ter", "ten", "zu"}


def bib_name(full: str) -> str:
    """"Ashish Vaswani" → "Vaswani, Ashish"; "Jan van der Berg" → "van der Berg, Jan"."""
    full = re.sub(r"\s+\d{4}$", "", (full or "").strip())        # DBLP homonym numbers
    full = re.sub(r"\s+", " ", full)
    if not full or "," in full:
        return full
    words = full.split(" ")
    if len(words) == 1:
        return full
    i = len(words) - 1
    while i > 1 and words[i - 1].lower() in _PARTICLES:
        i -= 1
    return f"{' '.join(words[i:])}, {' '.join(words[:i])}"


def _join_authors(names: list[str]) -> str:
    return " and ".join(bib_name(n) for n in names if n and n.strip())


def _plain(s: Any) -> str:
    s = html.unescape(str(s or ""))
    s = re.sub(r"<[^>]+>", "", s)            # Crossref <i>, <sub>, JATS tags
    return re.sub(r"\s+", " ", s).strip()


def _tex_escape(s: str) -> str:
    """Make plain text safe as a BibTeX value: balance braces, escape specials."""
    s = re.sub(r"(?<!\\)([&%#])", r"\\\1", s)
    try:
        bibtex.check_braces(s)
    except bibtex.BibError:
        s = s.replace("{", "").replace("}", "")
    return s


def _pages(s: Any) -> str:
    return re.sub(r"\s*[-–—]+\s*", "--", str(s or "").strip())


def candidate(source: str, etype: str, fields: dict[str, Any], source_id: str = "") -> dict[str, Any]:
    vals = {k: _tex_escape(_plain(v)) if k not in ("url", "doi", "month", "eprint") else str(v).strip()
            for k, v in fields.items() if v not in (None, "", [])}
    entry = bibtex.Entry(etype, "", [bibtex.Field(k, v, "") for k, v in vals.items()])
    d = bibtex.display(entry)
    return {
        "source": source, "source_id": source_id, "type": etype, "fields": vals,
        "title": d["title"], "authors": d["authors"], "author_list": d["author_list"],
        "year": d["year"], "venue": d["venue"],
        "doi": bibtex.clean_doi(vals.get("doi", "")), "arxiv": bibtex.arxiv_id(entry),
        "url": vals.get("url", ""),
    }


# ── parsers (pure: text in, candidates out) ────────────────────────────────
CROSSREF_TYPES = {"journal-article": "article", "proceedings-article": "inproceedings",
                  "book-chapter": "incollection", "book-part": "incollection", "book-section": "incollection",
                  "book": "book", "monograph": "book", "edited-book": "book", "reference-book": "book",
                  "dissertation": "phdthesis", "report": "techreport", "dataset": "dataset",
                  "posted-content": "misc", "proceedings": "proceedings", "standard": "manual"}


def parse_crossref_work(w: dict[str, Any]) -> dict[str, Any]:
    etype = CROSSREF_TYPES.get(w.get("type", ""), "misc")
    names = []
    for a in w.get("author") or []:
        if a.get("family"):
            names.append(f"{a['family']}, {a.get('given', '')}".strip().rstrip(","))
        elif a.get("name"):
            names.append("{" + a["name"] + "}")
    editors = [f"{a['family']}, {a.get('given', '')}".strip().rstrip(",")
               for a in (w.get("editor") or []) if a.get("family")]
    date = (w.get("issued") or w.get("published") or w.get("published-print") or {}).get("date-parts") or [[None]]
    year = date[0][0] if date and date[0] else None
    month = date[0][1] if date and date[0] and len(date[0]) > 1 else None
    container = (w.get("container-title") or [""])[0]
    title = (w.get("title") or [""])[0]
    sub = (w.get("subtitle") or [""])
    if sub and sub[0] and sub[0].lower() not in title.lower():
        title = f"{title}: {sub[0]}"
    f: dict[str, Any] = {
        "author": " and ".join(names), "editor": " and ".join(editors) if etype in ("book", "proceedings", "incollection") else "",
        "title": title, "year": year,
        "month": f"#{bibtex.MONTHS[month - 1]}#" if isinstance(month, int) and 1 <= month <= 12 else "",
        "volume": w.get("volume"), "number": w.get("issue"), "pages": _pages(w.get("page")),
        "publisher": w.get("publisher") if etype in ("book", "incollection", "inproceedings", "proceedings",
                                                     "techreport", "misc", "dataset") else "",
        "doi": w.get("DOI"),
    }
    if etype == "article":
        f["journal"] = container
        f["issn"] = (w.get("ISSN") or [""])[0]
    elif etype in ("inproceedings", "incollection"):
        f["booktitle"] = container
    elif etype == "phdthesis":
        f["school"] = (w.get("institution") or [{}])[0].get("name", "") if w.get("institution") else w.get("publisher")
    elif etype == "techreport":
        f["institution"] = w.get("publisher")
    if etype in ("book", "incollection"):
        f["isbn"] = (w.get("ISBN") or [""])[0]
    return candidate("crossref", etype, f, w.get("DOI", ""))


def parse_crossref(text: str) -> list[dict[str, Any]]:
    data = json.loads(text).get("message") or {}
    items = data.get("items") if "items" in data else [data]
    return [parse_crossref_work(w) for w in items if w]


_ATOM = {"a": "http://www.w3.org/2005/Atom", "ax": "http://arxiv.org/schemas/atom",
         "os": "http://a9.com/-/spec/opensearch/1.1/"}


def parse_arxiv(text: str) -> list[dict[str, Any]]:
    root = ET.fromstring(text)
    out = []
    for e in root.findall("a:entry", _ATOM):
        raw_id = (e.findtext("a:id", "", _ATOM) or "").strip()
        m = re.search(r"arxiv\.org/abs/(.+?)$", raw_id)
        if not m:
            continue              # the API's error entries have no abs/ id
        full = m.group(1)
        aid = re.sub(r"v\d+$", "", full)
        title = re.sub(r"\s+", " ", e.findtext("a:title", "", _ATOM)).strip()
        names = [n.findtext("a:name", "", _ATOM) for n in e.findall("a:author", _ATOM)]
        published = e.findtext("a:published", "", _ATOM)
        prim = e.find("ax:primary_category", _ATOM)
        doi = e.findtext("ax:doi", "", _ATOM)
        jref = e.findtext("ax:journal_ref", "", _ATOM)
        f = {"author": _join_authors(names), "title": title, "year": published[:4],
             "month": f"#{bibtex.MONTHS[int(published[5:7]) - 1]}#" if len(published) >= 7 else "",
             "eprint": aid, "archiveprefix": "arXiv",
             "primaryclass": prim.get("term") if prim is not None else "",
             "doi": doi, "note": re.sub(r"\s+", " ", jref).strip() if jref else "",
             "url": f"https://arxiv.org/abs/{aid}",
             "abstract": re.sub(r"\s+", " ", e.findtext("a:summary", "", _ATOM)).strip()}
        out.append(candidate("arxiv", "misc", f, full))
    return out


DBLP_TYPES = {"Journal Articles": "article", "Conference and Workshop Papers": "inproceedings",
              "Books and Theses": "book", "Parts in Books or Collections": "incollection",
              "Editorship": "proceedings", "Informal and Other Publications": "misc",
              "Informal Publications": "misc", "Data and Artifacts": "dataset", "Reference Works": "incollection"}


def parse_dblp(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    hits = ((data.get("result") or {}).get("hits") or {}).get("hit") or []
    out = []
    for h in hits:
        info = h.get("info") or {}
        authors = (info.get("authors") or {}).get("author") or []
        if isinstance(authors, dict):
            authors = [authors]
        names = [a.get("text", "") if isinstance(a, dict) else str(a) for a in authors]
        etype = DBLP_TYPES.get(info.get("type", ""), "misc")
        venue = info.get("venue", "")
        if isinstance(venue, list):
            venue = venue[0] if venue else ""
        title = str(info.get("title", "")).rstrip(".")
        f: dict[str, Any] = {"author": _join_authors(names), "title": title, "year": info.get("year"),
                             "volume": info.get("volume"), "number": info.get("number"),
                             "pages": _pages(info.get("pages")), "doi": info.get("doi"),
                             "url": info.get("ee") if not info.get("doi") else ""}
        if etype == "article":
            f["journal"] = venue
        elif etype in ("inproceedings", "incollection"):
            f["booktitle"] = venue
        elif etype == "misc" and venue == "CoRR":
            m = re.search(r"abs/(\d{4}\.\d{4,5})", str(info.get("ee", "")) + " " + str(info.get("volume", "")))
            if m:
                f.update(eprint=m.group(1), archiveprefix="arXiv", volume="", url="")
            else:
                f["howpublished"] = "CoRR"
        out.append(candidate("dblp", etype, f, info.get("key", "")))
    return out


S2_PRIORITY = ["Conference", "JournalArticle", "BookSection", "Book", "Dataset", "Review"]
S2_TYPES = {"JournalArticle": "article", "Conference": "inproceedings", "Book": "book",
            "BookSection": "incollection", "Review": "article", "Dataset": "dataset"}


def parse_semanticscholar(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    out = []
    for p in data.get("data") or []:
        ext = p.get("externalIds") or {}
        types = p.get("publicationTypes") or []
        etype = next((S2_TYPES[t] for t in S2_PRIORITY if t in types), "misc")
        journal = p.get("journal") or {}
        venue = journal.get("name") or p.get("venue") or ""
        f: dict[str, Any] = {"author": _join_authors([a.get("name", "") for a in p.get("authors") or []]),
                             "title": p.get("title"), "year": p.get("year"),
                             "volume": journal.get("volume"), "pages": _pages(journal.get("pages")),
                             "doi": ext.get("DOI"),
                             "url": p.get("url") if not (ext.get("DOI") or ext.get("ArXiv")) else ""}
        if etype == "article":
            f["journal"] = venue
        elif etype in ("inproceedings", "incollection"):
            f["booktitle"] = venue
        if ext.get("ArXiv") and not ext.get("DOI"):
            f.update(eprint=ext["ArXiv"], archiveprefix="arXiv")
        out.append(candidate("semanticscholar", etype, f, p.get("paperId", "")))
    return out


OPENALEX_TYPES = {"article": "article", "book-chapter": "incollection", "book": "book", "dissertation": "phdthesis",
                  "dataset": "dataset", "preprint": "misc", "report": "techreport", "proceedings-article": "inproceedings",
                  "review": "article", "editorial": "article", "letter": "article", "standard": "manual"}


def parse_openalex(text: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    out = []
    for w in data.get("results") or []:
        loc = w.get("primary_location") or {}
        src = loc.get("source") or {}
        stype = src.get("type", "")
        etype = OPENALEX_TYPES.get(w.get("type", ""), "misc")
        if etype == "article" and stype == "conference":
            etype = "inproceedings"
        bib = w.get("biblio") or {}
        pages = f"{bib.get('first_page') or ''}--{bib.get('last_page')}" if bib.get("last_page") else (bib.get("first_page") or "")
        doi = bibtex.clean_doi(w.get("doi") or "")
        f: dict[str, Any] = {"author": _join_authors([(a.get("author") or {}).get("display_name", "")
                                                      for a in w.get("authorships") or []]),
                             "title": w.get("title") or w.get("display_name"), "year": w.get("publication_year"),
                             "volume": bib.get("volume"), "number": bib.get("issue"), "pages": _pages(pages),
                             "doi": doi, "url": loc.get("landing_page_url") if not doi else ""}
        venue = src.get("display_name", "")
        if etype == "article":
            f["journal"] = venue
        elif etype in ("inproceedings", "incollection"):
            f["booktitle"] = venue
        elif etype == "misc" and venue:
            f["howpublished"] = venue
            ax = re.search(r"arxiv\.org/abs/(\d{4}\.\d{4,5})", str(loc.get("landing_page_url", "")))
            if ax:
                f.update(eprint=ax.group(1), archiveprefix="arXiv", howpublished="", url="")
        out.append(candidate("openalex", etype, f, str(w.get("id", "")).rsplit("/", 1)[-1]))
    return out


def parse_openlibrary(text: str, isbn: str) -> list[dict[str, Any]]:
    data = json.loads(text)
    book = data.get(f"ISBN:{isbn}")
    if not book:
        return []
    year = re.search(r"\d{4}", str(book.get("publish_date", "")))
    f = {"author": _join_authors([a.get("name", "") for a in book.get("authors") or []]),
         "title": book.get("title") + (f": {book['subtitle']}" if book.get("subtitle") else ""),
         "publisher": ", ".join(p.get("name", "") for p in book.get("publishers") or []),
         "address": ", ".join(p.get("name", "") for p in book.get("publish_places") or []),
         "year": year.group(0) if year else "", "isbn": isbn, "url": book.get("url")}
    return [candidate("openlibrary", "book", f, isbn)]


def parse_bibtex_candidates(text: str, source: str) -> list[dict[str, Any]]:
    db = bibtex.parse(text)
    out = []
    for e in db.entries:
        vals = {f.name: bibtex.resolve(f.value, db.strings) if f.value.startswith("#") and f.value.endswith("#")
                and f.name != "month" else f.value for f in e.fields}
        c = candidate(source, e.type, {}, e.key)
        c["fields"] = vals
        d = bibtex.display(bibtex.Entry(e.type, e.key, [bibtex.Field(k, v, "") for k, v in vals.items()]))
        c.update(title=d["title"], authors=d["authors"], author_list=d["author_list"], year=d["year"],
                 venue=d["venue"], doi=bibtex.clean_doi(vals.get("doi", "")), url=vals.get("url", ""))
        out.append(c)
    return out


# ── the fetcher ────────────────────────────────────────────────────────────
class Fetcher:
    def __init__(self, cfg: Any, http: HttpGet | None = None) -> None:
        self.cfg = cfg
        self.http = http or _http_get
        self._cache: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    # configuration
    def enabled(self, source: str | None = None) -> bool:
        if not self.cfg.online:
            return False
        return source is None or source in self.cfg.sources

    def public(self) -> dict[str, Any]:
        return {
            "online": bool(self.cfg.online),
            "sources": [{"id": k, **v, "enabled": self.enabled(k)} for k, v in SOURCES.items()],
            "scholar": SCHOLAR,
        }

    # plumbing
    def _headers(self, accept: str = "application/json") -> dict[str, str]:
        ua = USER_AGENT + (f" mailto:{self.cfg.contact_email}" if self.cfg.contact_email else "")
        return {"User-Agent": ua, "Accept": accept}

    def _get(self, url: str, accept: str = "application/json", headers: dict[str, str] | None = None) -> str:
        key = f"{accept}|{url}"
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < 3600:
                return hit[1]
        h = self._headers(accept)
        h.update(headers or {})
        status, body = self.http(url, h, float(self.cfg.timeout_s))
        host = urllib.parse.urlsplit(url).netloc
        if status == 429:
            raise FetchError(f"{host} is rate-limiting requests — try again later"
                             + (" or add an API key in config.toml [bibliography]" if "semanticscholar" in host
                                or "openalex" in host else ""))
        if status == 404:
            raise FetchError("not found")
        if status >= 400:
            raise FetchError(f"{host} answered {status}")
        if body.lstrip().lower().startswith(("<!doctype html", "<html")) and "json" in accept:
            raise FetchError(f"{host} returned a web page instead of data (it may be blocking automated requests)")
        with self._lock:
            if len(self._cache) > 256:
                self._cache.clear()
            self._cache[key] = (now, body)
        return body

    def _need(self, source: str) -> None:
        if not self.cfg.online:
            raise FetchError("online lookups are turned off ([bibliography] online = false)")
        if source not in self.cfg.sources:
            raise FetchError(f"{SOURCES.get(source, {}).get('label', source)} is not enabled")

    # identifiers
    def lookup(self, text: str) -> list[dict[str, Any]]:
        ident = identify(text)
        if ident is None:
            raise FetchError("no DOI, arXiv id or ISBN found")
        kind, value = ident["kind"], ident["id"]
        if kind == "doi":
            return self.by_doi(value)
        if kind == "arxiv":
            return self.by_arxiv(value)
        return self.by_isbn(value)

    def by_doi(self, doi: str) -> list[dict[str, Any]]:
        self._need("crossref")
        q = urllib.parse.quote(doi, safe="/")
        try:
            return parse_crossref(self._get(f"https://api.crossref.org/works/{q}"))
        except FetchError as exc:
            if str(exc) != "not found":
                raise
        # not a Crossref DOI (DataCite, mEDRA, …): ask doi.org for BibTeX
        text = self._get(f"https://doi.org/{q}", accept="application/x-bibtex")
        found = parse_bibtex_candidates(text, "doi.org")
        if not found:
            raise FetchError(f"no record for DOI {doi}")
        return found

    def by_arxiv(self, aid: str) -> list[dict[str, Any]]:
        self._need("arxiv")
        text = self._get("https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(aid, safe="/.")
                         , accept="application/atom+xml")
        found = parse_arxiv(text)
        if not found:
            raise FetchError(f"no arXiv paper {aid}")
        return found

    def by_isbn(self, isbn: str) -> list[dict[str, Any]]:
        self._need("openlibrary")
        text = self._get(f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data")
        found = parse_openlibrary(text, isbn)
        if not found:
            raise FetchError(f"no book with ISBN {isbn} in Open Library")
        return found

    # search
    def search(self, source: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
        if source not in SOURCES or not SOURCES[source]["search"]:
            raise FetchError(f"{source} can't be searched")
        self._need(source)
        q = re.sub(r"\s+", " ", query or "").strip()
        if len(q) < 2:
            raise FetchError("type a few words to search")
        limit = max(1, min(int(limit or 10), 25))
        enc = urllib.parse.quote
        if source == "crossref":
            mail = f"&mailto={enc(self.cfg.contact_email)}" if self.cfg.contact_email else ""
            return parse_crossref(self._get(f"https://api.crossref.org/works?query.bibliographic={enc(q)}"
                                            f"&rows={limit}{mail}"))
        if source == "arxiv":
            # the title phrase ranks best; arXiv ANDs stop words literally, so
            # the fallback searches the content words only
            base = "https://export.arxiv.org/api/query?sortBy=relevance&max_results=" + str(limit) + "&search_query="
            phrase = q.replace('"', "")
            found = parse_arxiv(self._get(base + "ti:" + enc(f'"{phrase}"'), accept="application/atom+xml"))
            if found:
                return found
            words = [w for w in re.findall(r"[\w.-]+", phrase) if w.lower() not in bibtex.STOP_WORDS][:10]
            if not words:
                return []
            return parse_arxiv(self._get(base + "+AND+".join(f"all:{enc(w)}" for w in words),
                                         accept="application/atom+xml"))
        if source == "dblp":
            return parse_dblp(self._get(f"https://dblp.org/search/publ/api?q={enc(q)}&format=json&h={limit}"))
        if source == "semanticscholar":
            key = self.cfg.api_key("semanticscholar")
            fields = "title,authors,year,venue,externalIds,url,publicationTypes,journal"
            return parse_semanticscholar(self._get(
                f"https://api.semanticscholar.org/graph/v1/paper/search?query={enc(q)}&limit={limit}&fields={fields}",
                headers={"x-api-key": key} if key else None))
        if source == "openalex":
            key = self.cfg.api_key("openalex")
            extra = (f"&mailto={enc(self.cfg.contact_email)}" if self.cfg.contact_email else "") + \
                (f"&api_key={enc(key)}" if key else "")
            return parse_openalex(self._get(f"https://api.openalex.org/works?search={enc(q)}&per-page={limit}{extra}"))
        raise FetchError(f"unknown source {source}")
