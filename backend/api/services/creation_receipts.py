"""Make retries of a form submission safe, in the same transaction as creation."""
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from models import CreationReceipt


def _owner(user):
    if user.get('user_id') is not None:
        return f"user:{user['user_id']}"
    # Real workspace sessions have a user ID. Identity overrides in route tests
    # and legacy internal callers still need a stable, separate owner.
    identity = json.dumps([user.get('username'), user.get('user_type'), user.get('project_site')], separators=(',', ':'))
    return 'identity:' + hashlib.sha256(identity.encode()).hexdigest()


def _existing_result(db, receipt, payload_hash, model):
    if receipt.payload_hash != payload_hash:
        raise HTTPException(409, 'This submission was already used for different details. Start a new draft.')
    record = db.query(model).filter(model.id == receipt.record_id).first()
    if record is None:
        raise HTTPException(409, 'This submission was already saved and its record was removed. Review the history before starting a new draft.')
    return record


def retire_creation_receipts(db, operation, record_id):
    """Retain consumed keys when their record is deleted.

    SQLite can reuse a deleted integer ID. Clearing the association within the
    deletion transaction prevents a retry from resolving to an unrelated row.
    """
    db.query(CreationReceipt).filter(
        CreationReceipt.operation == operation,
        CreationReceipt.record_id == record_id,
    ).update({CreationReceipt.record_id: None}, synchronize_session='fetch')


def claim_creation(db, user, operation, submission_key, payload, model):
    """Return (receipt, existing record); a new receipt commits with its record.

    Call after taking the project's write lock. The unique owner/key constraint
    also protects against simultaneous use of a key in different projects.
    A failed creation rolls back its receipt, allowing the same intent to retry.
    """
    if not submission_key:
        return None, None
    canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    payload_hash = hashlib.sha256(canonical.encode()).hexdigest()
    owner = _owner(user)

    def lookup():
        return db.query(CreationReceipt).filter(
            CreationReceipt.owner == owner,
            CreationReceipt.operation == operation,
            CreationReceipt.submission_key == submission_key,
        ).first()

    existing = lookup()
    if existing:
        return existing, _existing_result(db, existing, payload_hash, model)
    receipt = CreationReceipt(owner=owner, operation=operation, submission_key=submission_key, payload_hash=payload_hash)
    try:
        with db.begin_nested():
            db.add(receipt)
            db.flush()
    except IntegrityError:
        # The competing transaction's receipt and record are committed together.
        # Its uniqueness check finishes before this transaction can continue.
        winner = lookup()
        if winner is None:
            raise
        return winner, _existing_result(db, winner, payload_hash, model)
    return receipt, None
