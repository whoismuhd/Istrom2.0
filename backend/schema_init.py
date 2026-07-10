"""Database schema initialization and migrations."""
import os
from sqlalchemy import text
from db import engine, Base
from models import (
    AccessCode,
    ProjectSiteAccessCode,
    ProjectSite,
    User,
    Item,
    Request,
    Notification,
    AccessLog,
    Actual,
    DeletedRequest,
)
from constants import DEFAULT_ADMIN_CODE, DEFAULT_USER_CODE
from api.services.auth_service import hash_access_code, is_hashed_code


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
            ac = AccessCode(
                admin_code=hash_access_code(DEFAULT_ADMIN_CODE),
                user_code=hash_access_code(DEFAULT_USER_CODE),
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

        # Check if project_sites is empty
        if db.query(ProjectSite).count() == 0:
            ps = ProjectSite(name="Lifecamp Kafe", description="Default project site")
            db.add(ps)
            db.commit()

        # Check if project_site_access_codes has Lifecamp Kafe
        if db.query(ProjectSiteAccessCode).filter(
            ProjectSiteAccessCode.project_site == "Lifecamp Kafe"
        ).count() == 0:
            pac = ProjectSiteAccessCode(
                project_site="Lifecamp Kafe",
                admin_code=hash_access_code(DEFAULT_ADMIN_CODE),
                user_code=hash_access_code(DEFAULT_USER_CODE),
                user_code_plain=DEFAULT_USER_CODE,
            )
            db.add(pac)
            db.commit()
        else:
            pacs = db.query(ProjectSiteAccessCode).all()
            changed = False
            for pac in pacs:
                if pac.admin_code and not is_hashed_code(pac.admin_code):
                    pac.admin_code = hash_access_code(pac.admin_code)
                    changed = True
                if pac.user_code and not is_hashed_code(pac.user_code):
                    pac.user_code = hash_access_code(pac.user_code)
                    changed = True
            if changed:
                db.commit()

    finally:
        db.close()


def run_migrations():
    """Add any new columns if needed (for existing DBs)."""
    migrations = [
        ("ALTER TABLE requests ADD COLUMN current_price REAL", "current_price"),
        ("ALTER TABLE requests ADD COLUMN building_subtype VARCHAR(100)", "building_subtype"),
        ("ALTER TABLE requests ADD COLUMN project_site VARCHAR(255)", "project_site"),
        ("ALTER TABLE actuals ADD COLUMN request_id INTEGER", "request_id"),
        ("ALTER TABLE deleted_requests ADD COLUMN budget VARCHAR(255)", "deleted_budget"),
        ("ALTER TABLE deleted_requests ADD COLUMN building_subtype VARCHAR(100)", "deleted_building_subtype"),
        ("ALTER TABLE notifications ADD COLUMN item_name VARCHAR(255)", "notif_item_name"),
        ("ALTER TABLE notifications ADD COLUMN qty REAL", "notif_qty"),
        ("ALTER TABLE notifications ADD COLUMN budget VARCHAR(255)", "notif_budget"),
        ("ALTER TABLE notifications ADD COLUMN building_subtype VARCHAR(100)", "notif_building_subtype"),
        ("ALTER TABLE project_site_access_codes ADD COLUMN user_code_plain VARCHAR(255)", "pac_user_code_plain"),
    ]
    for sql, _ in migrations:
        try:
            with engine.connect() as conn:
                conn.execute(text(sql))
                conn.commit()
        except Exception:
            pass  # Column may already exist


if __name__ == "__main__":
    init_db()
    run_migrations()
    seed_default_data()
    print("Database initialized successfully.")
