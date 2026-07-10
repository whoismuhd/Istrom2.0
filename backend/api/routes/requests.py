"""Requests routes."""
from typing import Optional, List
from datetime import datetime
from fastapi import APIRouter, Depends, Query, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from db import get_db
from models import Request, Item, Notification, Actual, DeletedRequest
from api.schemas import RequestCreate, RequestStatusUpdate, RequestOut
from api.dependencies import get_current_user, get_current_admin, enforce_project_site_scope
from api.services.notification_hub import notification_hub
from api.services.push_service import send_push_for_notification

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
            item_name=item.name if item else str(r.item_id),
            budget=item.budget if item else None,
            qty=r.qty, requested_by=r.requested_by, note=r.note,
            building_subtype=r.building_subtype, status=r.status,
            approved_by=r.approved_by, current_price=r.current_price,
            project_site=r.project_site, created_at=r.created_at,
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
    if data.qty <= 0:
        raise HTTPException(422, "Quantity must be greater than zero")
    item = db.query(Item).filter(Item.id == data.item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    requested_site = data.project_site or item.project_site or user.get("project_site") or "Lifecamp Kafe"
    project_site = enforce_project_site_scope(user, requested_site) or "Lifecamp Kafe"
    if item.project_site and item.project_site != project_site:
        raise HTTPException(403, "Item does not belong to selected project site")
    requested_by = user.get("full_name") or user.get("username") or data.requested_by or "Unknown"

    req = Request(
        item_id=data.item_id,
        qty=data.qty,
        requested_by=requested_by,
        current_price=data.current_price,
        note=data.note,
        building_subtype=data.building_subtype,
        project_site=project_site,
        status="Pending",
        section=item.category,
    )
    db.add(req)
    db.commit()
    db.refresh(req)

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
    enforce_project_site_scope(user, req.project_site)

    if data.status not in ALLOWED_REQUEST_STATUSES:
        raise HTTPException(422, "Invalid status")
    item = db.query(Item).filter(Item.id == req.item_id).first()
    old_status = req.status
    new_status = data.status
    status_changed = old_status != new_status
    approved_by = data.approved_by or user.get("full_name") or user.get("username") or "Admin"

    # Revert inventory/actuals if an approved request is moved away from Approved
    if old_status == "Approved" and new_status != "Approved":
        if item:
            item.qty = (item.qty or 0) + req.qty
        db.query(Actual).filter(Actual.request_id == req.id).delete(synchronize_session=False)

    # Apply inventory/actuals if request is newly approved
    if old_status != "Approved" and new_status == "Approved":
        if item and (item.qty or 0) < req.qty:
            raise HTTPException(409, "Insufficient inventory quantity for approval")
        if item:
            item.qty = (item.qty or 0) - req.qty

        cost = req.current_price or (item.unit_cost if item else 0)
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

    req.status = new_status
    req.approved_by = None if new_status == "Pending" else approved_by
    req.updated_at = datetime.utcnow()
    status_notif = None

    if status_changed and new_status == "Approved":
        budget_str = f" (Budget: {item.budget})" if item and item.budget else ""
        btype_str = f", Building: {req.building_subtype}" if req.building_subtype else ""
        notif = Notification(
            notification_type="request_approved",
            title="Request Approved",
            message=f"Your request for {item.name if item else 'item'} x {req.qty} was approved.{budget_str}{btype_str}",
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
    return req


@router.delete("/{req_id}")
def delete_request(
    req_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    req = db.query(Request).filter(Request.id == req_id).first()
    if not req:
        raise HTTPException(404, "Request not found")
    enforce_project_site_scope(user, req.project_site)
    item = db.query(Item).filter(Item.id == req.item_id).first()
    item_name = item.name if item else "Unknown"

    # If approved, remove the auto-created actual
    if req.status == "Approved":
        if item:
            item.qty = (item.qty or 0) + req.qty
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
        deleted_by=user.get("full_name") or user.get("username", "Admin"),
        project_site=req.project_site,
    )
    db.add(dr)
    db.delete(req)
    db.commit()
    return {"ok": True}
