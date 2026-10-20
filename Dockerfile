# Tex Word Studio — container image.
#
# The app runs from source (config.py resolves config.toml/config.sample.toml
# relative to the repo root, i.e. /app), so we install dependencies and then
# run `uvicorn app.main:app` from /app. Mount a real config.toml and provider
# API keys at runtime; the committed sample is the fallback.
#
# TikZ/PDF figure rasterisation needs a TeX engine on PATH — install the
# "[pdf]" extra and a TeX distribution in a derived image if you need it.

# ── Stage 1: the embedded TikZ editor (github.com/DominikPeters/tikz-editor, MIT).
# A ~50 MB browser bundle built from a pinned upstream commit; see
# scripts/build_tikz_editor.sh. Without it the app still runs; the TikZ editor
# tool then explains how to install the bundle.
FROM node:22-bookworm-slim AS tikz-editor
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY scripts/build_tikz_editor.sh scripts/
COPY tools/tikz-editor-embed tools/tikz-editor-embed
RUN TIKZ_EDITOR_OUT=/out scripts/build_tikz_editor.sh

# ── Stage 2: the app
FROM python:3.12-slim

# uv for fast, reproducible dependency installs.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install dependencies (and the project) into the system environment. Copy the
# metadata and package first so this layer caches across source-only changes.
COPY pyproject.toml README.md ./
COPY app ./app
RUN uv pip install --system --no-cache .

# The TikZ editor bundle from stage 1 (served at /static/vendor/tikz-editor/).
COPY --from=tikz-editor /out ./app/static/vendor/tikz-editor

# The sample config must sit at the app root (config.py's fallback path).
COPY config.sample.toml ./

ENV PORT=8000
EXPOSE 8000

# Run from /app so the source package (and its config lookup) take precedence.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
