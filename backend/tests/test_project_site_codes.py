"""Sites are project records; shared login-code management is retired."""
from models import ProjectSiteAccessCode, ProjectSite
from api.services.auth_service import hash_access_code


def test_create_site_without_a_login_code(client, test_db):
    response = client.post('/project-sites', json={'name': 'Site X', 'description': 'New build'})
    assert response.status_code == 200
    assert response.json()['name'] == 'Site X'
    assert 'user_code' not in response.json()
    assert test_db.query(ProjectSiteAccessCode).count() == 0


def test_legacy_site_records_are_preserved_without_revealing_credentials(client, test_db):
    site = ProjectSite(name='Legacy Site', is_active=True)
    test_db.add(site)
    test_db.add(ProjectSiteAccessCode(project_site='Legacy Site', admin_code='', user_code=hash_access_code('old-code'), user_code_plain=None))
    test_db.commit()
    assert client.get('/project-sites').json()[0]['name'] == 'Legacy Site'
    assert 'user_code' not in client.get('/project-sites').json()[0]
    assert client.get(f'/project-sites/{site.id}/access-code').status_code == 404
    assert client.patch(f'/project-sites/{site.id}/access-code', json={'user_code': 'replacement'}).status_code == 404


def test_legacy_code_only_login_is_rejected(client):
    assert client.post('/auth/login', json={'access_code': 'old-code'}).status_code == 422
