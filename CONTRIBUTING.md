# Contributing to Tex Word Studio

Thanks for your interest in improving `tex2word-web` — the web workspace that
wraps the [`tex2word`](https://pypi.org/project/tex2word/) engine. This guide
covers the local setup, the test bar every change must clear, and the
**sprint harness** we plan work against.

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0 License](LICENSE).

## Ground rules

- **`tex2word` is the engine.** All document semantics — parsing, numbering,
  citations, cross-references, `.docx`/OOXML output — live in the `tex2word`
  package. The web app is an **adapter** around its IR and outputs, never a
  re-implementation. Prefer routing through `convert_source` / `roundtrip` over
  re-deriving document logic here.
- **No frontend build step.** `app/static/` is vanilla JS/CSS served directly.
  Don't introduce a bundler, framework, or transpiler without discussion.
- **Secrets never get committed.** API keys live in `config.toml` (gitignored)
  or environment variables via `api_key_env`. See `config.sample.toml`.

## Local setup

Requires **Python 3.12+** and [`uv`](https://docs.astral.sh/uv/). Node.js is
optional (used only for the `node --check` JS syntax gate).

```bash
uv venv --python 3.12
uv pip install -e ".[dev]"          # add "[pdf]" for TikZ/PDF figure rasterisation

cp config.sample.toml config.toml   # fill in provider keys if using the assistant
uv run uvicorn app.main:app --reload
```

Open <http://localhost:8000>. Auth is off by default; to enable it see
`manage.py` and the `[auth]` block in `config.sample.toml`.

## Tests — the bar for every PR

```bash
uv run pytest -q            # the full suite must pass
node --check app/static/app.js   # frontend JS must parse
```

Both are enforced by CI (`.github/workflows/ci.yml`). A pull request should not
be merged red.

- New behaviour needs tests. Bug fixes need a **regression test** that fails
  before the fix (see `tests/test_md_math.py` for the pattern).
- Tests run against a temporary SQLite DB via `conftest.py`. A stray root
  `tex2word.db` is gitignored; delete it if an ad-hoc import created one.

## Branch & PR flow

1. Branch off `dev` (or the branch a maintainer assigns you).
2. Keep commits focused; write clear, imperative commit messages.
3. Open a PR **into `dev`**. CI must be green.
4. `dev` is periodically promoted to `main` via PR; `main` is the release line.

## The sprint harness

Planning lives in [`Sprint/`](Sprint) and is how features get scoped before
code is written:

- [`Sprint/README.md`](Sprint/README.md) — the product context and the
  numbered **roadmap** (each sprint has a status).
- `Sprint/sprint-NN-<theme>.md` — one file per committed sprint: goal, the gaps
  it closes, the approach, and the tests that lock the behaviour.
- [`Sprint/gap-analysis*.md`](Sprint) — the analysis that motivates upcoming
  sprints; [`Sprint/backlog.md`](Sprint/backlog.md) — the unscheduled backlog.

**Proposing a change of any size:**

1. Check the roadmap and backlog — it may already be scoped.
2. For a non-trivial feature, open an issue (or draft a `sprint-NN-*.md`)
   describing the gap, the approach, and how it will be tested, before writing
   code. Small fixes can go straight to a PR.
3. Land the sprint doc alongside the implementation so the roadmap stays an
   accurate record of what shipped.

## Cutting a release

Releases are automated. Bump `version` in `pyproject.toml` and `app/__init__.py`,
land it on `main`, then push a matching tag:

```bash
git tag -a v0.1.0 -m "tex2word-web v0.1.0"
git push origin v0.1.0
```

The `Release` workflow (`.github/workflows/release.yml`) runs the test suite and,
if green, creates a GitHub Release for the tag with auto-generated notes. Tags
with a suffix (e.g. `v0.1.0-rc1`) are published as pre-releases.

**Artifact publishing is opt-in** (so a release is never blocked by unconfigured
infrastructure). Enable it per repository under **Settings → Secrets and
variables → Actions → Variables**:

- **Container image → GHCR:** set `PUBLISH_DOCKER = true`. The workflow builds
  the [`Dockerfile`](Dockerfile) and pushes `ghcr.io/<owner>/tex2word-web` tagged
  with the version (and `latest` for non-pre-release tags).
- **PyPI:** set `PUBLISH_PYPI = true` **and** configure a
  [PyPI Trusted Publisher](https://docs.pypi.org/trusted-publishers/) for this
  workflow (no API token needed). Note: the wheel's top-level package is `app`;
  rename it before publishing publicly to avoid a namespace clash.

Dependency and action updates arrive as Dependabot PRs (`.github/dependabot.yml`).

## Reporting bugs & requesting features

Use the GitHub issue templates. For a bug, include the input (LaTeX/Markdown),
what you expected, what you got, and your Python/OS versions. For LaTeX/Word
fidelity issues, a minimal reproducing snippet is worth a lot.
