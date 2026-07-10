"""Project sites routes."""
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from db import get_db
from models import ProjectSite, ProjectSiteAccessCode
from api.schemas import ProjectSiteCreate, ProjectSiteUpdate, ProjectSiteOut, ProjectSiteAccessCodeUpdate
from api.dependencies import get_current_global_admin
from api.services.auth_service import hash_access_code

router = APIRouter(prefix="/project-sites", tags=["project-sites"])


@router.get("", response_model=List[ProjectSiteOut])
def list_project_sites(db: Session = Depends(get_db), user: dict = Depends(get_current_global_admin)):
    sites = db.query(ProjectSite).filter(ProjectSite.is_active == True).all()
    out = []
    for ps in sites:
        pac = db.query(ProjectSiteAccessCode).filter(
            ProjectSiteAccessCode.project_site == ps.name
        ).first()
        data = {
            "id": ps.id,
            "name": ps.name,
            "description": ps.description,
            "created_at": ps.created_at,
            "user_code": "Configured" if pac and pac.user_code else "",
        }
        out.append(ProjectSiteOut(**data))
    return out


@router.post("", response_model=ProjectSiteOut)
def create_project_site(
    data: ProjectSiteCreate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    user_code = data.user_code.strip()
    if not user_code:
        raise HTTPException(422, "User access code cannot be empty")
    ps = ProjectSite(name=data.name, description=data.description)
    db.add(ps)
    db.commit()
    db.refresh(ps)
    pac = ProjectSiteAccessCode(
        project_site=data.name,
        admin_code="",  # Admin uses global
        user_code=hash_access_code(user_code),
        user_code_plain=user_code,
    )
    db.add(pac)
    db.commit()
    return ps


@router.patch("/{site_id}", response_model=ProjectSiteOut)
def update_project_site(
    site_id: int,
    data: ProjectSiteUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    ps = db.query(ProjectSite).filter(ProjectSite.id == site_id).first()
    if not ps:
        raise HTTPException(404, "Project site not found")
    old_name = ps.name
    if data.name:
        ps.name = data.name
    if data.description is not None:
        ps.description = data.description
    db.commit()
    # Update project_site_access_codes if name changed
    if data.name and old_name != data.name:
        pac = db.query(ProjectSiteAccessCode).filter(
            ProjectSiteAccessCode.project_site == old_name
        ).first()
        if pac:
            pac.project_site = data.name
            db.commit()
    db.refresh(ps)
    return ps


@router.delete("/{site_id}")
def delete_project_site(
    site_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    ps = db.query(ProjectSite).filter(ProjectSite.id == site_id).first()
    if not ps:
        raise HTTPException(404, "Project site not found")
    ps.is_active = False
    # Remove access code so users can no longer log in with this site
    db.query(ProjectSiteAccessCode).filter(
        ProjectSiteAccessCode.project_site == ps.name
    ).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@router.patch("/{site_id}/access-code")
def update_site_access_code(
    site_id: int,
    data: ProjectSiteAccessCodeUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    ps = db.query(ProjectSite).filter(ProjectSite.id == site_id).first()
    if not ps:
        raise HTTPException(404, "Project site not found")
    pac = db.query(ProjectSiteAccessCode).filter(
        ProjectSiteAccessCode.project_site == ps.name
    ).first()
    code = data.user_code.strip()
    if not code:
        raise HTTPException(422, "User access code cannot be empty")
    if pac:
        pac.user_code = hash_access_code(code)
        pac.user_code_plain = code
    else:
        pac = ProjectSiteAccessCode(
            project_site=ps.name,
            admin_code="",
            user_code=hash_access_code(code),
            user_code_plain=code,
        )
        db.add(pac)
    db.commit()
    return {"ok": True}


@router.get("/{site_id}/access-code")
def reveal_site_access_code(
    site_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    """Return the current user access code for a site (global admin only).

    user_code is null for codes set before retrievable storage existed —
    the bcrypt hash cannot be reversed, so those must be reset to be viewable.
    """
    ps = db.query(ProjectSite).filter(ProjectSite.id == site_id).first()
    if not ps:
        raise HTTPException(404, "Project site not found")
    pac = db.query(ProjectSiteAccessCode).filter(
        ProjectSiteAccessCode.project_site == ps.name
    ).first()
    configured = bool(pac and pac.user_code)
    return {
        "project_site": ps.name,
        "configured": configured,
        "user_code": pac.user_code_plain if (pac and pac.user_code_plain) else None,
    }
