"""Actuals routes."""
from typing import Optional, List
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session

from db import get_db
from models import Actual, Item
from api.schemas import ActualCreate, ActualOut
from api.dependencies import get_current_user, get_current_admin, enforce_project_site_scope

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
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    item = db.query(Item).filter(Item.id == data.item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    requested_site = data.project_site or item.project_site or user.get("project_site") or "Lifecamp Kafe"
    project_site = enforce_project_site_scope(user, requested_site) or "Lifecamp Kafe"
    if item.project_site and item.project_site != project_site:
        raise HTTPException(403, "Item does not belong to selected project site")
    actual = Actual(
        item_id=data.item_id,
        actual_qty=data.actual_qty,
        actual_cost=data.actual_cost,
        actual_date=data.actual_date,
        recorded_by=data.recorded_by,
        notes=data.notes,
        building_subtype=data.building_subtype,
        project_site=project_site,
    )
    db.add(actual)
    db.commit()
    db.refresh(actual)
    return actual


@router.delete("/{actual_id}")
def delete_actual(
    actual_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    a = db.query(Actual).filter(Actual.id == actual_id).first()
    if not a:
        raise HTTPException(404, "Actual not found")
    enforce_project_site_scope(user, a.project_site)
    db.delete(a)
    db.commit()
    return {"ok": True}
