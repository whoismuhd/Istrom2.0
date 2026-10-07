"""Saved administrator forms must not overwrite concurrent account/site changes."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy.orm import sessionmaker

from api.routes.project_sites import update_project_site
from api.routes.users import update_user
from api.schemas import ProjectSiteUpdate, UserUpdate
from models import AccessCode, Item, ProjectSite, PushSubscription, User
from tests.conftest import make_account


def seed_workspace(db):
    db.add(AccessCode(admin_code='isolated-test-code', user_code='retired'))
    db.add_all([ProjectSite(name=name, is_active=True) for name in ('A', 'B', 'C')])
    db.commit()


def user_payload(site='B', active=True, expected_site='A', expected_active=True):
    return {
        'user_type': 'project_site', 'project_site': site, 'is_active': active,
        'expected': {'user_type': 'project_site', 'project_site': expected_site, 'is_active': expected_active},
    }


@pytest.mark.parametrize('change', ['assignment', 'status', 'role'])
def test_stale_user_edit_rejects_all_writes_and_preserves_sessions(client, test_db, change):
    seed_workspace(test_db)
    account = make_account(test_db, 'subject', site='A')
    account_id = account.id
    if change == 'role':
        account.user_type, account.project_site = 'admin', None
        test_db.commit()
    else:
        assert client.patch(f'/users/{account_id}', json={
            'user_type': 'project_site', 'project_site': 'B' if change == 'assignment' else 'A',
            'is_active': change != 'status',
        }).status_code == 200
    test_db.refresh(account)
    before = (account.user_type, account.project_site, account.is_active, account.session_version)
    subscription = PushSubscription(endpoint='https://push.example.test/subject', p256dh='test', auth='test',
        user_id=account_id, user_type=account.user_type, project_site=account.project_site)
    test_db.add(subscription)
    test_db.commit()
    response = client.patch(f'/users/{account_id}', json=user_payload(site='C', active=False))
    assert response.status_code == 409
    assert 'changed' in response.json()['detail']
    test_db.refresh(account)
    assert (account.user_type, account.project_site, account.is_active, account.session_version) == before
    assert test_db.query(PushSubscription).filter_by(user_id=account_id).count() == 1


def test_current_user_baseline_allows_explicit_assignment_and_status_change(client, test_db):
    seed_workspace(test_db)
    account = make_account(test_db, 'subject', site='A')
    old_version = account.session_version
    response = client.patch(f'/users/{account.id}', json=user_payload(site='B', active=False))
    assert response.status_code == 200
    assert response.json()['project_site'] == 'B'
    assert response.json()['is_active'] is False
    test_db.refresh(account)
    assert account.session_version == old_version + 1
    assert 'expected' not in response.json()


def test_unassigned_disabled_user_can_be_assigned_using_null_baseline(client, test_db):
    seed_workspace(test_db)
    account = make_account(test_db, 'legacy.unassigned', site=None)
    account.is_active = False
    test_db.commit()
    response = client.patch(f'/users/{account.id}', json=user_payload(site='A', expected_site=None, expected_active=False))
    assert response.status_code == 200
    assert response.json()['project_site'] == 'A'
    assert response.json()['is_active'] is True


@pytest.mark.parametrize('expected', [
    {'user_type': 'project_site', 'project_site': 'A'},
    {'user_type': 'owner', 'project_site': 'A', 'is_active': True},
    {'user_type': 'project_site', 'project_site': 'A' * 256, 'is_active': True},
])
def test_malformed_user_baseline_cannot_change_an_account(client, test_db, expected):
    seed_workspace(test_db)
    account = make_account(test_db, 'subject', site='A')
    response = client.patch(f'/users/{account.id}', json={**user_payload(), 'expected': expected})
    assert response.status_code == 422
    test_db.refresh(account)
    assert account.project_site == 'A' and account.is_active is True


@pytest.mark.parametrize('change', ['name', 'description', 'inactive'])
def test_stale_project_edit_preserves_current_site_and_linked_records(client, test_db, change):
    seed_workspace(test_db)
    site = test_db.query(ProjectSite).filter_by(name='A').one()
    site.description = 'Original scope'
    test_db.add(Item(name='Cement', unit='bags', qty=10, unit_cost=100, category='Materials', project_site='A'))
    account = make_account(test_db, 'subject', site='A')
    site_id, account_id = site.id, account.id
    test_db.commit()
    expected = {'name': 'A', 'description': 'Original scope', 'is_active': True}
    if change == 'inactive':
        assert client.delete(f'/project-sites/{site_id}').status_code == 200
    else:
        data = {'name': 'Renamed A'} if change == 'name' else {'description': 'Updated scope'}
        assert client.patch(f'/project-sites/{site_id}', json=data).status_code == 200
    test_db.refresh(site)
    test_db.refresh(account)
    before = (site.name, site.description, site.is_active, account.project_site, account.session_version)
    response = client.patch(f'/project-sites/{site_id}', json={'name': 'Draft name', 'description': 'Draft scope', 'expected': expected})
    assert response.status_code == 409
    test_db.refresh(site)
    test_db.refresh(account)
    assert (site.name, site.description, site.is_active, account.project_site, account.session_version) == before
    assert test_db.query(Item).one().project_site == site.name
    assert test_db.get(User, account_id).project_site == before[3]


def test_current_project_baseline_allows_save_and_null_description_matches_empty_text(client, test_db):
    seed_workspace(test_db)
    site = test_db.query(ProjectSite).filter_by(name='A').one()
    assert site.description is None
    response = client.patch(f'/project-sites/{site.id}', json={
        'name': 'New A', 'description': 'Updated scope',
        'expected': {'name': 'A', 'description': '', 'is_active': True},
    })
    assert response.status_code == 200
    assert response.json()['name'] == 'New A'
    assert response.json()['description'] == 'Updated scope'
    assert 'expected' not in response.json()


def test_inactive_project_cannot_be_renamed_by_an_old_client_without_baseline(client, test_db):
    seed_workspace(test_db)
    site = test_db.query(ProjectSite).filter_by(name='A').one()
    site.is_active = False
    test_db.commit()
    response = client.patch(f'/project-sites/{site.id}', json={'name': 'Reopened by accident'})
    assert response.status_code == 409
    test_db.refresh(site)
    assert site.name == 'A' and site.is_active is False


@pytest.mark.parametrize('kind', ['user', 'project'])
def test_simultaneous_administrator_edits_with_same_baseline_have_one_winner(concurrent_db, kind):
    factory = sessionmaker(bind=concurrent_db)
    with factory() as db:
        seed_workspace(db)
        if kind == 'user':
            record_id = make_account(db, 'subject', site='A').id
        else:
            record_id = db.query(ProjectSite).filter_by(name='A').one().id
    ready = Barrier(2)
    admin = {'username': 'admin', 'user_type': 'admin', 'project_site': None, 'is_global_admin': True}

    def save(value):
        with factory() as db:
            ready.wait(timeout=10)
            try:
                if kind == 'user':
                    update_user(record_id, UserUpdate(**user_payload(site=value)), BackgroundTasks(), db, admin)
                else:
                    update_project_site(record_id, ProjectSiteUpdate(name='New ' + value, description=value,
                        expected={'name': 'A', 'description': None, 'is_active': True}), BackgroundTasks(), db, admin)
                return 200, value
            except HTTPException as exc:
                return exc.status_code, value

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ['B', 'C']))
    assert sorted(status for status, _ in results) == [200, 409]
    winner = next(value for status, value in results if status == 200)
    with factory() as db:
        if kind == 'user':
            saved = db.get(User, record_id)
            assert saved.project_site == winner and saved.is_active is True
            assert saved.session_version == 2
        else:
            saved = db.get(ProjectSite, record_id)
            assert saved.name == 'New ' + winner and saved.description == winner
