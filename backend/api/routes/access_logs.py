"""Access logs routes."""
from typing import Optional, List
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from datetime import datetime, timedelta

from db import get_db
from models import AccessLog
from api.schemas import AccessLogOut
from api.dependencies import get_current_global_admin

router = APIRouter(prefix="/access-logs", tags=["access-logs"])


@router.get("", response_model=List[AccessLogOut])
def list_access_logs(
    role: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    since = datetime.utcnow() - timedelta(days=days)
    q = db.query(AccessLog).filter(AccessLog.access_time >= since)
    if role:
        q = q.filter(AccessLog.role == role)
    return q.order_by(AccessLog.access_time.desc()).limit(limit).all()


@router.delete("")
def clear_access_logs(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    db.query(AccessLog).delete()
    db.commit()
    return {"ok": True}
