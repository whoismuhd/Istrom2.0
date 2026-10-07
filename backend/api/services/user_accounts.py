"""Individual accounts and one-way password storage."""
import base64
import hashlib
import hmac
import secrets
import unicodedata

from models import User
from api.dependencies import create_access_token

# OWASP's equivalent scrypt configuration: 32 MiB, three parallel blocks.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 3


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(unicodedata.normalize('NFC', password).encode('utf-8'), salt=salt, n=SCRYPT_N,
                            r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024, dklen=32)
    encode = lambda value: base64.urlsafe_b64encode(value).decode('ascii')
    return f'scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${encode(salt)}${encode(digest)}'


_DUMMY_HASH = hash_password(secrets.token_urlsafe(32))


def verify_password(password: str, stored: str | None) -> bool:
    try:
        scheme, n, r, p, salt, expected = (stored or _DUMMY_HASH).split('$')
        if (scheme, int(n), int(r), int(p)) != ('scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P):
            return False
        salt = base64.urlsafe_b64decode(salt)
        expected = base64.urlsafe_b64decode(expected)
        if len(salt) != 16 or len(expected) != 32:
            return False
        digest = hashlib.scrypt(unicodedata.normalize('NFC', password).encode('utf-8'), salt=salt, n=SCRYPT_N,
                                r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024, dklen=32)
        return hmac.compare_digest(digest, expected) and stored is not None
    except (ValueError, TypeError):
        return False


def admin_accounts_exist(db) -> bool:
    # Disabled accounts still close setup: disabling admins cannot reopen a
    # back door through the old shared code.
    return db.query(User.id).filter(User.user_type == 'admin',
        User.login_name.isnot(None), User.password_hash.isnot(None)).first() is not None


def identity(account: User) -> dict:
    return dict(user_id=account.id, username=account.username,
                user_type=account.user_type, project_site=account.project_site,
                is_global_admin=account.user_type == 'admin',
                must_change_password=account.must_change_password, needs_account_setup=False)


def login_response(account: User) -> dict:
    user = identity(account)
    token = create_access_token({**user, 'credential_kind': 'user',
                                'credential_id': account.id, 'session_version': account.session_version})
    return {'success': True, 'user': user, 'token': token}
