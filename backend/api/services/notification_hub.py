"""Realtime notification broadcast hub for websocket clients."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Dict, Optional

from fastapi import WebSocket

from api.dependencies import is_global_admin_user


@dataclass
class _NotificationConnection:
    websocket: WebSocket
    user_type: Optional[str]
    project_site: Optional[str]
    is_global_admin: bool


class NotificationHub:
    """Tracks websocket clients and broadcasts role-scoped notification events."""

    def __init__(self) -> None:
        self._connections: Dict[int, _NotificationConnection] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, user: dict) -> None:
        await websocket.accept()
        conn = _NotificationConnection(
            websocket=websocket,
            user_type=user.get("user_type"),
            project_site=user.get("project_site"),
            is_global_admin=is_global_admin_user(user),
        )
        async with self._lock:
            self._connections[id(websocket)] = conn

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.pop(id(websocket), None)

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
