"""Database schema initialization and migrations."""
import os
from sqlalchemy import inspect, text
from db import engine, Base
from models import (
    AccessCode,
    ProjectSiteAccessCode,
    ProjectSite,
    User,
    AdminPasswordReset,
    Item,
    Request,
    Notification,
    NotificationRead,
    AccessLog,
    Actual,
    DeletedRequest,
)
from api.services.auth_service import hash_access_code, is_hashed_code
from api.services.code_storage import encrypt_legacy_codes
from api.account_policy import ADMIN_USERNAME, ADMIN_LOGIN_NAME


def init_db():
    """Create all tables."""
    Base.metadata.create_all(bind=engine)


def seed_default_data():
    """Seed default access codes and project site if empty."""
    from sqlalchemy.orm import Session
    from db import SessionLocal

    db = SessionLocal()
    try:
        # Check if access_codes is empty
        count = db.query(AccessCode).count()
        if count == 0:
            initial_code = os.getenv('INITIAL_ADMIN_CODE', '').strip()
            if not initial_code:
                raise RuntimeError('Set INITIAL_ADMIN_CODE before initializing a new database. It is used once to create the first administrator.')
            ac = AccessCode(
                admin_code=hash_access_code(initial_code),
                user_code='',
            )
            db.add(ac)
            db.commit()
        else:
            ac = db.query(AccessCode).first()
            changed = False
            if ac and ac.admin_code and not is_hashed_code(ac.admin_code):
                ac.admin_code = hash_access_code(ac.admin_code)
                changed = True
            if ac and ac.user_code and not is_hashed_code(ac.user_code):
                ac.user_code = hash_access_code(ac.user_code)
                changed = True
            if changed:
                db.commit()

        # Sites are organisational records. Access belongs to individual users.
        if db.query(ProjectSite).count() == 0:
            db.add(ProjectSite(name="Lifecamp Kafe", description="Default project site"))
            db.commit()

        changed = False
        for pac in db.query(ProjectSiteAccessCode).all():
            if pac.admin_code and not is_hashed_code(pac.admin_code):
                pac.admin_code = hash_access_code(pac.admin_code)
                changed = True
            if pac.user_code and not is_hashed_code(pac.user_code):
                pac.user_code = hash_access_code(pac.user_code)
                changed = True
        changed = encrypt_legacy_codes(db) or changed
        if changed:
            db.commit()

    finally:
        db.close()


def run_migrations():
    """Add missing columns, then recover a budget baseline for existing items."""
    NotificationRead.__table__.create(bind=engine, checkfirst=True)
    AdminPasswordReset.__table__.create(bind=engine, checkfirst=True)
    additions = {
        "requests": {"current_price": "REAL", "building_subtype": "VARCHAR(100)", "project_site": "VARCHAR(255)", "approved_shortage_qty": "REAL NOT NULL DEFAULT 0", "requested_by_user_id": "INTEGER", "approved_by_user_id": "INTEGER"},
        "users": {"login_name": "VARCHAR(255)", "password_hash": "TEXT", "session_version": "INTEGER NOT NULL DEFAULT 1", "must_change_password": "BOOLEAN NOT NULL DEFAULT TRUE", "last_login_at": "TIMESTAMP"},
        "push_subscriptions": {"user_id": "INTEGER"},
        "actuals": {"request_id": "INTEGER"},
        "deleted_requests": {"budget": "VARCHAR(255)", "building_subtype": "VARCHAR(100)"},
        "notifications": {"item_name": "VARCHAR(255)", "qty": "REAL", "budget": "VARCHAR(255)", "building_subtype": "VARCHAR(100)"},
        "project_site_access_codes": {"user_code_plain": "TEXT", "session_version": "INTEGER NOT NULL DEFAULT 1"},
        "access_codes": {"session_version": "INTEGER NOT NULL DEFAULT 1"},
        "items": {"planned_qty": "REAL", "planned_unit_cost": "REAL", "budget_scope": "VARCHAR(255)", "source_sheet": "VARCHAR(255)", "source_row": "INTEGER", "import_key": "VARCHAR(64)"},
    }
    with engine.begin() as conn:
        inspector = inspect(conn)
        for table, columns in additions.items():
            existing = {col["name"] for col in inspector.get_columns(table)}
            for name, sql_type in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))
        if engine.dialect.name == 'postgresql':
            conn.execute(text('ALTER TABLE project_site_access_codes ALTER COLUMN user_code_plain TYPE TEXT'))
        conn.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_name ON users (login_name)'))
        conn.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS ux_items_import_key ON items (import_key)'))
        # Preserve an existing admin's password and account ID during the switch
        # to the fixed login. Never choose between multiple personal admins.
        admins = conn.execute(text("SELECT id, username, login_name FROM users WHERE user_type = 'admin' AND login_name IS NOT NULL AND password_hash IS NOT NULL")).mappings().all()
        if len(admins) > 1:
            raise RuntimeError('Select one administrator account before upgrading to the fixed Istrom_Admin login.')
        if admins and (admins[0]['username'], admins[0]['login_name']) != (ADMIN_USERNAME, ADMIN_LOGIN_NAME):
            admin_id = admins[0]['id']
            collision = conn.execute(text('SELECT id FROM users WHERE login_name = :name AND id != :id'), {'name': ADMIN_LOGIN_NAME, 'id': admin_id}).first()
            if collision:
                raise RuntimeError('The reserved Istrom_Admin username belongs to another account. Rename that account before upgrading.')
            conn.execute(text('UPDATE users SET username = :username, login_name = :login, full_name = NULL, session_version = session_version + 1 WHERE id = :id'),
                         {'username': ADMIN_USERNAME, 'login': ADMIN_LOGIN_NAME, 'id': admin_id})
            conn.execute(text('DELETE FROM push_subscriptions WHERE user_id = :id'), {'id': admin_id})
        # Approved requests have already reduced stock. Include their quantities
        # once when reconstructing the plan; subsequent startups preserve it.
        conn.execute(text("""
            UPDATE items SET planned_qty = COALESCE(qty, 0) + COALESCE(
                (SELECT SUM(requests.qty) FROM requests
                 WHERE requests.item_id = items.id AND requests.status = 'Approved'), 0)
            WHERE planned_qty IS NULL
        """))
        conn.execute(text("UPDATE items SET planned_unit_cost = COALESCE(unit_cost, 0) WHERE planned_unit_cost IS NULL"))


if __name__ == "__main__":
    init_db()
    run_migrations()
    seed_default_data()
    print("Database initialized successfully.")
