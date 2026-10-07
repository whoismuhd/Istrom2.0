"""Authorization, credential, and upload regression checks with real sessions."""
import io
import runpy
from pathlib import Path
from datetime import datetime
from zipfile import ZipFile, ZIP_DEFLATED

import pytest
from jose import jwt
from starlette.websockets import WebSocketDisconnect

from api.main import app
from api.dependencies import get_current_user, get_current_admin, get_authenticated_user, create_access_token, JWT_SECRET
from api.services.auth_service import hash_access_code, verify_access_code
from api.services.code_storage import encrypt_legacy_codes, decrypt_code
from api.services.workbook_security import validate_workbook_archive
from models import AccessCode, ProjectSite, ProjectSiteAccessCode, Item, Request, Actual, Notification, NotificationRead, DeletedRequest
from tests.conftest import build_workbook, account_token
from openpyxl import Workbook


@pytest.fixture
def identities(client, test_db):
    ac = AccessCode(admin_code='configured', user_code='unused')
    test_db.add(ac)
    test_db.flush()
    tokens = {'global': account_token(test_db, 'admin', 'admin')}
    for name in ('A', 'B'):
        test_db.add(ProjectSite(name=name, is_active=True))
        tokens[f'{name}:project_site'] = account_token(test_db, f'user-{name.lower()}', 'project_site', name)
    test_db.commit()
    app.dependency_overrides.pop(get_current_user)
    app.dependency_overrides.pop(get_current_admin)
    app.dependency_overrides.pop(get_authenticated_user)
    return {name: {'Authorization': 'Bearer ' + token} for name, token in tokens.items()}


def test_every_sensitive_resource_requires_login(client, identities):
    for path in ('/items', '/requests', '/actuals', '/notifications', '/project-sites', '/users',
                 '/access-logs', '/deleted-requests', '/auth/me', '/push/vapid-public-key'):
        assert client.get(path).status_code == 401, path
    assert client.post('/push/subscription-status', json={'endpoint':'https://fcm.googleapis.com/test'}).status_code == 401


def test_read_access_is_site_scoped_and_settings_global_only(client, test_db, identities):
    for name in ('A', 'B'):
        item = Item(name='Cement ' + name, category='Materials', unit='bags', qty=10, unit_cost=100,
                    planned_qty=10, planned_unit_cost=100, project_site=name)
        test_db.add(item)
        test_db.flush()
        test_db.add(Request(item_id=item.id, qty=1, status='Pending', requested_by='Tester', project_site=name))
        test_db.add(Actual(item_id=item.id, actual_qty=1, actual_cost=100, actual_date=datetime(2026, 10, 5), recorded_by='Tester', project_site=name))
        test_db.add(Notification(notification_type='request_approved', title=name, project_site=name))
    test_db.commit()
    for role in ('A:project_site',):
        headers = identities[role]
        assert client.get('/auth/me', headers=headers).json()['project_site'] == 'A'
        for path in ('/items', '/requests', '/actuals'):
            response = client.get(path, headers=headers)
            assert response.status_code == 200
            assert len(response.json()) == 1
            assert response.json()[0]['project_site'] == 'A'
            assert client.get(path + '?project_site=B', headers=headers).status_code == 403
        assert [n['title'] for n in client.get('/notifications', headers=headers).json()] == ['A']
        for path in ('/project-sites', '/users', '/access-logs'):
            assert client.get(path, headers=headers).status_code == 403
    assert len(client.get('/items', headers=identities['global']).json()) == 2


def test_cross_site_records_cannot_be_changed(client, test_db, identities):
    item = Item(name='Other site cement', category='Materials', unit='bags', qty=10, unit_cost=100,
                planned_qty=10, planned_unit_cost=100, project_site='B')
    test_db.add(item)
    test_db.flush()
    request = Request(item_id=item.id, qty=1, status='Pending', requested_by='Tester', project_site='B')
    actual = Actual(item_id=item.id, actual_qty=1, actual_cost=100, actual_date=datetime(2026, 10, 5), recorded_by='Tester', project_site='B')
    notification = Notification(notification_type='request_approved', title='Other', project_site='B')
    test_db.add_all([request, actual, notification])
    test_db.commit()
    for role in ('A:project_site',):
        headers = identities[role]
        for method, path, body in [
            ('patch', f'/items/{item.id}', {'qty': 0}), ('delete', f'/items/{item.id}', None),
            ('post', '/requests', {'item_id': item.id, 'qty': 1, 'requested_by': 'Tester'}),
            ('patch', f'/requests/{request.id}/status', {'status': 'Approved'}),
            ('delete', f'/requests/{request.id}', None), ('delete', f'/actuals/{actual.id}', None),
            ('post', f'/notifications/{notification.id}/read', None), ('delete', f'/notifications/{notification.id}', None),
        ]:
            kwargs = {'headers': headers}
            if body is not None:
                kwargs['json'] = body
            assert client.request(method, path, **kwargs).status_code in (403, 404), path
    test_db.refresh(item)
    test_db.refresh(request)
    assert item.qty == 10 and request.status == 'Pending'
    assert test_db.query(Actual).count() == 1


def test_admin_cannot_submit_but_can_review_site_user_requests(client, test_db, identities, monkeypatch):
    monkeypatch.setattr('api.routes.requests.send_push_for_notification', lambda *args: None)
    item = Item(name='Cement', category='Materials', unit='bags', qty=10, unit_cost=100,
                planned_qty=10, planned_unit_cost=100, project_site='A')
    test_db.add(item)
    test_db.commit()
    payload = {'item_id': item.id, 'qty': 2, 'project_site': 'A', 'requested_by': 'user-a'}
    denied = client.post('/requests', headers=identities['global'], json=payload)
    assert denied.status_code == 403 and 'Only site users' in denied.json()['detail']
    assert test_db.query(Request).count() == 0
    assert test_db.query(Notification).count() == 0
    submitted = client.post('/requests', headers=identities['A:project_site'], json=payload)
    assert submitted.status_code == 200
    assert submitted.json()['requested_by'] == 'user-a'
    assert client.get('/requests', headers=identities['global']).status_code == 200
    approved = client.patch(f"/requests/{submitted.json()['id']}/status",
                            headers=identities['global'], json={'status': 'Approved'})
    assert approved.status_code == 200 and approved.json()['status'] == 'Approved'
    test_db.refresh(item)
    assert item.qty == 8 and item.planned_qty == 10


def test_notification_read_status_is_personal_and_receipts_are_cleaned_up(client, test_db, identities):
    second = {'Authorization': 'Bearer ' + account_token(test_db, 'second-site-user', site='A')}
    notification = Notification(notification_type='request_approved', title='Approved', project_site='A', is_read=False)
    submitted = Notification(notification_type='request_submitted', title='Submitted', project_site='A')
    test_db.add_all([notification, submitted])
    test_db.commit()
    path = f'/notifications/{notification.id}/read'
    assert client.post(path, headers=identities['B:project_site']).status_code == 403
    for _ in range(2):
        assert client.post(path, headers=identities['A:project_site']).status_code == 200
    assert test_db.query(NotificationRead).count() == 1
    for headers, expected in [(identities['A:project_site'], True), (second, False), (identities['global'], False)]:
        rows = {row['id']: row for row in client.get('/notifications', headers=headers).json()}
        assert rows[notification.id]['is_read'] is expected
    assert client.post(f'/notifications/{submitted.id}/read', headers=identities['global']).status_code == 403
    assert client.delete(f'/notifications/{notification.id}', headers=identities['global']).status_code == 200
    assert test_db.query(NotificationRead).count() == 0
    assert client.post(f'/notifications/{submitted.id}/read', headers=second).status_code == 200
    assert client.delete('/notifications', headers=identities['global']).status_code == 200
    assert test_db.query(NotificationRead).count() == 0


def test_deleted_log_clearing_preserves_other_sites_and_requires_global_admin(client, test_db, identities):
    test_db.add_all([DeletedRequest(req_id=1, project_site='A'), DeletedRequest(req_id=2, project_site='B')])
    test_db.commit()
    assert len(client.get('/deleted-requests', headers=identities['global']).json()) == 2
    assert client.delete('/deleted-requests?project_site=A', headers=identities['A:project_site']).status_code == 403
    assert client.delete('/deleted-requests?project_site=A', headers=identities['global']).status_code == 200
    assert [row['project_site'] for row in client.get('/deleted-requests', headers=identities['global']).json()] == ['B']


def test_realtime_read_updates_are_personal_and_workspace_updates_are_site_scoped():
    import asyncio
    from starlette.websockets import WebSocketState
    from api.services.notification_hub import NotificationHub

    class Socket:
        application_state = WebSocketState.CONNECTED

        def __init__(self):
            self.events = []

        async def send_json(self, payload):
            self.events.append(payload)

    async def verify():
        hub = NotificationHub()
        admin, first, same_user_device, second, other_site = [Socket() for _ in range(5)]
        for socket, user in [
            (admin, {'user_type': 'admin', 'is_global_admin': True, 'user_id': 1}),
            (first, {'user_type': 'project_site', 'project_site': 'A', 'user_id': 2}),
            (same_user_device, {'user_type': 'project_site', 'project_site': 'A', 'user_id': 2}),
            (second, {'user_type': 'project_site', 'project_site': 'A', 'user_id': 3}),
            (other_site, {'user_type': 'project_site', 'project_site': 'B', 'user_id': 4}),
        ]:
            await hub.connect(socket, user)
        await hub.broadcast_notification_read(10, 2)
        assert [len(socket.events) for socket in (admin, first, same_user_device, second, other_site)] == [0, 1, 1, 0, 0]
        await hub.broadcast_workspace_changed('A')
        assert [len(socket.events) for socket in (admin, first, same_user_device, second, other_site)] == [1, 2, 2, 1, 0]
        assert admin.events[0]['type'] == 'workspace_updated'
    asyncio.run(verify())


@pytest.mark.parametrize('changes', [
    {'credential_id': '1'}, {'credential_id': True}, {'credential_id': -1},
    {'session_version': {}}, {'is_global_admin': 'true'}, {'user_type': 'project_site'},
    {'project_site': 'A'}, {'exp': None}, {'exp': 1},
])
def test_invalid_session_claims_are_rejected(client, identities, changes):
    payload = dict(username='admin', credential_kind='user', user_type='admin', is_global_admin=True, project_site=None, credential_id=1, session_version=1)
    token = create_access_token(payload)
    decoded = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
    decoded.update(changes)
    token = jwt.encode(decoded, JWT_SECRET, algorithm='HS256')
    assert client.get('/items', headers={'Authorization': 'Bearer ' + token}).status_code == 401


def test_sessions_require_expiry_and_cannot_change_signature_algorithm(client, identities):
    payload = dict(user_type='admin', is_global_admin=True, project_site=None, credential_id=1, session_version=1)
    for token in (jwt.encode(payload, JWT_SECRET, algorithm='HS256'), jwt.encode(payload, JWT_SECRET, algorithm='HS512')):
        assert client.get('/items', headers={'Authorization': 'Bearer ' + token}).status_code == 401


def test_websocket_auth_is_message_based_and_origin_checked(client, identities):
    token = identities['global']['Authorization'].removeprefix('Bearer ')
    with client.websocket_connect('/ws/notifications', headers={'Origin': 'http://localhost:5173'}) as socket:
        socket.send_json({'type': 'authenticate', 'token': token})
        assert socket.receive_json()['type'] == 'connected'
        socket.send_text('ping')
        assert socket.receive_json()['type'] == 'pong'
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect('/ws/notifications', headers={'Origin': 'https://attacker.test'}):
            pass
    assert error.value.code == 1008
    with client.websocket_connect('/ws/notifications?token=' + token) as socket:
        socket.send_text('ping')
        with pytest.raises(WebSocketDisconnect) as error:
            socket.receive_json()
        assert error.value.code == 1008


def test_legacy_recoverable_codes_are_encrypted_idempotently(test_db):
    credential = ProjectSiteAccessCode(project_site='Legacy', admin_code='', user_code=hash_access_code('legacy-code'), user_code_plain='legacy-code')
    test_db.add(credential)
    test_db.commit()
    original_hash = credential.user_code
    assert encrypt_legacy_codes(test_db)
    test_db.commit()
    assert credential.user_code_plain != 'legacy-code'
    assert decrypt_code(credential.user_code_plain) == 'legacy-code'
    assert credential.user_code == original_hash and credential.session_version == 1
    encrypted = credential.user_code_plain
    assert not encrypt_legacy_codes(test_db)
    assert credential.user_code_plain == encrypted


def test_access_codes_cannot_collide_at_bcrypt_truncation_boundary(client):
    stored = hash_access_code('x' * 72)
    assert verify_access_code('x' * 72, stored)
    assert not verify_access_code('x' * 72 + 'different', stored)
    for value in ('x' * 73, 'é' * 37):
        assert client.post('/auth/setup', json={'access_code': value, 'username': 'admin', 'full_name': 'Test', 'password': 'A long test passphrase'}).status_code == 422


def test_security_headers_and_body_limits(client):
    from api.settings import ALLOWED_ORIGINS
    response = client.get('/health')
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert response.headers['referrer-policy'] == 'no-referrer'
    assert client.post('/auth/login', content='x' * (2 * 1024 * 1024 + 1)).status_code == 413
    response = client.post('/auth/login', content=iter([b'x' * (2 * 1024 * 1024 + 1)]))
    assert response.status_code == 413
    # Hosted frontends must be able to read size errors from a separate API origin.
    response = client.post('/auth/login', content='x' * (2 * 1024 * 1024 + 1),
                           headers={'Origin': ALLOWED_ORIGINS[0]})
    assert response.status_code == 413
    assert response.headers.get('access-control-allow-origin') == ALLOWED_ORIGINS[0]
    response = client.post('/auth/login', content='x' * (2 * 1024 * 1024 + 1),
                           headers={'Origin': 'https://attacker.test'})
    assert 'access-control-allow-origin' not in response.headers


@pytest.mark.parametrize('secret', ['', 'short', 'istrom-secret-change-in-production'])
def test_weak_or_default_signing_secret_blocks_startup(monkeypatch, secret):
    monkeypatch.setenv('JWT_SECRET', secret)
    with pytest.raises(RuntimeError, match='JWT_SECRET'):
        runpy.run_path(str(Path(__file__).parents[1] / 'api' / 'settings.py'))


def test_wildcard_browser_origins_block_startup(monkeypatch):
    monkeypatch.setenv('CORS_ORIGINS', '*')
    with pytest.raises(RuntimeError, match='CORS_ORIGINS'):
        runpy.run_path(str(Path(__file__).parents[1] / 'api' / 'settings.py'))


@pytest.mark.parametrize('route', ['/bulk-upload/view', '/bulk-upload/preview', '/bulk-upload/analyze'])
def test_bad_workbooks_return_clear_validation_errors(client, test_db, route):
    test_db.add(ProjectSite(name='A', is_active=True))
    test_db.commit()
    response = client.post(route, data={'project_site': 'A'}, files={'file': ('broken.xlsx', b'not a workbook')})
    assert response.status_code == 422
    assert 'workbook' in response.json()['detail'].lower()


def test_workbook_entities_and_zip_expansion_are_rejected(monkeypatch):
    from api.services import workbook_security
    for data in (b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><x>&a;</x>',
                 b'<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x><x/>'.decode().encode('utf-16')):
        buffer = io.BytesIO()
        with ZipFile(buffer, 'w', ZIP_DEFLATED) as archive:
            archive.writestr('xl/workbook.xml', data)
        with pytest.raises(ValueError, match='document type'):
            validate_workbook_archive(buffer.getvalue())
    monkeypatch.setattr(workbook_security, 'MAX_EXPANDED_BYTES', 128)
    with pytest.raises(ValueError, match='expands'):
        validate_workbook_archive(build_workbook([('Sheet', [['Item', 'Qty'], ['Cement', 1]])]))


def test_workbooks_with_unknown_dimensions_still_preview_and_import(client, test_db):
    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet('FLATS BGT 1')
    sheet.append(['Materials', 'Qty', 'Unit', 'Rate'])
    sheet.append(['Cement', 2, 'bags', 1000])
    buffer = io.BytesIO()
    workbook.save(buffer)
    test_db.add(ProjectSite(name='A', is_active=True))
    test_db.commit()
    for route in ('/bulk-upload/view', '/bulk-upload/analyze'):
        response = client.post(route, data={'project_site': 'A'}, files={'file': ('generated.xlsx', buffer.getvalue())})
        assert response.status_code == 200, response.json()
    assert response.json()['item_count'] == 1


def test_csv_previews_keep_only_a_bounded_sample_and_imports_reject_excess_rows(client):
    content = b'name,qty\n' + b'Cement,1\n' * 2001
    response = client.post('/bulk-upload/view', files={'file': ('many.csv', content)})
    assert response.status_code == 200
    sheet = response.json()['sheets'][0]
    assert sheet['total_rows'] == 2001 and sheet['returned_rows'] == 500 and sheet['truncated']
    response = client.post('/bulk-upload/preview', files={'file': ('many.csv', content)})
    assert response.status_code == 422 and 'max rows' in response.json()['detail']
