"""Concurrent approvals apply each decision once and record uncovered usage."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, local

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from db import Base
from models import Item, Request, Actual
from api.routes.requests import update_request_status
from api.schemas import RequestStatusUpdate


@pytest.mark.parametrize('record_kind', ['request', 'actual'])
def test_item_deletion_cannot_leave_a_concurrently_created_record_orphaned(tmp_path, record_kind):
    from datetime import datetime
    from models import ProjectSite
    from api.routes.items import delete_item
    from api.routes.requests import create_request
    from api.routes.actuals import create_actual
    from api.schemas import RequestCreate, ActualCreate
    engine = create_engine(f"sqlite:///{tmp_path / 'linked-records.db'}", connect_args={'check_same_thread': False, 'timeout': 10})
    Base.metadata.create_all(engine)
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


@pytest.mark.parametrize('same_request', [False, True])
def test_concurrent_approvals_do_not_double_issue_stock(tmp_path, same_request):
    engine = create_engine(f"sqlite:///{tmp_path / 'concurrent.db'}", connect_args={'check_same_thread':False, 'timeout':10})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    qty = 4 if same_request else 7
    with factory() as session:
        item = Item(name='Cement', qty=10, unit_cost=1000, category='Materials', unit='bags', project_site='Site A')
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
        if statement.lstrip().upper().startswith('SELECT') and 'FROM items' in statement and not getattr(state, 'aligned', False):
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
            assert session.query(Item).one().qty == 10 - qty
            assert session.query(Request).filter_by(status='Approved').count() == 1
            assert all(status in (200, 409) for status in responses)
        else:
            assert responses == [200, 200]
            assert session.query(Actual).count() == 2
            assert session.query(Item).one().qty == 10 - 2 * qty
            assert session.query(Request).filter_by(status='Approved').count() == 2
            assert sorted(row.approved_shortage_qty for row in session.query(Request).all()) == [0, 4]
