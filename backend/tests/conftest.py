"""Pytest fixtures: temp DB, TestClient, admin auth override, workbook builder."""
import io
import os
import sys
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Test tokens must never authenticate against the developer's running app.
os.environ['JWT_SECRET'] = 'istrom-isolated-test-signing-secret-2026'

# backend/ must be importable as top-level (matches how the app runs).
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import db as db_module  # noqa: E402
from db import Base, get_db  # noqa: E402
import models  # noqa: E402  (registers tables on Base)
from api.services.user_accounts import hash_password, login_response  # noqa: E402

TEST_PASSWORD = 'A unique test passphrase 2026'
TEST_PASSWORD_HASH = hash_password(TEST_PASSWORD)


@contextmanager
def site_request_identity(site):
    """Submit as a site user, then restore the administrator for approvals."""
    from api.main import app
    from api.dependencies import get_current_user
    previous = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_current_user] = lambda: {
        'username': 'site.requester', 'user_type': 'project_site',
        'project_site': site, 'is_global_admin': False,
    }
    try:
        yield
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_current_user, None)
        else:
            app.dependency_overrides[get_current_user] = previous


def make_account(session, username, role='project_site', site=None, must_change=False):
    account = models.User(username=username, login_name=username.lower(), full_name=f'Person {username}',
        user_type=role, project_site=site, password_hash=TEST_PASSWORD_HASH,
        is_active=True, must_change_password=must_change, session_version=1)
    session.add(account)
    session.commit()
    return account


def account_token(session, username, role='project_site', site=None):
    return login_response(make_account(session, username, role, site))['token']


@pytest.fixture()
def test_db():
    postgres_url = os.getenv('ISTROM_TEST_POSTGRES_URL')
    if postgres_url:
        # Never let this destructive fixture target a hosted or application DB.
        url = make_url(postgres_url)
        if (url.get_backend_name() != 'postgresql' or
                url.host not in ('localhost', '127.0.0.1', '::1') or
                not (url.database or '').startswith('istrom_test_') or
                set(url.query) & {'host', 'hostaddr', 'dbname', 'database', 'service'}):
            raise ValueError('PostgreSQL tests require a local database named istrom_test_*.')
        engine = create_engine(url)
    else:
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
        engine.dispose()


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
def client(test_db, admin_user, monkeypatch):
    from api import main
    app = main.app
    from api.dependencies import get_current_user, get_current_admin, get_authenticated_user

    def _override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = lambda: admin_user
    app.dependency_overrides[get_current_admin] = lambda: admin_user
    app.dependency_overrides[get_authenticated_user] = lambda: admin_user
    # Route tests use the fixture database; startup must never migrate or seed
    # the developer's inventory database.
    monkeypatch.setattr(main, "init_db", lambda: None)
    monkeypatch.setattr(main, "run_migrations", lambda: None)
    monkeypatch.setattr(main, "seed_default_data", lambda: None)
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


def build_cached_workbook(sheets, cached_values, hidden_sheets=()):
    """Model an Excel-saved workbook, including saved formula results."""
    from zipfile import ZipFile, ZIP_DEFLATED
    from xml.etree import ElementTree as ET
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(name)
        for row in rows:
            ws.append(row)
        if name in hidden_sheets:
            ws.sheet_state = 'hidden'
    raw = io.BytesIO()
    wb.save(raw)
    out = io.BytesIO()
    namespace = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    with ZipFile(raw) as source, ZipFile(out, 'w', ZIP_DEFLATED) as target:
        for member in source.infolist():
            data = source.read(member.filename)
            for index, (name, _) in enumerate(sheets, 1):
                if member.filename == f'xl/worksheets/sheet{index}.xml' and name in cached_values:
                    root = ET.fromstring(data)
                    for cell in root.iter(namespace + 'c'):
                        if cell.get('r') in cached_values[name]:
                            value = cell.find(namespace + 'v')
                            if value is None:
                                value = ET.SubElement(cell, namespace + 'v')
                            value.text = str(cached_values[name][cell.get('r')])
                    data = ET.tostring(root)
            target.writestr(member, data)
    return out.getvalue()
