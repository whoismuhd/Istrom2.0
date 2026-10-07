"""Project sites routes."""
from typing import List
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy import func
from sqlalchemy.orm import Session

from db import get_db
from models import ProjectSite, ProjectSiteAccessCode, Item, Request, Actual, Notification, DeletedRequest, User, PushSubscription
from api.schemas import ProjectSiteCreate, ProjectSiteUpdate, ProjectSiteOut
from api.dependencies import get_current_global_admin
from api.services.notification_hub import notification_hub
from api.routes.auth import lock_account_changes
from api.services.project_records import lock_project_records

router = APIRouter(prefix="/project-sites", tags=["project-sites"])


def _validate_site_name(db: Session, name: str, site_id: int | None = None) -> str:
    name = name.strip()
    if not name:
        raise HTTPException(422, "Project site name cannot be empty")
    q = db.query(ProjectSite).filter(func.lower(ProjectSite.name) == name.lower())
    if site_id is not None:
        q = q.filter(ProjectSite.id != site_id)
    if q.first():
        raise HTTPException(409, "A project site with this name already exists")
    return name


@router.get("", response_model=List[ProjectSiteOut])
def list_project_sites(db: Session = Depends(get_db), user: dict = Depends(get_current_global_admin)):
    sites = db.query(ProjectSite).filter(ProjectSite.is_active == True).all()
    out = []
    for ps in sites:
        data = {
            "id": ps.id,
            "name": ps.name,
            "description": ps.description,
            "created_at": ps.created_at,
        }
        out.append(ProjectSiteOut(**data))
    return out


@router.post("", response_model=ProjectSiteOut)
def create_project_site(
    data: ProjectSiteCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    lock_account_changes(db)
    name = _validate_site_name(db, data.name)
    ps = ProjectSite(name=name, description=data.description)
    db.add(ps)
    db.commit()
    db.refresh(ps)
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, None)
    return ps


@router.patch("/{site_id}", response_model=ProjectSiteOut)
def update_project_site(
    site_id: int,
    data: ProjectSiteUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    lock_account_changes(db)
    ps = db.query(ProjectSite).filter(ProjectSite.id == site_id).first()
    if not ps:
        raise HTTPException(404, "Project site not found")
    lock_project_records(db, ps.name)
    old_name = ps.name
    if data.name is not None:
        ps.name = _validate_site_name(db, data.name, site_id)
    if data.description is not None:
        ps.description = data.description
    if old_name != ps.name:
        pac = db.query(ProjectSiteAccessCode).filter(
            ProjectSiteAccessCode.project_site == old_name
        ).first()
        if pac:
            pac.project_site = ps.name
            pac.session_version += 1
        for model in (Item, Request, Actual, Notification, DeletedRequest, User, PushSubscription):
            changes = {model.project_site: ps.name}
            if model is User:
                changes[User.session_version] = User.session_version + 1
            db.query(model).filter(model.project_site == old_name).update(
                changes, synchronize_session="fetch",
            )
        background_tasks.add_task(notification_hub.revoke_sessions, old_name)
    db.commit()
    db.refresh(ps)
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, None)
    return ps


@router.delete("/{site_id}")
def delete_project_site(
    site_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    lock_account_changes(db)
    ps = db.query(ProjectSite).filter(ProjectSite.id == site_id).first()
    if not ps:
        raise HTTPException(404, "Project site not found")
    lock_project_records(db, ps.name)
    ps.is_active = False
    # End every assigned user's session and remove retired shared credentials.
    db.query(User).filter(User.project_site == ps.name).update(
        {User.session_version: User.session_version + 1}, synchronize_session='fetch')
    db.query(ProjectSiteAccessCode).filter(
        ProjectSiteAccessCode.project_site == ps.name
    ).delete(synchronize_session=False)
    db.query(PushSubscription).filter(PushSubscription.project_site == ps.name).delete(synchronize_session=False)
    db.commit()
    background_tasks.add_task(notification_hub.revoke_sessions, ps.name)
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, None)
    return {"ok": True}
