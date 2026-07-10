"""Tests for Web Push subscriptions and targeting rules."""
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from models import PushSubscription  # noqa: E402
from api.services.push_service import subscription_can_receive  # noqa: E402
import api.routes.push as push_routes  # noqa: E402
import api.services.push_service as push_service  # noqa: E402


def _enable(monkeypatch, key="test-key"):
    monkeypatch.setattr(push_service, "VAPID_PRIVATE_KEY", key)
    monkeypatch.setattr(push_service, "VAPID_PUBLIC_KEY", key)
    monkeypatch.setattr(push_routes, "VAPID_PUBLIC_KEY", key)


SUB = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
       "keys": {"p256dh": "pk", "auth": "ak"}}


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
    client.post("/push/subscribe", json={**SUB, "keys": {"p256dh": "new", "auth": "new"}})
    rows = test_db.query(PushSubscription).all()
    assert len(rows) == 1
    assert rows[0].p256dh == "new"


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
