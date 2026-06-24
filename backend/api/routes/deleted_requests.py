"""Deleted requests routes."""
from typing import List
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from db import get_db
from models import DeletedRequest
from api.dependencies import get_current_admin, get_current_global_admin, enforce_project_site_scope

router = APIRouter(prefix="/deleted-requests", tags=["deleted-requests"])


@router.get("")
def list_deleted_requests(
    project_site: str = Query(None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    effective_site = enforce_project_site_scope(user, project_site)
    q = db.query(DeletedRequest)
    if effective_site:
        q = q.filter(DeletedRequest.project_site == effective_site)
    return q.order_by(DeletedRequest.deleted_at.desc()).all()


@router.delete("")
def clear_deleted_logs(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    db.query(DeletedRequest).delete()
    db.commit()
    return {"ok": True}
