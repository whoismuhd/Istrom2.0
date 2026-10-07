"""Shared authentication and browser-origin settings."""
import os

JWT_SECRET = os.getenv("JWT_SECRET", "")
if len(JWT_SECRET.encode("utf-8")) < 32 or JWT_SECRET in {
    "istrom-secret-change-in-production", "replace-with-64-hex-chars",
}:
    raise RuntimeError("Set JWT_SECRET to a unique secret of at least 32 bytes in .env before starting the app.")

_DEV_ORIGINS = [
    "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
    "http://localhost:5176", "http://localhost:3000",
    "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175",
    "http://127.0.0.1:5176",
]
ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()] or _DEV_ORIGINS
if "*" in ALLOWED_ORIGINS or "null" in ALLOWED_ORIGINS:
    raise RuntimeError("CORS_ORIGINS must list specific trusted frontend origins.")
