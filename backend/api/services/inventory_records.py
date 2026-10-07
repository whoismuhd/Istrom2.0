import math
from decimal import Decimal, localcontext
from fastapi import HTTPException
from models import Item


def finite_cost_total(qty, unit_cost, label='Total cost'):
    with localcontext() as context:
        context.prec = 40
        total = float(Decimal(str(qty)) * Decimal(str(unit_cost)))
    if not math.isfinite(total):
        raise HTTPException(422, f'{label} is too large. Reduce the quantity or unit price.')
    return total


def change_item_quantity(db, item, change):
    """Lock the latest balance and apply decimal quantities without float drift."""
    lock_linked_item(db, item)
    before = item.qty
    with localcontext() as context:
        context.prec = 40
        balance = float(Decimal(str(before)) + Decimal(str(change)))
    if not math.isfinite(balance):
        db.rollback()
        raise HTTPException(422, 'The quantity balance is too large. Reduce the quantity before trying again.')
    db.query(Item).filter(Item.id == item.id).update({Item.qty: balance}, synchronize_session='fetch')
    db.refresh(item)
    return before


def lock_linked_item(db, item):
    """Serialize new dependent records with inventory deletion and stock edits."""
    claimed = db.query(Item).filter(Item.id == item.id).update(
        {Item.qty: Item.qty}, synchronize_session='fetch',
    )
    if not claimed:
        db.rollback()
        raise HTTPException(409, 'The inventory item was removed. Refresh and choose another item.')
    db.refresh(item)
