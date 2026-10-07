"""API dependencies for auth and DB."""
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from db import get_db
from models import AccessCode, ProjectSite, User
from api.settings import JWT_SECRET

security = HTTPBearer(auto_error=False)
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24


def create_access_token(data: dict) -> str:
    expire = datetime.utcnow() + timedelta(hours=JWT_EXPIRY_HOURS)
    to_encode = data.copy()
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    if not isinstance(token, str) or len(token) > 4096:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM], options={"require_exp": True})
        return payload
    except (JWTError, ValueError, TypeError):
        return None


async def get_authenticated_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
):
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    token = credentials.credentials
    payload = validate_session(token, db)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    return payload


async def get_current_user(user: dict = Depends(get_authenticated_user)):
    if user.get('needs_account_setup'):
        raise HTTPException(403, 'Set up your individual administrator account first.')
    if user.get('must_change_password'):
        raise HTTPException(403, 'Change your temporary password before using the workspace.')
    return user


def validate_session(token: str, db: Session) -> Optional[dict]:
    """Check both JWT expiry and whether its source credential is still valid."""
    payload = decode_token(token)
    if not payload or "session_version" not in payload or "credential_id" not in payload:
        return None
    # Older sessions can contain a full name. Identity now uses only usernames.
    payload.pop('full_name', None)
    if any(type(payload[field]) is not int or payload[field] < 1 for field in ("session_version", "credential_id")):
        return None
    role, site = payload.get("user_type"), payload.get("project_site")
    global_admin = payload.get("is_global_admin")
    if role not in ("admin", "project_site") or type(global_admin) is not bool:
        return None
    if global_admin:
        if role != "admin" or site is not None:
            return None
    elif not isinstance(site, str) or not site.strip():
        return None
    if payload.get('credential_kind') == 'user':
        account = db.query(User).filter(User.id == payload['credential_id']).first()
        if not account or not account.is_active or not account.login_name or not account.password_hash:
            return None
        if account.session_version != payload['session_version']:
            return None
        if (role, site, global_admin, payload.get('username')) != (
            account.user_type, account.project_site, account.user_type == 'admin', account.username
        ):
            return None
        if account.user_type == 'project_site' and not db.query(ProjectSite.id).filter(
            ProjectSite.name == site, ProjectSite.is_active == True,
        ).first():
            return None
        return {**payload, 'user_id': account.id,
                'must_change_password': account.must_change_password, 'needs_account_setup': False}
    # Only an existing global administrator session can reach the upgrade
    # screen. Shared site credentials can never access business records.
    if is_global_admin_user(payload):
        if db.query(User.id).filter(User.user_type == 'admin', User.login_name.isnot(None),
                                   User.password_hash.isnot(None)).first():
            return None
        credential = db.query(AccessCode).filter(AccessCode.id == payload["credential_id"]).first()
    else:
        return None
    if not credential or credential.session_version != payload["session_version"]:
        return None
    return {**payload, 'needs_account_setup': True, 'must_change_password': False}


def is_global_admin_user(user: Optional[dict]) -> bool:
    """Return True for global admins, False for site-scoped admins/users."""
    if not user:
        return False
    if user.get("is_global_admin") is not None:
        return user.get("user_type") == "admin" and user.get("is_global_admin") is True and not user.get("project_site")
    # Backward compatibility for older tokens without is_global_admin
    return user.get("user_type") == "admin" and not user.get("project_site")


def enforce_project_site_scope(user: dict, target_project_site: Optional[str]) -> Optional[str]:
    """
    Enforce that non-global users cannot act outside their own project site.
    Returns the effective project site for downstream queries/writes.
    """
    if is_global_admin_user(user):
        return target_project_site
    user_site = user.get("project_site")
    if not user_site:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Project site scope is required",
        )
    if target_project_site and target_project_site != user_site:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied for selected project site",
        )
    return user_site


def enforce_record_scope(user: dict, project_site: Optional[str]):
    if not project_site and not is_global_admin_user(user):
        raise HTTPException(403, "This record is not assigned to your project site.")
    return enforce_project_site_scope(user, project_site)


def require_active_project_site(db: Session, user: dict, target_project_site: Optional[str]) -> str:
    site = enforce_project_site_scope(user, target_project_site)
    if not site:
        raise HTTPException(422, "Select a project site before adding records.")
    if not db.query(ProjectSite.id).filter(ProjectSite.name == site, ProjectSite.is_active == True).first():
        raise HTTPException(422, "The selected project site is unknown or inactive.")
    return site


async def get_current_admin(
    user: dict = Depends(get_current_user),
):
    if user.get("user_type") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user


async def get_current_global_admin(
    user: dict = Depends(get_current_admin),
):
    if not is_global_admin_user(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Global admin access required",
        )
    return user


def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
):
    if not credentials:
        return None
    return validate_session(credentials.credentials, db)
