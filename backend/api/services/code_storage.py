"""Authenticated encryption for the admin's recoverable site access codes."""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken
from api.settings import JWT_SECRET

PREFIX = "enc:v1:"
_key = os.getenv("ACCESS_CODE_ENCRYPTION_KEY") or base64.urlsafe_b64encode(
    hashlib.sha256(b"istrom:site-access-codes:v1:" + JWT_SECRET.encode()).digest()
).decode()
_cipher = Fernet(_key)


def encrypt_code(code: str) -> str:
    return PREFIX + _cipher.encrypt(code.encode()).decode()


def decrypt_code(value: str | None) -> str | None:
    if not value:
        return None
    if not value.startswith(PREFIX):
        return value  # Legacy value, encrypted on the next startup.
    try:
        return _cipher.decrypt(value[len(PREFIX):].encode()).decode()
    except (InvalidToken, UnicodeError, ValueError):
        return None


def encrypt_legacy_codes(db) -> bool:
    from models import ProjectSiteAccessCode
    changed = False
    for row in db.query(ProjectSiteAccessCode).all():
        if row.user_code_plain and not row.user_code_plain.startswith(PREFIX):
            row.user_code_plain = encrypt_code(row.user_code_plain)
            changed = True
    return changed
