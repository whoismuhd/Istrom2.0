"""Enforce limits before request bodies reach the JSON/multipart parsers."""
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        limit = (17 if headers.get(b"content-type", b"").startswith(b"multipart/") else 2) * 1024 * 1024
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid request size"}, status_code=400)(scope, receive, send)
        if length < 0 or length > limit:
            return await JSONResponse({"detail": "Request body is too large"}, status_code=413)(scope, receive, send)
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > limit:
                raise HTTPException(413, "Request body is too large")
            return message

        await self.app(scope, bounded_receive, send)
