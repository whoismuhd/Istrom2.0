"""Tests for the login rate limiter."""
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from api.services.rate_limit import LoginRateLimiter, login_limiter  # noqa: E402


def test_locks_after_max_attempts():
    lim = LoginRateLimiter(max_attempts=3, window_seconds=60, lockout_seconds=60)
    assert lim.seconds_until_unlocked("1.2.3.4") is None
    for _ in range(3):
        lim.record_failure("1.2.3.4")
    remaining = lim.seconds_until_unlocked("1.2.3.4")
    assert remaining is not None and remaining > 0


def test_success_clears_failures():
    lim = LoginRateLimiter(max_attempts=3)
    lim.record_failure("ip")
    lim.record_failure("ip")
    lim.record_success("ip")
    lim.record_failure("ip")  # counter was reset, so this is attempt #1 again
    assert lim.seconds_until_unlocked("ip") is None


def test_keys_are_independent():
    lim = LoginRateLimiter(max_attempts=2)
    lim.record_failure("a")
    lim.record_failure("a")
    assert lim.seconds_until_unlocked("a") is not None
    assert lim.seconds_until_unlocked("b") is None


def test_login_endpoint_locks_out(client):
    login_limiter.reset()
    try:
        for _ in range(login_limiter.max_attempts):
            r = client.post("/auth/login", json={"user_type": "project_site", "username": "nonexistent", "password": "definitely-wrong"})
            assert r.status_code == 401
        r = client.post("/auth/login", json={"user_type": "project_site", "username": "nonexistent", "password": "definitely-wrong"})
        assert r.status_code == 429
        assert "Try again" in r.json()["detail"]
    finally:
        login_limiter.reset()
