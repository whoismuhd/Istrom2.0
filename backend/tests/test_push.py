"""Tests for Web Push subscriptions and targeting rules."""
import os
import sys
import base64
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from models import AccessCode, ProjectSite, PushSubscription  # noqa: E402
from api.services.push_service import subscription_can_receive  # noqa: E402
import api.routes.push as push_routes  # noqa: E402
import api.services.push_service as push_service  # noqa: E402
from api.dependencies import get_current_user, validate_session
from api.main import app
from api.services.push_security import PushSession
from api.services.user_accounts import login_response
from fastapi import HTTPException
from tests.conftest import make_account


def _enable(monkeypatch, key="test-key"):
    monkeypatch.setattr(push_service, "VAPID_PRIVATE_KEY", key)
    monkeypatch.setattr(push_service, "VAPID_PUBLIC_KEY", key)
    monkeypatch.setattr(push_routes, "VAPID_PUBLIC_KEY", key)


def keys_for(number):
    public = ec.derive_private_key(number, ec.SECP256R1()).public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return {"p256dh": base64.urlsafe_b64encode(public).decode().rstrip("="),
            "auth": base64.urlsafe_b64encode(bytes([number]) * 16).decode().rstrip("=")}


SUB = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123", "keys": keys_for(1)}


def test_subscribe_stores_role_snapshot(client, test_db, monkeypatch):
    _enable(monkeypatch)
    r = client.post("/push/subscribe", json=SUB)
    assert r.status_code == 200
    row = test_db.query(PushSubscription).one()
    assert row.endpoint == SUB["endpoint"]
    assert row.user_type == "admin"          # conftest admin_user fixture
    assert row.is_global_admin is True


def test_subscribe_upserts_on_same_endpoint(client, test_db, monkeypatch):
    _enable(monkeypatch)
    client.post("/push/subscribe", json=SUB)
    client.post("/push/subscribe", json={**SUB, "keys": keys_for(2)})
    rows = test_db.query(PushSubscription).all()
    assert len(rows) == 1
    assert rows[0].p256dh == keys_for(2)["p256dh"]


@pytest.mark.parametrize("endpoint", [
    "https://127.0.0.1/internal", "https://169.254.169.254/latest/meta-data/",
    "https://fcm.googleapis.com.attacker.test/send", "https://fcm.googleapis.com:8000/send",
    "https://attacker@fcm.googleapis.com/send", "http://fcm.googleapis.com/send",
    "https://fcm.googleapis.com/send#fragment", "https://example.test/send",
])
def test_untrusted_push_destinations_rejected(client, test_db, monkeypatch, endpoint):
    _enable(monkeypatch)
    assert client.post('/push/subscribe', json={**SUB, 'endpoint': endpoint}).status_code == 422
    assert test_db.query(PushSubscription).count() == 0


def test_subscription_cannot_be_hijacked_or_deleted_by_another_site(client, test_db, monkeypatch):
    _enable(monkeypatch)
    assert client.post('/push/subscribe', json=SUB).status_code == 200
    app.dependency_overrides[get_current_user] = lambda: dict(user_type='project_site', project_site='Other', is_global_admin=False)
    assert client.post('/push/subscribe', json={**SUB, 'keys': keys_for(2)}).status_code == 403
    assert client.post('/push/unsubscribe', json={'endpoint': SUB['endpoint']}).status_code == 403
    assert test_db.query(PushSubscription).one().is_global_admin is True
    # The actual browser may change accounts, using its secret subscription keys.
    assert client.post('/push/subscribe', json=SUB).status_code == 200
    assert test_db.query(PushSubscription).one().project_site == 'Other'
    assert client.post('/push/unsubscribe', json=SUB).status_code == 200


def test_push_keys_must_be_real_curve_and_auth_keys(client, monkeypatch):
    _enable(monkeypatch)
    assert client.post('/push/subscribe', json={**SUB, 'keys': {'p256dh': 'pk', 'auth': 'ak'}}).status_code == 422


def test_push_delivery_never_follows_redirects(monkeypatch):
    captured = {}
    def fake_request(self, method, url, **kwargs):
        captured.update(kwargs)
    monkeypatch.setattr('requests.Session.request', fake_request)
    with PushSession() as session:
        session.post(SUB['endpoint'], allow_redirects=True)
        assert captured['allow_redirects'] is False
        with pytest.raises(ValueError):
            session.post('https://127.0.0.1/internal')


def test_legacy_unsafe_subscriptions_are_pruned_without_delivery(test_db, monkeypatch):
    _enable(monkeypatch)
    test_db.add(PushSubscription(endpoint='https://127.0.0.1/internal', p256dh='pk', auth='ak', user_type='admin', is_global_admin=True))
    test_db.commit()
    monkeypatch.setattr('db.SessionLocal', lambda: test_db)
    delivered = []
    monkeypatch.setattr(push_service, 'webpush', lambda **kwargs: delivered.append(kwargs))
    push_service.send_push_for_notification(1, 'new_request', 'Site A', 'Test', '')
    assert delivered == []
    assert test_db.query(PushSubscription).count() == 0


def test_unsubscribe_removes(client, test_db, monkeypatch):
    _enable(monkeypatch)
    client.post("/push/subscribe", json=SUB)
    r = client.post("/push/unsubscribe", json={"endpoint": SUB["endpoint"]})
    assert r.status_code == 200
    assert test_db.query(PushSubscription).count() == 0


def test_signout_preserves_another_tabs_device_notifications(client, test_db, monkeypatch):
    _enable(monkeypatch)
    assert client.post('/push/subscribe', json=SUB).status_code == 200
    app.dependency_overrides[get_current_user] = lambda: dict(
        user_id=99, user_type='project_site', project_site='Other', is_global_admin=False)
    response = client.post('/push/unsubscribe', json={**SUB, 'current_account_only': True})
    assert response.status_code == 200
    assert response.json()['removed'] is False
    assert test_db.query(PushSubscription).count() == 1
    assert client.post('/push/subscription-status', json=SUB).json() == {'enabled':False}
    app.dependency_overrides[get_current_user] = lambda: dict(user_type='admin', is_global_admin=True)
    assert client.post('/push/subscription-status', json=SUB).json() == {'enabled':True}
    response = client.post('/push/unsubscribe', json={**SUB, 'current_account_only': True})
    assert response.json()['removed'] is True
    assert test_db.query(PushSubscription).count() == 0


@pytest.mark.parametrize('change', ['disabled', 'reassigned', 'session_changed', 'password_required', 'site_inactive'])
def test_inflight_subscription_cannot_restore_a_revoked_account(test_db, monkeypatch, change):
    _enable(monkeypatch)
    test_db.add_all([AccessCode(admin_code='configured', user_code='unused'),
                     ProjectSite(name='A'), ProjectSite(name='B')])
    test_db.commit()
    account = make_account(test_db, 'push-reviewer', site='A')
    # Authentication completes before the administrator's account change.
    identity = validate_session(login_response(account)['token'], test_db)
    if change == 'disabled':
        account.is_active = False
    elif change == 'reassigned':
        account.project_site = 'B'
    elif change == 'session_changed':
        account.session_version += 1
    elif change == 'password_required':
        account.must_change_password = True
    else:
        test_db.query(ProjectSite).filter_by(name='A').update({'is_active': False})
    test_db.commit()
    # An in-flight request must recheck that identity before saving the device.
    with pytest.raises(HTTPException) as error:
        push_routes.subscribe(push_routes.PushSubscribeIn(**SUB), test_db, identity)
    assert error.value.status_code == 401
    assert test_db.query(PushSubscription).count() == 0


@pytest.mark.parametrize('change', ['disabled', 'reassigned', 'role_changed', 'password_required', 'site_inactive', 'legacy'])
def test_delivery_prunes_subscriptions_without_current_account_access(test_db, monkeypatch, change):
    _enable(monkeypatch)
    test_db.add_all([ProjectSite(name='A'), ProjectSite(name='B')])
    test_db.commit()
    account = make_account(test_db, 'push-reviewer', site='A')
    subscription = PushSubscription(**SUB['keys'], endpoint=SUB['endpoint'], user_id=account.id,
        user_type='project_site', project_site='A', is_global_admin=False)
    test_db.add(subscription)
    if change == 'disabled':
        account.is_active = False
    elif change == 'reassigned':
        account.project_site = 'B'
    elif change == 'role_changed':
        account.user_type, account.project_site = 'admin', None
    elif change == 'password_required':
        account.must_change_password = True
    elif change == 'site_inactive':
        test_db.query(ProjectSite).filter_by(name='A').update({'is_active': False})
    else:
        subscription.user_id = None
    test_db.commit()
    delivered = []
    monkeypatch.setattr('db.SessionLocal', lambda: test_db)
    monkeypatch.setattr(push_service, 'webpush', lambda **kwargs: delivered.append(kwargs))
    push_service.send_push_for_notification(1, 'request_approved', 'A', 'Test', '')
    assert delivered == []
    assert test_db.query(PushSubscription).count() == 0


@pytest.mark.parametrize('role', ['admin', 'project_site'])
def test_current_accounts_can_subscribe_and_receive_their_notifications(test_db, monkeypatch, role):
    _enable(monkeypatch)
    test_db.add_all([AccessCode(admin_code='configured', user_code='unused'), ProjectSite(name='A')])
    test_db.commit()
    account = make_account(test_db, 'push-reviewer', role=role, site='A' if role == 'project_site' else None)
    identity = validate_session(login_response(account)['token'], test_db)
    assert push_routes.subscribe(push_routes.PushSubscribeIn(**SUB), test_db, identity) == {'ok': True}
    delivered = []
    monkeypatch.setattr('db.SessionLocal', lambda: test_db)
    monkeypatch.setattr(push_service, 'webpush', lambda **kwargs: delivered.append(kwargs))
    push_service.send_push_for_notification(1, 'request_approved', 'A', 'Test', '')
    assert len(delivered) == 1
    assert test_db.query(PushSubscription).count() == 1


def test_delivery_rechecks_accounts_while_other_devices_are_sending(test_db, monkeypatch):
    _enable(monkeypatch)
    test_db.add(ProjectSite(name='A'))
    test_db.commit()
    first = make_account(test_db, 'first-reviewer', site='A')
    second = make_account(test_db, 'second-reviewer', site='A')
    for account in (first, second):
        test_db.add(PushSubscription(**SUB['keys'], endpoint=SUB['endpoint'] + f'/{account.id}',
            user_id=account.id, user_type='project_site', project_site='A', is_global_admin=False))
    test_db.commit()
    first_id = first.id
    delivered = []

    def send_and_disable_second(**kwargs):
        delivered.append(kwargs)
        second.is_active = False
        test_db.commit()

    monkeypatch.setattr('db.SessionLocal', lambda: test_db)
    monkeypatch.setattr(push_service, 'webpush', send_and_disable_second)
    push_service.send_push_for_notification(1, 'request_approved', 'A', 'Test', '')
    assert len(delivered) == 1
    assert test_db.query(PushSubscription).one().user_id == first_id


def test_delivery_pruning_preserves_a_device_registered_to_a_current_account(test_db, monkeypatch):
    _enable(monkeypatch)
    test_db.add(ProjectSite(name='A'))
    test_db.commit()
    former = make_account(test_db, 'former-reviewer', site='A')
    current = make_account(test_db, 'current-reviewer', site='A')
    former.is_active = False
    for account in (former, current):
        test_db.add(PushSubscription(**SUB['keys'], endpoint=SUB['endpoint'] + f'/{account.id}',
            user_id=account.id, user_type='project_site', project_site='A', is_global_admin=False))
    test_db.commit()
    stale_id = test_db.query(PushSubscription).filter_by(user_id=former.id).one().id
    current_id = current.id

    def register_device_to_current_account(**kwargs):
        test_db.query(PushSubscription).filter_by(id=stale_id).update({'user_id': current_id})
        test_db.commit()

    monkeypatch.setattr('db.SessionLocal', lambda: test_db)
    monkeypatch.setattr(push_service, 'webpush', register_device_to_current_account)
    push_service.send_push_for_notification(1, 'request_approved', 'A', 'Test', '')
    assert test_db.query(PushSubscription).count() == 2
    assert test_db.query(PushSubscription).filter_by(id=stale_id).one().user_id == current_id


def test_endpoints_503_when_not_configured(client, monkeypatch):
    monkeypatch.setattr(push_service, "VAPID_PRIVATE_KEY", "")
    monkeypatch.setattr(push_service, "VAPID_PUBLIC_KEY", "")
    assert client.get("/push/vapid-public-key").status_code == 503
    assert client.post("/push/subscribe", json=SUB).status_code == 503


def test_targeting_mirrors_in_app_visibility():
    # global admin: everything except request_submitted
    ga = dict(user_type="admin", project_site=None, is_global_admin=True)
    assert subscription_can_receive(**ga, notification_type="new_request", notification_site="A")
    assert not subscription_can_receive(**ga, notification_type="request_submitted", notification_site="A")
    # site user: own site only, never new_request
    su = dict(user_type="project_site", project_site="A", is_global_admin=False)
    assert subscription_can_receive(**su, notification_type="request_approved", notification_site="A")
    assert not subscription_can_receive(**su, notification_type="request_approved", notification_site="B")
    assert not subscription_can_receive(**su, notification_type="new_request", notification_site="A")
    # site admin: own site only, never request_submitted
    sa = dict(user_type="admin", project_site="A", is_global_admin=False)
    assert subscription_can_receive(**sa, notification_type="new_request", notification_site="A")
    assert not subscription_can_receive(**sa, notification_type="new_request", notification_site="B")
    assert not subscription_can_receive(**sa, notification_type="request_submitted", notification_site="A")
