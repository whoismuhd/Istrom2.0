"""Actuals routes."""
from typing import Optional, List
from fastapi import APIRouter, Depends, Query, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from db import get_db
from models import Actual, Item
from api.schemas import ActualCreate, ActualOut
from api.dependencies import get_current_user, get_current_admin, enforce_project_site_scope, enforce_record_scope, require_active_project_site
from api.services.notification_hub import notification_hub
from api.services.inventory_records import lock_linked_item
from api.services.project_records import lock_project_records

router = APIRouter(prefix="/actuals", tags=["actuals"])


@router.get("", response_model=List[ActualOut])
def list_actuals(
    project_site: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    effective_site = enforce_project_site_scope(user, project_site)
    q = db.query(Actual)
    if effective_site:
        q = q.filter(Actual.project_site == effective_site)
    return q.all()


@router.post("", response_model=ActualOut)
def create_actual(
    data: ActualCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    item = db.query(Item).filter(Item.id == data.item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    lock_project_records(db, item.project_site, item)
    lock_linked_item(db, item)
    requested_site = data.project_site or item.project_site or user.get("project_site")
    project_site = require_active_project_site(db, user, requested_site)
    if item.project_site != project_site:
        raise HTTPException(403, "Item does not belong to selected project site")
    actual = Actual(
        item_id=data.item_id,
        actual_qty=data.actual_qty,
        actual_cost=data.actual_cost,
        actual_date=data.actual_date,
        recorded_by=user.get("username") or "Admin",
        notes=data.notes,
        building_subtype=data.building_subtype,
        project_site=project_site,
    )
    db.add(actual)
    db.commit()
    db.refresh(actual)
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, actual.project_site)
    return actual


@router.delete("/{actual_id}")
def delete_actual(
    actual_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    a = db.query(Actual).filter(Actual.id == actual_id).first()
    if not a:
        raise HTTPException(404, "Actual not found")
    lock_project_records(db, a.project_site, a)
    enforce_record_scope(user, a.project_site)
    if a.request_id is not None:
        raise HTTPException(409, "This actual is linked to an approved request. Reverse or delete the request to adjust stock and actuals together.")
    site = a.project_site
    db.delete(a)
    db.commit()
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, site)
    return {"ok": True}
