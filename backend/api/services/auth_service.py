"""Authentication service."""
from sqlalchemy.orm import Session
from passlib.context import CryptContext

from models import AccessCode, ProjectSiteAccessCode, AccessLog
from api.dependencies import create_access_token

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def is_hashed_code(value: str | None) -> bool:
    """Return True when value looks like a bcrypt hash."""
    if not value:
        return False
    return value.startswith("$2a$") or value.startswith("$2b$") or value.startswith("$2y$")


def hash_access_code(code: str) -> str:
    """Hash access codes using bcrypt."""
    return pwd_context.hash(code.strip())


def verify_access_code(plain_code: str, stored_value: str | None) -> bool:
    """Verify plain access code against stored (bcrypt hash or legacy plaintext)."""
    if not stored_value:
        return False
    plain = plain_code.strip()
    if not plain:
        return False
    if is_hashed_code(stored_value):
        try:
            return pwd_context.verify(plain, stored_value)
        except Exception:
            return False
    return stored_value == plain


def _upgrade_code_if_plaintext(db: Session, obj, field_name: str, plain_code: str):
    """One-time migration: replace matching plaintext values with bcrypt hashes."""
    current = getattr(obj, field_name, None)
    if not current or is_hashed_code(current):
        return
    if current != plain_code:
        return
    setattr(obj, field_name, hash_access_code(plain_code))
    db.commit()


def _mask_access_code(access_code: str | None) -> str | None:
    """Mask access codes before writing to logs."""
    if not access_code:
        return None
    code = access_code.strip()
    if not code:
        return None
    if len(code) <= 4:
        return "*" * len(code)
    return "*" * (len(code) - 4) + code[-4:]


def _find_matching_project_site_code(db: Session, code: str, field_name: str) -> ProjectSiteAccessCode | None:
    """Find matching project-site code and transparently migrate plaintext to bcrypt."""
    rows = db.query(ProjectSiteAccessCode).all()
    for row in rows:
        stored = getattr(row, field_name, None)
        if verify_access_code(code, stored):
            _upgrade_code_if_plaintext(db, row, field_name, code)
            return row
    return None


def authenticate(db: Session, access_code: str) -> dict | None:
    """Authenticate by access code. Returns user dict or None."""
    code = access_code.strip()
    if not code:
        return None

    # Check global admin
    ac = db.query(AccessCode).first()
    if ac and verify_access_code(code, ac.admin_code):
        _upgrade_code_if_plaintext(db, ac, "admin_code", code)
        payload = {
            "username": "admin",
            "full_name": "Administrator",
            "user_type": "admin",
            "project_site": None,
            "is_global_admin": True,
        }
        return {
            **payload,
            "token": create_access_token(payload),
        }

    # Check project site user codes
    pac = _find_matching_project_site_code(db, code, "user_code")
    if pac:
        site_name = pac.project_site
        full_name = site_name.replace(" Site", " User") if " Site" in site_name else f"{site_name} User"
        payload = {
            "username": site_name,
            "full_name": full_name,
            "user_type": "project_site",
            "project_site": pac.project_site,
            "is_global_admin": False,
        }
        return {
            **payload,
            "token": create_access_token(payload),
        }

    # Check project site admin codes (can act as admin for that site)
    pac_admin = _find_matching_project_site_code(db, code, "admin_code")
    if pac_admin:
        payload = {
            "username": f"admin_{pac_admin.project_site}",
            "full_name": f"Admin - {pac_admin.project_site}",
            "user_type": "admin",
            "project_site": pac_admin.project_site,
            "is_global_admin": False,
        }
        return {
            **payload,
            "token": create_access_token(payload),
        }

    return None


def log_access(db: Session, access_code: str, user_name: str, success: bool, role: str):
    """Log access attempt."""
    log = AccessLog(
        access_code=_mask_access_code(access_code),
        user_name=user_name,
        success=success,
        role=role,
    )
    db.add(log)
    db.commit()
