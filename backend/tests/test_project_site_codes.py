"""Tests for the admin access-code reveal on project sites."""
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from models import ProjectSite, ProjectSiteAccessCode  # noqa: E402
from api.services.auth_service import hash_access_code  # noqa: E402


def test_reveal_code_after_create(client):
    resp = client.post("/project-sites", json={"name": "Site X", "user_code": "sitex123"})
    assert resp.status_code == 200
    site_id = resp.json()["id"]

    reveal = client.get(f"/project-sites/{site_id}/access-code")
    assert reveal.status_code == 200
    body = reveal.json()
    assert body["configured"] is True
    assert body["user_code"] == "sitex123"


def test_reveal_code_after_update(client):
    site_id = client.post(
        "/project-sites", json={"name": "Site Y", "user_code": "old-code"}
    ).json()["id"]
    resp = client.patch(f"/project-sites/{site_id}/access-code", json={"user_code": "new-code-9"})
    assert resp.status_code == 200

    body = client.get(f"/project-sites/{site_id}/access-code").json()
    assert body["user_code"] == "new-code-9"


def test_legacy_hashed_code_reveals_null(client, test_db):
    # A site whose code predates retrievable storage: hash only, no plain copy.
    test_db.add(ProjectSite(name="Legacy Site", is_active=True))
    test_db.add(ProjectSiteAccessCode(
        project_site="Legacy Site", admin_code="",
        user_code=hash_access_code("forgotten"), user_code_plain=None,
    ))
    test_db.commit()
    site_id = test_db.query(ProjectSite).filter_by(name="Legacy Site").first().id

    body = client.get(f"/project-sites/{site_id}/access-code").json()
    assert body["configured"] is True
    assert body["user_code"] is None  # cannot be recovered; must be reset


def test_reveal_unknown_site_404(client):
    assert client.get("/project-sites/9999/access-code").status_code == 404
