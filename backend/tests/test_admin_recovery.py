"""Admin recovery uses real authorization and a substitute SMTP transport."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier
import hashlib
import re
import secrets
import smtplib

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from api.main import app
from api.dependencies import get_authenticated_user, get_current_admin, get_current_user
from api.routes.admin_recovery import request_limiter, reset_limiter
from api.services import recovery_mail
from api.services.rate_limit import login_limiter
from api.services.user_accounts import login_response, verify_password
from api.account_policy import ADMIN_USERNAME
from db import Base, get_db
from models import AccessCode, AdminPasswordReset, ProjectSite, PushSubscription, AccessLog
from tests.conftest import make_account, TEST_PASSWORD

NEW_PASSWORD = 'Replacement admin passphrase 2026'
REAL_SEND_MAIL = recovery_mail.send_mail


@pytest.fixture()
def recovery(client, test_db, monkeypatch):
    for dependency in (get_current_user, get_current_admin, get_authenticated_user):
        app.dependency_overrides.pop(dependency, None)
    test_db.add(AccessCode(admin_code='retired-setup-code', user_code=''))
    test_db.add(ProjectSite(name='A', is_active=True))
    test_db.commit()
    for key, value in {
        'ADMIN_RECOVERY_EMAIL': 'owner@example.com', 'APP_FRONTEND_URL': 'https://app.example.com',
        'SMTP_HOST': 'smtp.example.com', 'SMTP_USERNAME': 'mailer', 'SMTP_PASSWORD': 'private-mail-secret',
        'SMTP_PORT': '587', 'SMTP_SECURITY': 'starttls', 'SMTP_FROM': 'mail@example.com',
        'ADMIN_RECOVERY_PROVIDER': 'smtp',
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(recovery_mail, 'ALLOWED_ORIGINS', ['https://app.example.com', 'http://localhost:5173'])
    messages = []
    monkeypatch.setattr(recovery_mail, 'send_mail',
        lambda config, subject, body, **options: messages.append((config, subject, body, options)))
    for limiter in (request_limiter, reset_limiter, login_limiter):
        limiter.reset()
    yield client, messages
    for limiter in (request_limiter, reset_limiter, login_limiter):
        limiter.reset()


def issue(recovery):
    client, messages = recovery
    result = client.post('/auth/admin-recovery/request', json={})
    assert result.status_code == 200, result.json()
    return re.search(r'#token=([A-Za-z0-9_-]{43})', messages[-1][2])[1]


def reset(client, token, password=NEW_PASSWORD, **changes):
    return client.post('/auth/admin-recovery/reset', json={
        'token': token, 'new_password': password, 'confirm_password': password, **changes,
    })


def test_recovery_revokes_http_websocket_push_and_all_links_without_affecting_site_users(recovery, test_db):
    client, messages = recovery
    admin = make_account(test_db, ADMIN_USERNAME, 'admin')
    site_user = make_account(test_db, 'site.person', site='A')
    old_token, site_token = login_response(admin)['token'], login_response(site_user)['token']
    for account in (admin, site_user):
        test_db.add(PushSubscription(endpoint=f'https://test/{account.id}', p256dh='key', auth='key', user_id=account.id))
    test_db.commit()
    token = issue(recovery)
    record = test_db.query(AdminPasswordReset).one()
    assert record.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in record.token_hash and TEST_PASSWORD not in str(record.__dict__)
    assert timedelta(minutes=14, seconds=59) < record.expires_at - record.created_at <= timedelta(minutes=15)
    assert messages[0][0].recipient == 'owner@example.com'
    assert 'https://app.example.com/reset-password#token=' in messages[0][2]
    assert f'https://app.example.com/reset-password#token={token}' in messages[0][3]['html']
    assert '?token=' not in messages[0][2]
    assert 'private-mail-secret' not in repr(messages[0][0])
    # A second email does not invalidate the first link.
    record.created_at -= timedelta(seconds=61); test_db.commit()
    second_token = issue(recovery)
    with client.websocket_connect('/ws/notifications') as socket:
        socket.send_json({'type': 'authenticate', 'token': old_token})
        assert socket.receive_json()['type'] == 'connected'
        result = reset(client, token)
        assert result.status_code == 200 and result.json() == {'ok': True}
        with pytest.raises(WebSocketDisconnect) as closed:
            socket.receive_json()
        assert closed.value.code == 1008
    assert client.get('/auth/me', headers={'Authorization': 'Bearer ' + old_token}).status_code == 401
    assert client.get('/items', headers={'Authorization': 'Bearer ' + site_token}).status_code == 200
    assert test_db.query(PushSubscription).filter_by(user_id=admin.id).count() == 0
    assert test_db.query(PushSubscription).filter_by(user_id=site_user.id).count() == 1
    assert reset(client, token).status_code == reset(client, second_token).status_code == 400
    assert client.post('/auth/login', json={'user_type': 'admin', 'password': TEST_PASSWORD}).status_code == 401
    assert client.post('/auth/login', json={'user_type': 'admin', 'password': NEW_PASSWORD}).status_code == 200
    assert test_db.query(AccessLog).filter_by(role='admin_password_reset').one().access_code is None
    assert NEW_PASSWORD not in messages[-1][2] and token not in messages[-1][2]
    assert NEW_PASSWORD not in messages[-1][3]['html'] and token not in messages[-1][3]['html']
    assert 'password was changed' in messages[-1][1]
    assert client.get('/auth/setup-status').json()['setup_required'] is False


@pytest.mark.parametrize('reason', ['expired', 'wrong_token', 'used', 'email_changed', 'password_changed', 'disabled', 'site_account'])
def test_invalid_links_cannot_change_passwords(recovery, test_db, monkeypatch, reason):
    client, _ = recovery
    admin = make_account(test_db, ADMIN_USERNAME, 'admin')
    token = issue(recovery)
    record = test_db.query(AdminPasswordReset).one()
    if reason == 'expired': record.expires_at = datetime.utcnow() - timedelta(seconds=1)
    if reason == 'used': record.used_at = datetime.utcnow()
    if reason == 'email_changed': monkeypatch.setenv('ADMIN_RECOVERY_EMAIL', 'replacement@example.com')
    if reason == 'password_changed':
        result = client.post('/auth/password', headers={'Authorization': 'Bearer ' + login_response(admin)['token']},
            json={'current_password': TEST_PASSWORD, 'new_password': 'A different admin password'})
        assert result.status_code == 200
    if reason == 'disabled': admin.is_active = False
    if reason == 'site_account': record.user_id = make_account(test_db, 'site.person', site='A').id
    if reason == 'wrong_token': token = secrets.token_urlsafe(32)
    test_db.commit()
    original = admin.password_hash
    result = reset(client, token)
    assert result.status_code == 400 and 'invalid or has expired' in result.json()['detail']
    test_db.refresh(admin)
    assert admin.password_hash == original


def test_password_validation_preserves_link_until_valid_reset(recovery, test_db):
    client, _ = recovery
    admin = make_account(test_db, ADMIN_USERNAME, 'admin')
    token = issue(recovery)
    for password in ('short', '12345678', TEST_PASSWORD):
        assert reset(client, token, password).status_code == 422
    assert reset(client, token, confirm_password='A mismatched password').status_code == 422
    test_db.refresh(admin)
    assert verify_password(TEST_PASSWORD, admin.password_hash)
    assert reset(client, token, 'Eight123').status_code == 200


def test_recipient_cannot_be_supplied_by_visitor_and_host_cannot_change_link(recovery, test_db):
    client, messages = recovery
    make_account(test_db, ADMIN_USERNAME, 'admin')
    for payload in ({'email': 'attacker@example.com'}, {'username': 'site.person'}, {'access_code': 'retired-setup-code'}):
        assert client.post('/auth/admin-recovery/request', json=payload).status_code == 422
    result = client.post('/auth/admin-recovery/request', json={}, headers={'Host': 'attacker.example', 'Origin': 'https://attacker.example'})
    assert result.status_code == 200
    assert 'owner@example.com' not in result.text and 'token' not in result.text
    assert messages[0][0].recipient == 'owner@example.com'
    assert 'attacker.example' not in messages[0][2]


def test_missing_account_has_generic_response_and_never_creates_account(recovery, test_db):
    client, messages = recovery
    site = make_account(test_db, 'site.person', site='A')
    result = client.post('/auth/admin-recovery/request', json={})
    assert result.status_code == 200 and messages == []
    assert test_db.query(AdminPasswordReset).count() == 0
    assert verify_password(TEST_PASSWORD, site.password_hash)
    assert client.get('/auth/setup-status').json()['setup_required'] is True


def test_request_cooldown_and_reset_throttle_do_not_lock_normal_signin(recovery, test_db):
    client, messages = recovery
    make_account(test_db, ADMIN_USERNAME, 'admin')
    token = issue(recovery)
    assert client.post('/auth/admin-recovery/request', json={}).status_code == 429
    assert len(messages) == 1
    for _ in range(8):
        assert reset(client, secrets.token_urlsafe(32)).status_code == 400
    assert reset(client, token).status_code == 429
    assert client.post('/auth/login', json={'user_type': 'admin', 'password': TEST_PASSWORD}).status_code == 200


def test_request_limits_survive_process_limiter_reset(recovery, test_db):
    client, messages = recovery
    make_account(test_db, ADMIN_USERNAME, 'admin')
    for _ in range(5):
        request_limiter.reset()
        issue(recovery)
        latest = test_db.query(AdminPasswordReset).order_by(AdminPasswordReset.id.desc()).first()
        latest.created_at -= timedelta(seconds=61); test_db.commit()
    request_limiter.reset()
    assert client.post('/auth/admin-recovery/request', json={}).status_code == 429
    assert len(messages) == 5


def test_delivery_failure_invalidates_link_and_does_not_expose_mail_secrets(recovery, test_db, monkeypatch, caplog):
    client, _ = recovery
    admin = make_account(test_db, ADMIN_USERNAME, 'admin')
    def fail(*args):
        raise smtplib.SMTPAuthenticationError(535, b'private-mail-secret owner@example.com')
    monkeypatch.setattr(recovery_mail, 'send_reset_link', fail)
    response = client.post('/auth/admin-recovery/request', json={})
    assert response.status_code == 503
    assert test_db.query(AdminPasswordReset).one().used_at is not None
    assert 'private-mail-secret' not in response.text + caplog.text
    assert 'owner@example.com' not in response.text + caplog.text
    assert verify_password(TEST_PASSWORD, admin.password_hash)


@pytest.mark.parametrize('key,value', [
    ('SMTP_PASSWORD', ''), ('SMTP_SECURITY', 'none'), ('SMTP_PORT', 'bad'), ('SMTP_PORT', '0'),
    ('SMTP_HOST', 'smtp.example.com\r\nInjected'), ('ADMIN_RECOVERY_EMAIL', 'owner@example.com\nBcc:attacker@example.com'),
    ('SMTP_FROM', 'invalid'), ('APP_FRONTEND_URL', 'http://app.example.com'),
    ('APP_FRONTEND_URL', 'https://attacker.example'), ('APP_FRONTEND_URL', 'https://app.example.com/?next=attacker'),
    ('APP_FRONTEND_URL', 'https://user:password@app.example.com'), ('APP_FRONTEND_URL', 'https://app.example.com/other'),
])
def test_incomplete_or_insecure_configuration_disables_recovery(recovery, test_db, monkeypatch, key, value):
    client, messages = recovery
    make_account(test_db, ADMIN_USERNAME, 'admin')
    monkeypatch.setenv(key, value)
    assert client.post('/auth/admin-recovery/request', json={}).status_code == 503
    assert reset(client, secrets.token_urlsafe(32)).status_code == 503
    assert test_db.query(AdminPasswordReset).count() == 0 and messages == []


@pytest.mark.parametrize('security,port', [('starttls', '587'), ('ssl', '465')])
def test_smtp_verifies_tls_before_authentication(recovery, monkeypatch, security, port):
    monkeypatch.setenv('SMTP_SECURITY', security)
    monkeypatch.setenv('SMTP_PORT', port)
    config = recovery_mail.get_recovery_config()
    calls = []
    class Transport:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def ehlo(self): calls.append('ehlo')
        def starttls(self, context):
            assert context.check_hostname and context.verify_mode != 0
            assert context.cert_store_stats()['x509_ca'] > 0
            calls.append('tls')
        def login(self, username, password): calls.append('login')
        def send_message(self, message):
            assert message['To'] == 'owner@example.com' and message['From'] == 'Istrom <mail@example.com>'
            calls.append('send')
    def create(host, selected_port, **kwargs):
        assert host == config.host and selected_port == int(port) and kwargs['timeout'] == 10
        if security == 'ssl':
            assert kwargs['context'].check_hostname and kwargs['context'].verify_mode != 0
            assert kwargs['context'].cert_store_stats()['x509_ca'] > 0
            calls.append('tls')
        return Transport()
    monkeypatch.setattr(recovery_mail.smtplib, 'SMTP', create)
    monkeypatch.setattr(recovery_mail.smtplib, 'SMTP_SSL', create)
    REAL_SEND_MAIL(config, 'Reset test', 'Mail body')
    assert calls.index('tls') < calls.index('login') < calls.index('send')


def test_notification_delivery_failure_does_not_undo_completed_reset(recovery, test_db, monkeypatch, caplog):
    client, _ = recovery
    admin = make_account(test_db, ADMIN_USERNAME, 'admin')
    token = issue(recovery)
    def fail(*args, **kwargs): raise OSError('private-mail-secret')
    monkeypatch.setattr(recovery_mail, 'send_mail', fail)
    assert reset(client, token).status_code == 200
    test_db.refresh(admin)
    assert verify_password(NEW_PASSWORD, admin.password_hash)
    assert 'private-mail-secret' not in caplog.text


@pytest.mark.parametrize('status,payload,expected', [
    (200, b'{"id":"accepted-message"}', True),
    (403, b'{"message":"private-api-key"}', False),
    (302, b'{"id":"redirect"}', False),
    (200, b'{"message":"missing id"}', False),
    (200, b'not-json', False),
])
def test_resend_transport_uses_fixed_https_destination_and_checks_acceptance(recovery, monkeypatch, status, payload, expected):
    import json
    monkeypatch.setenv('ADMIN_RECOVERY_PROVIDER', 'resend')
    monkeypatch.setenv('RESEND_API_KEY', 're_private_api_key_for_test')
    monkeypatch.setenv('RESEND_FROM', 'onboarding@resend.dev')
    config = recovery_mail.get_recovery_config()
    assert config is not None and 're_private_api_key' not in repr(config)
    calls = []
    class Transport:
        def __init__(self, host, timeout, context):
            assert host == 'api.resend.com' and timeout == 10
            assert context.check_hostname and context.verify_mode != 0
            assert context.cert_store_stats()['x509_ca'] > 0
        def request(self, method, path, body, headers):
            assert method == 'POST' and path == '/emails'
            assert headers['Authorization'] == 'Bearer re_private_api_key_for_test'
            assert json.loads(body) == {'from': 'Istrom <onboarding@resend.dev>', 'to': ['owner@example.com'], 'subject': 'Reset', 'text': 'Body'}
            calls.append('send')
        def getresponse(self): return self
        def read(self, limit):
            assert limit == 65536
            return payload
        def close(self): calls.append('close')
    Transport.status = status
    monkeypatch.setattr(recovery_mail.http.client, 'HTTPSConnection', Transport)
    if expected:
        REAL_SEND_MAIL(config, 'Reset', 'Body')
    else:
        with pytest.raises(OSError) as error: REAL_SEND_MAIL(config, 'Reset', 'Body')
        assert 'private-api-key' not in str(error.value)
    assert calls == ['send', 'close']


def test_resend_configuration_and_recovery_do_not_require_smtp_settings(recovery, test_db, monkeypatch):
    client, messages = recovery
    monkeypatch.setenv('ADMIN_RECOVERY_PROVIDER', 'resend')
    monkeypatch.setenv('RESEND_API_KEY', 're_private_api_key_for_test')
    monkeypatch.setenv('RESEND_FROM', 'onboarding@resend.dev')
    monkeypatch.delenv('SMTP_PASSWORD')
    make_account(test_db, ADMIN_USERNAME, 'admin')
    token = issue(recovery)
    assert messages[0][0].provider == 'resend'
    assert reset(client, token).status_code == 200
    monkeypatch.setenv('RESEND_API_KEY', '')
    assert client.post('/auth/admin-recovery/request', json={}).status_code == 503


@pytest.mark.parametrize('url', [
    'http://app.example.com', 'https://attacker.example', 'https://app.example.com/other',
    'https://user:password@app.example.com', 'https://app.example.com?redirect=evil',
])
def test_resend_also_requires_the_trusted_https_frontend(recovery, monkeypatch, url):
    monkeypatch.setenv('ADMIN_RECOVERY_PROVIDER', 'resend')
    monkeypatch.setenv('RESEND_API_KEY', 're_private_api_key_for_test')
    monkeypatch.setenv('RESEND_FROM', 'onboarding@resend.dev')
    monkeypatch.setenv('APP_FRONTEND_URL', url)
    assert recovery_mail.get_recovery_config() is None


@pytest.mark.parametrize('different_links', [False, True])
def test_concurrent_resets_change_password_once(recovery, tmp_path, different_links):
    from fastapi import BackgroundTasks, HTTPException, Request
    from api.routes.admin_recovery import reset_password
    from api.schemas import AdminRecoveryReset
    engine = create_engine(f"sqlite:///{tmp_path / 'recovery-race.db'}", connect_args={'check_same_thread': False, 'timeout': 10})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    config = recovery_mail.get_recovery_config()
    tokens = [secrets.token_urlsafe(32), secrets.token_urlsafe(32)]
    with factory() as db:
        db.add(AccessCode(admin_code='retired', user_code=''))
        admin = make_account(db, ADMIN_USERNAME, 'admin')
        for token in tokens:
            db.add(AdminPasswordReset(user_id=admin.id, token_hash=hashlib.sha256(token.encode()).hexdigest(),
                recipient_hash=config.recipient_hash, session_version=1,
                expires_at=datetime.utcnow() + timedelta(minutes=15)))
        db.commit()
    barrier = Barrier(2, timeout=5)
    def consume(index):
        with factory() as db:
            barrier.wait()
            try:
                reset_password(AdminRecoveryReset(token=tokens[index if different_links else 0],
                    new_password=NEW_PASSWORD, confirm_password=NEW_PASSWORD),
                    Request({'type': 'http', 'client': ('recovery-test', 123), 'headers': []}), BackgroundTasks(), db)
                return 200
            except HTTPException as error:
                db.rollback()
                return error.status_code
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            assert sorted(executor.map(consume, [0, 1])) == [200, 400]
        with factory() as db:
            from models import User
            assert db.query(User).one().session_version == 2
            assert db.query(AdminPasswordReset).filter_by(used_at=None).count() == 0
            assert db.query(AccessLog).filter_by(role='admin_password_reset').count() == 1
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_recovery_table_migrates_without_changing_existing_admin(tmp_path, monkeypatch):
    import schema_init
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-recovery.db'}")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as db:
        admin = make_account(db, ADMIN_USERNAME, 'admin')
        original = (admin.password_hash, admin.session_version)
    with engine.begin() as conn:
        conn.execute(text('DROP TABLE admin_password_resets'))
    monkeypatch.setattr(schema_init, 'engine', engine)
    for _ in range(2): schema_init.run_migrations()
    assert 'admin_password_resets' in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert tuple(conn.execute(text('SELECT password_hash, session_version FROM users')).one()) == original
    engine.dispose()
