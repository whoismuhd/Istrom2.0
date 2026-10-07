"""Exercise legacy-data migration and startup without the local inventory DB."""
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import db
import schema_init
from db import Base
from models import ProjectSite, ProjectSiteAccessCode
from api.account_policy import ADMIN_USERNAME, ADMIN_LOGIN_NAME
from api.dependencies import validate_session
from api.services.user_accounts import login_response, verify_password
from tests.conftest import make_account, TEST_PASSWORD


def test_startup_is_repeatable_with_the_selected_database(test_db, monkeypatch):
    """Exercise fresh schema creation and migrations on SQLite or PostgreSQL."""
    from models import AccessCode
    engine = test_db.get_bind()
    monkeypatch.setattr(schema_init, 'engine', engine)
    monkeypatch.setattr(db, 'SessionLocal', sessionmaker(bind=engine))
    monkeypatch.setenv('INITIAL_ADMIN_CODE', 'disposable-startup-check')
    for _ in range(2):
        schema_init.init_db()
        schema_init.run_migrations()
        schema_init.seed_default_data()
    assert test_db.query(AccessCode).count() == 1
    assert test_db.query(ProjectSite).count() == 1
    assert test_db.query(ProjectSiteAccessCode).count() == 0


def test_personal_notification_receipts_migrate_without_changing_history(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-notifications.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text('DROP TABLE notification_reads'))
        conn.execute(text("INSERT INTO notifications (notification_type, title, is_read) VALUES ('request_approved', 'Historical approval', 1)"))
    monkeypatch.setattr(schema_init, 'engine', engine)
    schema_init.run_migrations()
    schema_init.run_migrations()
    assert 'notification_reads' in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert tuple(conn.execute(text('SELECT title, is_read FROM notifications')).one()) == ('Historical approval', 1)


def test_import_scope_migration_preserves_items_and_adds_unique_source_keys(tmp_path, monkeypatch):
    from sqlalchemy.exc import IntegrityError
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-import.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text('DROP INDEX ux_items_import_key'))
        for column in ['budget_scope', 'source_sheet', 'source_row', 'import_key']:
            conn.execute(text(f'ALTER TABLE items DROP COLUMN {column}'))
        conn.execute(text("INSERT INTO items (id, name, category, unit, qty, unit_cost, planned_qty, planned_unit_cost) VALUES (1, 'Cement', 'Materials', 'bags', 5, 1000, 8, 900)"))
    monkeypatch.setattr(schema_init, 'engine', engine)
    schema_init.run_migrations()
    schema_init.run_migrations()
    with engine.connect() as conn:
        assert tuple(conn.execute(text('SELECT qty, planned_qty, planned_unit_cost, budget_scope, import_key FROM items')).one()) == (5, 8, 900, None, None)
    with engine.begin() as conn:
        conn.execute(text("UPDATE items SET import_key = 'same-source' WHERE id = 1"))
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text("INSERT INTO items (name, category, unit, qty, unit_cost, planned_qty, planned_unit_cost, import_key) VALUES ('Cement', 'Materials', 'bags', 1, 1000, 1, 1000, 'same-source')"))


def test_legacy_budget_backfill_is_idempotent(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for table, column in [('items', 'planned_qty'), ('items', 'planned_unit_cost'),
                              ('requests', 'approved_shortage_qty'),
                              ('access_codes', 'session_version'), ('project_site_access_codes', 'session_version')]:
            conn.execute(text(f'ALTER TABLE {table} DROP COLUMN {column}'))
        conn.execute(text("INSERT INTO items (id, name, category, unit, qty, unit_cost) VALUES (1, 'Cement', 'Materials', 'bags', 6, 1000), (2, 'Sand', 'Materials', 'bags', 0, 0)"))
        conn.execute(text("INSERT INTO requests (item_id, qty, requested_by, status) VALUES (1, 4, 'Test User', 'Approved'), (1, 2, 'Test User', 'Pending'), (1, 3, 'Test User', 'Rejected')"))
    monkeypatch.setattr(schema_init, 'engine', engine)
    schema_init.run_migrations()
    with engine.connect() as conn:
        row = conn.execute(text('SELECT qty, planned_qty, planned_unit_cost FROM items WHERE id = 1')).one()
        assert tuple(row) == (6, 10, 1000)
        assert tuple(conn.execute(text('SELECT planned_qty, planned_unit_cost FROM items WHERE id = 2')).one()) == (0, 0)
    with engine.begin() as conn:
        conn.execute(text('UPDATE items SET qty = 2, unit_cost = 1200 WHERE id = 1'))
    schema_init.run_migrations()
    with engine.connect() as conn:
        assert tuple(conn.execute(text('SELECT qty, planned_qty, planned_unit_cost FROM items WHERE id = 1')).one()) == (2, 10, 1000)
    assert 'session_version' in {c['name'] for c in inspect(engine).get_columns('access_codes')}
    with engine.connect() as conn:
        assert conn.execute(text('SELECT approved_shortage_qty FROM requests')).scalars().all() == [0, 0, 0]


def test_startup_does_not_restore_revoked_default_site_codes(tmp_path, monkeypatch):
    monkeypatch.setenv('INITIAL_ADMIN_CODE', 'isolated-initial-admin-code')
    engine = create_engine(f"sqlite:///{tmp_path / 'seed.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(db, 'SessionLocal', factory)
    schema_init.seed_default_data()
    with factory() as session:
        assert session.query(ProjectSiteAccessCode).count() == 0
        session.query(ProjectSite).update({'is_active': False})
        session.query(ProjectSiteAccessCode).delete()
        session.commit()
    schema_init.seed_default_data()
    with factory() as session:
        assert session.query(ProjectSiteAccessCode).count() == 0
        assert session.query(ProjectSite).first().is_active is False


def test_legacy_users_and_request_history_survive_account_migration(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-accounts.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text('DROP TABLE users'))
        conn.execute(text('CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(255) NOT NULL, full_name VARCHAR(255), user_type VARCHAR(50) NOT NULL, project_site VARCHAR(255), created_at TIMESTAMP, is_active BOOLEAN)'))
        conn.execute(text("INSERT INTO users (id, username, full_name, user_type, project_site, is_active) VALUES (1, 'old-site', 'Historical Site User', 'project_site', 'Site A', 1)"))
        conn.execute(text('DROP TABLE requests'))
        conn.execute(text('CREATE TABLE requests (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, qty REAL NOT NULL, requested_by VARCHAR(255) NOT NULL, status VARCHAR(50), current_price REAL, building_subtype VARCHAR(100), project_site VARCHAR(255), approved_shortage_qty REAL NOT NULL DEFAULT 0)'))
        conn.execute(text('DROP TABLE push_subscriptions'))
        conn.execute(text('CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL, p256dh VARCHAR(255) NOT NULL, auth VARCHAR(255) NOT NULL, user_type VARCHAR(50), project_site VARCHAR(255), is_global_admin BOOLEAN, created_at TIMESTAMP)'))
        conn.execute(text("INSERT INTO items (id, name, category, unit, qty, unit_cost, planned_qty, planned_unit_cost) VALUES (1, 'Cement', 'Materials', 'bags', 10, 100, 10, 100)"))
        conn.execute(text("INSERT INTO requests (item_id, qty, requested_by, status) VALUES (1, 2, 'Historical Site User', 'Approved')"))
    monkeypatch.setattr(schema_init, 'engine', engine)
    schema_init.run_migrations()
    schema_init.run_migrations()
    with engine.connect() as conn:
        row = conn.execute(text('SELECT username, full_name, login_name, password_hash, session_version, must_change_password FROM users')).one()
        assert tuple(row) == ('old-site', 'Historical Site User', None, None, 1, True)
        assert tuple(conn.execute(text('SELECT requested_by, requested_by_user_id, approved_by_user_id FROM requests')).one()) == ('Historical Site User', None, None)
    assert 'user_id' in {col['name'] for col in inspect(engine).get_columns('push_subscriptions')}


def test_fixed_admin_migration_preserves_password_account_and_history(tmp_path, monkeypatch):
    from models import User, Item, Request, PushSubscription
    engine = create_engine(f"sqlite:///{tmp_path / 'fixed-admin.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        admin = make_account(session, 'previous.admin', 'admin')
        account_id, password_hash = admin.id, admin.password_hash
        old_token = login_response(admin)['token']
        item = Item(name='Cement', category='Materials', unit='bags', qty=10, unit_cost=100)
        session.add(item); session.flush()
        session.add(Request(item_id=item.id, qty=1, requested_by='Historical Person', status='Approved',
                            approved_by='previous.admin', approved_by_user_id=account_id))
        session.add(PushSubscription(user_id=account_id, endpoint='https://test/old', p256dh='test', auth='test', user_type='admin'))
        session.commit()
    monkeypatch.setattr(schema_init, 'engine', engine)
    schema_init.run_migrations()
    schema_init.run_migrations()
    with factory() as session:
        admin = session.get(User, account_id)
        assert (admin.username, admin.login_name, admin.full_name) == (ADMIN_USERNAME, ADMIN_LOGIN_NAME, None)
        assert admin.password_hash == password_hash and verify_password(TEST_PASSWORD, admin.password_hash)
        assert admin.session_version == 2
        assert validate_session(old_token, session) is None
        assert validate_session(login_response(admin)['token'], session)['username'] == ADMIN_USERNAME
        history = session.query(Request).one()
        assert history.approved_by_user_id == account_id and history.approved_by == 'previous.admin'
        assert session.query(PushSubscription).count() == 0


@pytest.mark.parametrize('conflict', ['multiple_admins', 'reserved_username'])
def test_fixed_admin_migration_does_not_overwrite_conflicting_accounts(tmp_path, monkeypatch, conflict):
    from models import User
    engine = create_engine(f"sqlite:///{tmp_path / 'conflicting-admin.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        admin = make_account(session, 'previous.admin', 'admin')
        if conflict == 'multiple_admins':
            make_account(session, 'other.admin', 'admin')
        else:
            make_account(session, ADMIN_LOGIN_NAME, site='A')
        account_id, password_hash = admin.id, admin.password_hash
    monkeypatch.setattr(schema_init, 'engine', engine)
    with pytest.raises(RuntimeError):
        schema_init.run_migrations()
    with factory() as session:
        admin = session.get(User, account_id)
        assert admin.username == 'previous.admin' and admin.password_hash == password_hash
        assert admin.session_version == 1
        assert session.query(User).count() == 2
