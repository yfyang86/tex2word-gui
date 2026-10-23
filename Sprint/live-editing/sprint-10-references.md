# Sprint 10 — Reference manager (BibTeX)

## Goal

Manage a project's BibTeX references inside the editor, the way JabRef does
for a `.bib` file:

- see, search and cite the entries;
- edit them with fields per entry type;
- add new ones from an identifier or an online search;
- keep the file clean: integrity checks, cleanup, citation keys, duplicates.

Online sources are public and optional.

## What JabRef does, and what we took

| JabRef | Here |
| --- | --- |
| Entry table with search, sorting, groups | Table with JabRef-style search (`author:knuth year:1984 "exact words"`), sortable columns, filters: cited / not cited / problems / missing |
| Entry editor: required / optional fields per type, BibTeX source tab | The same, plus a BibTeX tab that rewrites only that entry |
| New entry from DOI, arXiv id, ISBN | Crossref (DOI; doi.org content negotiation for DataCite and others), arXiv API, Open Library |
| Web search (arXiv, Crossref, DBLP, Semantic Scholar, …) | arXiv, Crossref, DBLP, Semantic Scholar, OpenAlex |
| Google Scholar fetcher | **Not automated.** Scholar has no API and blocks scripted requests (we checked: it redirects to a bot check), so it's a link-out. Copy Scholar's Cite → BibTeX and use **Paste BibTeX**. |
| Citation key patterns `[auth][year]` | Same syntax: `auth`, `authors`, `authEtAl`, `auth.etal`, `authors2`, `year`, `shortyear`, `veryshorttitle`, `shorttitle`, `title`, `firstpage`, `journal`, `entrytype`, `eprint`, with `:lower`, `:upper` or `:capitalize`; clashes get `a`, `b`, … |
| Integrity checks | Missing required fields, key characters, year, page ranges, DOI form, duplicate keys, month macros, arXiv fields, unprotected acronyms, parse errors with line numbers |
| Cleanup entries | Page dashes, DOI (and doi.org URLs → `doi`), months → macros, arXiv `eprint`/`archiveprefix`, whitespace and empty fields, `{BERT}`-style acronym protection |
| Find duplicates, merge entries | Same DOI, same arXiv id, or the same / nearly the same title (±1 year). Merge fills the kept entry's empty fields and re-points the deleted entries' `\cite` commands |
| Push citation to the editor | Click a reference to cite it at the caret, or add it to a `\cite{…}` the caret is inside |

## What changed

**Engine** (`app/bibtex.py`)
- A parser for `@entry`, `@string`, `@preamble` and `@comment` that keeps
  every block's exact span. A malformed block is reported with its line, and
  parsing resumes at the next `@` at the start of a line.
- **Edits rewrite only their own entry.** Unchanged fields keep their
  original raw text (quotes, macros, numbers, field-name case); the rest of the
  file stays byte-for-byte the same.
- Field values in JabRef's editor form: the text inside the outer braces, with
  a macro written `#jan#`. Writing a value back checks that its braces balance.
- LaTeX → Unicode for display: accents, `\ss`, `\TeX`, dashes, ties.
- BibTeX name parsing: First von Last, "von Last, Jr, First", `{Braced
  Corporate}` names.
- **Citations in the project:** `\cite`-family commands outside comments.
  Renaming a key updates them, and `\bibliography` / `\addbibresource` show
  which `.bib` files the document uses.

**Online** (`app/bibfetch.py`, `[bibliography]` in config.toml)
- Server-side requests with a timeout, a polite User-Agent (plus
  `contact_email` for Crossref and OpenAlex) and a one-hour cache.
- Optional API keys for Semantic Scholar and OpenAlex, read from environment
  variables (both rate-limit anonymous use hard).
- `online = false` turns every lookup off; `sources = [...]` limits them.
- Clear errors for a rate limit, for a bot-check page, and for "not found".
- Pure parsers turn each service's JSON / Atom / BibTeX into candidate entries
  with BibTeX types and fields:
  - authors become "Last, First", keeping "van der" particles in the last
    name and dropping DBLP's homonym numbers;
  - pages use `--`, months become macros, `& % #` are escaped;
  - arXiv records get `eprint`, `archiveprefix` and `primaryclass`;
  - CoRR, OpenAlex and Semantic Scholar preprints map to arXiv ids.
- arXiv search tries the exact title phrase first, since arXiv ANDs stop words
  literally, then falls back to the content words.

**API** (`app/bib_api.py`)
- Read a project's bibliography: its files and which are used, the entries
  (display, links, problems, cited count, source), cited-but-missing keys,
  unused entries and duplicates.
- Entry CRUD:
  - keys are generated from the pattern;
  - a likely duplicate gets a 409 naming it, unless `force`;
  - a key change follows into `\cite` commands;
  - the raw-source edit replaces only that entry;
  - the first entry creates a new `.bib` file.
- Import pasted BibTeX or online candidates. Duplicates are skipped, a
  clashing key gets a suffix, and a candidate may bring its own key (used to
  fill a missing citation).
- Cleanup, key regeneration (with a dry run) and merging duplicates.
- Online: lookup, search with a Google Scholar link, and "fetch details" for
  an entry, which compares it field by field with the online record.
- Settings: key pattern, cite command and default sources. With auth on,
  only admins can change them.

**UI** (`app/static/bib-ui.js`, `bib.js`)
- **Left panel → References** (foldable, remembered):
  - filter box, and each entry shown as key, author and year, title;
  - uncited entries are dimmed, and entries with errors are marked;
  - click to cite, double-click to edit; Enter in the filter box cites the
    first match;
  - a warning line for cited keys that have no entry;
  - "Create refs.bib" when the project has no `.bib` file.
- **Manager dialog** (left panel tools, rail icon, or ⧉ in the References head):
  - the `.bib` file selector, with a new-file option;
  - search, the filters, and a sortable table;
  - the entry editor: type, key (with generate), required and optional
    fields, add or remove fields, inline problems with **Fix**, links (DOI,
    arXiv, URL, Google Scholar), Cite, Fetch details, Delete, and the BibTeX
    tab;
  - side panels: Add by ID, Search online (source chips, checkboxes, results
    already in the library are marked), Paste BibTeX, Clean up, Generate
    keys (preview), Duplicates (merge), Settings;
  - **Missing** lists cited keys without an entry, with where they're cited,
    Search online (the query comes from the key) and New entry with that key;
  - a banner when the `.bib` file isn't used by the document, with a button
    that adds `\bibliography{…}` (or `\addbibresource` with biblatex).
- The editor's unsaved changes are saved before any operation. Every result
  (the `.bib` text, `.tex` files whose citations changed) goes back into the
  open editor.

## Tests

- `tests/test_bibtex.py` (12):
  - parse and errors, value round trips, in-place edits;
  - append and delete;
  - names and LaTeX text;
  - key patterns;
  - checks, cleanup, duplicates and merge;
  - citations and resources, identifiers;
  - every online parser on recorded replies (`tests/fixtures/bib`:
    real arXiv, Crossref, doi.org and Open Library replies; DBLP, Semantic
    Scholar and OpenAlex fixtures follow their documented formats, because
    those services rate-limited or bot-checked this machine).
- `tests/test_bib_api.py` (6), with a fake HTTP layer:
  - reading the bibliography;
  - CRUD with the rename following `\cite`;
  - import, cleanup, keys and merge;
  - lookup and search, including the doi.org fallback, bot-check and
    rate-limit errors, the cache, fetch details, and lookups turned off;
  - settings.
- `tests/js/bib.test.js` (4): search syntax, sorting, where a citation goes,
  key → query, field groups.
- `tests/e2e/bib.e2e.js` (5). The e2e server answers lookups from the
  fixtures (`tests/e2e/fake_bib.py`), so the suite never uses the network:
  - the panel: filter, cite, join an open `\cite`, missing keys;
  - the manager: search, sort, Fix, edit and rename following `\cite`, the
    BibTeX tab, new / delete, Cite;
  - add by DOI and by arXiv id, Crossref search and multi-add, DBLP;
  - paste, filling a missing key from a search, cleanup, keys (preview +
    apply), merging duplicates;
  - creating `refs.bib`, the `\bibliography` hint, a second file.

## Not done (ideas)

- Groups and keyword tags; linked PDFs; an `.aux`-based citation count.
- Exporting to RIS / CSL-JSON; journal abbreviation lists.
- INSPIRE-HEP, PubMed and zbMATH as more sources.
