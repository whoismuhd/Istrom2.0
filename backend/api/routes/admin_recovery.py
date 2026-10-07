"""Email recovery for the fixed administrator, without shared setup codes."""
from datetime import datetime, timedelta
import hashlib
import logging
import secrets

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from db import get_db
from models import AdminPasswordReset, User, PushSubscription, AccessLog
from api.account_policy import ADMIN_LOGIN_NAME
from api.routes.auth import lock_account_changes
from api.schemas import AdminRecoveryRequest, AdminRecoveryReset
from api.services import recovery_mail
from api.services.notification_hub import notification_hub
from api.services.rate_limit import LoginRateLimiter
from api.services.user_accounts import hash_password, verify_password

router = APIRouter(prefix='/auth/admin-recovery', tags=['auth'])
logger = logging.getLogger(__name__)
request_limiter = LoginRateLimiter(max_attempts=5, window_seconds=900, lockout_seconds=900)
reset_limiter = LoginRateLimiter(max_attempts=8, window_seconds=900, lockout_seconds=900)
INVALID_LINK = 'This reset link is invalid or has expired. Request a new link.'


def _throttle(request, limiter):
    key = request.client.host if request.client else 'unknown'
    remaining = limiter.seconds_until_unlocked(key)
    if remaining is not None:
        raise HTTPException(429, f'Too many attempts. Try again in {remaining} seconds.')
    limiter.record_failure(key)


def _admin(db):
    return db.query(User).filter(User.login_name == ADMIN_LOGIN_NAME, User.user_type == 'admin',
        User.is_active == True, User.password_hash.isnot(None)).populate_existing().first()


@router.post('/request')
def request_reset(data: AdminRecoveryRequest, request: Request, db: Session = Depends(get_db)):
    _throttle(request, request_limiter)
    config = recovery_mail.get_recovery_config()
    if config is None:
        raise HTTPException(503, 'Admin password recovery is not configured yet.')
    lock_account_changes(db)
    account = _admin(db)
    response = {'ok': True, 'message': 'If admin recovery is available, a reset link will be sent to the saved email address.'}
    if account is None:
        return response
    now = datetime.utcnow()
    recent = db.query(AdminPasswordReset).filter(AdminPasswordReset.user_id == account.id,
        AdminPasswordReset.created_at > now - timedelta(minutes=15)).order_by(AdminPasswordReset.created_at.desc()).all()
    if recent and recent[0].created_at > now - timedelta(seconds=60):
        raise HTTPException(429, 'Wait one minute before requesting another reset link.')
    if len(recent) >= 5:
        raise HTTPException(429, 'Too many reset requests. Try again in 15 minutes.')
    db.query(AdminPasswordReset).filter(AdminPasswordReset.created_at < now - timedelta(days=1)).delete(synchronize_session=False)
    token = secrets.token_urlsafe(32)
    record = AdminPasswordReset(user_id=account.id, token_hash=hashlib.sha256(token.encode('ascii')).hexdigest(),
        recipient_hash=config.recipient_hash, session_version=account.session_version,
        created_at=now, expires_at=now + timedelta(minutes=15))
    db.add(record)
    db.commit()
    try:
        recovery_mail.send_reset_link(config, token)
    except (OSError, ValueError):
        db.query(AdminPasswordReset).filter(AdminPasswordReset.id == record.id).update(
            {AdminPasswordReset.used_at: datetime.utcnow()}, synchronize_session=False)
        db.commit()
        logger.error('Admin password reset link could not be delivered.')
        raise HTTPException(503, 'Could not send the reset email. Try again later.') from None
    return response


@router.post('/reset')
def reset_password(data: AdminRecoveryReset, request: Request, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db)):
    _throttle(request, reset_limiter)
    config = recovery_mail.get_recovery_config()
    if config is None:
        raise HTTPException(503, 'Admin password recovery is not configured yet.')
    # The same database lock serializes resets, changes and account updates.
    # Session versions also invalidate links issued before a password change.
    lock_account_changes(db)
    account = _admin(db)
    now = datetime.utcnow()
    record = db.query(AdminPasswordReset).filter(
        AdminPasswordReset.token_hash == hashlib.sha256(data.token.encode('ascii')).hexdigest(),
        AdminPasswordReset.used_at.is_(None), AdminPasswordReset.expires_at > now,
    ).populate_existing().first()
    if (account is None or record is None or record.user_id != account.id or
            record.session_version != account.session_version or record.recipient_hash != config.recipient_hash):
        raise HTTPException(400, INVALID_LINK)
    if verify_password(data.new_password, account.password_hash):
        raise HTTPException(422, 'Choose a password different from your current password.')
    account.password_hash = hash_password(data.new_password)
    account.must_change_password = False
    account.session_version += 1
    db.query(AdminPasswordReset).filter(AdminPasswordReset.user_id == account.id,
        AdminPasswordReset.used_at.is_(None)).update({AdminPasswordReset.used_at: now}, synchronize_session=False)
    db.query(PushSubscription).filter(PushSubscription.user_id == account.id).delete(synchronize_session=False)
    db.add(AccessLog(user_name=account.username, success=True, role='admin_password_reset'))
    db.commit()
    background_tasks.add_task(notification_hub.revoke_user_sessions, account.id)
    background_tasks.add_task(recovery_mail.notify_password_reset, config)
    return {'ok': True}
