"""In-memory login rate limiter (per client key).

Guards login, administrator setup and password checks by IP and account name.
State is process-local, so with multiple uvicorn workers each worker keeps its
own counters. A shared store is required for consistent throttling across
multiple workers.
"""
from __future__ import annotations

import time
from threading import Lock
from typing import Dict, List, Optional


class LoginRateLimiter:
    def __init__(self, max_attempts: int = 8, window_seconds: int = 300, lockout_seconds: int = 300):
        self.max_attempts = max_attempts
        self.window = window_seconds
        self.lockout = lockout_seconds
        self._fails: Dict[str, List[float]] = {}
        self._locked: Dict[str, float] = {}
        self._lock = Lock()

    def seconds_until_unlocked(self, key: str) -> Optional[int]:
        """Return remaining lockout seconds for key, or None if not locked."""
        now = time.time()
        with self._lock:
            unlock_at = self._locked.get(key)
            if unlock_at is None:
                return None
            if unlock_at <= now:
                self._locked.pop(key, None)
                return None
            return int(unlock_at - now) + 1

    def record_failure(self, key: str) -> None:
        now = time.time()
        with self._lock:
            recent = [t for t in self._fails.get(key, []) if now - t < self.window]
            recent.append(now)
            if len(recent) >= self.max_attempts:
                self._locked[key] = now + self.lockout
                self._fails[key] = []
            else:
                self._fails[key] = recent

    def record_success(self, key: str) -> None:
        with self._lock:
            self._fails.pop(key, None)
            self._locked.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._fails.clear()
            self._locked.clear()


# Module-level singleton used by the login route.
login_limiter = LoginRateLimiter()
