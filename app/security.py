"""Request hardening helpers: a small in-memory per-key rate limiter.

A fixed-window counter (per minute) keyed by ``ip + bucket`` — enough to blunt
brute-force and runaway clients on a single instance. It is intentionally simple
(no external store); a multi-instance deployment would back this with Redis, the
same way the job queue would (see the gap analysis).
"""

from __future__ import annotations

import threading
import time


class RateLimiter:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self._lock = threading.Lock()
        self._hits: dict[str, list[float]] = {}  # key -> [window_start, count]

    def allow(self, key: str, limit: int, window: float = 60.0) -> bool:
        """Record a hit; return False once ``limit`` is exceeded within ``window``."""
        if not self.enabled or limit <= 0:
            return True
        now = time.monotonic()
        with self._lock:
            entry = self._hits.get(key)
            if entry is None or now - entry[0] >= window:
                self._hits[key] = [now, 1]
                return True
            if entry[1] >= limit:
                return False
            entry[1] += 1
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
