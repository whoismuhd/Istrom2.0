"""Refresh/retry safety for forms whose first response may have been lost."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy.orm import sessionmaker

from .conftest import site_request_identity
from models import CreationReceipt, Item, Notification, ProjectSite, Request
from api.routes.items import create_item
from api.routes.requests import create_request
from api.schemas import ItemCreate, RequestCreate
from api.services.creation_receipts import claim_creation
from api.services.project_records import lock_project_records


KEY = '7bba3a03-4544-4c7e-a870-9aad45fd4407'


@pytest.fixture(autouse=True)
def no_external_push(monkeypatch):
    monkeypatch.setattr('api.routes.requests.send_push_for_notification', lambda *args: None)


def seed_site(db, name='Site A'):
    db.add(ProjectSite(name=name, is_active=True))
    db.commit()


def item_payload(site='Site A', **changes):
    return {
        'name': 'Cement', 'qty': 20, 'unit': 'bags', 'unit_cost': 500,
        'category': 'Materials', 'section': 'Foundation',
        'budget': 'Budget 1 - Flats(General Materials)',
        'building_type': 'Flats', 'project_site': site,
        'submission_key': KEY, **changes,
    }


def seed_item(db, site='Site A'):
    row = Item(**{key: value for key, value in item_payload(site).items() if key != 'submission_key'})
    db.add(row)
    db.commit()
    return row.id


def test_item_retry_returns_same_saved_item(client, test_db):
    seed_site(test_db)
    first = client.post('/items', json=item_payload())
    replay = client.post('/items', json=item_payload())
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert test_db.query(Item).count() == 1
    assert test_db.query(CreationReceipt).count() == 1


def test_request_retry_returns_same_request_without_repeat_notifications(client, test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    data = {'item_id': item_id, 'qty': 2, 'current_price': 520, 'note': 'Foundation work', 'building_subtype': 'B2', 'submission_key': KEY}
    with site_request_identity('Site A'):
        first = client.post('/requests', json=data)
        # An explicit site and untrusted requested_by do not change the intent.
        replay = client.post('/requests', json={**data, 'project_site': 'Site A', 'requested_by': 'someone else'})
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert test_db.query(Request).count() == 1
    assert test_db.query(Notification).count() == 2
    assert test_db.query(CreationReceipt).count() == 1


@pytest.mark.parametrize('kind,changes', [
    ('item', {'qty': 21}), ('item', {'name': 'Different item'}),
    ('request', {'qty': 3}), ('request', {'note': 'Different work'}),
])
def test_changed_payload_cannot_reuse_a_completed_submission(client, test_db, kind, changes):
    seed_site(test_db)
    if kind == 'request':
        item_id = seed_item(test_db)
        data = {'item_id': item_id, 'qty': 2, 'submission_key': KEY}
        with site_request_identity('Site A'):
            first = client.post('/requests', json=data)
            changed = client.post('/requests', json={**data, **changes})
        assert test_db.query(Request).count() == 1
    else:
        first = client.post('/items', json=item_payload())
        changed = client.post('/items', json=item_payload(**changes))
        assert test_db.query(Item).count() == 1
    assert first.status_code == 200
    assert changed.status_code == 409


@pytest.mark.parametrize('kind', ['item', 'request'])
def test_new_submission_key_allows_a_deliberate_second_entry(client, test_db, kind):
    seed_site(test_db)
    fresh_key = '25ae632d-4b9a-4411-a506-97f79c489c04'
    if kind == 'request':
        item_id = seed_item(test_db)
        data = {'item_id': item_id, 'qty': 2, 'submission_key': KEY}
        with site_request_identity('Site A'):
            first = client.post('/requests', json=data)
            second = client.post('/requests', json={**data, 'submission_key': fresh_key})
    else:
        first = client.post('/items', json=item_payload())
        second = client.post('/items', json=item_payload(submission_key=fresh_key))
    assert first.status_code == second.status_code == 200
    assert first.json()['id'] != second.json()['id']
    assert test_db.query(CreationReceipt).count() == 2


def test_reusing_key_after_item_deletion_cannot_recreate_it(client, test_db):
    seed_site(test_db)
    first = client.post('/items', json=item_payload())
    assert first.status_code == 200
    assert client.delete(f"/items/{first.json()['id']}").status_code == 200
    retry = client.post('/items', json=item_payload())
    assert retry.status_code == 409
    assert test_db.query(Item).count() == 0


def test_reusing_key_after_request_deletion_cannot_recreate_it(client, test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    data = {'item_id': item_id, 'qty': 2, 'submission_key': KEY}
    with site_request_identity('Site A'):
        first = client.post('/requests', json=data)
    assert first.status_code == 200
    assert client.delete(f"/requests/{first.json()['id']}").status_code == 200
    with site_request_identity('Site A'):
        retry = client.post('/requests', json=data)
    assert retry.status_code == 409
    assert test_db.query(Request).count() == 0


@pytest.mark.parametrize('kind', ['item', 'request'])
def test_retry_after_deleted_id_is_reused_never_returns_an_unrelated_record(client, test_db, kind):
    seed_site(test_db)
    if kind == 'item':
        data = item_payload()
        first = client.post('/items', json=data)
        assert first.status_code == 200
        old_id = first.json()['id']
        assert client.delete(f'/items/{old_id}').status_code == 200
        replacement = client.post('/items', json={key: value for key, value in item_payload(name='New timber').items() if key != 'submission_key'})
        assert replacement.status_code == 200
        retry = client.post('/items', json=data)
        assert test_db.query(Item).count() == 1
        assert test_db.query(Item).one().name == 'New timber'
    else:
        data = {'item_id': seed_item(test_db), 'qty': 2, 'submission_key': KEY}
        with site_request_identity('Site A'):
            first = client.post('/requests', json=data)
        assert first.status_code == 200
        old_id = first.json()['id']
        assert client.delete(f'/requests/{old_id}').status_code == 200
        with site_request_identity('Site A'):
            replacement = client.post('/requests', json={'item_id': data['item_id'], 'qty': 7, 'note': 'Unrelated work'})
            assert replacement.status_code == 200
            notifications_before_retry = test_db.query(Notification).count()
            retry = client.post('/requests', json=data)
        assert test_db.query(Request).count() == 1
        assert test_db.query(Request).one().qty == 7
        assert test_db.query(Notification).count() == notifications_before_retry
    if test_db.get_bind().dialect.name == 'sqlite':
        assert replacement.json()['id'] == old_id
    else:
        assert replacement.json()['id'] != old_id
    assert retry.status_code == 409
    receipt = test_db.query(CreationReceipt).filter(CreationReceipt.operation == kind, CreationReceipt.submission_key == KEY).one()
    assert receipt.record_id is None


def test_failed_item_deletion_keeps_its_receipt_linked(client, test_db):
    seed_site(test_db)
    first = client.post('/items', json=item_payload())
    assert first.status_code == 200
    item_id = first.json()['id']
    with site_request_identity('Site A'):
        assert client.post('/requests', json={'item_id': item_id, 'qty': 1}).status_code == 200
    assert client.delete(f'/items/{item_id}').status_code == 409
    replay = client.post('/items', json=item_payload())
    assert replay.status_code == 200
    assert replay.json()['id'] == item_id
    assert test_db.query(CreationReceipt).one().record_id == item_id


def test_request_retry_returns_its_current_approval_without_repeating_usage(client, test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    data = {'item_id': item_id, 'qty': 2, 'submission_key': KEY}
    with site_request_identity('Site A'):
        first = client.post('/requests', json=data)
    assert first.status_code == 200
    assert client.patch(f"/requests/{first.json()['id']}/status", json={'status': 'Approved'}).status_code == 200
    with site_request_identity('Site A'):
        retry = client.post('/requests', json=data)
    assert retry.status_code == 200
    assert retry.json()['id'] == first.json()['id']
    assert retry.json()['status'] == 'Approved'
    assert test_db.query(Item).filter(Item.id == item_id).one().qty == 18
    assert test_db.query(Notification).count() == 3


def test_receipts_are_isolated_by_account(test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    data = RequestCreate(item_id=item_id, qty=2, submission_key=KEY)
    users = [{'username': name, 'user_type': 'project_site', 'project_site': 'Site A'} for name in ('alice', 'bob')]
    first = create_request(data, BackgroundTasks(), test_db, users[0])
    second = create_request(data, BackgroundTasks(), test_db, users[1])
    assert first.id != second.id
    assert test_db.query(CreationReceipt).count() == 2


def test_request_retry_does_not_bypass_current_project_access(client, test_db):
    seed_site(test_db, 'Site A')
    seed_site(test_db, 'Site B')
    data = {'item_id': seed_item(test_db), 'qty': 2, 'submission_key': KEY}
    with site_request_identity('Site A'):
        first = client.post('/requests', json=data)
    with site_request_identity('Site B'):
        retry = client.post('/requests', json=data)
    assert first.status_code == 200
    assert retry.status_code == 403
    assert test_db.query(Request).count() == 1


def test_request_creation_rejects_replaced_selected_item_with_same_id_and_budget(client, test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    original = client.get(f'/items/{item_id}').json()
    assert client.delete(f'/items/{item_id}').status_code == 200
    row = {key: value for key, value in item_payload().items() if key != 'submission_key'}
    test_db.add(Item(id=item_id, **row, created_at=datetime.fromisoformat(original['created_at']) + timedelta(seconds=1)))
    test_db.commit()
    with site_request_identity('Site A'):
        response = client.post('/requests', json={
            'item_id': item_id, 'qty': 2, 'submission_key': KEY,
            'expected_item_created_at': original['created_at'],
        })
    assert response.status_code == 409
    assert test_db.query(Request).count() == 0
    assert test_db.query(CreationReceipt).count() == 0
    assert test_db.query(Notification).count() == 0


def test_request_identity_guards_preserve_retry_keys_across_utc_date_formats(client, test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    created_at = client.get(f'/items/{item_id}').json()['created_at']
    offset = datetime.fromisoformat(created_at).replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=1))).isoformat()
    data = {'item_id': item_id, 'qty': 2, 'submission_key': KEY}
    with site_request_identity('Site A'):
        first = client.post('/requests', json={**data, 'expected_item_created_at': created_at})
        replay = client.post('/requests', json={**data, 'expected_item_created_at': offset})
    assert first.status_code == replay.status_code == 200
    assert first.json()['id'] == replay.json()['id']
    assert test_db.query(Request).count() == 1
    assert test_db.query(Notification).count() == 2


def test_existing_request_receipt_can_replay_with_added_matching_identity_guard(client, test_db):
    seed_site(test_db)
    item_id = seed_item(test_db)
    created_at = client.get(f'/items/{item_id}').json()['created_at']
    data = {'item_id': item_id, 'qty': 2, 'submission_key': KEY}
    with site_request_identity('Site A'):
        first = client.post('/requests', json=data)
        replay = client.post('/requests', json={**data, 'expected_item_created_at': created_at})
    assert first.status_code == replay.status_code == 200
    assert first.json()['id'] == replay.json()['id']
    assert test_db.query(Request).count() == 1
    assert test_db.query(Notification).count() == 2


@pytest.mark.parametrize('missing', ['expected', 'stored'])
def test_request_identity_guard_rejects_missing_identity(client, test_db, missing):
    seed_site(test_db)
    item_id = seed_item(test_db)
    created_at = client.get(f'/items/{item_id}').json()['created_at']
    if missing == 'stored':
        test_db.query(Item).filter(Item.id == item_id).update({Item.created_at: None})
        test_db.commit()
    with site_request_identity('Site A'):
        response = client.post('/requests', json={
            'item_id': item_id, 'qty': 2, 'submission_key': KEY,
            'expected_item_created_at': None if missing == 'expected' else created_at,
        })
    assert response.status_code == 409
    assert test_db.query(Request).count() == 0
    assert test_db.query(CreationReceipt).count() == 0


def test_transaction_rollback_does_not_leave_a_claimed_submission(test_db):
    seed_site(test_db)
    lock_project_records(test_db, 'Site A')
    user = {'user_id': 123}
    receipt, existing = claim_creation(test_db, user, 'item', KEY, {'qty': 2}, Item)
    assert receipt is not None and existing is None
    test_db.rollback()
    assert test_db.query(CreationReceipt).count() == 0
    lock_project_records(test_db, 'Site A')
    receipt, existing = claim_creation(test_db, user, 'item', KEY, {'qty': 3}, Item)
    assert receipt is not None and existing is None
    test_db.rollback()


def test_creation_receipt_migration_is_repeatable_and_preserves_records(tmp_path, monkeypatch):
    from sqlalchemy import create_engine, inspect
    from db import Base
    import schema_init
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-retries.db'}")
    Base.metadata.create_all(engine)
    CreationReceipt.__table__.drop(engine)
    factory = sessionmaker(bind=engine)
    with factory() as db:
        seed_site(db)
        item_id = seed_item(db)
    monkeypatch.setattr(schema_init, 'engine', engine)
    schema_init.run_migrations()
    schema_init.run_migrations()
    assert 'creation_receipts' in inspect(engine).get_table_names()
    with factory() as db:
        assert db.query(Item).one().id == item_id
        assert db.query(CreationReceipt).count() == 0
    engine.dispose()


@pytest.mark.parametrize('kind', ['item', 'request'])
@pytest.mark.parametrize('key', ['', 'x', 'x' * 101, 'spaces are not allowed'])
def test_submission_key_validation(client, test_db, kind, key):
    seed_site(test_db)
    if kind == 'request':
        with site_request_identity('Site A'):
            response = client.post('/requests', json={'item_id': seed_item(test_db), 'qty': 2, 'submission_key': key})
    else:
        response = client.post('/items', json=item_payload(submission_key=key))
    assert response.status_code == 422
    assert test_db.query(CreationReceipt).count() == 0


@pytest.mark.parametrize('kind', ['item', 'request'])
def test_simultaneous_identical_submissions_create_one_record(concurrent_db, kind):
    factory = sessionmaker(bind=concurrent_db)
    with factory() as db:
        seed_site(db)
        item_id = seed_item(db) if kind == 'request' else None
    ready = Barrier(2)

    def submit():
        with factory() as db:
            ready.wait(timeout=10)
            if kind == 'request':
                row = create_request(RequestCreate(item_id=item_id, qty=2, submission_key=KEY), BackgroundTasks(), db,
                    {'username': 'alice', 'user_type': 'project_site', 'project_site': 'Site A'})
            else:
                row = create_item(ItemCreate(**item_payload()), BackgroundTasks(), db,
                    {'username': 'admin', 'user_type': 'admin', 'project_site': None, 'is_global_admin': True})
            return row.id

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert results[0] == results[1]
    with factory() as db:
        assert db.query(CreationReceipt).count() == 1
        assert db.query(Request if kind == 'request' else Item).count() == 1
        assert db.query(Notification).count() == (2 if kind == 'request' else 0)


def test_simultaneous_key_reuse_across_projects_has_one_winner(concurrent_db):
    factory = sessionmaker(bind=concurrent_db)
    with factory() as db:
        seed_site(db, 'Site A')
        seed_site(db, 'Site B')
    ready = Barrier(2)

    def submit(site):
        with factory() as db:
            ready.wait(timeout=10)
            try:
                row = create_item(ItemCreate(**item_payload(site)), BackgroundTasks(), db,
                    {'username': 'admin', 'user_type': 'admin', 'project_site': None, 'is_global_admin': True})
                return (200, row.id)
            except HTTPException as exc:
                return (exc.status_code, None)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, ['Site A', 'Site B']))
    assert sorted(result[0] for result in results) == [200, 409]
    with factory() as db:
        assert db.query(Item).count() == 1
        assert db.query(CreationReceipt).count() == 1
