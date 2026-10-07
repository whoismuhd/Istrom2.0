"""Items routes."""
from typing import Optional, List
from fastapi import APIRouter, Depends, Query, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import exists

from db import get_db
from models import Item, Request, Actual
from api.schemas import ItemCreate, ItemUpdate, ItemOut
from api.dependencies import get_current_user, get_current_admin, enforce_project_site_scope, enforce_record_scope, require_active_project_site
from api.services.notification_hub import notification_hub

router = APIRouter(prefix="/items", tags=["items"])


def _filter_items(db: Session, project_site: Optional[str], budget: Optional[str],
                  section: Optional[str], building_type: Optional[str]):
    q = db.query(Item)
    if project_site:
        q = q.filter(Item.project_site == project_site)
    if budget:
        q = q.filter(Item.budget == budget)
    if section:
        q = q.filter(Item.section == section)
    if building_type:
        q = q.filter(Item.building_type == building_type)
    return q


@router.get("", response_model=List[ItemOut])
def list_items(
    project_site: Optional[str] = Query(None),
    budget: Optional[str] = Query(None),
    section: Optional[str] = Query(None),
    building_type: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    effective_site = enforce_project_site_scope(user, project_site)
    q = _filter_items(db, effective_site, budget, section, building_type)
    return q.all()


@router.get("/{item_id}", response_model=ItemOut)
def get_item(item_id: int, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    enforce_record_scope(user, item.project_site)
    return item


@router.post("", response_model=ItemOut)
def create_item(
    data: ItemCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    requested_site = data.project_site or user.get("project_site")
    project_site = require_active_project_site(db, user, requested_site)
    item = Item(
        name=data.name,
        category=data.category,
        unit=data.unit,
        qty=data.qty,
        unit_cost=data.unit_cost,
        planned_qty=data.qty,
        planned_unit_cost=data.unit_cost,
        budget=data.budget,
        section=data.section,
        grp=data.grp,
        building_type=data.building_type,
        project_site=project_site,
    )
    db.add(item)
    db.flush()
    item.code = f"IT-{item.id}"
    db.commit()
    db.refresh(item)
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, item.project_site)
    return item


@router.patch("/{item_id}", response_model=ItemOut)
def update_item(
    item_id: int,
    data: ItemUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    enforce_record_scope(user, item.project_site)
    if data.expected_qty is not None:
        changes = data.model_dump(exclude_none=True, exclude={"expected_qty"})
        if changes:
            updated = db.query(Item).filter(Item.id == item.id, Item.qty == data.expected_qty).update(changes, synchronize_session="fetch")
            if not updated:
                db.rollback()
                raise HTTPException(409, "Availability changed while you were editing. Refresh Actuals and try again.")
            db.commit()
            db.refresh(item)
            background_tasks.add_task(notification_hub.broadcast_workspace_changed, item.project_site)
        return item
    if data.qty is not None:
        item.qty = data.qty
    if data.unit_cost is not None:
        item.unit_cost = data.unit_cost
    if data.planned_qty is not None:
        item.planned_qty = data.planned_qty
    if data.planned_unit_cost is not None:
        item.planned_unit_cost = data.planned_unit_cost
    db.commit()
    db.refresh(item)
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, item.project_site)
    return item


@router.delete("/{item_id}")
def delete_item(
    item_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    enforce_record_scope(user, item.project_site)
    has_requests = db.query(Request.id).filter(Request.item_id == item_id).first()
    has_actuals = db.query(Actual.id).filter(Actual.item_id == item_id).first()
    if has_requests or has_actuals:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete item because it is linked to requests or actuals.",
        )
    site = item.project_site
    removed = db.query(Item).filter(
        Item.id == item_id,
        ~exists().where(Request.item_id == item_id),
        ~exists().where(Actual.item_id == item_id),
    ).delete(synchronize_session=False)
    if not removed:
        db.rollback()
        raise HTTPException(409, 'This item changed or was linked to a request or actual. Refresh and try again.')
    db.commit()
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, site)
    return {"ok": True}
