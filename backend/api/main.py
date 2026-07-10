"""Istrom Inventory Management System - FastAPI Backend."""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import get_db
from schema_init import init_db, seed_default_data, run_migrations
from api.routes import auth, items, requests, notifications, actuals, project_sites
from api.routes import access_codes, access_logs, constants, deleted_requests
from api.routes import bulk_upload
from api.routes import realtime

_DEV_ORIGINS = [
    "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
    "http://localhost:5176", "http://localhost:3000",
    "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175",
    "http://127.0.0.1:5176",
]

# Production sets CORS_ORIGINS to a comma-separated list of the real frontend
# origin(s). Falls back to the local dev origins. Never use "*" with credentials.
_env_origins = os.getenv("CORS_ORIGINS", "").strip()
ALLOWED_ORIGINS = [o.strip() for o in _env_origins.split(",") if o.strip()] or _DEV_ORIGINS

# API docs are exposed only when ENABLE_DOCS is truthy (dev). Off in production
# to avoid publishing the full API surface.
_docs_enabled = os.getenv("ENABLE_DOCS", "").lower() in ("1", "true", "yes", "on")

app = FastAPI(
    title="Istrom Inventory Management System",
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(items.router)
app.include_router(requests.router)
app.include_router(notifications.router)
app.include_router(actuals.router)
app.include_router(project_sites.router)
app.include_router(access_codes.router)
app.include_router(access_logs.router)
app.include_router(constants.router)
app.include_router(deleted_requests.router)
app.include_router(bulk_upload.router)
app.include_router(realtime.router)


@app.on_event("startup")
def startup():
    init_db()
    run_migrations()
    seed_default_data()


@app.get("/health")
def health():
    return {"ok": True}
