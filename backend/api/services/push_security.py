"""Restrict server-side push delivery to browser vendor services."""
import base64
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric import ec
from requests import Session

_HOSTS = {"fcm.googleapis.com", "push.services.mozilla.com", "updates.push.services.mozilla.com", "web.push.apple.com"}


def valid_push_endpoint(endpoint: str) -> bool:
    try:
        parsed = urlsplit(endpoint)
        host = parsed.hostname or ""
        return (
            len(endpoint) <= 4096
            and parsed.scheme == "https" and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.fragment
            and (host in _HOSTS or host.endswith(".notify.windows.com"))
            and bool(parsed.path) and not any(c.isspace() for c in endpoint)
        )
    except ValueError:
        return False


def validate_push_key(value: str, public: bool = False) -> str:
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        if public:
            if len(raw) != 65:
                raise ValueError()
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
        elif len(raw) != 16:
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid browser push subscription key") from exc
    return value


class PushSession(Session):
    def request(self, method, url, **kwargs):
        if not valid_push_endpoint(url):
            raise ValueError("Untrusted push destination")
        kwargs["allow_redirects"] = False
        return super().request(method, url, **kwargs)
