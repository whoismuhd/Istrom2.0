"""Administrator management of individual accounts."""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from db import get_db
from models import User, ProjectSite, PushSubscription
from api.schemas import UserCreate, UserUpdate, ManagedUserOut, PasswordReset
from api.dependencies import get_current_global_admin
from api.services.user_accounts import hash_password
from api.services.notification_hub import notification_hub
from api.routes.auth import lock_account_changes

router = APIRouter(prefix='/users', tags=['users'])


def _site(db, role, site, allow_inactive=False):
    if role == 'admin':
        if site:
            raise HTTPException(422, 'Administrators have access to all sites. Leave the project site empty.')
        return None
    query = db.query(ProjectSite.id).filter(ProjectSite.name == site)
    if not allow_inactive:
        query = query.filter(ProjectSite.is_active == True)
    if not site or not query.first():
        raise HTTPException(422, 'Assign the user to an active project site.')
    return site


def _account(db, user_id):
    account = db.query(User).filter(User.id == user_id, User.login_name.isnot(None),
                                    User.password_hash.isnot(None)).populate_existing().first()
    if not account:
        raise HTTPException(404, 'User not found.')
    return account


def _revoke(db, background_tasks, account):
    account.session_version += 1
    db.query(PushSubscription).filter(PushSubscription.user_id == account.id).delete(synchronize_session=False)
    background_tasks.add_task(notification_hub.revoke_user_sessions, account.id)


@router.get('', response_model=list[ManagedUserOut])
def list_users(db: Session = Depends(get_db), admin: dict = Depends(get_current_global_admin)):
    return db.query(User).filter(User.login_name.isnot(None), User.password_hash.isnot(None)).order_by(User.username, User.id).all()


@router.post('', response_model=ManagedUserOut)
def create_user(data: UserCreate, db: Session = Depends(get_db), admin: dict = Depends(get_current_global_admin)):
    if data.user_type == 'admin':
        raise HTTPException(409, 'The app uses one fixed administrator account. Add site users here.')
    lock_account_changes(db)
    site = _site(db, data.user_type, data.project_site)
    account = User(username=data.username, login_name=data.username,
                   password_hash=hash_password(data.password), user_type=data.user_type,
                   project_site=site, is_active=True, must_change_password=True, session_version=1)
    db.add(account)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'This username is already in use.')
    db.refresh(account)
    return account


@router.patch('/{user_id}', response_model=ManagedUserOut)
def update_user(user_id: int, data: UserUpdate, background_tasks: BackgroundTasks,
                db: Session = Depends(get_db), admin: dict = Depends(get_current_global_admin)):
    lock_account_changes(db)
    account = _account(db, user_id)
    if data.user_type != account.user_type:
        raise HTTPException(409, 'Account roles are fixed. Site users cannot become the administrator.')
    site = _site(db, data.user_type, data.project_site, allow_inactive=(not data.is_active and data.project_site == account.project_site))
    if account.id == admin.get('user_id') and (not data.is_active or data.user_type != 'admin'):
        raise HTTPException(409, 'You cannot disable your own account or remove your administrator role.')
    if account.is_active and account.user_type == 'admin' and (not data.is_active or data.user_type != 'admin'):
        others = db.query(User.id).filter(User.id != account.id, User.user_type == 'admin',
            User.is_active == True, User.password_hash.isnot(None), User.login_name.isnot(None)).first()
        if not others:
            raise HTTPException(409, 'Keep at least one active administrator.')
    changed = (account.project_site, account.is_active) != (site, data.is_active)
    account.project_site, account.is_active = site, data.is_active
    if changed:
        _revoke(db, background_tasks, account)
    db.commit()
    db.refresh(account)
    return account


@router.post('/{user_id}/reset-password')
def reset_password(user_id: int, data: PasswordReset, background_tasks: BackgroundTasks,
                   db: Session = Depends(get_db), admin: dict = Depends(get_current_global_admin)):
    lock_account_changes(db)
    account = _account(db, user_id)
    if account.id == admin.get('user_id'):
        raise HTTPException(409, 'Use Change password to update your own password.')
    account.password_hash = hash_password(data.password)
    account.must_change_password = True
    _revoke(db, background_tasks, account)
    db.commit()
    return {'ok': True}
