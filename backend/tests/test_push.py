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

from models import PushSubscription  # noqa: E402
from api.services.push_service import subscription_can_receive  # noqa: E402
import api.routes.push as push_routes  # noqa: E402
import api.services.push_service as push_service  # noqa: E402
from api.dependencies import get_current_user
from api.main import app
from api.services.push_security import PushSession


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
