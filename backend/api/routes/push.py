"""Web Push subscription routes."""
import hmac
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from db import get_db
from models import ProjectSite, PushSubscription, User
from api.dependencies import get_current_user, is_global_admin_user
from api.routes.auth import lock_account_changes
from api.services.push_service import VAPID_PUBLIC_KEY, push_enabled
from api.services.push_security import valid_push_endpoint, validate_push_key

router = APIRouter(prefix="/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: str = Field(max_length=128)
    auth: str = Field(max_length=64)

    @field_validator("p256dh", "auth")
    @classmethod
    def valid_key(cls, value, info):
        return validate_push_key(value, public=info.field_name == "p256dh")


class PushSubscribeIn(BaseModel):
    endpoint: str = Field(max_length=4096)
    keys: PushKeys


class PushUnsubscribeIn(BaseModel):
    endpoint: str = Field(max_length=4096)
    keys: PushKeys | None = None
    current_account_only: bool = False


def _same_identity(sub, user) -> bool:
    return (
        sub.user_id == user.get('user_id')
        and
        sub.user_type == user.get("user_type")
        and sub.project_site == user.get("project_site")
        and bool(sub.is_global_admin) == is_global_admin_user(user)
    )


def _can_manage(sub, user, keys) -> bool:
    # The browser's secret proves ownership when changing accounts on a device.
    owns_device = keys is not None and hmac.compare_digest(sub.auth, keys.auth) and hmac.compare_digest(sub.p256dh, keys.p256dh)
    return _same_identity(sub, user) or owns_device


def _locked_subscription(db, endpoint):
    db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).update(
        {PushSubscription.auth: PushSubscription.auth}, synchronize_session=False)
    return db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).populate_existing().first()


def _lock_current_account(db, user):
    """Do not let an in-flight registration outlive an account change."""
    lock_account_changes(db)
    # Individual sessions carry these claims; dependency overrides may supply
    # an identity without a credential, but cannot be reached through login.
    if user.get('credential_kind') != 'user':
        return
    account = db.query(User).filter(User.id == user.get('user_id')).populate_existing().first()
    valid = bool(account and account.is_active and account.login_name and account.password_hash
        and not account.must_change_password
        and account.session_version == user.get('session_version')
        and (account.username, account.user_type, account.project_site, account.user_type == 'admin') ==
            (user.get('username'), user.get('user_type'), user.get('project_site'), user.get('is_global_admin')))
    if valid and account.user_type == 'project_site':
        valid = db.query(ProjectSite.id).filter(
            ProjectSite.name == account.project_site, ProjectSite.is_active == True).first() is not None
    if not valid:
        db.rollback()
        raise HTTPException(401, 'Session expired. Sign in again.')


@router.post('/subscription-status')
def subscription_status(data: PushUnsubscribeIn, db: Session = Depends(get_db),
                        user: dict = Depends(get_current_user)):
    sub = db.query(PushSubscription).filter(PushSubscription.endpoint == data.endpoint.strip()).first()
    return {'enabled': bool(sub and _same_identity(sub, user))}


@router.get("/vapid-public-key")
def get_vapid_public_key(user: dict = Depends(get_current_user)):
    """Public application-server key the browser needs to create a subscription."""
    if not push_enabled():
        raise HTTPException(503, "Push notifications are not configured on this server")
    return {"public_key": VAPID_PUBLIC_KEY}


@router.post("/subscribe")
def subscribe(
    data: PushSubscribeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if not push_enabled():
        raise HTTPException(503, "Push notifications are not configured on this server")
    endpoint = data.endpoint.strip()
    if not valid_push_endpoint(endpoint):
        raise HTTPException(422, "Unsupported browser push service")

    _lock_current_account(db, user)
    sub = _locked_subscription(db, endpoint)
    if sub is not None and not _can_manage(sub, user, data.keys):
        raise HTTPException(403, "This subscription belongs to another account")
    if sub is None:
        sub = PushSubscription(endpoint=endpoint)
        db.add(sub)
    sub.p256dh = data.keys.p256dh
    sub.auth = data.keys.auth
    # Snapshot the subscriber's role/site so pushes are targeted like in-app
    # notifications. Re-subscribing (e.g. after switching accounts on a shared
    # device) overwrites the snapshot.
    sub.user_type = user.get("user_type")
    sub.user_id = user.get('user_id')
    sub.project_site = user.get("project_site")
    sub.is_global_admin = is_global_admin_user(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'Device notification settings changed. Try again.') from exc
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(
    data: PushUnsubscribeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = _locked_subscription(db, data.endpoint.strip())
    removed = False
    if sub is not None:
        if data.current_account_only and not _same_identity(sub, user):
            return {'ok': True, 'removed': False}
        if not _can_manage(sub, user, data.keys):
            raise HTTPException(403, "This subscription belongs to another account")
        db.delete(sub)
        removed = True
    db.commit()
    return {"ok": True, 'removed': removed}
