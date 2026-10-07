"""Prevent restored or concurrently edited forms from overwriting newer values."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy.orm import sessionmaker

from models import Item, ProjectSite
from api.routes.items import update_item
from api.schemas import ItemUpdate


def seed_item(db, site='Site A', qty=10, cost=1000):
    if site:
        db.add(ProjectSite(name=site, is_active=True))
    row = Item(name='Cement', qty=qty, unit_cost=cost, planned_qty=qty, planned_unit_cost=cost,
        category='Materials', unit='bags', project_site=site)
    db.add(row)
    db.commit()
    return row.id


@pytest.mark.parametrize('field,expected_field,changed', [
    ('planned_qty', 'expected_planned_qty', 12),
    ('planned_unit_cost', 'expected_planned_unit_cost', 1100),
    ('qty', 'expected_qty', 8),
    ('unit_cost', 'expected_unit_cost', 1200),
])
def test_stale_field_rejects_entire_edit_without_overwriting_any_other_value(client, test_db, field, expected_field, changed):
    item_id = seed_item(test_db)
    original = client.get(f'/items/{item_id}').json()
    assert client.patch(f'/items/{item_id}', json={field: changed}).status_code == 200
    data = {
        'qty': 30, 'unit_cost': 2000, 'planned_qty': 40, 'planned_unit_cost': 3000,
        'expected_qty': original['qty'], 'expected_unit_cost': original['unit_cost'],
        'expected_planned_qty': original['planned_qty'], 'expected_planned_unit_cost': original['planned_unit_cost'],
    }
    assert expected_field in data
    response = client.patch(f'/items/{item_id}', json=data)
    assert response.status_code == 409
    saved = client.get(f'/items/{item_id}').json()
    for saved_field in ('qty', 'unit_cost', 'planned_qty', 'planned_unit_cost'):
        assert saved[saved_field] == (changed if saved_field == field else original[saved_field])


def test_current_fractional_plan_baselines_allow_save_and_preserve_availability(client, test_db):
    item_id = seed_item(test_db, qty=0.3, cost=100.01)
    response = client.patch(f'/items/{item_id}', json={
        'planned_qty': 0.1, 'planned_unit_cost': 100.02,
        'expected_planned_qty': 0.3, 'expected_planned_unit_cost': 100.01,
    })
    assert response.status_code == 200
    saved = response.json()
    assert saved['planned_qty'] == 0.1 and saved['planned_unit_cost'] == 100.02
    assert saved['qty'] == 0.3 and saved['unit_cost'] == 100.01


def test_availability_checks_quantity_and_current_cost_even_when_quantity_is_unchanged(client, test_db):
    item_id = seed_item(test_db, qty=0.3, cost=100.01)
    assert client.patch(f'/items/{item_id}', json={'unit_cost': 100.02}).status_code == 200
    stale = client.patch(f'/items/{item_id}', json={
        'qty': -0.1, 'unit_cost': 100.03, 'expected_qty': 0.3, 'expected_unit_cost': 100.01,
    })
    assert stale.status_code == 409
    current = client.patch(f'/items/{item_id}', json={
        'qty': -0.1, 'unit_cost': 100.03, 'expected_qty': 0.3, 'expected_unit_cost': 100.02,
    })
    assert current.status_code == 200
    assert current.json()['qty'] == -0.1
    assert current.json()['planned_qty'] == 0.3
    assert current.json()['planned_unit_cost'] == 100.01


def test_negative_availability_and_zero_cost_are_valid_expected_baselines(client, test_db):
    item_id = seed_item(test_db, qty=-0.2, cost=0)
    response = client.patch(f'/items/{item_id}', json={
        'qty': 1, 'unit_cost': 2, 'expected_qty': -0.2, 'expected_unit_cost': 0,
    })
    assert response.status_code == 200
    assert response.json()['qty'] == 1
    assert response.json()['unit_cost'] == 2


@pytest.mark.parametrize('field,baseline', [('qty', 'expected_qty'), ('planned_qty', 'expected_planned_qty')])
def test_small_quantity_changes_are_not_rounded_away_by_conflict_checks(client, test_db, field, baseline):
    item_id = seed_item(test_db, qty=0.3)
    assert client.patch(f'/items/{item_id}', json={field: 0.3000001}).status_code == 200
    stale = client.patch(f'/items/{item_id}', json={field: 0.4, baseline: 0.3})
    assert stale.status_code == 409
    assert client.get(f'/items/{item_id}').json()[field] == 0.3000001


@pytest.mark.parametrize('kind', ['plan', 'availability'])
def test_replaced_item_with_reused_id_and_same_amounts_rejects_original_creation_identity(client, test_db, kind):
    item_id = seed_item(test_db)
    original = client.get(f'/items/{item_id}').json()
    old_created_at = datetime.fromisoformat(original['created_at'])
    assert client.delete(f'/items/{item_id}').status_code == 200
    replacement = Item(id=item_id, name='Replacement cement', qty=10, unit_cost=1000,
        planned_qty=10, planned_unit_cost=1000, category='Materials', unit='bags',
        project_site='Site A', created_at=old_created_at + timedelta(seconds=1))
    test_db.add(replacement)
    test_db.commit()
    changes = ({'planned_qty': 30, 'planned_unit_cost': 1200,
        'expected_planned_qty': 10, 'expected_planned_unit_cost': 1000}
        if kind == 'plan' else
        {'qty': 30, 'unit_cost': 1200, 'expected_qty': 10, 'expected_unit_cost': 1000})
    response = client.patch(f'/items/{item_id}', json={**changes, 'expected_created_at': original['created_at']})
    assert response.status_code == 409
    saved = client.get(f'/items/{item_id}').json()
    assert saved['name'] == 'Replacement cement'
    assert saved['qty'] == saved['planned_qty'] == 10
    assert saved['unit_cost'] == saved['planned_unit_cost'] == 1000


def test_creation_identity_compares_naive_and_aware_dates_in_utc(client, test_db):
    item_id = seed_item(test_db)
    created_at = datetime.fromisoformat(client.get(f'/items/{item_id}').json()['created_at'])
    utc = created_at.replace(tzinfo=timezone.utc)
    offset = utc.astimezone(timezone(timedelta(hours=1)))
    for expected in (utc.isoformat(), offset.isoformat()):
        response = client.patch(f'/items/{item_id}', json={'expected_created_at': expected, 'planned_qty': 12})
        assert response.status_code == 200
    saved = client.get(f'/items/{item_id}').json()
    assert saved['created_at'] == created_at.isoformat()
    assert saved['planned_qty'] == 12


@pytest.mark.parametrize('missing', ['expected', 'stored'])
def test_missing_creation_identity_cannot_bypass_supplied_guard(client, test_db, missing):
    item_id = seed_item(test_db)
    created_at = client.get(f'/items/{item_id}').json()['created_at']
    if missing == 'stored':
        test_db.query(Item).filter(Item.id == item_id).update({Item.created_at: None})
        test_db.commit()
    response = client.patch(f'/items/{item_id}', json={
        'expected_created_at': None if missing == 'expected' else created_at, 'planned_qty': 30,
    })
    assert response.status_code == 409
    assert client.get(f'/items/{item_id}').json()['planned_qty'] == 10


@pytest.mark.parametrize('kind', ['plan', 'availability'])
@pytest.mark.parametrize('site', ['Site A', None])
def test_simultaneous_edits_with_same_baseline_have_one_winner(concurrent_db, kind, site):
    factory = sessionmaker(bind=concurrent_db)
    with factory() as db:
        item_id = seed_item(db, site=site)
    ready = Barrier(2)
    admin = {'username': 'admin', 'user_type': 'admin', 'project_site': None, 'is_global_admin': True}

    def save(value):
        data = ItemUpdate(**(
            {'planned_qty': value, 'planned_unit_cost': value * 100,
                'expected_planned_qty': 10, 'expected_planned_unit_cost': 1000}
            if kind == 'plan' else
            {'qty': value, 'unit_cost': value * 100, 'expected_qty': 10, 'expected_unit_cost': 1000}
        ))
        with factory() as db:
            ready.wait(timeout=10)
            try:
                update_item(item_id, data, BackgroundTasks(), db, admin)
                return 200, value
            except HTTPException as exc:
                return exc.status_code, value

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, [20, 30]))
    assert sorted(status for status, _value in results) == [200, 409]
    winner = next(value for status, value in results if status == 200)
    with factory() as db:
        saved = db.query(Item).filter(Item.id == item_id).one()
        if kind == 'plan':
            assert saved.planned_qty == winner and saved.planned_unit_cost == winner * 100
            assert saved.qty == 10 and saved.unit_cost == 1000
        else:
            assert saved.qty == winner and saved.unit_cost == winner * 100
            assert saved.planned_qty == 10 and saved.planned_unit_cost == 1000
