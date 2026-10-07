"""Concurrent approvals apply each decision once and record uncovered usage."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, local
from time import sleep

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import event
from sqlalchemy.orm import sessionmaker

from models import Item, Request, Actual
from api.routes.requests import update_request_status
from api.schemas import RequestStatusUpdate


@pytest.mark.parametrize('operation', ['manual_item', 'import', 'approval'])
def test_site_rename_during_record_changes_keeps_every_record_linked(concurrent_db, monkeypatch, operation):
    from models import AccessCode, ProjectSite, Notification
    from api.routes import items, bulk_upload, project_sites
    from api.schemas import ItemCreate, BulkUploadCommitIn, ProjectSiteUpdate
    factory = sessionmaker(bind=concurrent_db)
    with factory() as session:
        session.add(AccessCode(admin_code='unused test hash', user_code='unused test hash'))
        site = ProjectSite(name='Site A', is_active=True)
        session.add(site)
        item = Item(name='Cement', qty=10, unit_cost=1000, category='Materials', unit='bags', project_site='Site A')
        session.add(item)
        session.flush()
        request = Request(item_id=item.id, qty=2, requested_by='Site user', status='Pending', project_site='Site A')
        session.add(request)
        session.commit()
        site_id, request_id = site.id, request.id
    ready = Event()
    if operation != 'approval':
        module = items if operation == 'manual_item' else bulk_upload
        original = module.require_active_project_site
        def delayed_validation(*args, **kwargs):
            site_name = original(*args, **kwargs)
            ready.set()
            sleep(0.25)
            return site_name
        monkeypatch.setattr(module, 'require_active_project_site', delayed_validation)
    else:
        def delay_item_read(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith('SELECT') and 'FROM items' in statement and not ready.is_set():
                ready.set()
                sleep(0.25)
        event.listen(concurrent_db, 'after_cursor_execute', delay_item_read)
    admin = {'username':'Admin', 'user_type':'admin', 'is_global_admin':True}
    row = dict(name='Timber', qty=1, unit='lengths', unit_cost=100, category='Materials',
               building_type='Flats', budget='Budget 1', section='Concrete', project_site='Site A')
    def change_record():
        with factory() as session:
            try:
                if operation == 'manual_item':
                    items.create_item(ItemCreate(**row), BackgroundTasks(), session, admin)
                elif operation == 'import':
                    bulk_upload.commit_bulk_upload(BulkUploadCommitIn(project_site='Site A', rows=[row]), BackgroundTasks(), session, admin)
                else:
                    update_request_status(request_id, RequestStatusUpdate(status='Approved'), BackgroundTasks(), session, admin)
                return 200
            except HTTPException as error:
                session.rollback()
                return error.status_code
    def rename():
        with factory() as session:
            project_sites.update_project_site(site_id, ProjectSiteUpdate(name='Renamed site'), BackgroundTasks(), session, admin)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            result = executor.submit(change_record)
            assert ready.wait(5)
            executor.submit(rename).result(timeout=10)
            assert result.result(timeout=10) in (200, 409)
    finally:
        if operation == 'approval':
            event.remove(concurrent_db, 'after_cursor_execute', delay_item_read)
    with factory() as session:
        assert session.query(ProjectSite).one().name == 'Renamed site'
        for model in (Item, Request, Actual, Notification):
            assert all(record.project_site == 'Renamed site' for record in session.query(model).all())


@pytest.mark.parametrize('operation', ['create', 'rename'])
def test_concurrent_project_changes_preserve_unique_names(concurrent_db, monkeypatch, operation):
    from models import AccessCode, ProjectSite
    from api.routes import project_sites
    from api.schemas import ProjectSiteCreate, ProjectSiteUpdate
    factory = sessionmaker(bind=concurrent_db)
    with factory() as session:
        session.add(AccessCode(admin_code='unused test hash', user_code='unused test hash'))
        sites = [ProjectSite(name=name) for name in ['First project', 'Second project']]
        session.add_all(sites)
        session.commit()
        ids = [site.id for site in sites]
    original_validate = project_sites._validate_site_name
    def delayed_validate(*args, **kwargs):
        name = original_validate(*args, **kwargs)
        # Allow a second tab to act after validation and before commit.
        sleep(0.1)
        return name
    monkeypatch.setattr(project_sites, '_validate_site_name', delayed_validate)
    start = Barrier(2, timeout=5)
    def change(index):
        with factory() as session:
            start.wait()
            try:
                name = 'Tower' if index == 0 else ' tower '
                admin = {'user_type': 'admin', 'is_global_admin': True}
                if operation == 'create':
                    project_sites.create_project_site(ProjectSiteCreate(name=name), BackgroundTasks(), session, admin)
                else:
                    project_sites.update_project_site(ids[index], ProjectSiteUpdate(name=name), BackgroundTasks(), session, admin)
                return 200
            except HTTPException as error:
                session.rollback()
                return error.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(change, [0, 1]))
    assert sorted(results) == [200, 409]
    with factory() as session:
        assert len([site for site in session.query(ProjectSite).all() if site.name.lower() == 'tower']) == 1


@pytest.mark.parametrize('record_kind', ['request', 'actual'])
def test_item_deletion_cannot_leave_a_concurrently_created_record_orphaned(concurrent_db, record_kind):
    from datetime import datetime
    from models import ProjectSite
    from api.routes.items import delete_item
    from api.routes.requests import create_request
    from api.routes.actuals import create_actual
    from api.schemas import RequestCreate, ActualCreate
    engine = concurrent_db
    factory = sessionmaker(bind=engine)
    with factory() as session:
        session.add(ProjectSite(name='Site A', is_active=True))
        item = Item(name='Cement', qty=10, unit_cost=1000, category='Materials', unit='bags', project_site='Site A')
        session.add(item)
        session.commit()
        item_id = item.id
    barrier = Barrier(2, timeout=5)
    state = local()
    @event.listens_for(engine, 'after_cursor_execute')
    def align_item_reads(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'FROM items' in statement and not getattr(state, 'aligned', False):
            state.aligned = True
            barrier.wait()
    def change(action):
        with factory() as session:
            try:
                if action == 'delete':
                    delete_item(item_id, BackgroundTasks(), session, {'user_type':'admin','is_global_admin':True})
                elif record_kind == 'request':
                    create_request(RequestCreate(item_id=item_id, qty=1), BackgroundTasks(), session,
                                   {'username':'site.user','user_type':'project_site','project_site':'Site A','is_global_admin':False})
                else:
                    create_actual(ActualCreate(item_id=item_id, actual_qty=1, actual_cost=1000,
                                  actual_date=datetime.utcnow(), recorded_by='Admin'), BackgroundTasks(), session,
                                  {'user_type':'admin','is_global_admin':True})
                return 200
            except HTTPException as error:
                session.rollback()
                return error.status_code
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(change, ['create','delete']))
    finally:
        event.remove(engine, 'after_cursor_execute', align_item_reads)
    assert sorted(responses) == [200,409]
    with factory() as session:
        linked_model = Request if record_kind == 'request' else Actual
        for record in session.query(linked_model).all():
            assert session.get(Item, record.item_id) is not None


@pytest.mark.parametrize('same_request, qty, stock, expected_balance, shortages', [
    (False, 7, 10, -4, [0, 4]), (True, 4, 10, 6, None),
    (False, 0.1, 0.2, 0, [0, 0]), (False, 0.2, 0.3, -0.1, [0, 0.1]),
])
def test_concurrent_approvals_do_not_double_issue_stock(concurrent_db, same_request, qty, stock, expected_balance, shortages):
    engine = concurrent_db
    factory = sessionmaker(bind=engine)
    with factory() as session:
        item = Item(name='Cement', qty=stock, unit_cost=1000, category='Materials', unit='bags', project_site='Site A')
        session.add(item)
        session.flush()
        first = Request(item_id=item.id, qty=qty, requested_by='Test User', project_site='Site A', status='Pending')
        second = Request(item_id=item.id, qty=qty, requested_by='Test User', project_site='Site A', status='Pending')
        session.add_all([first, second])
        session.commit()
        ids = [first.id, first.id if same_request else second.id]
    barrier = Barrier(2, timeout=5)
    state = local()

    @event.listens_for(engine, 'after_cursor_execute')
    def align_stock_reads(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT') and 'FROM requests' in statement and not getattr(state, 'aligned', False):
            state.aligned = True
            barrier.wait()

    def approve(req_id):
        with factory() as session:
            try:
                update_request_status(req_id, RequestStatusUpdate(status='Approved'), BackgroundTasks(), session,
                    {'user_type':'admin', 'is_global_admin':True, 'full_name':'Test Admin'})
                return 200
            except HTTPException as error:
                session.rollback()
                return error.status_code

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(approve, ids))
    finally:
        event.remove(engine, 'after_cursor_execute', align_stock_reads)
    with factory() as session:
        if same_request:
            assert session.query(Actual).count() == 1
            assert session.query(Item).one().qty == expected_balance
            assert session.query(Request).filter_by(status='Approved').count() == 1
            assert all(status in (200, 409) for status in responses)
        else:
            assert responses == [200, 200]
            assert session.query(Actual).count() == 2
            assert session.query(Item).one().qty == expected_balance
            assert session.query(Request).filter_by(status='Approved').count() == 2
            assert sorted(row.approved_shortage_qty for row in session.query(Request).all()) == shortages
