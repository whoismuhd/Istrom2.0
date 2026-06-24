"""Auth routes."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from db import get_db
from api.schemas import LoginRequest, LoginResponse
from api.services.auth_service import authenticate, log_access

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    result = authenticate(db, req.access_code)
    if result:
        log_access(db, req.access_code, result["full_name"], True, result["user_type"])
        return LoginResponse(
            success=True,
            user={
                "username": result["username"],
                "full_name": result["full_name"],
                "user_type": result["user_type"],
                "project_site": result["project_site"],
                "is_global_admin": result.get("is_global_admin", False),
            },
            token=result["token"],
        )
    log_access(db, req.access_code, None, False, "unknown")
    raise HTTPException(status_code=401, detail="Invalid access code")
