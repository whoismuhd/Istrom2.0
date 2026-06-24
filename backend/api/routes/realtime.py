"""Realtime websocket routes."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from api.dependencies import decode_token
from api.services.notification_hub import notification_hub

router = APIRouter(tags=["realtime"])


@router.websocket("/ws/notifications")
async def notifications_socket(websocket: WebSocket):
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    user = decode_token(token)
    if not user:
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
            if message == "ping":
                await notification_hub.send_personal(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await notification_hub.disconnect(websocket)
