"""Import contracts across workbook layouts, independent of customer files."""
import io
from zipfile import ZipFile
from itertools import permutations

import pytest
from openpyxl import Workbook

from api.services.budget_workbook_parser import parse_budget_workbook
from api.services.workbook_numbers import budget_number
from models import Item, ProjectSite
from tests.conftest import build_workbook


@pytest.mark.parametrize('order', list(permutations(range(4))))
@pytest.mark.parametrize('offset', [0, 2])
def test_column_orders_offsets_and_currency_headers_preserve_source_values(order, offset):
    labels = ['Resource description', 'Planned quantity', 'Unit of measurement', 'NGN unit price']
    values = ['Steel rebar', '2.5', 'length', 'NGN 1,250.50']
    content = build_workbook([('Supplier estimate', [
        ['Building type:', None, 'fully detached'], ['Budget no:', None, 4],
        [None] * offset + [labels[i] for i in order],
        [None] * offset + [values[i] for i in order],
    ])])
    sheet = parse_budget_workbook(content).sheets[0]
    item = sheet.items[0]
    assert (item.name, item.qty, item.unit, item.unit_cost) == ('Steel rebar', 2.5, 'length', 1250.50)
    assert (sheet.building_type, sheet.budget_number, item.grp) == ('Fully-detached', 4, 'Irons')
    assert item.row_number == 4


@pytest.mark.parametrize('value,expected', [
    ('₦ 1,250.50', 1250.5), ('1 250.50 NGN', 1250.5), ('1\u202f250,50', 1250.5),
    ("1'250.50", 1250.5), ('1.250,50', 1250.5), ('1250,50', 1250.5),
    ('1,250,000', 1250000), ('0', 0), ('2e3', 2000), ('3 bags', None),
    ('TBD', None), (True, None), (-2, None), ('(200)', None), ('NaN', None),
    (float('inf'), None), ('1,25,000', None), ('1 25', None),
])
def test_formatted_numbers_remain_strict(value, expected):
    assert budget_number(value) == expected


def test_split_column_headers_and_declared_merged_metadata():
    wb = Workbook()
    ws = wb.active
    ws.title = 'Estimate'
    ws.append(['Building Type', 'Budget No', 'Building Scope', 'Description', 'Planned', 'Unit', 'Unit', 'Total'])
    ws.append([None, None, None, None, 'Quantity', None, 'Price', 'Amount'])
    ws.append(['semi detached', 2, 'Block A', 'Cement', 2, 'bags', 100, '=E3*G3'])
    ws.append([None, None, None, 'Sand', 3, 'tons', 200, '=E4*G4'])
    for column in ('A', 'B', 'C'):
        ws.merge_cells(f'{column}3:{column}4')
    for column in ('A', 'B', 'C', 'D', 'F'):
        ws.merge_cells(f'{column}1:{column}2')
    buf = io.BytesIO(); wb.save(buf)
    parsed = parse_budget_workbook(buf.getvalue())
    assert len(parsed.sheets) == 1
    sheet = parsed.sheets[0]
    assert (sheet.building_type, sheet.budget_number, sheet.budget_scope) == ('Semi-detached', 2, 'Block A')
    assert [(i.name, i.qty, i.unit_cost, i.source_amount) for i in sheet.items] == [('Cement', 2, 100, 200), ('Sand', 3, 200, 600)]


def test_unnamed_unit_detection_is_not_tied_to_serial_columns_or_column_d():
    content = build_workbook([('Flats BGT 2', [
        ['Rate', 'Description', None, 'Qty', None], [100, 'Cement', 'bags', 2, 'CM-12'],
        [200, 'Sand', 'tons', 3, 'SD-11'],
    ])])
    parsed = parse_budget_workbook(content)
    assert parsed.layouts[0]['suggested_mapping']['unit'] == 2
    assert [i.unit for i in parsed.sheets[0].items] == ['bags', 'tons']


def test_two_possible_unit_columns_require_review():
    content = build_workbook([('Data', [['Description', 'Qty', None, None, 'Rate'], ['Cement', 2, 'bags', 'pieces', 100]])])
    parsed = parse_budget_workbook(content)
    assert 'unit' not in parsed.layouts[0]['suggested_mapping']
    assert parsed.sheets[0].items[0].unit == ''


def test_amount_only_and_quantity_amount_tables_derive_reviewable_rates():
    parsed = parse_budget_workbook(build_workbook([('Flats BGT 3', [
        ['Description', 'Unit', 'Line amount'], ['Transport', 'sum', '15 000 NGN'],
        ['Description', 'Unit', 'Qty', 'Extended cost'], ['Cement', 'bags', 5, '1.250,50'],
    ])]))
    allowance, cement = parsed.sheets[0].items
    assert (allowance.qty, allowance.unit_cost) == (1, 15000)
    assert (cement.qty, cement.unit_cost) == (5, 250.1)
    assert allowance.warnings and cement.warnings


def test_invalid_numbers_cannot_be_replaced_by_amount_only_inference_or_hidden():
    parsed = parse_budget_workbook(build_workbook([('Data', [
        ['Description', 'Qty', 'Rate', 'Amount'], ['Cement', 'two', 'TBD', 200],
        ['Sand', -3, 200, 0], ['Timber', '=UNKNOWN(4)', 10, 40],
        [None, 2, 50, 100],
    ])]))
    assert len(parsed.sheets[0].items) == 4
    for item in parsed.sheets[0].items:
        assert item.errors and not item.excluded_by_default
    assert parsed.sheets[0].items[0].qty is None
    assert parsed.sheets[0].items[0].unit_cost is None


def test_metadata_and_sections_can_change_between_tables():
    parsed = parse_budget_workbook(build_workbook([('Estimate', [
        ['Building type', None, 'Flats'], ['Budget no', 1], ['Building scope', 'Block A'],
        ['Description', 'Qty', 'Unit', 'Rate'], ['Cement', 2, 'bags', 100],
        ['Building scope: Block B'], ['Budget no', 2], ['Section: Roof repairs'],
        ['Rate', 'Unit', 'Description', 'Qty'], [50, 'length', 'Timber', 3],
    ])]))
    assert len(parsed.sheets) == 2
    assert len({s.sheet_name for s in parsed.sheets}) == 2
    assert [(s.budget_number, s.budget_scope) for s in parsed.sheets] == [(1, 'Block A'), (2, 'Block B')]
    assert parsed.sheets[1].items[0].section == 'Roof repairs'


def test_duplicate_semantic_columns_are_not_silently_chosen():
    parsed = parse_budget_workbook(build_workbook([('Data', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Price'], ['Cement', 2, 'bags', 100, 200],
    ])]))
    assert parsed.sheets == []
    assert parsed.layouts[0]['status'] == 'needs_mapping'


def test_complete_header_does_not_hide_an_earlier_incomplete_table():
    parsed = parse_budget_workbook(build_workbook([('Data', [
        ['Description', 'Qty'], ['Cement', 2],
        ['Description', 'Qty', 'Rate'], ['Sand', 3, 100],
    ])]))
    assert parsed.layouts[0]['status'] == 'needs_mapping'
    assert any('earlier table' in warning for warning in parsed.layouts[0]['warnings'])


def test_manual_mapping_follows_later_recognized_reordered_headers():
    parsed = parse_budget_workbook(build_workbook([('Data', [
        ['Product text', 'Count needed', 'Cost each', 'Measure'], ['Cement', 2, 100, 'bags'],
        ['Rate', 'Description', 'Unit', 'Qty'], [200, 'Sand', 'tons', 3],
    ])]), {'Data': {'header_row': 1, 'columns': {'name': 0, 'qty': 1, 'unit_cost': 2, 'unit': 3}}})
    assert [(i.name, i.qty, i.unit_cost) for i in parsed.sheets[0].items] == [('Cement', 2, 100), ('Sand', 3, 200)]


@pytest.mark.parametrize('formula', ["='[remote.xlsx]Sheet1'!A1", '=B2', '=1/0', '=UNKNOWN(2)', '=SUM(B2:B999999)', '=1e309', '=SUM(', '=SUM(1,'])
def test_unsupported_external_circular_and_nonfinite_formulas_require_correction(formula):
    parsed = parse_budget_workbook(build_workbook([('Data', [['Description', 'Qty', 'Rate'], ['Cement', formula, 100]])]))
    item = parsed.sheets[0].items[0]
    assert item.qty is None and item.errors and not item.excluded_by_default


@pytest.mark.parametrize('formula', ['=SUM(', '=SUM(1,'])
@pytest.mark.parametrize('field', ['qty', 'total'])
def test_incomplete_formulas_return_a_correctable_preview(client, test_db, formula, field):
    test_db.add(ProjectSite(name='Formula review site', is_active=True))
    test_db.commit()
    content = build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Amount'],
        ['Cement', formula if field == 'qty' else 1, 'bags', 100, 100],
        ['GRAND TOTAL', None, None, None, formula if field == 'total' else 100],
    ])])
    response = client.post('/bulk-upload/analyze', data={'project_site': 'Formula review site'},
        files={'file': ('budget.xlsx', content)})
    assert response.status_code == 200, response.text
    sheet = response.json()['sheets'][0]
    if field == 'qty':
        assert sheet['items'][0]['qty'] is None
        assert sheet['items'][0]['errors']
        assert not sheet['items'][0]['excluded_by_default']
    else:
        assert sheet['source_total'] is None
        assert sheet['total_unreadable']
    assert test_db.query(Item).count() == 0


def test_simple_uncached_formulas_and_total_preserve_cost_and_multiplier():
    parsed = parse_budget_workbook(build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Amount'],
        ['Cement', '=SUM(1,2)', 'bags', '=100*1.1', '=B2*D2'],
        ['Sand', 2, 'tons', 20, '=B3*D3'], ['GRAND TOTAL', None, None, None, '=SUM(E2:E3)*2'],
    ])]))
    sheet = parsed.sheets[0]
    assert sheet.source_total == pytest.approx(740)
    assert sheet.suggested_multiplier == 2
    assert sheet.items[0].qty == 3
    assert sheet.items[0].unit_cost == pytest.approx(110)
    assert sum(i.qty * i.unit_cost * sheet.suggested_multiplier for i in sheet.items) == pytest.approx(sheet.source_total)


def test_missing_amounts_follow_the_budget_formula_and_zero_quantities_stay_valid():
    parsed = parse_budget_workbook(build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Amount'],
        ['Cement', 2, 'bags', 100, '=B2*D2'], ['Reused timber', 3, 'length', 50, 'AVAILABLE'],
        ['Sand', 0, 'tons', 500, None], ['GRAND TOTAL', None, None, None, '=SUM(E2:E4)'],
    ])]))
    sheet = parsed.sheets[0]
    assert sheet.source_total == 200
    assert not sheet.items[0].excluded_by_default
    assert sheet.items[1].excluded_by_default
    assert not sheet.items[2].excluded_by_default
    assert [(i.name, i.qty) for i in sheet.items] == [('Cement', 2), ('Reused timber', 3), ('Sand', 0)]


def test_missing_amount_without_a_total_keeps_priced_lines_for_review():
    parsed = parse_budget_workbook(build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Amount'], ['Cement', 2, 'bags', 100, None],
    ])]))
    assert not parsed.sheets[0].items[0].excluded_by_default
    assert parsed.sheets[0].source_total is None


def test_uncached_total_can_start_in_a_column_after_blank_cells(client, test_db):
    test_db.add(ProjectSite(name='Offset total', is_active=True)); test_db.commit()
    content = build_workbook([('Flats BGT 2', [
        [None, 'Description', 'Qty', 'Unit', 'Rate', 'Amount'],
        [None, 'Cement', 2, 'bags', 100, '=C2*E2'],
        [None, 'GRAND TOTAL', None, None, None, '=SUM(F2)'],
    ])])
    response = client.post('/bulk-upload/analyze', data={'project_site': 'Offset total'}, files={'file': ('offset.xlsx', content)})
    assert response.status_code == 200, response.text
    assert response.json()['sheets'][0]['source_total'] == 200


def test_oversized_merge_expansion_is_rejected_before_reading_items():
    content = build_workbook([('Data', [['Description', 'Qty', 'Rate'], ['Cement', 2, 100]])])
    output = io.BytesIO()
    with ZipFile(io.BytesIO(content)) as source, ZipFile(output, 'w') as target:
        for entry in source.infolist():
            data = source.read(entry.filename)
            if entry.filename == 'xl/worksheets/sheet1.xml':
                data = data.replace(b'</worksheet>', b'<mergeCells count="3"><mergeCell ref="A1:CV10000"/><mergeCell ref="A1:CV9999"/><mergeCell ref="A1:CV9998"/></mergeCells></worksheet>')
            target.writestr(entry, data)
    with pytest.raises(ValueError, match='too many merged cells'):
        parse_budget_workbook(output.getvalue())


def test_noninteger_budget_identifiers_are_not_truncated_to_another_budget():
    parsed = parse_budget_workbook(build_workbook([('Data', [
        ['Building Type', 'Budget No', 'Description', 'Qty', 'Unit', 'Rate'],
        ['FLATS', 2.5, 'Cement', 2, 'bags', 100],
    ])]))
    assert parsed.sheets[0].budget_number is None
    assert parsed.sheets[0].items[0].budget == ''


def test_budget_title_is_read_even_when_the_sheet_name_has_no_budget():
    parsed = parse_budget_workbook(build_workbook([('Estimate', [
        ['BUDGET NO. 12'], ['Building type: Flats'],
        ['Description', 'Qty', 'Unit', 'Rate'], ['Cement', 2, 'bags', 100],
    ])]))
    assert (parsed.sheets[0].building_type, parsed.sheets[0].budget_number) == ('Flats', 12)


def test_sum_ignores_text_and_boolean_references_and_percentage_rates_work():
    parsed = parse_budget_workbook(build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate', 'Amount'],
        ['Cement', 1, 'bags', '=100+100*10%', '=B2*D2'],
        [None, None, None, None, 'Not budgeted'], [None, None, None, None, True], [],
        ['GRAND TOTAL', None, None, None, '=SUM(E5:E2)'],
    ])]))
    sheet = parsed.sheets[0]
    assert sheet.source_total == 110
    assert sheet.items[0].unit_cost == 110


def test_conduit_and_explicit_labour_names_do_not_get_other_trade_groups():
    parsed = parse_budget_workbook(build_workbook([('Flats BGT 1', [
        ['Description', 'Qty', 'Unit', 'Rate'], ['PVC conduit pipe', 2, 'length', 100],
        ['Block laying labour', 1, 'sum', 200],
    ])]))
    assert [(i.grp, i.category) for i in parsed.sheets[0].items] == [('Electrical', 'Materials'), ('Labour', 'Labour')]


@pytest.mark.parametrize('layout', ['reordered', 'amount_only', 'formula'])
def test_different_layouts_preview_and_commit_with_values_intact(client, test_db, layout):
    test_db.add(ProjectSite(name='Layout test', is_active=True)); test_db.commit()
    rows = {
        'reordered': [['Rate (NGN)', 'Description', 'UOM', 'Qnty'], ['1.250,50', 'Cement', 'bags', '2']],
        'amount_only': [['Description', 'Unit', 'Line amount'], ['Transport', 'sum', 2501]],
        'formula': [['Description', 'Qty', 'Unit', 'Rate', 'Amount'], ['Cement', '=1+1', 'bags', 1250.5, '=B2*D2'],
                    ['GRAND TOTAL', None, None, None, '=SUM(E2)']],
    }[layout]
    content = build_workbook([('FLATS BGT 1', [['MATERIALS ONLY']] + rows)])
    # The formula references above are adjusted for the shared heading row.
    if layout == 'formula':
        rows[1][-1], rows[2][-1] = '=B3*D3', '=SUM(E3)'
        content = build_workbook([('FLATS BGT 1', [['MATERIALS ONLY']] + rows)])
    response = client.post('/bulk-upload/analyze', data={'project_site': 'Layout test'}, files={'file': ('estimate.xlsx', content)})
    assert response.status_code == 200, response.text
    body = response.json(); sheet = body['sheets'][0]; item = sheet['items'][0]
    assert item['qty'] * item['unit_cost'] == pytest.approx(2501)
    payload = {'project_site': 'Layout test', 'preview_token': body['preview_token'],
        'sheet_checks': [{'sheet_name': sheet['sheet_name'], 'budget_scope': sheet['budget_scope'], 'multiplier': 1,
                          'confirmed': True, 'reviewed_total': 2501}],
        'rows': [{key: item[key] for key in ('name', 'qty', 'unit', 'unit_cost', 'category', 'grp', 'budget', 'section')} | {
            'project_site': 'Layout test', 'building_type': sheet['building_type'], 'budget_scope': sheet['budget_scope'],
            'source_sheet': item['sheet_name'], 'source_row': item['row_number'], 'source_qty': item['qty'], 'import_sheet': sheet['sheet_name']}]}
    saved = client.post('/bulk-upload/commit', json=payload)
    assert saved.status_code == 200, saved.text
    record = test_db.query(Item).one()
    assert (record.name, record.unit) == (item['name'], item['unit'])
    assert record.planned_qty * record.planned_unit_cost == pytest.approx(2501)
