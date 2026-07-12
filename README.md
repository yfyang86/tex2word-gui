# Tex Word Studio

A web workspace for converting **LaTeX → Microsoft Word (`.docx`)** with the
[`tex2word`](https://pypi.org/project/tex2word/) engine. tex2word is the
essential module; the web app is a thin adapter around its IR and outputs.


| Image | Description |
|:------|:------------|
| [![01-login](./assets/01-login.png)](./assets/01-login.png) | Project login page |
| [![02-project](./assets/02-project.png)](./assets/02-project.png) | Project overview/dashboard |
| [![03-import-arXiv](./assets/03-import-arXiv.png)](./assets/03-import-arXiv.png) | Import from arXiv interface |
| [![04-import-markdown](./assets/04-import-markdown.png)](./assets/04-import-markdown.png) | Import markdown files interface |
| [![05-main](./assets/05-main.png)](./assets/05-main.png) | Main application interface, sync location for single file |
| [![06-main-structure](./assets/06-main-structure.png)](./assets/06-main-structure.png) | Main document structure/organization view |
| [![07-convert-log](./assets/07-convert-log.png)](./assets/07-convert-log.png) | tex2word convert log interface |
| [![08-chat-memory](./assets/08-chat-memory.png)](./assets/08-chat-memory.png) | Chat memory/conversation history |


## Features

- **Convert** LaTeX (single file or multi-file project) to a real `.docx`, with a
  conversion **report** (math coverage, diagnostics) and download. Conversions
  run as **background jobs** (poll for status) and output is stored **durably**
  (SQLite), surviving restarts.
- **Projects** persisted in SQLite — a **collapsible folder tree** (add / rename /
  delete files in place), multi-file `\input`/`\include` resolution, with **syntax
  highlighting** for LaTeX and Markdown in the editor. The gallery supports
  **search**, **kind/state filters**, and per-card **favourite / archive / rename
  / delete**.
- **Figures** — upload images (or import them in an archive); `\includegraphics`
  embeds real figures in the `.docx` and shows them in the preview. **PDF/EPS**
  graphics and inline **TikZ/PGF** are rasterised for the preview via tex2word's
  own backend (install the `pdf` extra; TikZ also needs a TeX engine on `PATH`).
- **Live preview** of the rendered document with typeset math (native MathML),
  a structure **outline** and **statistics** — in a resizable source⇄preview split
  with **rough two-way scroll sync** (click the editor to follow in the preview,
  click the preview to jump the editor).
- **tex-copilot assistant** — fix / polish / explain / ask over the current file
  and report, via a configurable LLM provider (Anthropic or any OpenAI-compatible).
  Replies **stream** in live, code suggestions apply through a **diff** (accept /
  reject), and the **provider/model** is selectable. It's a **multi-turn chat**
  (persisted per project, history-aware, with a rolling summary so long chats stay
  bounded, plus editable **per-project memory**) and an **autocomplete** that
  completes `@file` (pull a project file into context) and `/`-skills (`/fix` ·
  `/polish` · `/explain`, plus any **custom skills** you add) as you type — skills
  are served from `/api/skills` and managed with `manage.py`.
- **Import** from **Markdown** (→ LaTeX → Word), an **arXiv** source bundle, or
  an uploaded **`.zip`/`.tar(.gz)`** archive of a LaTeX project.
- **Coverage dashboard** — aggregate tex2word metrics (math OMML coverage,
  warnings/errors, `.docx` validity) across all projects.
- **Round-trip** a tex2word-generated `.docx` back to LaTeX.
- **Optional accounts** — turn on `[auth]` for a login gate with scrypt-hashed
  passwords and RSA-signed (RS256) JWT sessions; manage users and the database
  with the `manage.py` admin CLI. Off by default (the app stays open). With auth
  on, projects (and their chats/jobs) are **scoped to their owner**.
- **Hardened** — per-IP **rate limiting** (tighter on login / convert / LLM) and
  a request **body-size cap**, both configurable in `[security]`.

The UI follows the **Enthumelon** design system from
[`front-prototype/`](front-prototype). Architecture and internals are documented
in [`DEVELOPER-MANUAL.md`](DEVELOPER-MANUAL.md); planning lives in
[`Sprint/`](Sprint).

## Requirements

- Python **≥ 3.12** (`tex2word` requires it)
- [`uv`](https://docs.astral.sh/uv/)

## Quickstart

```bash
# create the env and install (app + dev deps)
uv venv --python 3.12
uv pip install -e ".[dev]"

# run the app (dev, auto-reload)
uv run uvicorn app.main:app --reload
# open http://127.0.0.1:8000

# run the tests
uv run pytest
```

### Managing the server

`server.sh` runs the app in the background with a PID file and log
(`server.log`). Host/port come from `config.toml` `[backend]`; override with
`TEX2WORD_HOST` / `TEX2WORD_PORT`.

```bash
./server.sh --start     # start in the background
./server.sh --status    # running? on which host:port
./server.sh --restart   # stop then start
./server.sh --stop      # stop
```

## Configuration

Runtime settings live in `config.toml` (TOML). Copy the sample and edit:

```bash
cp config.sample.toml config.toml   # config.toml is gitignored
```

It defines the backend host/port, CORS origins, and the LLM providers used by
the **tex-copilot assistant** (`POST /api/assistant` — fix / polish / explain /
ask over the current file and conversion report). The `default.provider` selects
which provider the assistant uses; `claude`-type providers go through the
Anthropic SDK (default model `claude-opus-4-8`), `openai`-type providers through
the OpenAI SDK against their `base_url` (DeepSeek, Kimi, Minimax, vLLM, …).
Provider API keys are read from environment variables via `api_key_env`
(preferred) or given inline with `api_key`. The app loads `config.toml` if
present and falls back to `config.sample.toml` otherwise. `GET /api/config`
returns a **redacted** view — key values are never exposed, only `has_key` and
the env-var name. With no key set, the assistant returns a clear `422`.

## Accounts & admin (optional auth)

Authentication is **off by default** — the app runs open. To require a login,
use the `manage.py` admin CLI and enable `[auth]`:

```bash
uv run python manage.py init-keys                       # write the RSA keypair (0600)
uv run python manage.py create-admin --username you      # prompts for a password
# then set `enabled = true` under [auth] in config.toml and restart
```

Passwords are hashed with **scrypt** (memory-hard, salted — never stored or
recoverable in plaintext). Sessions are **JWTs signed with an RSA private key**
(RS256) and verified with the public key; the SPA shows a login gate and sends
the token on every request (`?access_token=` is accepted for `<img>`/downloads).

`manage.py` also manages the store: `list-users`, `passwd`, `set-role`,
`delete-user`, plus `db-info` (project/file/user counts + size) and `db-vacuum`.
It manages **assistant skills** too — `add-skill --name summarize --prompt
"…{source}…"`, `list-skills`, `delete-skill` — which then appear in the `/`
autocomplete for everyone. Run `uv run python manage.py --help` for everything.
The DB path follows `TEX2WORD_DB` / `[backend].metasqlite_db`; key paths come
from `[auth]`.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET`  | `/api/health` | — | `{status, tex2word_version}` |
| `GET`  | `/api/config` | — | redacted config (providers, backend, CORS) |
| `POST` | `/api/convert` | `{source, filename?, options?}` | `{artifact_id, filename, download_url, report}` |
| `POST` | `/api/preview` | `{source, options?}` | `{html, outline, statistics, report, title}` |
| `POST` | `/api/assistant` | `{action, source, instruction?, report?, provider?, context?}` | `{reply, provider, model, action, is_code}` |
| `POST` | `/api/assistant/stream` | same as `/api/assistant` | `text/event-stream` (JSON deltas + a `done` event) |
| `GET`  | `/api/skills` | — | `[{name, title, description, is_code, scope}]` (built-in + custom) |
| `POST`/`GET` | `/api/projects/{id}/conversations` | `{title?}` / — | chat session(s) |
| `GET`/`PATCH`/`DELETE` | `/api/conversations/{cid}` | — / `{title}` / — | a conversation + messages |
| `POST` | `/api/conversations/{cid}/message[/stream]` | `{content, source?, skill?, provider?, context?}` | reply (JSON or SSE), persisted |
| `GET`/`PUT` | `/api/projects/{id}/memory` | — / `{memory}` | per-project assistant memory |
| `GET`  | `/api/coverage` | — | `{aggregate, rows}` metrics across all projects |
| `GET`  | `/api/coverage.html` | — | tex2word's native coverage dashboard (HTML) |
| `GET`  | `/api/artifacts/{id}` | — | the `.docx` (attachment) |
| `POST` | `/api/to-latex` | multipart `file=<docx>` | `{latex}` |
| `POST` | `/api/markdown/to-tex` | `{markdown, title?}` | `{latex}` (Markdown → LaTeX) |
| `POST` | `/api/auth/login` | `{username, password}` | `{token, user}` (when auth enabled) |
| `GET`  | `/api/auth/me` | — (bearer token) | `{username, role}` |
| `GET`  | `/` | — | the single-page workspace |

The **preview** renders the tex2word IR to HTML (math as native MathML via
`latex2mathml`), with a document outline and statistics. tex2word stays the
source of truth — citations, cross-references and structure come from the
engine; the web layer only assigns the display numbers Word would. In the
workspace, source and preview sit in a **resizable split** (drag the divider) and
the preview can be hidden; it refreshes on demand and shortly after you stop
typing.

### Projects (multi-file)

Projects persist to SQLite (`config.toml` `[backend].metasqlite_db`, override
with `TEX2WORD_DB`). Converting a project resolves `\input`/`\include` across
its files. When a project has several files with `\documentclass`, the file you
**click** in the tree becomes the render/convert root (`main_path` override); if
none is selected, the detected main (the `\begin{document}` file) is used.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST`   | `/api/projects` | `{name, kind?, main_path?, files?}` | project detail (201) |
| `GET`    | `/api/projects` | — | `[project summary]` |
| `GET`    | `/api/projects/{id}` | — | project detail (files) |
| `PATCH`  | `/api/projects/{id}` | `{name?, main_path?, favourite?, archived?}` | project detail |
| `DELETE` | `/api/projects/{id}` | — | 204 |
| `PUT`    | `/api/projects/{id}/settings` | `{settings}` | project detail (persisted options) |
| `PUT`    | `/api/projects/{id}/files/{path}` | `{content}` | file (text) |
| `POST`   | `/api/projects/{id}/assets/{path}` | multipart `file` | file (binary) |
| `POST`   | `/api/projects/{id}/convert/async` | `{options?, filename?, main_path?}` | `{job_id, status, status_url}` (202) |
| `GET`    | `/api/jobs/{job_id}` | — | `{status, …, download_url, report}` when done |
| `GET`    | `/api/projects/{id}/files/{path}/raw` | — | the raw file bytes |
| `DELETE` | `/api/projects/{id}/files/{path}` | — | 204 |
| `POST`   | `/api/projects/{id}/convert` | `{options?, filename?, main_path?}` | `{artifact_id, filename, download_url, report}` |
| `POST`   | `/api/projects/{id}/preview` | `{options?, main_path?}` | `{html, outline, statistics, report, title}` |
| `POST`   | `/api/projects/import/markdown` | `{name, markdown}` | project detail (201) |
| `POST`   | `/api/projects/import/arxiv` | `{arxiv_id}` | project detail (201) |
| `POST`   | `/api/projects/import/archive` | multipart `file=<zip/tar>`, `name?` | project detail (201) |

**Import:** Markdown is converted to a LaTeX document (mistune AST → LaTeX) and
still converted to Word by tex2word; the original `.md` is kept. arXiv pulls the
paper's LaTeX **source** bundle and turns its text files into a project. Archive
upload accepts a `.zip` or `.tar(.gz)`: its text files (`.tex/.bib/.sty/…`) become
the project (a shared top-level folder is stripped; binaries are skipped).

`options`: `number_by_section` (bool), `columns` (1–4), `language` (BCP-47
string), `frontend` (`pure` | `latexml`), `citation_mode` (`static` | `zotero`),
`csl` (a project-relative `.csl` style path), `math_image_fallback` (bool),
`reference_doc` (a project-relative template `.docx`). Projects also persist
these as defaults via `PUT /api/projects/{id}/settings`.

Example:

```bash
curl -s localhost:8000/api/convert \
  -H 'content-type: application/json' \
  -d '{"source":"\\documentclass{article}\\begin{document}Hi $E=mc^2$.\\end{document}"}'
```

## Project layout

```
app/
  main.py        FastAPI routes + static mount + error mapping
  service.py     tex2word boundary (convert / preview / to-latex / report)
  preview.py     IR → HTML preview + outline + statistics
  projects.py    project + file CRUD (over SQLite)
  db.py          SQLite connection + schema
  store.py       durable artifact store for converted .docx (SQLite)
  jobs.py        async conversion jobs (JobStore + thread-pool JobQueue)
  config.py      config.toml loader (backend, CORS, LLM providers)
  llm.py         LLM provider dispatch (Anthropic / OpenAI)
  assistant.py   tex-copilot prompts (fix / polish / explain / ask)
  ingest.py      Markdown → LaTeX (mistune) + arXiv fetch/unpack
  auth.py        scrypt passwords + RSA-signed (RS256) JWT sessions
  security.py    per-IP rate limiter (body-size cap + authz live in main.py)
  users.py       user accounts store (over SQLite)
  skills.py      assistant skill registry (built-ins + custom)
  chat.py        persisted multi-turn conversations + messages
  models.py      pydantic schemas
  static/        single-page UI (HTML/CSS/JS + design tokens)
tests/           pytest suite (one file per area) + conftest
manage.py        admin / DB management CLI (users, keys, db-info)
config.sample.toml  configuration template (copy to config.toml)
DEVELOPER-MANUAL.md  architecture & internals
server.sh        start/stop/status/restart wrapper
```

See [`DEVELOPER-MANUAL.md`](DEVELOPER-MANUAL.md) for the architecture, module
guide, testing, and extension recipes.



# Author

Yifan Yang <yfyang.86 AT hotmail>

Lic: Apache 2.0

