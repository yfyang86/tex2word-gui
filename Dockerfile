# Tex Word Studio — container image.
#
# The app runs from source (config.py resolves config.toml/config.sample.toml
# relative to the repo root, i.e. /app), so we install dependencies and then
# run `uvicorn app.main:app` from /app. Mount a real config.toml and provider
# API keys at runtime; the committed sample is the fallback.
#
# TikZ/PDF figure rasterisation needs a TeX engine on PATH — install the
# "[pdf]" extra and a TeX distribution in a derived image if you need it.
FROM python:3.14-slim

# uv for fast, reproducible dependency installs.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install dependencies (and the project) into the system environment. Copy the
# metadata and package first so this layer caches across source-only changes.
COPY pyproject.toml README.md ./
COPY app ./app
RUN uv pip install --system --no-cache .

# The sample config must sit at the app root (config.py's fallback path).
COPY config.sample.toml ./

ENV PORT=8000
EXPOSE 8000

# Run from /app so the source package (and its config lookup) take precedence.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
