"""Access codes routes."""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from db import get_db
from models import AccessCode, PushSubscription
from api.schemas import AccessCodeUpdate
from api.dependencies import get_current_global_admin
from api.services.auth_service import hash_access_code
from api.services.notification_hub import notification_hub

router = APIRouter(prefix="/access-codes", tags=["access-codes"])


@router.get("")
def get_access_codes(db: Session = Depends(get_db), user: dict = Depends(get_current_global_admin)):
    ac = db.query(AccessCode).first()
    if not ac:
        return {"admin_code": "", "user_code": ""}
    return {
        "admin_code": "Configured" if ac.admin_code else "",
        "user_code": "Configured" if ac.user_code else "",
    }


@router.patch("")
def update_access_codes(
    data: AccessCodeUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_global_admin),
):
    code = data.admin_code.strip()
    if not code:
        raise HTTPException(422, "Admin code cannot be empty")

    ac = db.query(AccessCode).first()
    if not ac:
        ac = AccessCode(admin_code=hash_access_code(code), user_code="")
        db.add(ac)
    else:
        ac.admin_code = hash_access_code(code)
        ac.session_version += 1
    ac.updated_by = user.get("username", "admin")
    db.query(PushSubscription).filter(PushSubscription.is_global_admin == True).delete(synchronize_session=False)
    db.commit()
    background_tasks.add_task(notification_hub.revoke_sessions, None)
    return {"ok": True}
