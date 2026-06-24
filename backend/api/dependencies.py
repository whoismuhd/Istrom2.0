"""API dependencies for auth and DB."""
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from datetime import datetime, timedelta
import os

security = HTTPBearer(auto_error=False)
JWT_SECRET = os.getenv("JWT_SECRET", "istrom-secret-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 24


def create_access_token(data: dict) -> str:
    expire = datetime.utcnow() + timedelta(hours=JWT_EXPIRY_HOURS)
    to_encode = data.copy()
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError:
        return None


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
):
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    token = credentials.credentials
    payload = decode_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )
    return payload


def is_global_admin_user(user: Optional[dict]) -> bool:
    """Return True for global admins, False for site-scoped admins/users."""
    if not user:
        return False
    if user.get("is_global_admin") is not None:
        return bool(user.get("is_global_admin"))
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
):
    if not credentials:
        return None
    return decode_token(credentials.credentials)
