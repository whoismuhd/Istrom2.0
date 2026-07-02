"""Pytest fixtures: temp DB, TestClient, admin auth override, workbook builder."""
import io
import os
import sys

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# backend/ must be importable as top-level (matches how the app runs).
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import db as db_module  # noqa: E402
from db import Base, get_db  # noqa: E402
import models  # noqa: E402  (registers tables on Base)


@pytest.fixture()
def test_db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


@pytest.fixture()
def admin_user():
    return {
        "username": "admin",
        "full_name": "Administrator",
        "user_type": "admin",
        "project_site": None,
        "is_global_admin": True,
    }


@pytest.fixture()
def client(test_db, admin_user):
    from api.main import app
    from api.dependencies import get_current_user, get_current_admin

    def _override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: admin_user
    app.dependency_overrides[get_current_admin] = lambda: admin_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def build_workbook(sheets):
    """sheets: list of (sheet_name, rows) where rows is a list of lists (cells)."""
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
