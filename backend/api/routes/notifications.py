"""Notifications routes."""
import re
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from db import get_db
from models import Notification, NotificationRead, Request, Item, DeletedRequest
from api.schemas import NotificationOut
from api.dependencies import (
    get_current_user,
    get_current_global_admin,
    enforce_project_site_scope,
    is_global_admin_user,
)
from api.services.notification_hub import notification_hub

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _enrich_from_request(db: Session, n, item_name, qty, budget, building_subtype):
    """Enrich notification with request/item data. Try Request first, then DeletedRequest."""
    if n.request_id:
        req = db.query(Request).filter(Request.id == n.request_id).first()
        if req:
            if not building_subtype:
                building_subtype = req.building_subtype
            if qty is None:
                qty = req.qty
            item = db.query(Item).filter(Item.id == req.item_id).first()
            if item:
                if not item_name:
                    item_name = item.name
                if not budget:
                    budget = item.budget
            return item_name, qty, budget, building_subtype

        dr = db.query(DeletedRequest).filter(DeletedRequest.req_id == n.request_id).first()
        if dr:
            if not item_name:
                item_name = dr.item_name
            if qty is None:
                qty = dr.qty
            if not budget:
                budget = dr.budget
            if not building_subtype:
                building_subtype = dr.building_subtype

    if not item_name or not budget:
        match = re.search(r"for\s+([^x]+)\s*x\s*([\d.]+)", (n.message or ""), re.I)
        if match:
            parsed_name, parsed_qty = match.group(1).strip(), float(match.group(2))
            if not item_name:
                item_name = parsed_name
            if qty is None:
                qty = parsed_qty
            req = (
                db.query(Request)
                .join(Item, Item.id == Request.item_id)
                .filter(Item.name.like(f"%{parsed_name}%"), Request.qty == parsed_qty)
                .filter(Request.project_site == n.project_site)
                .order_by(Request.created_at.desc())
                .first()
            )
            if req:
                if not budget:
                    item = db.query(Item).filter(Item.id == req.item_id).first()
                    budget = item.budget if item else None
                if not building_subtype:
                    building_subtype = req.building_subtype
            else:
                dr = (
                    db.query(DeletedRequest)
                    .filter(
                        DeletedRequest.item_name.like(f"%{parsed_name}%"),
                        DeletedRequest.qty == parsed_qty,
                        DeletedRequest.project_site == n.project_site,
                    )
                    .order_by(DeletedRequest.deleted_at.desc())
                    .first()
                )
                if dr:
                    if not budget:
                        budget = dr.budget
                    if not building_subtype:
                        building_subtype = dr.building_subtype

    return item_name, qty, budget, building_subtype


def _can_access_notification(user: dict, notification: Notification) -> bool:
    if user.get('user_type') == 'admin' and notification.notification_type == 'request_submitted':
        return False
    if is_global_admin_user(user):
        return True
    user_site = user.get("project_site")
    if not user_site:
        return False
    if notification.project_site != user_site:
        return False
    if user.get("user_type") == "project_site" and notification.notification_type == "new_request":
        return False
    return True


@router.get("", response_model=List[NotificationOut])
def list_notifications(
    project_site: Optional[str] = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    effective_site = enforce_project_site_scope(user, project_site)
    q = db.query(Notification)
    is_admin = user.get("user_type") == "admin"
    if effective_site:
        q = q.filter(Notification.project_site == effective_site)
    if user.get("user_type") == "project_site":
        q = q.filter(Notification.notification_type != "new_request")
    if is_admin:
        # request_submitted is requester-facing; admins should use new_request to review incoming work.
        q = q.filter(Notification.notification_type != "request_submitted")
    rows = q.order_by(Notification.created_at.desc()).limit(100).all()
    user_id = user.get('user_id')
    read_ids = set()
    if user_id and rows:
        read_ids = {row.notification_id for row in db.query(NotificationRead).filter(
            NotificationRead.user_id == user_id,
            NotificationRead.notification_id.in_([n.id for n in rows]),
        ).all()}

    out = []
    for n in rows:
        item_name = getattr(n, "item_name", None)
        qty = getattr(n, "qty", None)
        budget = getattr(n, "budget", None)
        building_subtype = getattr(n, "building_subtype", None)

        if not budget or not building_subtype or not item_name:
            item_name, qty, budget, building_subtype = _enrich_from_request(
                db, n, item_name, qty, budget, building_subtype
            )

        message = n.message
        if is_admin and n.notification_type in ("request_approved", "request_rejected"):
            requested_by = None
            if n.request_id:
                req = db.query(Request).filter(Request.id == n.request_id).first()
                if req:
                    requested_by = req.requested_by
                else:
                    dr = db.query(DeletedRequest).filter(DeletedRequest.req_id == n.request_id).first()
                    if dr:
                        requested_by = dr.requested_by
            if not requested_by and (item_name or n.message):
                match = re.search(r"for\s+([^x]+)\s*x\s*([\d.]+)", (n.message or ""), re.I)
                if match:
                    parsed_name, parsed_qty = match.group(1).strip(), float(match.group(2))
                    req = (
                        db.query(Request)
                        .join(Item, Item.id == Request.item_id)
                        .filter(Item.name.like(f"%{parsed_name}%"), Request.qty == parsed_qty)
                        .filter(Request.project_site == n.project_site)
                        .order_by(Request.created_at.desc())
                        .first()
                    )
                    if req:
                        requested_by = req.requested_by
                    else:
                        dr = (
                            db.query(DeletedRequest)
                            .filter(
                                DeletedRequest.item_name.like(f"%{parsed_name}%"),
                                DeletedRequest.qty == parsed_qty,
                                DeletedRequest.project_site == n.project_site,
                            )
                            .order_by(DeletedRequest.deleted_at.desc())
                            .first()
                        )
                        if dr:
                            requested_by = dr.requested_by
            if requested_by:
                if n.notification_type == "request_approved":
                    action = "approved"
                elif n.notification_type == "request_rejected":
                    action = "rejected"
                else:
                    action = "submitted"
                iname = item_name or "item"
                q = qty if qty is not None else "?"
                message = f"Request for {iname} x {q} by {requested_by} was {action}."
                if n.notification_type == "request_approved":
                    _, marker, shortage_detail = (n.message or "").partition(" Approved over quantity: ")
                    if marker:
                        message += marker + shortage_detail
            elif (n.message or "").startswith("Your request"):
                message = (n.message or "").replace("Your request for", "Request for", 1)

        out.append(NotificationOut(
            id=n.id,
            notification_type=n.notification_type,
            title=n.title,
            message=message,
            item_name=item_name,
            qty=qty,
            budget=budget,
            building_subtype=building_subtype,
            is_read=n.id in read_ids if user_id else n.is_read,
            created_at=n.created_at,
        ))
    return out


@router.post("/{notif_id}/read")
def mark_read(
    notif_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    n = db.query(Notification).filter(Notification.id == notif_id).first()
    if not n:
        raise HTTPException(404, "Notification not found")
    if not _can_access_notification(user, n):
        raise HTTPException(403, "Access denied")
    user_id = user.get('user_id')
    if user_id:
        if not db.get(NotificationRead, (n.id, user_id)):
            db.add(NotificationRead(notification_id=n.id, user_id=user_id))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                if not db.get(NotificationRead, (notif_id, user_id)):
                    raise
        background_tasks.add_task(notification_hub.broadcast_notification_read, n.id, user_id)
    else:
        n.is_read = True
        db.commit()
        background_tasks.add_task(notification_hub.broadcast_notification_updated, n.id, n.notification_type, n.project_site)
    return {"ok": True}


@router.delete("")
def clear_all_notifications(
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    db.query(NotificationRead).delete(synchronize_session=False)
    db.query(Notification).delete()
    db.commit()
    background_tasks.add_task(notification_hub.broadcast_notifications_cleared)
    return {"ok": True}


@router.delete("/{notif_id}")
def delete_notification(
    notif_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    n = db.query(Notification).filter(Notification.id == notif_id).first()
    if n:
        n_id = n.id
        n_type = n.notification_type
        n_site = n.project_site
        db.query(NotificationRead).filter(NotificationRead.notification_id == n_id).delete(synchronize_session=False)
        db.delete(n)
        db.commit()
        background_tasks.add_task(
            notification_hub.broadcast_notification_deleted,
            n_id,
            n_type,
            n_site,
        )
    return {"ok": True}
