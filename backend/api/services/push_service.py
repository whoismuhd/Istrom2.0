"""Web Push delivery for notifications.

Second delivery channel next to the WebSocket hub: sends a system push to
subscribed devices (via the browser vendors' push services) so users are
notified even when the app is closed. Targeting mirrors the hub's
_can_receive_notification rules exactly.

Requires VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY (raw base64url strings) and
VAPID_SUBJECT (mailto:...) in the environment. When unset, sending is a no-op
so the app runs unchanged without push configured.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from pywebpush import WebPushException, webpush
from sqlalchemy import and_, exists, or_
from api.services.push_security import valid_push_endpoint, PushSession

logger = logging.getLogger("istrom.push")

VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "")
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:admin@istrom.local")


def push_enabled() -> bool:
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY)


def subscription_can_receive(
    *,
    user_type: Optional[str],
    project_site: Optional[str],
    is_global_admin: bool,
    notification_type: str,
    notification_site: Optional[str],
) -> bool:
    """Same visibility rules as notification_hub._can_receive_notification."""
    if is_global_admin:
        return notification_type != "request_submitted"
    if user_type == "admin":
        return (
            bool(project_site)
            and project_site == notification_site
            and notification_type != "request_submitted"
        )
    if user_type == "project_site":
        return (
            bool(project_site)
            and project_site == notification_site
            and notification_type != "new_request"
        )
    return False


def _current_account_access():
    """Require the saved device identity to still match an active account."""
    from models import ProjectSite, PushSubscription, User

    active_site = exists().where(ProjectSite.name == User.project_site,
        ProjectSite.is_active == True).correlate(User)
    same_site = or_(User.project_site == PushSubscription.project_site,
        and_(User.project_site.is_(None), PushSubscription.project_site.is_(None)))
    global_admin = and_(User.user_type == 'admin', User.project_site.is_(None))
    return exists().where(
        User.id == PushSubscription.user_id, User.is_active == True,
        User.must_change_password == False, User.login_name.isnot(None), User.password_hash.isnot(None),
        User.user_type == PushSubscription.user_type, same_site,
        PushSubscription.is_global_admin == global_admin,
        or_(global_admin, and_(User.user_type == 'project_site', active_site)),
    ).correlate(PushSubscription)


def send_push_for_notification(
    notification_id: int,
    notification_type: str,
    project_site: Optional[str],
    title: str,
    message: Optional[str],
) -> None:
    """Send a push to every subscription allowed to see this notification.

    Runs as a background task; opens its own DB session. Dead subscriptions
    (endpoint gone at the push service) are pruned.
    """
    if not push_enabled():
        return

    # Local import so the module stays importable in tests without app context.
    from db import SessionLocal
    from models import PushSubscription

    payload = json.dumps({
        "title": title,
        "body": message or "",
        "notification_type": notification_type,
        "notification_id": notification_id,
        "url": "/notifications",
    })

    db = SessionLocal()
    push_session = PushSession()
    try:
        subscription_ids = db.query(PushSubscription.id).order_by(PushSubscription.id).all()
        stale_ids = []
        revoked_ids = []
        for (subscription_id,) in subscription_ids:
            # Check each recipient immediately before its delivery. An account
            # can be disabled while earlier devices are waiting on push services.
            sub = db.query(PushSubscription).filter(PushSubscription.id == subscription_id,
                _current_account_access()).populate_existing().first()
            if sub is None:
                revoked_ids.append(subscription_id)
                continue
            if not valid_push_endpoint(sub.endpoint):
                stale_ids.append(sub.id)
                continue
            if not subscription_can_receive(
                user_type=sub.user_type,
                project_site=sub.project_site,
                is_global_admin=bool(sub.is_global_admin),
                notification_type=notification_type,
                notification_site=project_site,
            ):
                continue
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub.endpoint,
                        "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                    },
                    data=payload,
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": VAPID_SUBJECT},
                    ttl=3600,
                    timeout=10,
                    requests_session=push_session,
                )
            except WebPushException as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status in (404, 410):
                    stale_ids.append(sub.id)  # subscription expired/unsubscribed
                else:
                    logger.warning("push delivery failed (status %s)", status)
            except Exception as exc:  # never let push break the caller
                logger.warning("push delivery error (%s)", type(exc).__name__)

        if revoked_ids:
            # A device re-registered during delivery may now be valid. Prune
            # only rows whose current owner still has no matching access.
            db.query(PushSubscription).filter(PushSubscription.id.in_(revoked_ids),
                ~_current_account_access()).delete(synchronize_session=False)
        if stale_ids:
            db.query(PushSubscription).filter(PushSubscription.id.in_(stale_ids)).delete(
                synchronize_session=False
            )
        if stale_ids or revoked_ids:
            db.commit()
    finally:
        push_session.close()
        db.close()
