"""Realtime notification broadcast hub for websocket clients."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Dict, Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from api.dependencies import is_global_admin_user


@dataclass
class _NotificationConnection:
    websocket: WebSocket
    user_type: Optional[str]
    project_site: Optional[str]
    is_global_admin: bool
    user_id: Optional[int] = None


class NotificationHub:
    """Tracks websocket clients and broadcasts role-scoped notification events."""

    def __init__(self) -> None:
        self._connections: Dict[int, _NotificationConnection] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, user: dict) -> None:
        if websocket.application_state != WebSocketState.CONNECTED:
            await websocket.accept()
        conn = _NotificationConnection(
            websocket=websocket,
            user_type=user.get("user_type"),
            project_site=user.get("project_site"),
            is_global_admin=is_global_admin_user(user),
            user_id=user.get('user_id'),
        )
        async with self._lock:
            self._connections[id(websocket)] = conn

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.pop(id(websocket), None)

    async def revoke_sessions(self, project_site: Optional[str]) -> None:
        """Close active connections whose credentials have just been revoked."""
        async with self._lock:
            revoked = [c for c in self._connections.values() if (
                c.is_global_admin if project_site is None else c.project_site == project_site
            )]
            for conn in revoked:
                self._connections.pop(id(conn.websocket), None)
        for conn in revoked:
            try:
                await conn.websocket.close(code=1008, reason="Session revoked. Please sign in again.")
            except Exception:
                pass  # A disconnected client needs no further cleanup.

    async def revoke_user_sessions(self, user_id: int) -> None:
        async with self._lock:
            revoked = [c for c in self._connections.values() if c.user_id == user_id]
            for conn in revoked:
                self._connections.pop(id(conn.websocket), None)
        for conn in revoked:
            try:
                await conn.websocket.close(code=1008, reason='Account changed. Please sign in again.')
            except Exception:
                pass

    async def send_personal(self, websocket: WebSocket, payload: dict) -> None:
        await websocket.send_json(payload)

    async def broadcast_notification_created(
        self,
        notification_id: int,
        notification_type: str,
        project_site: Optional[str],
    ) -> None:
        await self._broadcast(
            payload={
                "type": "notification_created",
                "notification_id": notification_id,
                "notification_type": notification_type,
                "project_site": project_site,
                "emitted_at": _utc_now_iso(),
            },
            predicate=lambda c: _can_receive_notification(
                c, notification_type=notification_type, project_site=project_site
            ),
        )

    async def broadcast_notification_updated(
        self,
        notification_id: int,
        notification_type: str,
        project_site: Optional[str],
    ) -> None:
        await self._broadcast(
            payload={
                "type": "notification_updated",
                "notification_id": notification_id,
                "notification_type": notification_type,
                "project_site": project_site,
                "emitted_at": _utc_now_iso(),
            },
            predicate=lambda c: _can_receive_notification(
                c, notification_type=notification_type, project_site=project_site
            ),
        )

    async def broadcast_notification_deleted(
        self,
        notification_id: int,
        notification_type: str,
        project_site: Optional[str],
    ) -> None:
        await self._broadcast(
            payload={
                "type": "notification_deleted",
                "notification_id": notification_id,
                "notification_type": notification_type,
                "project_site": project_site,
                "emitted_at": _utc_now_iso(),
            },
            predicate=lambda c: _can_receive_notification(
                c, notification_type=notification_type, project_site=project_site
            ),
        )

    async def broadcast_notifications_cleared(self) -> None:
        await self._broadcast(
            payload={
                "type": "notifications_cleared",
                "emitted_at": _utc_now_iso(),
            }
        )

    async def broadcast_notification_read(self, notification_id: int, user_id: int) -> None:
        await self._broadcast(
            payload={'type': 'notification_updated', 'notification_id': notification_id,
                     'emitted_at': _utc_now_iso()},
            predicate=lambda c: c.user_id == user_id,
        )

    async def broadcast_workspace_changed(self, project_site: Optional[str]) -> None:
        await self._broadcast(
            payload={'type': 'workspace_updated', 'project_site': project_site,
                     'emitted_at': _utc_now_iso()},
            predicate=lambda c: c.is_global_admin or (bool(project_site) and c.project_site == project_site),
        )

    async def _broadcast(
        self,
        payload: dict,
        predicate: Optional[Callable[[_NotificationConnection], bool]] = None,
    ) -> None:
        async with self._lock:
            connections = list(self._connections.values())

        stale_ids = []
        for conn in connections:
            if predicate and not predicate(conn):
                continue
            try:
                await conn.websocket.send_json(payload)
            except Exception:
                stale_ids.append(id(conn.websocket))

        if stale_ids:
            async with self._lock:
                for ws_id in stale_ids:
                    self._connections.pop(ws_id, None)


def _can_receive_notification(
    conn: _NotificationConnection,
    notification_type: str,
    project_site: Optional[str],
) -> bool:
    if conn.is_global_admin:
        return notification_type != "request_submitted"

    if conn.user_type == "admin":
        return (
            bool(conn.project_site)
            and conn.project_site == project_site
            and notification_type != "request_submitted"
        )

    if conn.user_type == "project_site":
        return (
            bool(conn.project_site)
            and conn.project_site == project_site
            and notification_type != "new_request"
        )

    return False


def _utc_now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


notification_hub = NotificationHub()
