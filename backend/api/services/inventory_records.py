from fastapi import HTTPException
from models import Item


def lock_linked_item(db, item):
    """Serialize new dependent records with inventory deletion and stock edits."""
    claimed = db.query(Item).filter(Item.id == item.id).update(
        {Item.qty: Item.qty}, synchronize_session='fetch',
    )
    if not claimed:
        db.rollback()
        raise HTTPException(409, 'The inventory item was removed. Refresh and choose another item.')
    db.refresh(item)
