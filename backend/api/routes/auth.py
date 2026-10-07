"""Personal login, initial administrator setup, and password changes."""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from db import get_db
from models import User, AccessCode, AccessLog, ProjectSite, PushSubscription
from api.schemas import LoginRequest, LoginResponse, AdminSetupRequest, PasswordChange
from api.services.auth_service import verify_access_code
from api.services.user_accounts import admin_accounts_exist, verify_password, hash_password, login_response
from api.services.rate_limit import login_limiter
from api.dependencies import get_authenticated_user
from api.services.notification_hub import notification_hub
from api.account_policy import ADMIN_USERNAME, ADMIN_LOGIN_NAME

router = APIRouter(prefix='/auth', tags=['auth'])


def lock_account_changes(db):
    """Serialize administrator changes and first-account setup, including SQLite."""
    credential = db.query(AccessCode).first()
    if credential:
        db.query(AccessCode).filter(AccessCode.id == credential.id).update(
            {AccessCode.session_version: AccessCode.session_version}, synchronize_session=False)
    return credential


def _keys(request, username):
    host = request.client.host if request.client else 'unknown'
    return (f'ip:{host}', f'account:{username.strip().lower()}')


def _check_limit(keys):
    for key in keys:
        remaining = login_limiter.seconds_until_unlocked(key)
        if remaining is not None:
            raise HTTPException(429, f'Too many failed attempts. Try again in {remaining} seconds.')


def _record_attempt(db, keys, username, success, role='unknown'):
    for key in keys:
        (login_limiter.record_success if success else login_limiter.record_failure)(key)
    # No password, access code, or partial secret is recorded.
    db.add(AccessLog(user_name=username[:255], success=success, role=role))
    db.commit()


def _account_label(account):
    return account.username


@router.get('/setup-status')
def setup_status(db: Session = Depends(get_db)):
    return {'setup_required': not admin_accounts_exist(db)}


@router.get('/me')
def current_identity(user: dict = Depends(get_authenticated_user)):
    return {key: user.get(key) for key in (
        'user_id', 'username', 'user_type', 'project_site', 'is_global_admin',
        'must_change_password', 'needs_account_setup',
    )}


@router.post('/setup', response_model=LoginResponse)
def setup_admin(data: AdminSetupRequest, request: Request, background_tasks: BackgroundTasks,
                db: Session = Depends(get_db)):
    keys = _keys(request, 'initial-administrator-setup')
    _check_limit(keys)
    credential = lock_account_changes(db)
    if admin_accounts_exist(db):
        raise HTTPException(409, 'Administrator setup is complete. Sign in with your individual account.')
    if not credential or not verify_access_code(data.access_code, credential.admin_code):
        _record_attempt(db, keys, 'Administrator setup', False)
        raise HTTPException(401, 'The existing administrator code is incorrect.')
    account = User(username=ADMIN_USERNAME, login_name=ADMIN_LOGIN_NAME, full_name=None,
                   password_hash=hash_password(data.password), user_type='admin', project_site=None,
                   is_active=True, must_change_password=False, session_version=1,
                   last_login_at=datetime.utcnow())
    db.add(account)
    # Retire shared-login sessions and subscriptions; keep project history.
    credential.session_version += 1
    db.query(PushSubscription).filter(PushSubscription.user_id.is_(None)).delete(synchronize_session=False)
    try:
        db.flush()
        _record_attempt(db, keys, _account_label(account), True, 'admin')
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'This username is already in use.')
    background_tasks.add_task(notification_hub.revoke_sessions, None)
    return login_response(account)


@router.post('/login', response_model=LoginResponse)
def login(data: LoginRequest, request: Request, db: Session = Depends(get_db)):
    username = data.username.strip().lower()
    keys = _keys(request, username)
    _check_limit(keys)
    account = db.query(User).filter(User.login_name == username).first()
    correct_password = verify_password(data.password, account.password_hash if account else None)
    valid = correct_password and account and account.is_active and account.user_type == data.user_type
    if valid and account.user_type == 'project_site':
        valid = db.query(ProjectSite.id).filter(ProjectSite.name == account.project_site,
                                                ProjectSite.is_active == True).first() is not None
    if not valid:
        _record_attempt(db, keys, username, False)
        raise HTTPException(401, 'Invalid password.' if data.user_type == 'admin' else 'Invalid username or password.')
    account.last_login_at = datetime.utcnow()
    _record_attempt(db, keys, _account_label(account), True, account.user_type)
    return login_response(account)


@router.post('/password', response_model=LoginResponse)
def change_password(data: PasswordChange, request: Request, background_tasks: BackgroundTasks,
                    db: Session = Depends(get_db), user: dict = Depends(get_authenticated_user)):
    if user.get('credential_kind') != 'user':
        raise HTTPException(403, 'Set up your individual account first.')
    keys = _keys(request, user['username'])
    _check_limit(keys)
    lock_account_changes(db)
    account = db.query(User).filter(User.id == user['user_id']).populate_existing().one()
    if account.session_version != user['session_version'] or not account.is_active:
        raise HTTPException(401, 'Session expired. Sign in again.')
    if not verify_password(data.current_password, account.password_hash):
        _record_attempt(db, keys, account.username, False, account.user_type)
        raise HTTPException(400, 'Your current password is incorrect.')
    if verify_password(data.new_password, account.password_hash):
        raise HTTPException(422, 'Choose a password different from your current password.')
    account.password_hash = hash_password(data.new_password)
    account.must_change_password = False
    account.session_version += 1
    db.query(PushSubscription).filter(PushSubscription.user_id == account.id).delete(synchronize_session=False)
    _record_attempt(db, keys, _account_label(account), True, account.user_type)
    background_tasks.add_task(notification_hub.revoke_user_sessions, account.id)
    return login_response(account)
