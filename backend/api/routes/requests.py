"""Requests routes."""
from typing import Optional, List
from datetime import datetime
from fastapi import APIRouter, Depends, Query, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from db import get_db
from models import Request, Item, Notification, Actual, DeletedRequest
from api.schemas import RequestCreate, RequestStatusUpdate, RequestOut
from api.dependencies import get_current_user, get_current_admin, enforce_project_site_scope, enforce_record_scope, require_active_project_site
from api.services.notification_hub import notification_hub
from api.services.push_service import send_push_for_notification
from api.services.inventory_records import lock_linked_item

router = APIRouter(prefix="/requests", tags=["requests"])
ALLOWED_REQUEST_STATUSES = {"Pending", "Approved", "Rejected"}


def _queue_notification_created_event(background_tasks: BackgroundTasks, notif: Notification):
    background_tasks.add_task(
        notification_hub.broadcast_notification_created,
        notif.id,
        notif.notification_type,
        notif.project_site,
    )
    # Second delivery channel: Web Push to subscribed devices (no-op unless
    # VAPID keys are configured). Same visibility rules as the hub.
    background_tasks.add_task(
        send_push_for_notification,
        notif.id,
        notif.notification_type,
        notif.project_site,
        notif.title,
        notif.message,
    )


@router.get("", response_model=List[RequestOut])
def list_requests(
    status: Optional[str] = Query(None),
    project_site: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    effective_site = enforce_project_site_scope(user, project_site)
    q = db.query(Request)
    if status:
        q = q.filter(Request.status == status)
    if effective_site:
        q = q.filter(Request.project_site == effective_site)
    rows = q.order_by(Request.created_at.desc()).all()
    out = []
    for r in rows:
        item = db.query(Item).filter(Item.id == r.item_id).first()
        d = RequestOut(
            id=r.id, ts=r.ts, section=r.section, item_id=r.item_id,
            item_unit=item.unit if item else None,
            available_qty=max(0, item.qty) if item else None,
            shortage_qty=max(0, r.qty - max(0, item.qty)) if item and r.status == "Pending" else 0,
            approved_shortage_qty=r.approved_shortage_qty,
            item_name=item.name if item else str(r.item_id),
            item_budget_scope=item.budget_scope if item else None,
            budget=item.budget if item else None,
            qty=r.qty, requested_by=r.requested_by, note=r.note,
            building_subtype=r.building_subtype, status=r.status,
            approved_by=r.approved_by, current_price=r.current_price,
            project_site=r.project_site, created_at=r.created_at, updated_at=r.updated_at,
        )
        out.append(d)
    return out


@router.post("", response_model=RequestOut)
def create_request(
    data: RequestCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if user.get('user_type') != 'project_site':
        raise HTTPException(403, 'Only site users can submit requests. Administrators review and approve them.')
    if data.qty <= 0:
        raise HTTPException(422, "Quantity must be greater than zero")
    item = db.query(Item).filter(Item.id == data.item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    lock_linked_item(db, item)
    requested_site = data.project_site or item.project_site or user.get("project_site")
    project_site = require_active_project_site(db, user, requested_site)
    if item.project_site != project_site:
        raise HTTPException(403, "Item does not belong to selected project site")
    requested_by = user.get("username") or "Unknown"

    req = Request(
        item_id=data.item_id,
        qty=data.qty,
        requested_by=requested_by,
        requested_by_user_id=user.get('user_id'),
        current_price=data.current_price,
        note=data.note,
        building_subtype=data.building_subtype,
        project_site=project_site,
        status="Pending",
        section=item.category,
    )
    db.add(req)
    db.flush()

    # Notifications: admin (new_request), project site (request_submitted)
    # Get admin users - for now we create for all project sites / global
    budget_str = f" (Budget: {item.budget})" if item.budget else ""
    btype_str = f", Building: {data.building_subtype}" if data.building_subtype else ""
    notif_admin = Notification(
        notification_type="new_request",
        title="New Request",
        message=f"Request for {item.name} x {data.qty} by {requested_by}.{budget_str}{btype_str}",
        item_name=item.name,
        qty=data.qty,
        budget=item.budget,
        building_subtype=data.building_subtype,
        request_id=req.id,
        project_site=project_site,
    )
    db.add(notif_admin)

    notif_site = Notification(
        notification_type="request_submitted",
        title="Request Submitted",
        message=f"Your request for {item.name} x {data.qty} has been submitted.{budget_str}{btype_str}",
        item_name=item.name,
        qty=data.qty,
        budget=item.budget,
        building_subtype=data.building_subtype,
        request_id=req.id,
        project_site=project_site,
    )
    db.add(notif_site)
    db.commit()
    db.refresh(req)
    _queue_notification_created_event(background_tasks, notif_admin)
    _queue_notification_created_event(background_tasks, notif_site)

    return req


@router.patch("/{req_id}/status", response_model=RequestOut)
def update_request_status(
    req_id: int,
    data: RequestStatusUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    req = db.query(Request).filter(Request.id == req_id).first()
    if not req:
        raise HTTPException(404, "Request not found")
    enforce_record_scope(user, req.project_site)

    if data.status not in ALLOWED_REQUEST_STATUSES:
        raise HTTPException(422, "Invalid status")
    item = db.query(Item).filter(Item.id == req.item_id).first()
    old_status = req.status
    new_status = data.status
    status_changed = old_status != new_status
    approved_by = user.get("username") or "Admin"
    if not status_changed:
        return req
    if (old_status == "Approved" or new_status == "Approved") and not item:
        raise HTTPException(409, "The linked inventory item is missing; this request cannot be approved or reversed.")
    # Claim this exact version of the request before changing stock. A second
    # approval or reversal must not apply effects from a stale read.
    claimed = db.query(Request).filter(
        Request.id == req.id, Request.status == old_status,
        Request.updated_at == req.updated_at,
    ).update({
        Request.status: new_status,
        Request.approved_by: None if new_status == "Pending" else approved_by,
        Request.approved_by_user_id: None if new_status == 'Pending' else user.get('user_id'),
        Request.approved_shortage_qty: 0,
        Request.updated_at: datetime.utcnow(),
    }, synchronize_session="fetch")
    if not claimed:
        db.rollback()
        raise HTTPException(409, "This request was changed by another user. Refresh and try again.")

    # Revert inventory/actuals if an approved request is moved away from Approved
    if old_status == "Approved" and new_status != "Approved":
        if item:
            db.query(Item).filter(Item.id == item.id).update(
                {Item.qty: Item.qty + req.qty}, synchronize_session="fetch",
            )
        db.query(Actual).filter(Actual.request_id == req.id).delete(synchronize_session=False)

    # Apply inventory/actuals if request is newly approved
    if old_status != "Approved" and new_status == "Approved":
        if item:
            issued = db.query(Item).filter(Item.id == item.id).update(
                {Item.qty: Item.qty - req.qty}, synchronize_session="fetch",
            )
            if not issued:
                db.rollback()
                raise HTTPException(409, "The linked inventory item is missing; this request cannot be approved.")
            db.refresh(item)
            # Use the balance after the atomic deduction, including any other
            # committed approvals. Record only this request's uncovered amount.
            available_before = item.qty + req.qty
            req.approved_shortage_qty = max(0, req.qty - max(0, available_before))

        cost = req.current_price if req.current_price is not None else (item.unit_cost if item else 0)
        actual = db.query(Actual).filter(Actual.request_id == req.id).first()
        if actual:
            actual.item_id = req.item_id
            actual.actual_qty = req.qty
            actual.actual_cost = req.qty * cost
            actual.actual_date = datetime.utcnow()
            actual.recorded_by = approved_by
            actual.building_subtype = req.building_subtype
            actual.project_site = req.project_site
        else:
            actual = Actual(
                item_id=req.item_id,
                request_id=req.id,
                actual_qty=req.qty,
                actual_cost=req.qty * cost,
                actual_date=datetime.utcnow(),
                recorded_by=approved_by,
                building_subtype=req.building_subtype,
                project_site=req.project_site,
            )
            db.add(actual)

    status_notif = None

    if status_changed and new_status == "Approved":
        budget_str = f" (Budget: {item.budget})" if item and item.budget else ""
        btype_str = f", Building: {req.building_subtype}" if req.building_subtype else ""
        shortage_str = f" Approved over quantity: {req.approved_shortage_qty:g} {item.unit}." if req.approved_shortage_qty > 0 else ""
        notif = Notification(
            notification_type="request_approved",
            title="Request Approved Over Quantity" if req.approved_shortage_qty > 0 else "Request Approved",
            message=f"Your request for {item.name if item else 'item'} x {req.qty} was approved.{budget_str}{btype_str}{shortage_str}",
            item_name=item.name if item else None,
            qty=req.qty,
            budget=item.budget if item else None,
            building_subtype=req.building_subtype,
            request_id=req.id,
            project_site=req.project_site,
        )
        db.add(notif)
        status_notif = notif
    elif status_changed and new_status == "Rejected":
        budget_str = f" (Budget: {item.budget})" if item and item.budget else ""
        btype_str = f", Building: {req.building_subtype}" if req.building_subtype else ""
        notif = Notification(
            notification_type="request_rejected",
            title="Request Rejected",
            message=f"Your request for {item.name if item else 'item'} x {req.qty} was rejected.{budget_str}{btype_str}",
            item_name=item.name if item else None,
            qty=req.qty,
            budget=item.budget if item else None,
            building_subtype=req.building_subtype,
            request_id=req.id,
            project_site=req.project_site,
        )
        db.add(notif)
        status_notif = notif

    db.commit()
    db.refresh(req)
    if status_notif:
        _queue_notification_created_event(background_tasks, status_notif)
    else:
        background_tasks.add_task(notification_hub.broadcast_workspace_changed, req.project_site)
    return req


@router.delete("/{req_id}")
def delete_request(
    req_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    req = db.query(Request).filter(Request.id == req_id).first()
    if not req:
        raise HTTPException(404, "Request not found")
    enforce_record_scope(user, req.project_site)
    item = db.query(Item).filter(Item.id == req.item_id).first()
    item_name = item.name if item else "Unknown"

    if req.status == "Approved" and not item:
        raise HTTPException(409, "The linked inventory item is missing; this request cannot be reversed.")
    # Claim deletion too, so a simultaneous reversal/deletion restores stock once.
    claimed = db.query(Request).filter(
        Request.id == req.id, Request.status == req.status,
        Request.updated_at == req.updated_at,
    ).update({Request.updated_at: datetime.utcnow()}, synchronize_session=False)
    if not claimed:
        db.rollback()
        raise HTTPException(409, "This request was changed by another user. Refresh and try again.")

    # If approved, remove the auto-created actual
    if req.status == "Approved":
        if item:
            db.query(Item).filter(Item.id == item.id).update(
                {Item.qty: Item.qty + req.qty}, synchronize_session="fetch",
            )
        db.query(Actual).filter(Actual.request_id == req.id).delete(synchronize_session=False)

    budget = item.budget if item else None
    dr = DeletedRequest(
        req_id=req.id,
        item_name=item_name,
        qty=req.qty,
        requested_by=req.requested_by,
        budget=budget,
        building_subtype=req.building_subtype,
        status=req.status,
        deleted_by=user.get("username", "Admin"),
        project_site=req.project_site,
    )
    db.add(dr)
    db.query(Notification).filter(Notification.request_id == req.id).update(
        {Notification.request_id: None}, synchronize_session=False,
    )
    site = req.project_site
    db.delete(req)
    db.commit()
    background_tasks.add_task(notification_hub.broadcast_workspace_changed, site)
    return {"ok": True}
