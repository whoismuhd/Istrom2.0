"""Web Push subscription routes."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db import get_db
from models import PushSubscription
from api.dependencies import get_current_user, is_global_admin_user
from api.services.push_service import VAPID_PUBLIC_KEY, push_enabled

router = APIRouter(prefix="/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscribeIn(BaseModel):
    endpoint: str
    keys: PushKeys


class PushUnsubscribeIn(BaseModel):
    endpoint: str


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
    if not endpoint.startswith("https://"):
        raise HTTPException(422, "Invalid subscription endpoint")

    sub = db.query(PushSubscription).filter(PushSubscription.endpoint == endpoint).first()
    if sub is None:
        sub = PushSubscription(endpoint=endpoint)
        db.add(sub)
    sub.p256dh = data.keys.p256dh
    sub.auth = data.keys.auth
    # Snapshot the subscriber's role/site so pushes are targeted like in-app
    # notifications. Re-subscribing (e.g. after switching accounts on a shared
    # device) overwrites the snapshot.
    sub.user_type = user.get("user_type")
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
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == data.endpoint.strip()
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}
