"""Items routes."""
from typing import Optional, List
from decimal import Decimal
from datetime import timezone
from fastapi import APIRouter, Depends, Query, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import exists
from sqlalchemy.exc import IntegrityError

from db import get_db
from models import Item, Request, Actual
from api.schemas import ItemCreate, ItemUpdate, ItemOut
from api.dependencies import get_current_user, get_current_admin, enforce_project_site_scope, enforce_record_scope, require_active_project_site
from api.services.notification_hub import notification_hub
from api.services.inventory_records import finite_cost_total, lock_linked_item
from api.services.project_records import lock_project_records
from api.services.creation_receipts import claim_creation, retire_creation_receipts

router = APIRouter(prefix="/items", tags=["items"])


def _utc_creation_time(value):
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


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
    project_site = require_active_project_site(db, user, requested_site, lock=True)
    finite_cost_total(data.qty, data.unit_cost)
    payload = data.model_dump(exclude={'submission_key'})
    payload['project_site'] = project_site
    receipt, existing = claim_creation(db, user, 'item', data.submission_key, payload, Item)
    if existing is not None:
        enforce_record_scope(user, existing.project_site)
        return existing
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
    if receipt is not None:
        receipt.record_id = item.id
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
    lock_project_records(db, item.project_site, item)
    enforce_record_scope(user, item.project_site)
    lock_linked_item(db, item)
    if 'expected_created_at' in data.model_fields_set:
        if (data.expected_created_at is None or item.created_at is None
                or _utc_creation_time(data.expected_created_at) != _utc_creation_time(item.created_at)):
            db.rollback()
            raise HTTPException(409, 'This inventory item was replaced or its identity could not be verified. Refresh and choose the item again.')
    expected_fields = {
        'expected_qty': 'qty',
        'expected_unit_cost': 'unit_cost',
        'expected_planned_qty': 'planned_qty',
        'expected_planned_unit_cost': 'planned_unit_cost',
    }
    for expected_field, stored_field in expected_fields.items():
        expected = getattr(data, expected_field)
        if expected is not None and Decimal(str(getattr(item, stored_field))) != Decimal(str(expected)):
            db.rollback()
            detail = ('The original budget changed while you were editing. Refresh Inventory and review the current values.'
                      if stored_field.startswith('planned_')
                      else 'Availability or unit cost changed while you were editing. Refresh Actuals and review the current values.')
            raise HTTPException(409, detail)
    finite_cost_total(data.qty if data.qty is not None else item.qty,
                      data.unit_cost if data.unit_cost is not None else item.unit_cost)
    finite_cost_total(data.planned_qty if data.planned_qty is not None else item.planned_qty,
                      data.planned_unit_cost if data.planned_unit_cost is not None else item.planned_unit_cost,
                      'Budget total')
    changes = data.model_dump(exclude_none=True, exclude={*expected_fields, 'expected_created_at'})
    if changes:
        for field, value in changes.items():
            setattr(item, field, value)
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
    lock_project_records(db, item.project_site, item)
    enforce_record_scope(user, item.project_site)
    lock_linked_item(db, item)
    has_requests = db.query(Request.id).filter(Request.item_id == item_id).first()
    has_actuals = db.query(Actual.id).filter(Actual.item_id == item_id).first()
    if has_requests or has_actuals:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete item because it is linked to requests or actuals.",
        )
    site = item.project_site
    try:
        removed = db.query(Item).filter(
            Item.id == item_id,
            ~exists().where(Request.item_id == item_id),
            ~exists().where(Actual.item_id == item_id),
        ).delete(synchronize_session=False)
        if removed:
            retire_creation_receipts(db, 'item', item_id)
            db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'This item is linked to a request or actual. Refresh and review its records.') from exc
    if not removed:
        db.rollback()
        raise HTTPException(409, 'This item changed or was linked to a request or actual. Refresh and try again.')
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, site)
    return {"ok": True}
