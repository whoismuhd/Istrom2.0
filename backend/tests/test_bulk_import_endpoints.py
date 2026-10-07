import os
import sys
import pytest

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from tests.conftest import build_workbook  # noqa: E402
from models import ProjectSite, Item  # noqa: E402


def _rows():
    return [
        ["SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)"],
        ["MATERIAL ONLY"],
        ["S/N", "MATERIALS", "QTY", "UNIT", "RATE", "AMOUNT"],
        [1, "CEMENTS", 803, "bags", 9400, 7548200],
    ]


def _seed_site(test_db, name="Lifecamp Kafe"):
    test_db.add(ProjectSite(name=name, is_active=True))
    test_db.commit()


@pytest.mark.parametrize('field,limit', [('name', 255), ('unit', 50), ('budget', 255), ('section', 255), ('grp', 255)])
def test_commit_rejects_oversized_text_before_saving_any_rows(client, test_db, field, limit):
    _seed_site(test_db)
    row = {'name': 'Cement', 'qty': 2, 'unit': 'bags', 'unit_cost': 10,
           'category': 'Materials', 'budget': 'Budget 1', 'section': 'Concrete',
           'building_type': 'Flats', 'project_site': 'Lifecamp Kafe', 'grp': 'Materials'}
    response = client.post('/bulk-upload/commit', json={
        'project_site': 'Lifecamp Kafe', 'rows': [row, {**row, field: 'X' * (limit + 1)}],
    })
    assert response.status_code == 422
    assert test_db.query(Item).count() == 0


def test_commit_rejects_blank_unit_before_saving(client, test_db):
    _seed_site(test_db)
    response = client.post('/bulk-upload/commit', json={'project_site': 'Lifecamp Kafe', 'rows': [{
        'name': 'Cement', 'qty': 2, 'unit': '   ', 'unit_cost': 10,
        'category': 'Materials', 'budget': 'Budget 1', 'section': 'Concrete',
        'building_type': 'Flats', 'project_site': 'Lifecamp Kafe',
    }]})
    assert response.status_code == 422
    assert test_db.query(Item).count() == 0


def test_preview_reports_oversized_text_even_when_every_row_is_invalid(client, test_db):
    import csv
    import io
    from constants import CONSTRUCTION_SECTIONS
    _seed_site(test_db)
    content = io.StringIO()
    writer = csv.writer(content)
    writer.writerow(['name', 'qty', 'unit', 'unit_cost', 'category', 'budget', 'section', 'building_type'])
    writer.writerow(['X' * 256, 2, 'bags', 10, 'Materials', 'Budget 1', CONSTRUCTION_SECTIONS[0], 'Flats'])
    response = client.post('/bulk-upload/preview', data={'default_project_site': 'Lifecamp Kafe'},
        files={'file': ('invalid.csv', content.getvalue().encode())})
    assert response.status_code == 200
    assert response.json()['valid_rows'] == []
    assert any(error['field'] == 'name' and '255' in error['message'] for error in response.json()['errors'])
    assert test_db.query(Item).count() == 0


def test_template_download_serves_blank_section_workbook(client):
    import io
    from openpyxl import load_workbook
    from api.services.import_template import build_import_template
    response = client.get('/bulk-upload/template.xlsx')
    assert response.status_code == 200
    assert response.content == build_import_template()
    assert response.headers['content-type'] == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    assert 'istrom-import-template.xlsx' in response.headers['content-disposition']
    workbook = load_workbook(io.BytesIO(response.content), data_only=True)
    assert workbook['Budget']['A2'].value == 'Section'
    assert workbook['Budget']['B10'].value is None
    workbook.close()


def test_analyze_returns_preview(client, test_db):
    _seed_site(test_db)
    content = build_workbook([("FLATS BGT 1", _rows())])
    resp = client.post(
        "/bulk-upload/analyze",
        data={"project_site": "Lifecamp Kafe"},
        files={"file": ("budget.xlsx", content,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["item_count"] == 1
    sheet = body["sheets"][0]
    assert sheet["building_type"] == "Flats"
    item = sheet["items"][0]
    assert item["name"] == "CEMENTS"
    assert item["budget"] == "Budget 1 - Flats(General Materials)"
    assert item["duplicate"] is False


def test_analyze_warns_about_manual_items_without_discarding_new_scope(client, test_db):
    _seed_site(test_db)
    test_db.add(Item(
        code="IT-1", name="CEMENTS", category="Materials", unit="bags",
        qty=803, unit_cost=9400, budget="Budget 1 - Flats(General Materials)",
        section="SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)", grp="General Materials",
        building_type="Flats", project_site="Lifecamp Kafe",
    ))
    test_db.commit()
    content = build_workbook([("FLATS BGT 1", _rows())])
    resp = client.post(
        "/bulk-upload/analyze",
        data={"project_site": "Lifecamp Kafe"},
        files={"file": ("budget.xlsx", content,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["duplicate_count"] == 0
    row = body['sheets'][0]['items'][0]
    assert row['duplicate'] is False
    assert any('similar item' in warning for warning in row['warnings'])


def test_commit_inserts_items_like_manual(client, test_db):
    _seed_site(test_db)
    payload = {
        "project_site": "Lifecamp Kafe",
        "skip_existing": True,
        "rows": [{
            "name": "CEMENTS", "qty": 803, "unit": "bags", "unit_cost": 9400,
            "category": "Materials", "budget": "Budget 1 - Flats(General Materials)",
            "section": "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)",
            "building_type": "Flats", "project_site": "Lifecamp Kafe",
            "grp": "General Materials",
        }],
    }
    resp = client.post("/bulk-upload/commit", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["inserted_count"] == 1
    assert body["created_codes"] == ["IT-1"]
    saved = test_db.query(Item).all()
    assert len(saved) == 1
    assert saved[0].name == "CEMENTS"
    assert saved[0].project_site == "Lifecamp Kafe"
    assert saved[0].code == "IT-1"


def test_commit_skips_existing_when_flagged(client, test_db):
    _seed_site(test_db)
    test_db.add(Item(
        code="IT-1", name="CEMENTS", category="Materials", unit="bags",
        qty=803, unit_cost=9400, budget="Budget 1 - Flats(General Materials)",
        section="SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)", grp="General Materials",
        building_type="Flats", project_site="Lifecamp Kafe",
    ))
    test_db.commit()
    payload = {
        "project_site": "Lifecamp Kafe", "skip_existing": True,
        "rows": [{
            "name": "CEMENTS", "qty": 803, "unit": "bags", "unit_cost": 9400,
            "category": "Materials", "budget": "Budget 1 - Flats(General Materials)",
            "section": "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)",
            "building_type": "Flats", "project_site": "Lifecamp Kafe",
            "grp": "General Materials",
        }],
    }
    resp = client.post("/bulk-upload/commit", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["inserted_count"] == 0
    assert len(body["skipped"]) == 1


def test_commit_rejects_invalid_category(client, test_db):
    _seed_site(test_db)
    payload = {
        "project_site": "Lifecamp Kafe", "skip_existing": True,
        "rows": [{
            "name": "X", "qty": 1, "unit": "pcs", "unit_cost": 1,
            "category": "Bogus", "budget": "Budget 1 - Flats(Irons)",
            "section": "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)",
            "building_type": "Flats", "project_site": "Lifecamp Kafe", "grp": "Irons",
        }],
    }
    resp = client.post("/bulk-upload/commit", json=payload)
    assert resp.status_code == 422
    assert test_db.query(Item).count() == 0  # transaction rolled back


def test_manual_mapping_reanalyzes_without_writing_inventory(client, test_db):
    import json
    _seed_site(test_db)
    content = build_workbook([('Sheet1', [
        ['Costing notes'], ['Product text', 'Count needed', 'Price each'], ['Cement', 3, 1000],
    ])])
    args = {'files': {'file': ('different.xlsx', content, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}}
    first = client.post('/bulk-upload/analyze', data={'project_site': 'Lifecamp Kafe'}, **args)
    assert first.status_code == 200
    assert first.json()['layouts'][0]['status'] == 'needs_mapping'
    mapped = client.post('/bulk-upload/analyze', data={
        'project_site': 'Lifecamp Kafe', 'mappings': json.dumps({'Sheet1': {
            'header_row': 2, 'columns': {'name': 0, 'qty': 1, 'unit_cost': 2},
        }}),
    }, **args)
    assert mapped.status_code == 200
    row = mapped.json()['sheets'][0]['items'][0]
    assert (row['qty'], row['unit_cost']) == (3, 1000)
    assert test_db.query(Item).count() == 0
    committed = client.post('/bulk-upload/commit', json={'project_site': 'Lifecamp Kafe', 'rows': [{
        'name': row['name'], 'qty': row['qty'], 'unit': 'bags', 'unit_cost': row['unit_cost'],
        'category': 'Materials', 'budget': 'Budget 1 - Flats(General Materials)', 'section': 'Concrete',
        'building_type': 'Flats', 'project_site': 'Lifecamp Kafe', 'grp': 'General Materials',
    }]})
    assert committed.status_code == 200
    item = test_db.query(Item).one()
    assert (item.qty, item.unit_cost, item.planned_qty) == (3, 1000, 3)


def test_bad_file_and_bad_mapping_return_readable_errors(client, test_db):
    import json
    _seed_site(test_db)
    bad = client.post('/bulk-upload/analyze', data={'project_site': 'Lifecamp Kafe'}, files={'file': ('broken.xlsx', b'not an Excel file')})
    assert bad.status_code == 422
    assert 'readable Excel workbook' in bad.json()['detail']
    content = build_workbook([('Sheet1', [['Name', 'Qty', 'Rate'], ['Cement', 3, 1000]])])
    for mappings in [
        'invalid json', '[]',
        json.dumps({'Sheet1': {'header_row': 1, 'columns': {'name': 0, 'qty': 0, 'unit_cost': 2}}}),
        json.dumps({'Sheet1': {'header_row': 1, 'columns': {'name': 0, 'qty': 1, 'unit_cost': 5}}}),
        json.dumps({'Sheet1': {'header_row': 10, 'columns': {'name': 0, 'qty': 1, 'unit_cost': 2}}}),
        json.dumps({'Other': {'header_row': 1, 'columns': {}}}),
    ]:
        result = client.post('/bulk-upload/analyze', data={'project_site': 'Lifecamp Kafe', 'mappings': mappings}, files={'file': ('data.xlsx', content)})
        assert result.status_code == 422
    assert test_db.query(Item).count() == 0


def test_unreadable_numbers_are_visible_in_preview_and_rejected_on_commit(client, test_db):
    _seed_site(test_db)
    content = build_workbook([('Sheet1', [['Name', 'Qty', 'Rate'], ['Cement', 'three bags', '=1+2']])])
    result = client.post('/bulk-upload/analyze', data={'project_site': 'Lifecamp Kafe'}, files={'file': ('data.xlsx', content)})
    assert result.status_code == 200
    row = result.json()['sheets'][0]['items'][0]
    assert row['qty'] is None and row['unit_cost'] is None
    assert len(row['errors']) == 2
    payload = {'name': row['name'], 'qty': row['qty'], 'unit': 'bags', 'unit_cost': row['unit_cost'],
        'category': 'Materials', 'budget': 'Budget 1 - Flats(General Materials)', 'section': 'Concrete',
        'building_type': 'Flats', 'project_site': 'Lifecamp Kafe', 'grp': 'General Materials'}
    assert client.post('/bulk-upload/commit', json={'project_site': 'Lifecamp Kafe', 'rows': [payload]}).status_code == 422
    assert test_db.query(Item).count() == 0
