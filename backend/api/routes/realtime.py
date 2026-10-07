"""Realtime websocket routes."""
import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status, Depends
from sqlalchemy.orm import Session
from db import get_db

from api.dependencies import validate_session
from api.services.notification_hub import notification_hub
from api.settings import ALLOWED_ORIGINS

router = APIRouter(tags=["realtime"])


@router.websocket("/ws/notifications")
async def notifications_socket(websocket: WebSocket, db: Session = Depends(get_db)):
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    # Authenticate in the first message so credentials never enter URL logs.
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        if len(raw) > 4096:
            raise ValueError("Authentication message too large")
        auth = json.loads(raw)
        token = auth.get("token") if isinstance(auth, dict) and auth.get("type") == "authenticate" else None
        user = validate_session(token, db) if isinstance(token, str) else None
    except WebSocketDisconnect:
        # A page change or React's development remount can close the socket
        # before authentication arrives. The client has already disconnected.
        return
    except (asyncio.TimeoutError, ValueError):
        user = None
    if user is None or user.get('must_change_password') or user.get('needs_account_setup'):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await notification_hub.connect(websocket, user)
    await notification_hub.send_personal(
        websocket,
        {
            "type": "connected",
            "project_site": user.get("project_site"),
            "user_type": user.get("user_type"),
        },
    )
    try:
        while True:
            message = await websocket.receive_text()
            db.expire_all()
            if not validate_session(token, db):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return
            if message == "ping":
                await notification_hub.send_personal(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await notification_hub.disconnect(websocket)
