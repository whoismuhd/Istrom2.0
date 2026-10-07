"""Web Push subscription routes."""
import hmac
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from db import get_db
from models import PushSubscription
from api.dependencies import get_current_user, is_global_admin_user
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


def _can_manage(sub, user, keys) -> bool:
    same_identity = (
        sub.user_id == user.get('user_id')
        and
        sub.user_type == user.get("user_type")
        and sub.project_site == user.get("project_site")
        and bool(sub.is_global_admin) == is_global_admin_user(user)
    )
    # The browser's secret proves ownership when changing accounts on a device.
    owns_device = keys is not None and hmac.compare_digest(sub.auth, keys.auth) and hmac.compare_digest(sub.p256dh, keys.p256dh)
    return same_identity or owns_device


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

    sub = db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).first()
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
    db.commit()
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(
    data: PushUnsubscribeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = db.query(PushSubscription).filter(PushSubscription.endpoint == data.endpoint.strip()).first()
    if sub is not None:
        if not _can_manage(sub, user, data.keys):
            raise HTTPException(403, "This subscription belongs to another account")
        db.delete(sub)
    db.commit()
    return {"ok": True}
