"""Istrom Inventory Management System - FastAPI Backend."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import get_db
from schema_init import init_db, seed_default_data, run_migrations
from api.routes import auth, items, requests, notifications, actuals, project_sites
from api.routes import access_codes, access_logs, constants, deleted_requests
from api.routes import bulk_upload
from api.routes import realtime

app = FastAPI(title="Istrom Inventory Management System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176", "http://localhost:3000", "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175", "http://127.0.0.1:5176"],
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
