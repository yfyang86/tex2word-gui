"""Point the app's SQLite database at a throwaway file for the test session.

This runs at collection time — before any test module imports ``app.main`` and
constructs the global ``ProjectStore`` — so the real ``tex2word.db`` is never
touched by the suite.
"""

import os
import tempfile

import pytest

_fd, _path = tempfile.mkstemp(suffix=".db", prefix="tex2word-test-")
os.close(_fd)
os.environ.setdefault("TEX2WORD_DB", _path)

# Give the default provider (deepseek) a key so assistant success-paths can run;
# the LLM call itself is monkeypatched in tests, so no network/real key is used.
# Leave OPENAI_API_KEY unset so the `openai` provider exercises the no-key path.
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")
os.environ.pop("OPENAI_API_KEY", None)


@pytest.fixture(autouse=True)
def _no_rate_limit():
    """The suite fires many requests fast; disable rate limiting except where a
    test exercises it explicitly (those re-enable + reset the limiter)."""
    from app.main import rate_limiter

    rate_limiter.enabled = False
    rate_limiter.reset()
    yield
