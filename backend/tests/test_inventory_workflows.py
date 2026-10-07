"""Regression coverage for approval accounting and project-site access."""
import pytest
from starlette.websockets import WebSocketDisconnect

from api.main import app
from api.dependencies import get_current_user, get_authenticated_user, create_access_token
from api.services.auth_service import hash_access_code
from tests.conftest import account_token, make_account, site_request_identity
from api.services.user_accounts import login_response
from models import (
    AccessCode, Actual, DeletedRequest, Item, Notification, ProjectSite,
    ProjectSiteAccessCode, PushSubscription, Request, User,
)


@pytest.fixture(autouse=True)
def no_external_push(monkeypatch):
    monkeypatch.setattr('api.routes.requests.send_push_for_notification', lambda *args: None)


def add_item(client, site='Site A'):
    if not any(row['name'] == site for row in client.get('/project-sites').json()):
        add_site(client, site)
    response = client.post('/items', json={
        'name': 'Cement', 'qty': 10, 'unit': 'bags', 'unit_cost': 1000,
        'category': 'Materials', 'budget': 'Budget 1 - Flats(General Materials)',
        'section': 'Concrete', 'building_type': 'Flats', 'project_site': site,
    })
    assert response.status_code == 200
    return response.json()


def add_site(client, name='Site A', code='site-a-test-code'):
    response = client.post('/project-sites', json={'name': name, 'user_code': code})
    assert response.status_code == 200
    return response.json()


def add_request(client, item, **overrides):
    with site_request_identity(item['project_site']):
        response = client.post('/requests', json={'item_id': item['id'], 'qty': 4, **overrides})
    assert response.status_code == 200
    return response.json()


def test_approval_and_reversal_preserve_budget(client):
    item = add_item(client)
    req = add_request(client, item)
    for status, stock, actual_qty in [('Approved', 6, 4), ('Approved', 6, 4), ('Pending', 10, 0), ('Approved', 6, 4)]:
        response = client.patch(f"/requests/{req['id']}/status", json={'status': status})
        assert response.status_code == 200
        current = client.get(f"/items/{item['id']}").json()
        assert current['qty'] == stock
        assert current['planned_qty'] == 10
        assert current['planned_unit_cost'] == 1000
        actuals = client.get('/actuals').json()
        assert sum(a['actual_qty'] for a in actuals) == actual_qty
        assert sum(a['actual_cost'] for a in actuals) == actual_qty * 1000
    assert client.delete(f"/requests/{req['id']}").status_code == 200
    assert client.get(f"/items/{item['id']}").json()['qty'] == 10
    assert client.get('/actuals').json() == []


def test_stock_edits_do_not_change_budget_and_budget_can_be_edited(client):
    item = add_item(client)
    response = client.patch(f"/items/{item['id']}", json={'qty': 20, 'unit_cost': 1100})
    assert response.status_code == 200
    assert response.json()['planned_qty'] == 10
    assert response.json()['planned_unit_cost'] == 1000
    response = client.patch(f"/items/{item['id']}", json={'planned_qty': 12, 'planned_unit_cost': 1200})
    assert response.json()['qty'] == 20
    assert response.json()['unit_cost'] == 1100
    assert response.json()['planned_qty'] == 12
    assert response.json()['planned_unit_cost'] == 1200


def test_zero_price_override_is_preserved(client):
    item = add_item(client)
    req = add_request(client, item, current_price=0)
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).status_code == 200
    assert client.get('/actuals').json()[0]['actual_cost'] == 0


def test_admin_can_approve_over_quantity_and_reverse_all_accounting(client):
    item = add_item(client)
    req = add_request(client, item, qty=11)
    response = client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'})
    assert response.status_code == 200
    assert response.json()['approved_shortage_qty'] == 1
    current = client.get(f"/items/{item['id']}").json()
    assert current['qty'] == -1
    assert current['planned_qty'] == 10
    assert current['planned_unit_cost'] == 1000
    actual = client.get('/actuals').json()[0]
    assert actual['actual_qty'] == 11
    assert actual['actual_cost'] == 11000
    approved = client.get('/requests').json()[0]
    assert approved['status'] == 'Approved'
    assert approved['approved_shortage_qty'] == 1
    assert 'Approved over quantity: 1 bags.' in client.get('/notifications').json()[0]['message']
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).json()['approved_shortage_qty'] == 1
    assert client.get(f"/items/{item['id']}").json()['qty'] == -1
    assert len(client.get('/actuals').json()) == 1
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Pending'}).json()['approved_shortage_qty'] == 0
    assert client.get(f"/items/{item['id']}").json()['qty'] == 10
    assert client.get('/actuals').json() == []
    assert client.get('/requests').json()[0]['status'] == 'Pending'
    assert 'Approved over quantity: 1 bags.' in client.get('/notifications').json()[0]['message']


def test_site_user_cannot_approve_over_quantity(client):
    from api.dependencies import get_current_admin
    item = add_item(client)
    req = add_request(client, item, qty=11)
    app.dependency_overrides.pop(get_current_admin)
    app.dependency_overrides[get_current_user] = lambda: {'user_type': 'project_site', 'project_site': 'Lifecamp Kafe'}
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).status_code == 403


def test_approval_actual_cannot_be_deleted_independently(client):
    item = add_item(client)
    req = add_request(client, item)
    client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'})
    actual = client.get('/actuals').json()[0]
    assert client.delete(f"/actuals/{actual['id']}").status_code == 409
    assert client.get('/actuals').json()[0]['actual_cost'] == 4000
    assert client.get(f"/items/{item['id']}").json()['qty'] == 6
    assert client.get('/requests').json()[0]['status'] == 'Approved'


def test_manual_actual_can_be_deleted(client):
    item = add_item(client)
    response = client.post('/actuals', json={'item_id': item['id'], 'actual_qty': 2, 'actual_cost': 2000,
        'actual_date': '2026-10-02T12:00:00', 'recorded_by': 'Test Admin'})
    assert response.status_code == 200
    assert client.delete(f"/actuals/{response.json()['id']}").status_code == 200


def test_inventory_edits_request_reversals_and_deletions_refresh_other_clients(client, monkeypatch):
    changed_sites = []
    async def record_change(site):
        changed_sites.append(site)
    monkeypatch.setattr('api.services.notification_hub.notification_hub.broadcast_workspace_changed', record_change)
    item = add_item(client)
    req = add_request(client, item)
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).status_code == 200
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Pending'}).status_code == 200
    assert client.delete(f"/requests/{req['id']}").status_code == 200
    assert client.patch(f"/items/{item['id']}", json={'qty': 20, 'expected_qty': 10}).status_code == 200
    actual = client.post('/actuals', json={'item_id': item['id'], 'actual_qty': 2, 'actual_cost': 2000,
        'actual_date': '2026-10-02T12:00:00', 'recorded_by': 'Test Admin'}).json()
    assert client.delete(f"/actuals/{actual['id']}").status_code == 200
    assert client.delete(f"/items/{item['id']}").status_code == 200
    assert changed_sites == [None] + ['Site A'] * 7


def test_project_and_account_changes_refresh_other_admin_workspaces(client, monkeypatch):
    changed_sites = []
    async def record_change(site):
        changed_sites.append(site)
    monkeypatch.setattr('api.services.notification_hub.notification_hub.broadcast_workspace_changed', record_change)
    site = client.post('/project-sites', json={'name':'Team project'}).json()
    assert client.patch(f"/project-sites/{site['id']}", json={'description':'Updated'}).status_code == 200
    account = client.post('/users', json={'username':'new.person','password':'Temporary password 2026',
        'user_type':'project_site','project_site':'Team project'}).json()
    assert client.patch(f"/users/{account['id']}", json={'is_active':False,'user_type':'project_site',
        'project_site':'Team project'}).status_code == 200
    assert client.post(f"/users/{account['id']}/reset-password", json={'password':'Another temporary password 2026'}).status_code == 200
    assert client.delete(f"/project-sites/{site['id']}").status_code == 200
    assert changed_sites == [None] * 6


def test_site_rename_moves_every_record_and_invalidates_old_token(client, test_db):
    site = add_site(client)
    token = account_token(test_db, 'person-a', site='Site A')
    item = add_item(client)
    req = add_request(client, item)
    client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'})
    test_db.add(DeletedRequest(req_id=999, project_site='Site A'))
    test_db.add(User(username='site-user', user_type='project_site', project_site='Site A'))
    test_db.add(PushSubscription(endpoint='https://example.test/renamed', p256dh='test', auth='test',
        user_type='project_site', project_site='Site A'))
    test_db.commit()
    response = client.patch(f"/project-sites/{site['id']}", json={'name': 'Site A Renamed'})
    assert response.status_code == 200
    for model in (Item, Request, Actual, Notification, DeletedRequest, User, PushSubscription):
        assert test_db.query(model).filter(model.project_site == 'Site A').count() == 0
        assert test_db.query(model).filter(model.project_site == 'Site A Renamed').count() >= 1
    assert len(client.get('/items', params={'project_site': 'Site A Renamed'}).json()) == 1
    app.dependency_overrides.pop(get_current_user)
    app.dependency_overrides.pop(get_authenticated_user)
    assert client.get('/items', headers={'Authorization': 'Bearer ' + token}).status_code == 401
    fresh = login_response(test_db.query(User).filter_by(username='person-a').one())['token']
    assert client.get('/items', headers={'Authorization': 'Bearer ' + fresh}).status_code == 200


def test_duplicate_site_names_rejected_before_any_data_changes(client, test_db):
    first = add_site(client)
    second = add_site(client, 'Site B', 'site-b-code')
    assert client.post('/project-sites', json={'name': ' site a ', 'user_code': 'other'}).status_code == 409
    assert client.patch(f"/project-sites/{second['id']}", json={'name': 'Site A'}).status_code == 409
    assert test_db.query(ProjectSite).count() == 2
    assert test_db.query(ProjectSiteAccessCode).count() == 0
    assert test_db.get(ProjectSite, first['id']).name == 'Site A'
    assert test_db.get(ProjectSite, second['id']).name == 'Site B'


def test_site_deactivation_revokes_http_websocket_and_push(client, test_db):
    site = add_site(client)
    add_site(client, 'Site B')
    old_token = account_token(test_db, 'person-a', site='Site A')
    other_token = account_token(test_db, 'person-b', site='Site B')
    test_db.add(PushSubscription(endpoint='https://example.test/revoked', p256dh='test', auth='test',
        user_type='project_site', project_site='Site A'))
    test_db.commit()
    app.dependency_overrides.pop(get_current_user)
    app.dependency_overrides.pop(get_authenticated_user)
    auth = {'Authorization': 'Bearer ' + old_token}
    assert client.get('/items', headers=auth).status_code == 200
    with client.websocket_connect('/ws/notifications') as socket:
        socket.send_json({'type': 'authenticate', 'token': old_token})
        assert socket.receive_json()['type'] == 'connected'
        # Keep the fixture admin override only for this site-management action.
        app.dependency_overrides[get_current_user] = lambda: {'user_type': 'admin', 'is_global_admin': True}
        response = client.delete(f"/project-sites/{site['id']}")
        app.dependency_overrides.pop(get_current_user)
        assert response.status_code == 200
        with pytest.raises(WebSocketDisconnect) as close:
            socket.receive_json()
        assert close.value.code == 1008
    assert client.get('/items', headers=auth).status_code == 401
    assert test_db.query(PushSubscription).count() == 0
    assert client.get('/items', headers={'Authorization': 'Bearer ' + other_token}).status_code == 200


def test_unversioned_tokens_require_fresh_login(client):
    token = create_access_token({'user_type': 'admin', 'is_global_admin': True})
    app.dependency_overrides.pop(get_current_user)
    app.dependency_overrides.pop(get_authenticated_user)
    assert client.get('/items', headers={'Authorization': 'Bearer ' + token}).status_code == 401


def test_unknown_or_missing_site_cannot_create_inventory(client):
    payload = {'name': 'Cement', 'qty': 10, 'unit': 'bags', 'unit_cost': 1000,
        'category': 'Materials', 'budget': 'Budget 1', 'section': 'Concrete', 'building_type': 'Flats'}
    assert client.post('/items', json=payload).status_code == 422
    assert client.post('/items', json={**payload, 'project_site': 'Missing'}).status_code == 422
    assert client.get('/items').json() == []


def test_nonfinite_values_cannot_enter_inventory(client):
    item = add_item(client)
    for value in ['Infinity', 'NaN', '-Infinity']:
        assert client.patch(f"/items/{item['id']}", json={'qty': value}).status_code == 422
    assert client.get(f"/items/{item['id']}").json()['qty'] == 10


@pytest.mark.parametrize('field', ['name', 'unit'])
def test_blank_item_names_and_units_do_not_create_incomplete_inventory(client, field):
    add_site(client)
    payload = {'name':'Cement','unit':'bags','qty':10,'unit_cost':1000,'category':'Materials',
               'budget':'Budget 1','section':'Concrete','building_type':'Flats','project_site':'Site A'}
    response = client.post('/items', json={**payload, field:'   '})
    assert response.status_code == 422
    assert client.get('/items').json() == []


def test_approval_uses_authenticated_actor_and_exposes_decision_timestamp(client):
    req = add_request(client, add_item(client))
    result = client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved', 'approved_by': 'Forged person'})
    assert result.status_code == 200
    assert result.json()['approved_by'] == 'admin'
    assert result.json()['updated_at']
    assert client.get('/requests').json()[0]['updated_at'] == result.json()['updated_at']


def test_notifications_follow_selected_site(client):
    for site in ['Site A', 'Site B']:
        add_request(client, add_item(client, site))
    assert len(client.get('/notifications').json()) == 2
    assert len(client.get('/notifications', params={'project_site': 'Site A'}).json()) == 1
    assert client.get('/notifications', params={'project_site': 'Site A'}).json()[0]['title'] == 'New Request'


def test_request_and_notifications_roll_back_together(client, test_db):
    from sqlalchemy import event
    item = add_item(client)
    def reject_notification(*args):
        raise RuntimeError('Notification storage failed')
    event.listen(Notification, 'before_insert', reject_notification)
    try:
        with site_request_identity(item['project_site']), pytest.raises(RuntimeError, match='Notification storage failed'):
            client.post('/requests', json={'item_id': item['id'], 'qty': 4})
    finally:
        event.remove(Notification, 'before_insert', reject_notification)
        test_db.rollback()
    assert test_db.query(Request).count() == 0
    assert test_db.query(Notification).count() == 0


def test_site_admin_cannot_modify_unassigned_records(client, test_db):
    from api.dependencies import get_current_admin
    item = Item(code='IT-legacy', name='Legacy', qty=10, unit='bags', unit_cost=1000,
        category='Materials', budget='Budget 1', section='Concrete', building_type='Flats', project_site=None)
    test_db.add(item)
    test_db.commit()
    site_admin = {'user_type': 'admin', 'project_site': 'Site A', 'is_global_admin': False}
    app.dependency_overrides[get_current_user] = lambda: site_admin
    app.dependency_overrides[get_current_admin] = lambda: site_admin
    assert client.get(f'/items/{item.id}').status_code == 403
    assert client.patch(f'/items/{item.id}', json={'qty': 1}).status_code == 403
    assert client.delete(f'/items/{item.id}').status_code == 403
    assert test_db.get(Item, item.id).qty == 10


def test_pending_requests_expose_live_shortage_after_other_approval(client):
    item = add_item(client)
    first = add_request(client, item, qty=4)
    second = add_request(client, item, qty=8)
    assert client.patch(f"/requests/{first['id']}/status", json={'status': 'Approved'}).status_code == 200
    requests = {row['id']: row for row in client.get('/requests').json()}
    assert requests[second['id']]['available_qty'] == 6
    assert requests[second['id']]['shortage_qty'] == 2
    assert requests[second['id']]['item_unit'] == 'bags'
    assert requests[first['id']]['shortage_qty'] == 0
    response = client.patch(f"/requests/{second['id']}/status", json={'status': 'Approved'})
    assert response.status_code == 200
    assert response.json()['approved_shortage_qty'] == 2
    original = client.get(f"/items/{item['id']}").json()
    assert original['planned_qty'] == 10
    assert original['planned_unit_cost'] == 1000
    assert original['qty'] == -2
    assert sum(row['actual_qty'] for row in client.get('/actuals').json()) == 12
    assert client.patch(f"/requests/{second['id']}/status", json={'status': 'Pending'}).status_code == 200
    assert client.patch(f"/requests/{first['id']}/status", json={'status': 'Pending'}).status_code == 200
    pending = {row['id']: row for row in client.get('/requests').json()}
    assert pending[second['id']]['shortage_qty'] == 0
    assert pending[second['id']]['available_qty'] == 10


def test_availability_adjustment_rejects_stale_quantity_without_overwriting_usage(client):
    item = add_item(client)
    req = add_request(client, item, qty=4)
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).status_code == 200
    response = client.patch(f"/items/{item['id']}", json={'qty': 20, 'unit_cost': 1200, 'expected_qty': 10})
    assert response.status_code == 409
    current = client.get(f"/items/{item['id']}").json()
    assert current['qty'] == 6
    assert current['unit_cost'] == 1000
    response = client.patch(f"/items/{item['id']}", json={'qty': 20, 'unit_cost': 1200, 'expected_qty': 6})
    assert response.status_code == 200
    assert response.json()['planned_qty'] == 10
    assert response.json()['planned_unit_cost'] == 1000
    assert client.get('/actuals').json()[0]['actual_qty'] == 4


def test_over_quantity_marker_survives_stock_receipts_and_negative_adjustments(client):
    item = add_item(client)
    first = add_request(client, item, qty=12)
    assert client.patch(f"/requests/{first['id']}/status", json={'status': 'Approved'}).json()['approved_shortage_qty'] == 2
    second = add_request(client, item, qty=3)
    pending = {row['id']: row for row in client.get('/requests').json()}[second['id']]
    assert pending['available_qty'] == 0 and pending['shortage_qty'] == 3
    assert client.patch(f"/requests/{second['id']}/status", json={'status': 'Approved'}).json()['approved_shortage_qty'] == 3
    assert client.get(f"/items/{item['id']}").json()['qty'] == -5
    assert client.patch(f"/items/{item['id']}", json={'qty': -5, 'unit_cost': 1200, 'expected_qty': -5}).status_code == 200
    assert client.patch(f"/items/{item['id']}", json={'qty': 10, 'expected_qty': -2}).status_code == 409
    assert client.patch(f"/items/{item['id']}", json={'qty': 10, 'expected_qty': -5}).status_code == 200
    requests = {row['id']: row for row in client.get('/requests').json()}
    assert requests[first['id']]['approved_shortage_qty'] == 2
    assert requests[second['id']]['approved_shortage_qty'] == 3
    assert client.get(f"/items/{item['id']}").json()['planned_qty'] == 10
    assert sum(row['actual_cost'] for row in client.get('/actuals').json()) == 15000
    assert client.delete(f"/requests/{second['id']}").status_code == 200
    assert client.get(f"/items/{item['id']}").json()['qty'] == 13
    assert sum(row['actual_qty'] for row in client.get('/actuals').json()) == 12


def test_request_review_exposes_price_note_section_and_recorded_cost(client):
    item = add_item(client)
    request = add_request(client, item, qty=8, current_price=1500, note='Foundation delivery', building_subtype='B1')
    pending = client.get('/requests').json()[0]
    assert pending['item_unit_cost'] == 1000
    assert pending['current_price'] == 1500
    assert pending['note'] == 'Foundation delivery'
    assert pending['item_section'] == 'Concrete'
    assert pending['item_building_type'] == 'Flats'
    assert pending['project_site'] == 'Site A'
    assert pending['actual_cost'] is None
    assert client.patch(f"/requests/{request['id']}/status", json={'status': 'Approved'}).status_code == 200
    assert client.get('/requests').json()[0]['actual_cost'] == 12000
    assert client.patch(f"/items/{item['id']}", json={'unit_cost': 2000}).status_code == 200
    approved = client.get('/requests').json()[0]
    assert approved['item_unit_cost'] == 2000 and approved['actual_cost'] == 12000
    assert client.patch(f"/requests/{request['id']}/status", json={'status': 'Pending'}).status_code == 200
    assert client.get('/requests').json()[0]['actual_cost'] is None


def test_review_preserves_zero_recorded_cost(client):
    request = add_request(client, add_item(client), current_price=0)
    assert client.patch(f"/requests/{request['id']}/status", json={'status': 'Approved'}).status_code == 200
    assert client.get('/requests').json()[0]['actual_cost'] == 0


def test_request_review_uses_one_query_for_all_linked_items_and_actual_costs(client, test_db):
    from sqlalchemy import event
    item = add_item(client)
    test_db.add_all([Request(item_id=item['id'], qty=1, requested_by='site.requester',
                             status='Pending', project_site='Site A') for _ in range(30)])
    test_db.commit()
    selects = []
    def count_selects(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith('SELECT'):
            selects.append(statement)
    event.listen(test_db.bind, 'before_cursor_execute', count_selects)
    try:
        response = client.get('/requests')
    finally:
        event.remove(test_db.bind, 'before_cursor_execute', count_selects)
    assert response.status_code == 200
    assert len(response.json()) == 30
    assert all(row['item_name'] == 'Cement' and row['item_unit_cost'] == 1000 for row in response.json())
    assert len(selects) == 1


def test_overflowing_item_totals_are_rejected_without_saving_changes(client):
    item = add_item(client)
    payload = {'name': 'Overflow', 'qty': 1e200, 'unit': 'bags', 'unit_cost': 1e200,
        'category': 'Materials', 'budget': 'Budget 1', 'section': 'Concrete',
        'building_type': 'Flats', 'project_site': 'Site A'}
    assert client.post('/items', json=payload).status_code == 422
    assert len(client.get('/items').json()) == 1
    assert client.patch(f"/items/{item['id']}", json={'planned_qty': 1e200, 'planned_unit_cost': 1e200}).status_code == 422
    current = client.get(f"/items/{item['id']}").json()
    assert current['planned_qty'] == 10 and current['planned_unit_cost'] == 1000


def test_overflowing_request_cost_is_rejected_before_creation_or_approval(client, test_db):
    item = add_item(client)
    with site_request_identity('Site A'):
        response = client.post('/requests', json={'item_id': item['id'], 'qty': 1e200, 'current_price': 1e200})
    assert response.status_code == 422
    assert test_db.query(Request).count() == 0
    assert test_db.query(Notification).count() == 0
    # A request created with a representable total may become invalid after a
    # rate edit. Approval must preserve the pending status and stock balance.
    req = add_request(client, item, qty=1e200)
    assert client.patch(f"/items/{item['id']}", json={'unit_cost': 1e200}).status_code == 200
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).status_code == 422
    assert client.get('/requests').json()[0]['status'] == 'Pending'
    assert client.get(f"/items/{item['id']}").json()['qty'] == 10
    assert client.get('/actuals').json() == []


def test_fractional_approvals_and_reversals_do_not_create_false_shortages(client):
    item = add_item(client)
    assert client.patch(f"/items/{item['id']}", json={'qty': 0.3, 'planned_qty': 0.3}).status_code == 200
    requests = [add_request(client, item, qty=qty) for qty in [0.1, 0.2]]
    for req in requests:
        approved = client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'})
        assert approved.status_code == 200
        assert approved.json()['approved_shortage_qty'] == 0
    assert client.get(f"/items/{item['id']}").json()['qty'] == 0
    assert all(row['title'] != 'Request Approved Over Quantity' for row in client.get('/notifications').json())
    for req in requests:
        assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Pending'}).status_code == 200
    assert client.get(f"/items/{item['id']}").json()['qty'] == 0.3


def test_a_real_small_fractional_shortage_is_preserved(client):
    item = add_item(client)
    assert client.patch(f"/items/{item['id']}", json={'qty': 0.3}).status_code == 200
    req = add_request(client, item, qty=0.3000001)
    approved = client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'})
    assert approved.status_code == 200
    assert approved.json()['approved_shortage_qty'] == pytest.approx(0.0000001)
    assert client.get(f"/items/{item['id']}").json()['qty'] == pytest.approx(-0.0000001)


def test_overflowing_stock_balance_rolls_back_the_entire_approval(client):
    item = add_item(client)
    requests = [add_request(client, item, qty=1e308, current_price=0) for _ in range(2)]
    assert client.patch(f"/requests/{requests[0]['id']}/status", json={'status': 'Approved'}).status_code == 200
    assert client.patch(f"/requests/{requests[1]['id']}/status", json={'status': 'Approved'}).status_code == 422
    assert client.get(f"/items/{item['id']}").json()['qty'] == -1e308
    assert sorted(row['status'] for row in client.get('/requests').json()) == ['Approved', 'Pending']
    assert len(client.get('/actuals').json()) == 1


@pytest.mark.parametrize('action', ['reverse', 'delete'])
def test_overflowing_stock_restoration_preserves_request_and_actuals(client, action):
    item = add_item(client)
    req = add_request(client, item, qty=1e308, current_price=0)
    assert client.patch(f"/requests/{req['id']}/status", json={'status': 'Approved'}).status_code == 200
    assert client.patch(f"/items/{item['id']}", json={'qty': 1e308, 'unit_cost': 0}).status_code == 200
    if action == 'reverse':
        response = client.patch(f"/requests/{req['id']}/status", json={'status': 'Pending'})
    else:
        response = client.delete(f"/requests/{req['id']}")
    assert response.status_code == 422
    assert client.get(f"/items/{item['id']}").json()['qty'] == 1e308
    assert client.get('/requests').json()[0]['status'] == 'Approved'
    assert len(client.get('/actuals').json()) == 1
    assert client.get('/deleted-requests').json() == []
