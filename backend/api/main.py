"""Istrom Inventory Management System - FastAPI Backend."""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import get_db
from schema_init import init_db, seed_default_data, run_migrations
from api.routes import auth, items, requests, notifications, actuals, project_sites
from api.routes import access_logs, constants, deleted_requests
from api.routes import bulk_upload
from api.routes import realtime
from api.routes import push
from api.routes import users
from api.routes import admin_recovery
from api.settings import ALLOWED_ORIGINS
from api.body_limit import BodyLimitMiddleware

# API docs are exposed only when ENABLE_DOCS is truthy (dev). Off in production
# to avoid publishing the full API surface.
_docs_enabled = os.getenv("ENABLE_DOCS", "").lower() in ("1", "true", "yes", "on")

app = FastAPI(
    title="Istrom Inventory Management System",
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

app.add_middleware(BodyLimitMiddleware)
# CORS wraps size validation so the hosted frontend can read rejected uploads.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cache-Control"] = "no-store"
    return response

app.include_router(auth.router)
app.include_router(admin_recovery.router)
app.include_router(items.router)
app.include_router(requests.router)
app.include_router(notifications.router)
app.include_router(actuals.router)
app.include_router(project_sites.router)
app.include_router(access_logs.router)
app.include_router(constants.router)
app.include_router(deleted_requests.router)
app.include_router(bulk_upload.router)
app.include_router(realtime.router)
app.include_router(push.router)
app.include_router(users.router)


@app.on_event("startup")
def startup():
    init_db()
    run_migrations()
    seed_default_data()


@app.get("/health")
def health():
    return {"ok": True}
