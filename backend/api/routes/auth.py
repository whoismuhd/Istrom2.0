"""Auth routes."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from db import get_db
from api.schemas import LoginRequest, LoginResponse
from api.services.auth_service import authenticate, log_access
from api.services.rate_limit import login_limiter

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    client_key = request.client.host if request.client else "unknown"
    locked_for = login_limiter.seconds_until_unlocked(client_key)
    if locked_for is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed attempts. Try again in {locked_for} seconds.",
        )

    result = authenticate(db, req.access_code)
    if result:
        login_limiter.record_success(client_key)
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
    login_limiter.record_failure(client_key)
    log_access(db, req.access_code, None, False, "unknown")
    raise HTTPException(status_code=401, detail="Invalid access code")
