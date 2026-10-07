import copy
import pytest

from models import Item, ProjectSite
from tests.conftest import build_cached_workbook
from api.services.budget_workbook_parser import parse_budget_workbook
from api.services.workbook_totals import trace_total
from openpyxl import Workbook


def workbook():
    rows = [
        ['SUBSTRUCTURE (GROUND TO DPC LEVEL)'], ['MATERIAL ONLY'],
        ['S/N', 'MATERIALS', 'QTY', None, 'RATE', 'AMOUNT'],
        [1, 'Cement', 2, 'bags', 10, '=C4*E4'],
        [2, 'Cement', 3, 'bags', 20, '=C5*E5'],
        [None, 'Materials subtotal', None, None, None, '=SUM(F4:F5)'],
        [None, 'FOR 4 BLOCKS OF 2 UNITS', None, None, None, '=F6*4'],
    ]
    return build_cached_workbook([
        ('SD 22-25 BGT 1', rows), ('FLATS OLD BGT 1', rows),
        ('SUMMARY PAGE', [[None, 'SD 22-25 four blocks', None, None, None, "='SD 22-25 BGT 1'!F7"]]),
    ], {'SD 22-25 BGT 1': {'F4': 20, 'F5': 60, 'F6': 80, 'F7': 320},
        'FLATS OLD BGT 1': {'F4': 20, 'F5': 60, 'F6': 80, 'F7': 320},
        'SUMMARY PAGE': {'F1': 320}}, hidden_sheets=['FLATS OLD BGT 1'])


def preview(client, test_db):
    test_db.add(ProjectSite(name='Review site', is_active=True))
    test_db.commit()
    content = workbook()
    result = client.post('/bulk-upload/analyze', data={'project_site': 'Review site'}, files={'file': ('budget.xlsx', content)})
    assert result.status_code == 200
    body = result.json()
    sheet = body['sheets'][0]
    rows = [{key: item[key] for key in ('name', 'unit', 'unit_cost', 'category', 'grp', 'section', 'budget')}
            | {'qty': item['qty'] * 4, 'source_qty': item['qty'], 'project_site': 'Review site',
               'building_type': sheet['building_type'], 'budget_scope': sheet['budget_scope'],
               'source_sheet': item['sheet_name'], 'source_row': item['row_number'], 'import_sheet': sheet['sheet_name']}
            for item in sheet['items']]
    return content, body, {'project_site': 'Review site', 'rows': rows, 'preview_token': body['preview_token'],
        'sheet_checks': [{'sheet_name': sheet['sheet_name'], 'multiplier': 4, 'budget_scope': sheet['budget_scope'], 'confirmed': True}]}


def test_parser_follows_summary_and_keeps_units_and_repeated_items():
    parsed = parse_budget_workbook(workbook())
    assert len(parsed.sheets) == 1
    sheet = parsed.sheets[0]
    assert sheet.suggested_multiplier == 4
    assert sheet.source_total == 320
    assert sheet.source_total_cell == 'F7'
    assert [item.unit for item in sheet.items] == ['bags', 'bags']
    assert [item.name for item in sheet.items] == ['Cement', 'Cement']
    assert sheet.budget_scope == 'SD 22-25 BGT 1'
    assert [layout['status'] for layout in parsed.layouts] == ['ready', 'skipped', 'skipped']
    included = parse_budget_workbook(workbook(), {'FLATS OLD BGT 1': {'header_row': 3, 'skip': False,
        'columns': {'name': 1, 'qty': 2, 'unit': 3, 'unit_cost': 4, 'amount': 5}}})
    assert len(included.sheets) == 2


def test_reviewed_commit_preserves_full_budget_and_is_idempotent(client, test_db):
    content, body, payload = preview(client, test_db)
    assert test_db.query(Item).count() == 0
    saved = client.post('/bulk-upload/commit', json=payload)
    assert saved.status_code == 200
    assert saved.json()['inserted_count'] == 2
    items = test_db.query(Item).all()
    assert sum(item.planned_qty * item.planned_unit_cost for item in items) == 320
    assert [item.planned_qty for item in items] == [8, 12]
    assert len({item.import_key for item in items}) == 2
    assert all(item.budget_scope == 'SD 22-25 BGT 1' and item.source_sheet == 'SD 22-25 BGT 1' for item in items)
    assert len(client.post('/bulk-upload/commit', json=payload).json()['skipped']) == 2
    again = client.post('/bulk-upload/analyze', data={'project_site': 'Review site'}, files={'file': ('budget.xlsx', content)})
    assert again.json()['duplicate_count'] == 2
    assert test_db.query(Item).count() == 2
    changed = copy.deepcopy(payload)
    changed['rows'][0]['unit_cost'] += 1
    changed['rows'][1]['unit_cost'] -= 2/3
    assert client.post('/bulk-upload/commit', json=changed).status_code == 422


def test_total_confirmation_multiplier_and_source_are_enforced(client, test_db):
    _, _, payload = preview(client, test_db)
    variants = []
    unconfirmed = copy.deepcopy(payload); unconfirmed['sheet_checks'][0]['confirmed'] = False; variants.append(unconfirmed)
    mismatch = copy.deepcopy(payload); mismatch['rows'][0]['unit_cost'] = 100; variants.append(mismatch)
    multiplier = copy.deepcopy(payload); multiplier['sheet_checks'][0]['multiplier'] = 2; variants.append(multiplier)
    unknown = copy.deepcopy(payload); unknown['rows'][0]['source_row'] = 999; variants.append(unknown)
    duplicate = copy.deepcopy(payload); duplicate['rows'][1]['source_row'] = duplicate['rows'][0]['source_row']; variants.append(duplicate)
    scope = copy.deepcopy(payload); scope['rows'][0]['budget_scope'] = 'Other blocks'; variants.append(scope)
    unsigned = copy.deepcopy(payload); unsigned.pop('preview_token'); variants.append(unsigned)
    tampered = copy.deepcopy(payload); tampered['preview_token'] += 'invalid'; variants.append(tampered)
    for invalid in variants:
        response = client.post('/bulk-upload/commit', json=invalid)
        assert response.status_code == 422, response.text
        assert test_db.query(Item).count() == 0


@pytest.mark.parametrize('unit_cost', [100.01, 99.99])
def test_one_kobo_total_tolerance_uses_decimal_values(client, test_db, unit_cost):
    from tests.conftest import build_workbook
    test_db.add(ProjectSite(name='Decimal review site', is_active=True))
    test_db.commit()
    content = build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Amount'],
        ['Cement', 1, 'bags', unit_cost, 100],
        ['GRAND TOTAL', None, None, None, 100],
    ])])
    result = client.post('/bulk-upload/analyze', data={'project_site': 'Decimal review site'},
        files={'file': ('budget.xlsx', content)})
    assert result.status_code == 200, result.text
    body = result.json()
    sheet, item = body['sheets'][0], body['sheets'][0]['items'][0]
    row = {key: item[key] for key in ('name', 'qty', 'unit', 'unit_cost', 'category', 'grp', 'section', 'budget')}
    row.update(source_qty=item['qty'], project_site='Decimal review site', building_type=sheet['building_type'],
        budget_scope=sheet['budget_scope'], source_sheet=item['sheet_name'], source_row=item['row_number'],
        import_sheet=sheet['sheet_name'])
    payload = {'project_site': 'Decimal review site', 'rows': [row], 'preview_token': body['preview_token'],
        'sheet_checks': [{'sheet_name': sheet['sheet_name'], 'multiplier': 1,
            'budget_scope': sheet['budget_scope'], 'confirmed': True}]}
    outside_tolerance = copy.deepcopy(payload)
    outside_tolerance['rows'][0]['unit_cost'] = 100.011 if unit_cost > 100 else 99.989
    rejected = client.post('/bulk-upload/commit', json=outside_tolerance)
    assert rejected.status_code == 422
    assert test_db.query(Item).count() == 0
    accepted = client.post('/bulk-upload/commit', json=payload)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()['inserted_count'] == 1
    assert test_db.query(Item).one().planned_unit_cost == unit_cost


def test_amount_allowances_unused_rows_and_labour_headings():
    content = build_cached_workbook([('SD 1 BGT 2', [
        ['S/N', 'MATERIALS', 'QTY', None, 'RATE', 'AMOUNT'],
        [1, 'Transport', None, 'sum', None, 15000],
        [2, 'Reused iron', 2, 'length', 100, 0],
        [None, 'SUPERSTRUCTURE GROUND FLOOR LABOUR ONLY'],
        [3, 'Mason', 1, 'day', 5000, 5000],
        [None, 'GRAND TOTAL', None, None, None, '=SUM(F2:F5)*3'],
    ])], {'SD 1 BGT 2': {'F6': 60000}})
    sheet = parse_budget_workbook(content).sheets[0]
    allowance, reused, mason = sheet.items
    assert (allowance.qty, allowance.unit_cost) == (1, 15000)
    assert reused.excluded_by_default
    assert mason.category == 'Labour' and mason.grp == 'Labour'
    assert sheet.suggested_multiplier == 3


def test_total_formula_trace_rejects_external_circular_and_nonlinear_references():
    ws = Workbook().active
    for formula in ["='[1]Elsewhere'!F3", '=F8', '=F3*F4', '=SUM(F3:F999999)']:
        ws['F8'] = formula
        try:
            trace_total(ws, 'F8', {'F3', 'F4'})
        except ValueError:
            pass
        else:
            raise AssertionError(formula)


def test_missing_or_unreadable_control_does_not_become_zero(client, test_db):
    from tests.conftest import build_workbook
    test_db.add(ProjectSite(name='Review site', is_active=True)); test_db.commit()
    data = build_workbook([('SD 1 BGT 1', [
        ['Name', 'Qty', 'Rate', 'Amount'], ['Cement', 1, 10, 10], ['GRAND TOTAL', None, None, '=SUM(D2)'],
    ])])
    result = client.post('/bulk-upload/analyze', data={'project_site': 'Review site'}, files={'file': ('budget.xlsx', data)})
    sheet = result.json()['sheets'][0]
    # A supported formula can be calculated without inventing a zero.
    assert sheet['source_total'] == 10
    assert sheet['total_unreadable'] is False
    data = build_workbook([('SD 1 BGT 1', [
        ['Name', 'Qty', 'Rate', 'Amount'], ['Cement', 1, 10, 10], ['GRAND TOTAL', None, None, '=UNKNOWN(D2)'],
    ])])
    result = client.post('/bulk-upload/analyze', data={'project_site': 'Review site'}, files={'file': ('budget.xlsx', data)})
    assert result.json()['sheets'][0]['total_unreadable'] is True


def test_preview_tokens_are_scoped_expire_and_cannot_be_used_to_sign_in(client, test_db):
    from datetime import datetime, timedelta, timezone
    from jose import jwt
    from api.settings import JWT_SECRET
    from api.dependencies import validate_session
    _, _, payload = preview(client, test_db)
    assert validate_session(payload['preview_token'], test_db) is None
    test_db.add(ProjectSite(name='Another site', is_active=True)); test_db.commit()
    wrong_site = copy.deepcopy(payload)
    wrong_site['project_site'] = 'Another site'
    for row in wrong_site['rows']:
        row['project_site'] = 'Another site'
    assert client.post('/bulk-upload/commit', json=wrong_site).status_code == 422
    claims = jwt.decode(payload['preview_token'], JWT_SECRET, algorithms=['HS256'])
    claims['exp'] = datetime.now(timezone.utc) - timedelta(seconds=1)
    expired = copy.deepcopy(payload)
    expired['preview_token'] = jwt.encode(claims, JWT_SECRET, algorithm='HS256')
    assert client.post('/bulk-upload/commit', json=expired).status_code == 422
    assert test_db.query(Item).count() == 0
