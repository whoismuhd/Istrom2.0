"""Authentication service."""
from passlib.context import CryptContext


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def is_hashed_code(value: str | None) -> bool:
    """Return True when value looks like a bcrypt hash."""
    if not value:
        return False
    return value.startswith("$2a$") or value.startswith("$2b$") or value.startswith("$2y$")


def hash_access_code(code: str) -> str:
    """Hash access codes using bcrypt."""
    code = code.strip()
    if not code or len(code.encode("utf-8")) > 72:
        raise ValueError("Access codes must contain 1 to 72 UTF-8 bytes.")
    return pwd_context.hash(code)


def verify_access_code(plain_code: str, stored_value: str | None) -> bool:
    """Verify plain access code against stored (bcrypt hash or legacy plaintext)."""
    if not stored_value:
        return False
    plain = plain_code.strip()
    if not plain or len(plain.encode("utf-8")) > 72:
        return False
    if is_hashed_code(stored_value):
        try:
            return pwd_context.verify(plain, stored_value)
        except Exception:
            return False
    return stored_value == plain
