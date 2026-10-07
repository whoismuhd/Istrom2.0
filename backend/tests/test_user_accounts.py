"""Exercise personal logins and account changes with real authorization."""
import pytest
from starlette.websockets import WebSocketDisconnect
from api.main import app
from api.dependencies import get_current_user, get_current_admin, get_authenticated_user, create_access_token, decode_token
from api.services.auth_service import hash_access_code
from api.services.user_accounts import login_response, verify_password, hash_password
from api.account_policy import ADMIN_USERNAME, ADMIN_LOGIN_NAME
from api.services.rate_limit import login_limiter
from models import AccessCode, User, ProjectSite, ProjectSiteAccessCode, PushSubscription, Item, Request, AccessLog
from tests.conftest import make_account, TEST_PASSWORD


@pytest.fixture()
def personal(client, test_db):
    for dependency in (get_current_user, get_current_admin, get_authenticated_user):
        app.dependency_overrides.pop(dependency, None)
    test_db.add(AccessCode(admin_code=hash_access_code('existing-admin-code'), user_code='retired'))
    test_db.add_all([ProjectSite(name='A', is_active=True), ProjectSite(name='B', is_active=True)])
    test_db.commit()
    login_limiter.reset()
    yield client
    login_limiter.reset()


def headers(account):
    return {'Authorization': 'Bearer ' + login_response(account)['token']}


def setup(client, **changes):
    return client.post('/auth/setup', json=dict(access_code='existing-admin-code',
        password=TEST_PASSWORD, **changes))


def test_setup_preserves_projects_closes_shared_logins_and_does_not_reopen(personal, test_db):
    test_db.add(ProjectSiteAccessCode(project_site='A', admin_code='', user_code=hash_access_code('old-site-code')))
    test_db.commit()
    old_admin = create_access_token(dict(username='admin', user_type='admin', project_site=None,
        is_global_admin=True, credential_id=1, session_version=1))
    old_headers = {'Authorization': 'Bearer ' + old_admin}
    assert personal.get('/auth/me', headers=old_headers).json()['needs_account_setup'] is True
    assert personal.get('/items', headers=old_headers).status_code == 403
    old_site = create_access_token(dict(username='A', user_type='project_site', project_site='A',
        is_global_admin=False, credential_id=1, session_version=1))
    assert personal.get('/items', headers={'Authorization': 'Bearer ' + old_site}).status_code == 401
    assert personal.get('/auth/setup-status').json()['setup_required'] is True
    result = setup(personal)
    assert result.status_code == 200, result.json()
    assert 'full_name' not in result.json()['user']
    assert result.json()['user']['username'] == ADMIN_USERNAME
    assert test_db.query(User).one().full_name is None
    assert result.json()['user']['must_change_password'] is False
    assert len(personal.get('/project-sites', headers={'Authorization': 'Bearer ' + result.json()['token']}).json()) == 2
    assert personal.get('/items', headers=old_headers).status_code == 401
    assert personal.get('/auth/setup-status').json()['setup_required'] is False
    assert setup(personal).status_code == 409
    assert personal.post('/auth/login', json={'access_code': 'old-site-code'}).status_code == 422
    assert personal.get('/project-sites/1/access-code', headers=headers(test_db.query(User).one())).status_code == 404
    assert personal.get('/access-codes', headers=headers(test_db.query(User).one())).status_code == 404
    test_db.query(User).update({'is_active': False}); test_db.commit()
    assert personal.get('/auth/setup-status').json()['setup_required'] is False
    assert setup(personal).status_code == 409
    assert test_db.query(ProjectSite).count() == 2


def test_websocket_disconnect_during_authentication_closes_cleanly(test_db):
    import asyncio
    from starlette.websockets import WebSocket
    from api.routes.realtime import notifications_socket

    messages = iter([{'type': 'websocket.connect'}, {'type': 'websocket.disconnect', 'code': 1000}])
    disconnected = False
    sent = []

    async def receive():
        nonlocal disconnected
        message = next(messages)
        disconnected = message['type'] == 'websocket.disconnect'
        return message

    async def send(message):
        # Uvicorn rejects another close after the peer disconnects.
        if disconnected:
            raise RuntimeError('Response already completed')
        sent.append(message['type'])

    socket = WebSocket({'type': 'websocket', 'headers': []}, receive, send)
    asyncio.run(notifications_socket(socket, db=test_db))
    assert sent == ['websocket.accept']


def test_setup_checks_existing_code_and_password_without_logging_secrets(personal, test_db):
    payload = dict(access_code='wrong-code', username='admin.person', password=TEST_PASSWORD)
    assert personal.post('/auth/setup', json=payload).status_code == 401
    assert test_db.query(User).count() == 0
    payload['access_code'] = 'existing-admin-code'; payload['password'] = 'short'
    assert personal.post('/auth/setup', json=payload).status_code == 422
    assert all(log.access_code is None for log in test_db.query(AccessLog).all())


def test_admin_creates_username_only_users_and_assigns_sites_without_codes(personal, test_db):
    admin = make_account(test_db, 'admin', 'admin')
    auth = headers(admin)
    site = personal.post('/project-sites', headers=auth, json={'name': 'New Project', 'description': 'Construction'}).json()
    assert site['name'] == 'New Project'
    assert 'user_code' not in site
    assert test_db.query(ProjectSiteAccessCode).count() == 0
    data = dict(username='  Jane.Site  ', password=TEST_PASSWORD,
        user_type='project_site', project_site='New Project')
    result = personal.post('/users', headers=auth, json=data)
    assert result.status_code == 200, result.json()
    account = result.json()
    assert account['username'] == 'jane.site' and account['must_change_password'] is True
    assert not {'full_name', 'password', 'password_hash', 'session_version', 'login_name'} & account.keys()
    assert personal.post('/users', headers=auth, json={**data, 'username': 'JANE.SITE'}).status_code == 409
    stored = test_db.get(User, account['id'])
    assert stored.full_name is None
    assert TEST_PASSWORD not in stored.password_hash and verify_password(TEST_PASSWORD, stored.password_hash)
    for bad in ({'username': 'bad', 'project_site': None}, {'username': 'bad', 'project_site': 'Missing'},
                {'username': 'bad', 'user_type': 'owner'}):
        assert personal.post('/users', headers=auth, json={**data, **bad}).status_code == 422


def test_legacy_full_names_are_ignored_without_changing_credentials_or_history(personal, test_db):
    admin = make_account(test_db, 'admin', 'admin')
    account = make_account(test_db, 'legacy.site', site='A')
    original_name, original_hash, original_version = account.full_name, account.password_hash, account.session_version
    token = login_response(account)['token']
    legacy_token = create_access_token({**decode_token(token), 'full_name': original_name})
    auth = {'Authorization': 'Bearer ' + legacy_token}
    identity = personal.get('/auth/me', headers=auth)
    assert identity.status_code == 200 and identity.json()['username'] == account.username
    assert 'full_name' not in identity.json()
    assert personal.get('/items', headers=auth).status_code == 200
    item = Item(name='Cement', category='Materials', unit='bags', qty=10, unit_cost=100, project_site='A')
    test_db.add(item); test_db.flush()
    historical = Request(item_id=item.id, qty=1, requested_by=original_name, requested_by_user_id=account.id,
                         project_site='A', status='Pending')
    test_db.add(historical); test_db.commit()
    update = personal.patch(f'/users/{account.id}', headers=headers(admin), json={
        'user_type': 'project_site', 'project_site': 'A', 'is_active': True, 'full_name': 'Ignored replacement',
    })
    assert update.status_code == 200 and 'full_name' not in update.json()
    test_db.refresh(account)
    assert (account.full_name, account.password_hash, account.session_version) == (original_name, original_hash, original_version)
    assert personal.get('/items', headers=auth).status_code == 200
    assert test_db.get(Request, historical.id).requested_by == original_name
    directory = personal.get('/users', headers=headers(admin)).json()
    assert all('full_name' not in row for row in directory)
    created = personal.post('/users', headers=headers(admin), json={
        'username': 'new.site', 'password': TEST_PASSWORD, 'user_type': 'project_site',
        'project_site': 'A', 'full_name': 'Ignored name',
    })
    assert created.status_code == 200 and 'full_name' not in created.json()
    assert test_db.get(User, created.json()['id']).full_name is None


def test_temporary_password_restricts_all_records_until_changed(personal, test_db):
    account = make_account(test_db, 'jane.site', site='A', must_change=True)
    result = personal.post('/auth/login', json={'user_type': 'project_site', 'username': ' JANE.SITE ', 'password': TEST_PASSWORD})
    assert result.status_code == 200
    auth = {'Authorization': 'Bearer ' + result.json()['token']}
    assert personal.get('/auth/me', headers=auth).json()['must_change_password'] is True
    for path in ('/items', '/requests', '/actuals', '/notifications', '/users'):
        assert personal.get(path, headers=auth).status_code == 403
    with personal.websocket_connect('/ws/notifications') as socket:
        socket.send_json({'type': 'authenticate', 'token': result.json()['token']})
        with pytest.raises(WebSocketDisconnect): socket.receive_json()
    assert personal.post('/auth/password', headers=auth, json={'current_password': 'incorrect', 'new_password': 'My own long passphrase'}).status_code == 400
    assert personal.post('/auth/password', headers=auth, json={'current_password': TEST_PASSWORD, 'new_password': TEST_PASSWORD}).status_code == 422
    response = personal.post('/auth/password', headers=auth, json={'current_password': TEST_PASSWORD, 'new_password': 'My own long passphrase'})
    assert response.status_code == 200 and response.json()['user']['must_change_password'] is False
    assert personal.get('/items', headers=auth).status_code == 401
    new_auth = {'Authorization': 'Bearer ' + response.json()['token']}
    assert personal.get('/items', headers=new_auth).status_code == 200
    assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': account.username, 'password': TEST_PASSWORD}).status_code == 401
    assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': account.username, 'password': 'My own long passphrase'}).status_code == 200


@pytest.mark.parametrize('change', ['disable', 'reassign', 'reset'])
def test_account_changes_revoke_only_that_person_http_websocket_and_push(personal, test_db, change):
    admin = make_account(test_db, 'admin', 'admin')
    account = make_account(test_db, 'subject', site='A')
    colleague = make_account(test_db, 'colleague', site='A')
    auth, colleague_auth = headers(account), headers(colleague)
    for owner in (account, colleague):
        test_db.add(PushSubscription(endpoint=f'https://test/{owner.id}', p256dh='test', auth='test',
            user_id=owner.id, user_type=owner.user_type, project_site=owner.project_site))
    test_db.commit()
    with personal.websocket_connect('/ws/notifications') as socket:
        socket.send_json({'type': 'authenticate', 'token': auth['Authorization'].split()[1]})
        assert socket.receive_json()['type'] == 'connected'
        if change == 'reset':
            result = personal.post(f'/users/{account.id}/reset-password', headers=headers(admin), json={'password': 'Replacement test passphrase'})
        else:
            result = personal.patch(f'/users/{account.id}', headers=headers(admin), json=dict(
                user_type='project_site', is_active=change != 'disable', project_site='B' if change == 'reassign' else 'A'))
        assert result.status_code == 200, result.json()
        with pytest.raises(WebSocketDisconnect) as close: socket.receive_json()
        assert close.value.code == 1008
    assert personal.get('/items', headers=auth).status_code == 401
    assert personal.get('/items', headers=colleague_auth).status_code == 200
    assert test_db.query(PushSubscription).filter_by(user_id=account.id).count() == 0
    assert test_db.query(PushSubscription).filter_by(user_id=colleague.id).count() == 1
    if change == 'disable':
        assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': 'subject', 'password': TEST_PASSWORD}).status_code == 401
        restored = personal.patch(f'/users/{account.id}', headers=headers(admin), json=dict(
            user_type='project_site', project_site='A', is_active=True))
        assert restored.status_code == 200
        assert personal.get('/items', headers=auth).status_code == 401
        assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': 'subject', 'password': TEST_PASSWORD}).status_code == 200
    if change == 'reset':
        assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': 'subject', 'password': TEST_PASSWORD}).status_code == 401
        fresh = personal.post('/auth/login', json={'user_type': 'project_site', 'username': 'subject', 'password': 'Replacement test passphrase'})
        assert fresh.json()['user']['must_change_password'] is True


def test_site_user_reads_own_site_and_submits_with_server_verified_identity(personal, test_db, monkeypatch):
    monkeypatch.setattr('api.routes.requests.send_push_for_notification', lambda *args: None)
    account = make_account(test_db, 'jane', site='A')
    auth = headers(account)
    for site in ('A', 'B'):
        test_db.add(Item(name=site, category='Materials', unit='bags', qty=100, unit_cost=10, project_site=site))
    test_db.commit()
    item = test_db.query(Item).filter_by(project_site='A').one()
    other = test_db.query(Item).filter_by(project_site='B').one()
    assert len(personal.get('/items', headers=auth).json()) == 1
    assert personal.get('/items?project_site=B', headers=auth).status_code == 403
    request = personal.post('/requests', headers=auth, json={'item_id': item.id, 'qty': 4, 'requested_by': 'Forged Name'})
    assert request.status_code == 200 and request.json()['requested_by'] == account.username
    assert test_db.get(Request, request.json()['id']).requested_by_user_id == account.id
    assert personal.post('/requests', headers=auth, json={'item_id': other.id, 'qty': 4}).status_code == 403
    for method, path, data in [('GET', '/users', None), ('POST', '/users', {'username': 'new', 'full_name': 'Test', 'user_type': 'admin', 'password': TEST_PASSWORD}),
        ('PATCH', f'/items/{item.id}', {'qty': 0}), ('DELETE', f'/items/{item.id}', None),
        ('PATCH', f'/requests/{request.json()["id"]}/status', {'status': 'Approved'}), ('DELETE', f'/requests/{request.json()["id"]}', None)]:
        kwargs = {'headers': auth}
        if data is not None: kwargs['json'] = data
        assert personal.request(method, path, **kwargs).status_code == 403
    admin = make_account(test_db, 'admin', 'admin')
    approved = personal.patch(f'/requests/{request.json()["id"]}/status', headers=headers(admin), json={'status': 'Approved', 'approved_by': 'Forged Admin'})
    assert approved.json()['approved_by'] == admin.username
    assert test_db.get(Request, request.json()['id']).approved_by_user_id == admin.id


def test_self_lockout_and_last_administrator_are_prevented(personal, test_db):
    admin = make_account(test_db, 'admin', 'admin')
    data = dict(full_name=admin.full_name, user_type='admin', is_active=False, project_site=None)
    assert personal.patch(f'/users/{admin.id}', headers=headers(admin), json=data).status_code == 409
    assert personal.post(f'/users/{admin.id}/reset-password', headers=headers(admin), json={'password': TEST_PASSWORD}).status_code == 409
    # An authenticated fixture admin cannot disable the last real admin either.
    app.dependency_overrides[get_current_user] = lambda: {'user_type': 'admin', 'is_global_admin': True, 'username': 'fixture'}
    assert personal.patch(f'/users/{admin.id}', json=data).status_code == 409
    assert test_db.get(User, admin.id).is_active


def test_failed_login_is_generic_and_rate_limited_by_account_across_addresses(personal, test_db):
    make_account(test_db, 'jane', site='A')
    for name in ('missing', 'jane'):
        response = personal.post('/auth/login', json={'user_type': 'project_site', 'username': name, 'password': 'wrong'})
        assert response.status_code == 401 and response.json()['detail'] == 'Invalid username or password.'
    login_limiter.reset()
    for _ in range(login_limiter.max_attempts):
        assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': 'jane', 'password': 'wrong'}).status_code == 401
    login_limiter.record_success('ip:testclient')
    assert personal.post('/auth/login', json={'user_type': 'project_site', 'username': 'JANE', 'password': 'wrong'}).status_code == 429
    assert all(row.access_code is None for row in test_db.query(AccessLog).all())


@pytest.mark.parametrize('role', ['admin', 'project_site'])
def test_login_requires_the_matching_portal_and_uses_saved_permissions(personal, test_db, role):
    # Existing accounts may have names from an earlier version; use their username.
    account = make_account(test_db, ADMIN_USERNAME if role == 'admin' else 'portal.person', role, 'A' if role == 'project_site' else None)
    credentials = {'username': account.username, 'password': TEST_PASSWORD}
    assert personal.post('/auth/login', json=credentials).status_code == 422
    wrong_role = 'project_site' if role == 'admin' else 'admin'
    rejected = personal.post('/auth/login', json={**credentials, 'user_type': wrong_role})
    assert rejected.status_code == 401 and 'token' not in rejected.json()
    assert test_db.query(AccessLog).order_by(AccessLog.id.desc()).first().success is False
    response = personal.post('/auth/login', json={**credentials, 'user_type': role})
    assert response.status_code == 200
    identity = response.json()['user']
    assert 'full_name' not in identity
    assert 'full_name' not in decode_token(response.json()['token'])
    assert identity['user_type'] == role
    assert identity['is_global_admin'] is (role == 'admin')
    assert identity['project_site'] == account.project_site
    auth = {'Authorization': 'Bearer ' + response.json()['token']}
    assert personal.get('/auth/me', headers=auth).json() == identity
    if role == 'admin':
        assert 'full_name' not in personal.get('/users', headers=auth).json()[0]
        assert test_db.query(AccessLog).order_by(AccessLog.id.desc()).first().user_name == account.username
    else:
        assert personal.get('/users', headers=auth).status_code == 403
        assert test_db.query(AccessLog).order_by(AccessLog.id.desc()).first().user_name == account.username


def test_fixed_admin_is_unique_and_site_users_cannot_take_its_username_or_role(personal, test_db):
    owner = setup(personal)
    auth = {'Authorization': 'Bearer ' + owner.json()['token']}
    account = test_db.query(User).one()
    assert account.username == ADMIN_USERNAME and account.login_name == ADMIN_LOGIN_NAME
    assert account.full_name is None
    assert personal.post('/users', headers=auth, json={
        'username': 'new.admin', 'user_type': 'admin', 'password': TEST_PASSWORD,
    }).status_code == 409
    update = {'user_type': 'admin', 'is_active': True}
    result = personal.patch(f'/users/{account.id}', headers=auth, json={**update, 'full_name': 'Unwanted Name'})
    assert result.status_code == 200 and 'full_name' not in result.json()
    assert personal.patch(f'/users/{account.id}', headers=auth, json={
        'user_type': 'project_site', 'project_site': 'A', 'is_active': True, 'full_name': 'Site Manager',
    }).status_code == 409
    site = make_account(test_db, 'site.person', site='A')
    assert personal.patch(f'/users/{site.id}', headers=auth, json=update).status_code == 409
    assert test_db.get(User, site.id).user_type == 'project_site'
    for name in (ADMIN_USERNAME, '  ISTROM_ADMIN  '):
        assert personal.post('/users', headers=auth, json={
            'username': name, 'user_type': 'project_site', 'project_site': 'A',
            'full_name': 'Site Person', 'password': TEST_PASSWORD,
        }).status_code == 422
    assert test_db.query(User).filter_by(user_type='admin').count() == 1


def test_eight_character_passwords_work_for_setup_creation_reset_and_change(personal, test_db):
    setup_data = {'access_code': 'existing-admin-code', 'password': 'River7!'}
    assert personal.post('/auth/setup', json=setup_data).status_code == 422
    assert test_db.query(User).count() == 0
    setup_data['password'] = 'River7!a'
    owner = personal.post('/auth/setup', json=setup_data)
    assert owner.status_code == 200, owner.json()
    auth = {'Authorization': 'Bearer ' + owner.json()['token']}
    user_data = {'username': 'site.person', 'user_type': 'project_site',
                 'project_site': 'A', 'password': 'Stone8!'}
    assert personal.post('/users', headers=auth, json=user_data).status_code == 422
    assert test_db.query(User).count() == 1
    user_data['password'] = 'Stone8!b'
    created = personal.post('/users', headers=auth, json=user_data)
    assert created.status_code == 200, created.json()
    account_id = created.json()['id']
    old_hash = test_db.get(User, account_id).password_hash
    assert personal.post(f'/users/{account_id}/reset-password', headers=auth, json={'password': 'Cedar9!'}).status_code == 422
    assert test_db.get(User, account_id).password_hash == old_hash
    assert personal.post(f'/users/{account_id}/reset-password', headers=auth, json={'password': 'Cedar9!c'}).status_code == 200
    credentials = {'username': 'site.person', 'user_type': 'project_site', 'password': 'Stone8!b'}
    assert personal.post('/auth/login', json=credentials).status_code == 401
    credentials['password'] = 'Cedar9!c'
    login = personal.post('/auth/login', json=credentials)
    assert login.status_code == 200 and login.json()['user']['must_change_password'] is True
    site_auth = {'Authorization': 'Bearer ' + login.json()['token']}
    password_data = {'current_password': 'Cedar9!c', 'new_password': 'Maple4!'}
    assert personal.post('/auth/password', headers=site_auth, json=password_data).status_code == 422
    password_data['new_password'] = 'Maple4!d'
    changed = personal.post('/auth/password', headers=site_auth, json=password_data)
    assert changed.status_code == 200 and changed.json()['user']['must_change_password'] is False
    assert personal.get('/items', headers=site_auth).status_code == 401
    credentials['password'] = 'Maple4!d'
    assert personal.post('/auth/login', json=credentials).status_code == 200


def test_admin_login_uses_only_fixed_identity_and_password(personal, test_db):
    response = setup(personal, username='caller.cannot.choose')
    assert response.status_code == 200
    admin = test_db.query(User).one()
    assert (admin.username, admin.login_name) == (ADMIN_USERNAME, ADMIN_LOGIN_NAME)
    make_account(test_db, 'site.person', site='A').password_hash = hash_password('SiteOnly8!')
    test_db.commit()
    for username in (None, 'site.person', 'caller.cannot.choose'):
        body = {'user_type': 'admin', 'password': TEST_PASSWORD}
        if username is not None:
            body['username'] = username
        result = personal.post('/auth/login', json=body)
        assert result.status_code == 200 and result.json()['user']['username'] == ADMIN_USERNAME
        auth = {'Authorization': 'Bearer ' + result.json()['token']}
        assert personal.get('/users', headers=auth).status_code == 200
    denied = personal.post('/auth/login', json={'user_type': 'admin', 'username': 'site.person', 'password': 'SiteOnly8!'})
    assert denied.status_code == 401 and denied.json()['detail'] == 'Invalid password.'
    assert personal.post('/auth/login', json={'user_type': 'project_site', 'password': TEST_PASSWORD}).status_code == 422


def test_admin_failed_attempts_share_one_rate_limit_even_with_different_posted_usernames(personal, test_db):
    setup(personal)
    for index in range(login_limiter.max_attempts):
        assert personal.post('/auth/login', json={
            'user_type': 'admin', 'username': f'fake.{index}', 'password': 'wrong',
        }).status_code == 401
    login_limiter.record_success('ip:testclient')
    assert personal.post('/auth/login', json={
        'user_type': 'admin', 'username': 'another.fake', 'password': TEST_PASSWORD,
    }).status_code == 429
