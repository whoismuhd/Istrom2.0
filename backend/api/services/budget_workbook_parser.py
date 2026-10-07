"""Parse Istrom multi-sheet budget workbooks into structured item previews.

Pure and DB-free: bytes in, dataclasses out. No validation against the database,
no writes.
"""
from __future__ import annotations

import difflib
import hashlib
import io
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from openpyxl import load_workbook
from api.services.workbook_security import validate_workbook_archive, workbook_merges
from api.services.workbook_totals import summary_controls, apply_sheet_control, trace_total
from api.services.workbook_numbers import budget_number as _number
from openpyxl.utils import get_column_letter

from constants import CONSTRUCTION_SECTIONS, PROPERTY_TYPES

MAX_SHEET_ROWS = 10000
MAX_SHEET_COLUMNS = 100
MAX_WORKBOOK_SHEETS = 50


def _norm(text) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text or "").strip().lower()).strip("_")


def infer_building_type(sheet_name: str) -> Tuple[str, bool]:
    u = str(sheet_name or "").strip().upper()
    if u.startswith("FLATS") or u.startswith("FLAT"):
        return ("Flats", True)
    if u.startswith("TER"):
        return ("Terraces", True)
    if u.startswith("SD"):
        return ("Semi-detached", True)
    if re.match(r"^D\s?\d", u):
        return ("Fully-detached", True)
    return ("", False)


def infer_budget_number(sheet_name: str) -> Tuple[Optional[int], bool]:
    u = str(sheet_name or "").strip().upper()
    m = re.search(r"B(?:GT|UDGET)?\s*(\d+)", u)
    if m:
        return (int(m.group(1)), True)
    return (None, False)


GROUP_MAP = {
    "material": ("General Materials", "Materials"),
    "material_only": ("General Materials", "Materials"),
    "materials": ("General Materials", "Materials"),
    "materials_only": ("General Materials", "Materials"),
    "general_materials": ("General Materials", "Materials"),
    "woods": ("Woods", "Materials"),
    "wood": ("Woods", "Materials"),
    "irons": ("Irons", "Materials"),
    "iron": ("Irons", "Materials"),
    "steel": ("Irons", "Materials"),
    "reinforcement": ("Irons", "Materials"),
    "timber": ("Woods", "Materials"),
    "plumbing": ("Plumbings", "Materials"),
    "plumbings": ("Plumbings", "Materials"),
    "electrical": ("Electrical", "Materials"),
    "mechanical": ("Mechanical", "Materials"),
    "labour": ("Labour", "Labour"),
    "labour_only": ("Labour", "Labour"),
    "labor": ("Labour", "Labour"),
    "labor_only": ("Labour", "Labour"),
    # Combined material+labour blocks (common on the Terraces sheets). No
    # dedicated budget group exists, so bucket under General Materials but mark
    # the item category as the combined "Material/Labour".
    "material_labour": ("General Materials", "Material/Labour"),
    "materials_labour": ("General Materials", "Material/Labour"),
    "material_labor": ("General Materials", "Material/Labour"),
    "materials_labor": ("General Materials", "Material/Labour"),
}

_SECTION_CANON = {_norm(s): s for s in CONSTRUCTION_SECTIONS}

# Minimum SequenceMatcher ratio (on normalized text) to accept a fuzzy section
# match. High on purpose: a wrong auto-match is worse than flagging for review.
_SECTION_FUZZY_THRESHOLD = 0.86

# Conservative item-name -> (group, category) inference, used only as a fallback
# when a row has no group sub-header above it. Patterns are checked in order, so
# more specific ones (e.g. binding wire -> Irons) come before generic ones
# (e.g. wire -> Electrical). Ambiguous names match nothing and stay unset.
_NAME_GROUP_PATTERNS = [
    (re.compile(r'\bLABOU?R\b'), ("Labour", "Labour")),
    (re.compile(r"\bY\s?\d{1,2}\s?MM\b|\bBRC\b|BINDING\s*WIRE|\bB\s*/?\s*WIRE\b|REBAR|\bRODS?\b"),
     ("Irons", "Materials")),
    (re.compile(r"PLANK|PLYWOOD|MARINE\s*BOARD|TIMBER|BOTTOM\s*BEAM\s*[69]\s*(?:'{2}|\"|INCH)|\bWOODS?\b|\b2\s*X\s*[234]\b|\b1\s*X\s*12\b"),
     ("Woods", "Materials")),
    (re.compile(r'\bCONDUIT\b'), ("Electrical", "Materials")),
    (re.compile(r"\bPIPES?\b|\bPVC\b|\bWC\b|CISTERN|PLUMB|SOAK\s*AWAY|\bGUTTER\b|\bELBOWS?\b|FITTINGS?"),
     ("Plumbings", "Materials")),
    (re.compile(r"\bCABLES?\b|CONDUIT|\bSWITCH(ES)?\b|\bSOCKETS?\b|\bELECTRIC|\bBULBS?\b|\bLAMPS?\b|\bWIRES?\b"),
     ("Electrical", "Materials")),
    (re.compile(r"CEMENT|\bSANDS?\b|GRANITES?|\bBLOCKS?\b|LATERITE|STONE\s*DUST|\bNAILS?\b|POLYST|\bDPM\b|GRAVEL"),
     ("General Materials", "Materials")),
    (re.compile(r"LABOUR|LABOR|\bMASONS?\b|CASTING|\bSETTING\b|FIXING|BENDER|WORKMAN"),
     ("Labour", "Labour")),
]


def group_to_grp_category(text) -> Optional[Tuple[str, str]]:
    key = _norm(text)
    key = key.replace('labours', 'labour').replace('labors', 'labor').replace('_and_', '_')
    key = re.sub(r'_con_?d$', '', key)
    if re.fullmatch(r'(?:[a-z0-9]+_)*labou?r_only', key):
        return ('Labour', 'Labour')
    return GROUP_MAP.get(key)


def infer_group_from_name(name) -> Optional[Tuple[str, str]]:
    """Best-effort (group, category) from an item name. None when ambiguous."""
    text = str(name or "").upper()
    for pattern, value in _NAME_GROUP_PATTERNS:
        if pattern.search(text):
            return value
    return None


def canonical_section(text) -> Tuple[str, bool]:
    raw = str(text or "").strip()
    key = _norm(raw)
    hit = _SECTION_CANON.get(key)
    if hit:
        return (hit, True)
    # Fuzzy fallback: pick the closest canonical section above the threshold.
    best_value = None
    best_ratio = 0.0
    for canon_key, canon_value in _SECTION_CANON.items():
        ratio = difflib.SequenceMatcher(None, key, canon_key).ratio()
        if ratio > best_ratio:
            best_ratio, best_value = ratio, canon_value
    if best_value and best_ratio >= _SECTION_FUZZY_THRESHOLD:
        return (best_value, True)
    return (raw, False)


@dataclass
class ParsedItem:
    name: str
    qty: Optional[float]
    unit: str
    unit_cost: Optional[float]
    category: str
    grp: str
    section: str
    section_matched: bool
    budget: str
    sheet_name: str
    row_number: int
    source_amount: Optional[float] = None
    amount_cell: str = ''
    source_amount_missing: bool = False
    excluded_by_default: bool = False
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


@dataclass
class ParsedSheet:
    sheet_name: str
    building_type: str
    building_type_confident: bool
    budget_number: Optional[int]
    budget_confident: bool
    items: List[ParsedItem] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    budget_scope: str = ''
    suggested_multiplier: float = 1
    multiplier_evidence: str = ''
    source_total: Optional[float] = None
    source_total_cell: str = ''
    source_total_formula: str = ''
    source_total_label: str = ''
    summary_label: str = ''
    total_unreadable: bool = False
    requires_confirmation: bool = False


@dataclass
class ParsedWorkbook:
    sheets: List[ParsedSheet] = field(default_factory=list)
    layouts: List[dict] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    workbook_id: str = ''


COLUMN_FIELDS = {"name", "qty", "unit", "unit_cost", "amount", "section", "grp", "category", "building_type", "budget_no", "budget_scope"}
REQUIRED_COLUMNS = {"name", "qty", "unit_cost"}
HEADER_ALIASES = {
    "building_type": "building_type", "building": "building_type", "buildingtype": "building_type",
    "property_type": "building_type", "budget_no": "budget_no", "budget_number": "budget_no",
    "budget": "budget_no", "budgetno": "budget_no", "section": "section", "work_section": "section",
    "group": "grp", "grp": "grp", "budget_group": "grp", "category": "category",
    "item_name": "name", "itemname": "name", "item": "name", "items": "name", "name": "name",
    "materials": "name", "material": "name", "description": "name", "descriptions": "name",
    "descrition": "name", "descritions": "name", "particulars": "name", "item_description": "name",
    "unit": "unit", "units": "unit", "uom": "unit", "unit_of_measure": "unit",
    "qty": "qty", "quantity": "qty", "quantities": "qty", "q_ty": "qty",
    "unit_cost": "unit_cost", "unitcost": "unit_cost", "rate": "unit_cost", "price": "unit_cost",
    "unit_price": "unit_cost", "cost_per_unit": "unit_cost", "unit_rate": "unit_cost",
    "amount": "amount", "total_cost": "amount", "line_total": "amount",
    "labour": "name", "labor": "name", "budget_scope": "budget_scope", "building_scope": "budget_scope",
    "product": "name", "product_name": "name", "resource": "name", "resource_description": "name",
    "qnt": "qty", "qnty": "qty", "planned_qty": "qty", "planned_quantity": "qty",
    "budgeted_quantity": "qty", "estimated_quantity": "qty",
    "unit_of_measurement": "unit", "u_o_m": "unit", "measure": "unit",
    "unit_measure": "unit", "measurement_unit": "unit",
    "cost_each": "unit_cost", "price_each": "unit_cost", "cost_unit": "unit_cost",
    "estimated_unit_cost": "unit_cost", "budgeted_rate": "unit_cost",
    "extended_cost": "amount", "total_amount": "amount", "line_amount": "amount",
    "budget_amount": "amount", "work_stage": "section", "trade": "grp",
    "trade_group": "grp", "block": "budget_scope", "block_name": "budget_scope",
}


def _cell(row, idx):
    return row[idx] if idx is not None and idx < len(row) else None


def _header_key(value):
    key = _norm(re.sub(r"[₦$£€]", "", str(value or "")))
    key = re.sub(r"^(ngn|naira)_|_(ngn|naira)$", "", key)
    return key


def _header_columns(row):
    mapping = {}
    for idx, cell in enumerate(row):
        # Currency suffixes are common in headings (e.g. Rate (₦)).
        key = _header_key(cell)
        mapped = HEADER_ALIASES.get(key)
        if mapped and mapped not in mapping:
            mapping[mapped] = idx
    return mapping


def _is_header(row):
    mapping = _header_columns(row)
    return "name" in mapping and bool({"qty", "unit_cost", "amount"} & set(mapping))


def _complete_mapping(mapping):
    return 'name' in mapping and (REQUIRED_COLUMNS <= set(mapping) or 'amount' in mapping)


def _headers(rows):
    """Recognize table headers, including two rows with split column captions."""
    detected, consumed = {}, set()
    for index, row in enumerate(rows):
        if index in consumed:
            continue
        header, end = list(row), index
        if index + 1 < len(rows):
            next_row = rows[index + 1]
            fragments = [str(c).strip() for c in next_row if c is not None and str(c).strip()]
            if ({'name', 'qty', 'unit', 'unit_cost', 'amount'} & set(_header_columns(row))
                    and not _complete_mapping(_header_columns(next_row)) and len(fragments) >= 2
                    and all(_header_key(c) in HEADER_ALIASES or _header_key(c) in ('ngn', 'naira') for c in fragments)):
                combined = []
                for column in range(max(len(row), len(next_row))):
                    top, bottom = _cell(row, column), _cell(next_row, column)
                    joint = f'{top or ""} {bottom or ""}'.strip()
                    combined.append(joint if _header_key(joint) in HEADER_ALIASES else top or bottom)
                if _complete_mapping(_header_columns(combined)):
                    header, end = combined, index + 1
        if not _is_header(header):
            continue
        mapping = _header_columns(header)
        duplicates = {field for field in mapping if sum(HEADER_ALIASES.get(_header_key(c)) == field for c in header) > 1}
        detected[index] = {'columns': mapping, 'end': end, 'header': header, 'duplicates': duplicates}
        consumed.update(range(index + 1, end + 1))
    return detected


SHEET_FIELDS = {"building_type", "budget_no", "budget_scope", "section"}


def _sheet_fields(rows):
    """Read shared label/value fields above the item tables."""
    fields = {}
    for row in rows:
        texts = [str(c).strip() for c in row if c is not None and str(c).strip()]
        if len(texts) == 1 and re.match(r'^B(?:GT|UDGET)\b', texts[0], re.I):
            number = _budget_field(texts[0])
            if number is not None:
                fields['budget_no'] = number
        for index, label in enumerate(row):
            inline = re.fullmatch(r'\s*([^:]+):\s*(.+)', str(label or ''))
            if inline and HEADER_ALIASES.get(_norm(inline[1])) in SHEET_FIELDS:
                fields[HEADER_ALIASES[_norm(inline[1])]] = inline[2].strip()
                continue
            key = HEADER_ALIASES.get(_norm(label))
            value = next((c for c in row[index + 1:] if c is not None and str(c).strip()), None)
            if key in SHEET_FIELDS and value is not None and str(value).strip():
                if HEADER_ALIASES.get(_norm(value)) not in SHEET_FIELDS:
                    fields[key] = value
    return fields


def _budget_string(building_type, budget_number, grp):
    if not building_type or budget_number is None or not grp:
        return ""
    return f"Budget {budget_number} - {building_type}({grp})"


def _budget_field(value):
    number = _number(value)
    if number is not None:
        return int(number) if number.is_integer() and number > 0 else None
    match = re.fullmatch(r'\s*(?:BGT|BUDGET)(?:\s+(?:NO\.?|NUMBER))?\s*[:#-]?\s*(\d+)\s*', str(value or ''), re.I)
    return int(match[1]) if match and int(match[1]) > 0 else None


def _building_field(value):
    text = str(value or '').strip()
    return {'flat': 'Flats', 'flats': 'Flats', 'terrace': 'Terraces', 'terraces': 'Terraces',
            'semi_detached': 'Semi-detached', 'fully_detached': 'Fully-detached',
            'detached': 'Fully-detached'}.get(_norm(text), text)


def _category_field(value):
    hit = group_to_grp_category(value)
    return hit[1] if hit else str(value or '').strip()


_UNIT_WORDS = set('bag bags roll rolls length lengths piece pieces pc pcs no nos nr each unit units day days hour hours sum lot lots item tonne tonnes ton tons kg g litre litres liter liters l lm m meter meters metre metres m2 m3 sqm sq_m sq_ft sqft cu_m cum ft feet sht sheet sheets bucket buckets set sets pair pairs'.split())


def _unnamed_unit_column(mapping, rows, header, start, end):
    if 'unit' in mapping:
        return mapping, False
    samples = [r for r in rows[start + 1:end] if _cell(r, mapping.get('name')) and
               (_number(_cell(r, mapping.get('qty'))) is not None or _number(_cell(r, mapping.get('amount'))) is not None)]
    candidates = []
    for column in range(len(header)):
        if column in mapping.values() or str(_cell(header, column) or '').strip():
            continue
        units = [str(_cell(r, column) or '').strip() for r in samples if str(_cell(r, column) or '').strip()]
        if units and all(_norm(unit.replace('²', '2').replace('³', '3')) in _UNIT_WORDS for unit in units):
            candidates.append(column)
    return ({**mapping, 'unit': candidates[0]}, True) if len(candidates) == 1 else (mapping, False)


def _legacy_missing_unit_header(mapping, rows, header_index):
    """Handle older budgets whose header omits UNIT but data still contains it."""
    if mapping.get("name") != 1 or mapping.get("qty") != 2 or mapping.get("unit_cost") not in (3, 4) or "unit" in mapping:
        return mapping, False
    samples = []
    for row in rows[header_index + 1:header_index + 61]:
        if _is_header(row):
            break
        if _number(_cell(row, 2)) is not None and _cell(row, 1) and _number(_cell(row, 0)) is not None:
            samples.append(row)
    unit_samples = [r for r in samples if str(_cell(r, 3) or '').strip()]
    # An unused line may have a unit but no rate. It must not hide the unit
    # column for all the priced lines in this table.
    if (unit_samples and all(_number(_cell(r, 3)) is None for r in unit_samples)
            and any(_number(_cell(r, 4)) is not None for r in unit_samples)
            and all(_cell(r, 4) in (None, '') or _number(_cell(r, 4)) is not None for r in unit_samples)):
        corrected = {**mapping, "unit": 3, "unit_cost": 4}
        if mapping.get('amount') == 4:
            corrected['amount'] = 5
        return corrected, True
    return mapping, False


def _display(value):
    return "" if value is None else str(value)[:180]


def _bounded_sheet_rows(ws):
    rows = []
    for row in ws.iter_rows(values_only=True):
        if len(rows) >= MAX_SHEET_ROWS or len(row) > MAX_SHEET_COLUMNS:
            raise ValueError(f"{ws.title}: maximum supported size is {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns.")
        rows.append(row)
    return rows


def parse_budget_workbook(content: bytes, mappings: Optional[dict] = None) -> ParsedWorkbook:
    mappings = mappings or {}
    validate_workbook_archive(content)
    merges = workbook_merges(content)
    # Read formulas separately so uncached formulas can be explained in preview.
    wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    formula_wb = load_workbook(io.BytesIO(content), data_only=False, read_only=True)
    try:
        if len(wb.worksheets) > MAX_WORKBOOK_SHEETS:
            raise ValueError(f"Workbook has too many sheets. Maximum: {MAX_WORKBOOK_SHEETS}.")
        unknown_sheets = set(mappings) - set(wb.sheetnames)
        if unknown_sheets:
            raise ValueError("Column mapping refers to a sheet that is not in this workbook.")
        result = ParsedWorkbook(workbook_id=hashlib.sha256(content).hexdigest())
        for ws in wb.worksheets:
            if (ws.max_row or 0) > MAX_SHEET_ROWS or (ws.max_column or 0) > MAX_SHEET_COLUMNS:
                raise ValueError(f'{ws.title}: maximum supported size is {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns.')
        controls = summary_controls(formula_wb)
        cell_count = 0
        formula_budget = [100000]
        for ws in wb.worksheets:
            if (ws.max_row or 0) > MAX_SHEET_ROWS or (ws.max_column or 0) > MAX_SHEET_COLUMNS:
                raise ValueError(f"{ws.title}: maximum supported size is {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns. Remove unused rows or columns and try again.")
            rows = _bounded_sheet_rows(ws)
            formula_rows = _bounded_sheet_rows(formula_wb[ws.title])
            formula_cells, formula_cache = None, {}

            def calculate(address):
                nonlocal formula_cells
                if formula_cells is None:
                    formula_cells = {f'{get_column_letter(col)}{row}': value for row, values in enumerate(formula_rows, 1)
                                     for col, value in enumerate(values, 1) if value is not None}
                if not str(formula_cells.get(address, '')).startswith('='):
                    return None
                try:
                    value, weights = trace_total(formula_wb[ws.title], address, set(), formula_cells, formula_cache, formula_budget)
                    return _number(value) if not weights else None
                except (ValueError, TypeError, ZeroDivisionError, RecursionError, OverflowError):
                    return None

            merge_columns = {}
            merge_anchors = {}
            for c1, r1, c2, r2 in merges.get(ws.title, []):
                for column in range(c1 - 1, c2):
                    merge_columns.setdefault(column, []).append((r1 - 1, r2 - 1, c1 - 1))

            def merged_cell(row_index, column):
                value = _cell(rows[row_index], column)
                if value is None and column is not None:
                    if column not in merge_anchors:
                        anchors = {}
                        for first, last, anchor in merge_columns.get(column, []):
                            for merged_row in range(first, last + 1):
                                anchors.setdefault(merged_row, (first, anchor))
                        merge_anchors[column] = anchors
                    origin = merge_anchors[column].get(row_index)
                    if origin:
                        return _cell(rows[origin[0]], origin[1])
                return value
            cell_count += sum(len(row) for row in rows)
            if cell_count > 2000000:
                raise ValueError("Workbook has too many cells. Split it into smaller workbooks.")
            override = mappings.get(ws.title, {})
            headers = _headers(rows)
            header_idx = next((idx for idx, header in headers.items() if _complete_mapping(header['columns'])), next(iter(headers), None))
            mapping = headers[header_idx]['columns'] if header_idx is not None else {}
            header_end = headers[header_idx]['end'] if header_idx is not None else -1
            guessed_unit = False
            if header_idx is not None:
                mapping, guessed_unit = _legacy_missing_unit_header(mapping, rows, header_end)
                next_header = next((idx for idx in headers if idx > header_end), len(rows))
                mapping, inferred_unit = _unnamed_unit_column(mapping, rows, headers[header_idx]['header'], header_end, next_header)
                guessed_unit = guessed_unit or inferred_unit
            if override and not override.get("skip"):
                header_idx = override["header_row"] - 1
                if header_idx >= len(rows):
                    raise ValueError(f"{ws.title}: selected header row does not exist.")
                mapping = override["columns"]
                header_end = header_idx
                if any(idx >= max((len(row) for row in rows), default=0) for idx in mapping.values()):
                    raise ValueError(f"{ws.title}: selected column does not exist.")
            header = headers[header_idx]['header'] if header_idx in headers else rows[header_idx] if header_idx is not None and header_idx >= 0 else []
            width = max((len(r) for r in rows), default=0)
            layout = {
                "sheet_name": ws.title, "status": "ready", "header_row": header_idx + 1 if header_idx is not None else None,
                "columns": [{"index": idx, "label": f"{get_column_letter(idx + 1)}: {_display(_cell(header, idx)) or 'unnamed'}"} for idx in range(width)],
                "sample_rows": [{"row_number": idx + 1, "cells": [_display(c) for c in row]}
                                for idx, row in enumerate(formula_rows) if any(c is not None for c in row)][:20],
                "suggested_mapping": mapping, "warnings": [], "is_manual": bool(override),
                "hidden": ws.sheet_state != 'visible',
            }
            result.layouts.append(layout)
            if override.get("skip") or ws.sheet_state != 'visible' and not override:
                layout["status"] = "skipped"
                layout["warnings"].append("Sheet excluded by you. No rows from this sheet will be imported." if override.get('skip') else "Hidden sheet excluded. Include it only if it belongs to the current budget.")
                continue
            if not any(any(c is not None for c in row) for row in rows):
                layout["status"] = "skipped"
                layout["warnings"].append("Empty sheet: no rows to import.")
                continue
            ambiguous = header_idx in headers and headers[header_idx]['duplicates'] and not override
            if header_idx is None or not _complete_mapping(mapping) or ambiguous:
                if not override and (re.search(r'\bsummary\b', ws.title, re.I) or ws.title == 'Template options'):
                    layout['status'] = 'skipped'
                    layout['warnings'].append('Template dropdown options excluded.' if ws.title == 'Template options' else 'Summary sheet used for budget total checks; its totals are not inventory items.')
                    continue
                layout["status"] = "needs_mapping"
                layout["warnings"].append('Several columns have the same meaning. Choose which columns belong to this budget.' if ambiguous else
                    'Choose the item name and either quantity with unit cost, or a line amount, then update the preview.')
                continue
            if not override and any(idx < header_idx and any(
                    _number(_cell(row, info['columns'].get(field))) is not None
                    for row in rows[info['end'] + 1:header_idx] for field in ('qty', 'unit_cost', 'amount'))
                    for idx, info in headers.items()):
                layout['status'] = 'needs_mapping'
                layout['warnings'].append('An earlier table has incomplete column headings. Map that table before importing so its costs are not omitted.')
            if guessed_unit and not override:
                layout["warnings"].append("The header omits Unit. Unit and rate columns were detected from the data; please verify the mapping.")
            building_type, _ = infer_building_type(ws.title)
            budget_number, _ = infer_budget_number(ws.title)
            shared = _sheet_fields(rows[:max(header_idx, 0)])
            building_type = _building_field(shared.get('building_type') or building_type)
            if shared.get('budget_no') is not None:
                budget_number = _budget_field(shared['budget_no'])
            current_section, section_matched = canonical_section(shared.get('section', ''))
            current_grp, current_category = "", ""
            explicit_group = False
            current_mapping = mapping
            table_category = ''
            grouped = {}
            skipped_rows = 0
            explicit_metadata = bool({"building_type", "budget_no", "section"} & set(mapping))
            for row_idx, row in enumerate(rows):
                if not any(c is not None and str(c).strip() for c in row):
                    continue
                if row_idx < header_idx and any(HEADER_ALIASES.get(_norm(c)) in SHEET_FIELDS for c in row):
                    continue
                if header_idx <= row_idx <= header_end:
                    if row_idx != header_idx:
                        continue
                    if _norm(_cell(row, mapping.get('name'))) in ('labour', 'labor'):
                        current_grp, current_category = 'Labour', 'Labour'
                    elif _norm(_cell(row, mapping.get('name'))) in ('materials', 'material'):
                        table_category = 'Materials'
                    continue
                if any(start < row_idx <= info['end'] for start, info in headers.items()):
                    continue
                if row_idx > header_idx and (row_idx in headers or tuple(row) == tuple(header)):
                    if not override or tuple(row) != tuple(rows[header_idx]) and row_idx in headers:
                        info = headers.get(row_idx, {'columns': _header_columns(row), 'end': row_idx, 'header': row, 'duplicates': set()})
                        next_mapping = {key: value for key, value in info['columns'].items() if key not in info['duplicates']}
                        current_mapping, _ = _legacy_missing_unit_header(next_mapping, rows, info['end'])
                        next_header = next((idx for idx in headers if idx > info['end']), len(rows))
                        current_mapping, _ = _unnamed_unit_column(current_mapping, rows, info['header'], info['end'], next_header)
                        if not _complete_mapping(current_mapping):
                            layout['warnings'].append(f'Row {row_idx + 1}: a later table header is missing a required column. Correct its values in the item preview.')
                    if _norm(_cell(row, current_mapping.get('name'))) in ('labour', 'labor'):
                        if current_category != 'Labour':
                            explicit_group = False
                        current_grp, current_category = 'Labour', 'Labour'
                    elif _norm(_cell(row, current_mapping.get('name'))) in ('materials', 'material'):
                        table_category = 'Materials'
                        if current_category == 'Labour' and not explicit_group:
                            current_grp, current_category = '', ''
                    continue
                def col(key):
                    column = current_mapping.get(key)
                    value = merged_cell(row_idx, column) if key in SHEET_FIELDS | {'grp', 'category', 'unit'} else _cell(row, column)
                    if key in {'qty', 'unit_cost', 'amount'} and value is None and column is not None:
                        value = calculate(f'{get_column_letter(column + 1)}{row_idx + 1}')
                    return value
                name = str(col("name") or "").strip()
                qty, cost = _number(col('qty')), _number(col('unit_cost'))
                amount = _number(col('amount'))
                text_cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
                marker = next((text for text in text_cells if group_to_grp_category(text)), None)
                section_marker = next((text for text in text_cells if _norm(text) in _SECTION_CANON), None)
                no_values = qty is None and cost is None and amount is None
                updated = _sheet_fields([row]) if amount is None and (qty is None or cost is None) else {}
                if updated:
                    shared.update(updated)
                    building_type = _building_field(shared.get('building_type') or building_type)
                    budget_number = _budget_field(shared['budget_no']) if 'budget_no' in shared else budget_number
                    current_section, section_matched = canonical_section(shared.get('section', current_section))
                    continue
                if not explicit_metadata and no_values and (marker or section_marker):
                    if marker:
                        grp, category = group_to_grp_category(marker)
                        explicit_group = True
                        # A combined cost heading should retain its trade heading.
                        if category == 'Material/Labour' and current_grp in ('Mechanical', 'Electrical', 'Plumbings'):
                            current_category = category
                        else:
                            current_grp, current_category = grp, category
                    if section_marker:
                        current_section, section_matched = canonical_section(section_marker)
                    continue
                # Lone headings are the section/group markers in block budgets.
                if not explicit_metadata and len(text_cells) == 1 and (
                        row_idx < header_idx or not name or group_to_grp_category(text_cells[0])):
                    text = text_cells[0]
                    if re.search(r"\b(total|totals|summary|budget)\b", text, re.I) or not _norm(text):
                        continue
                    hit = group_to_grp_category(text)
                    if hit:
                        current_grp, current_category = hit
                        explicit_group = True
                    elif _number(text) is None:
                        current_section, section_matched = canonical_section(text)
                    else:
                        skipped_rows += 1
                        layout['warnings'].append(f'Row {row_idx + 1} skipped: item name is empty.')
                    continue
                if row_idx < header_idx:
                    continue
                amount_formula = str(_cell(formula_rows[row_idx], current_mapping.get('amount')) or '')
                amount_col = get_column_letter(current_mapping['amount'] + 1) if 'amount' in current_mapping else ''
                # A named rollup can have any caption. Follow amount references,
                # rather than converting a subtotal into an amount-only item.
                if qty is None and cost is None and amount_col and re.search(rf'\b\$?{amount_col}\$?\d+', amount_formula, re.I):
                    continue
                label = name or str(_cell(row, 0) or "")
                # Ignore named totals, rather than substring-matching ordinary names.
                total_label = re.fullmatch(r"(?:grand\s+total|sub\s*total|totals?(?:\s+(?:materials?|labou?r|cost|amount))?|budget\s+summary|summary)[:;.]?", label, re.I)
                rollup = re.match(r'^(?:grand\s+total\b|total(?:\s|/|\()|summary\b|for\s+\d+\s+(?:blocks?|units?)\b)', label, re.I)
                if total_label or (rollup and qty is None):
                    continue
                if not name:
                    if qty is None and cost is None and amount in (None, 0) and all(
                            _cell(formula_rows[row_idx], current_mapping.get(key)) in (None, '') for key in ('qty', 'unit_cost')) and (
                            amount == 0 or _cell(formula_rows[row_idx], current_mapping.get('amount')) in (None, '')):
                        continue
                warnings, errors = [], []
                if not name:
                    errors.append('Item name is missing. Enter it before importing this source row.')
                for key in ('qty', 'unit_cost', 'amount'):
                    raw = _cell(formula_rows[row_idx], current_mapping.get(key))
                    if isinstance(raw, str) and raw.startswith('=') and _cell(row, current_mapping.get(key)) is None and col(key) is not None:
                        warnings.append(f'{key.replace("_", " ").capitalize()} calculated from a supported Excel formula; verify the result.')
                excluded = False
                unreadable = any(_cell(formula_rows[row_idx], current_mapping.get(key)) not in (None, '') and _number(col(key)) is None
                                 for key in ('qty', 'unit_cost'))
                if not unreadable and amount is not None and amount > 0 and qty is None and cost is None:
                    qty, cost = 1.0, amount
                    warnings.append('Amount-only cost: quantity 1 and unit cost equal to the saved amount. Verify this allowance.')
                elif not unreadable and qty is not None and qty > 0 and cost is None and amount is not None:
                    cost = amount / qty
                    warnings.append('Unit cost calculated from the saved amount divided by quantity. Verify this rate.')
                elif not unreadable and qty is None and cost is not None and cost > 0 and amount is not None and amount > 0:
                    qty = amount / cost
                    warnings.append('Quantity calculated from the saved amount divided by unit cost. Verify this quantity.')
                if not unreadable and (qty is None or cost is None) and (amount == 0 or amount is None and (qty is None or qty == 0)):
                    excluded = True
                    warnings.append('Unpriced or unused line excluded. Enter its quantity and cost to include it.')
                if 'amount' in current_mapping and qty is not None and cost is not None and qty * cost > 0 and amount == 0:
                    excluded = True
                    warnings.append('Excluded: the source amount is zero despite a priced quantity. Verify whether this line belongs in the budget.')
                if 'amount' in current_mapping and qty is not None and cost is not None and amount is not None and abs(qty * cost - amount) > .01:
                    warnings.append('Source line amount differs from quantity × unit cost. Verify these values before confirming the budget.')
                for key, value, label in [("qty", qty, "Quantity"), ("unit_cost", cost, "Unit cost")]:
                    if value is None:
                        formula = _cell(formula_rows[row_idx], current_mapping.get(key))
                        if isinstance(formula, str) and formula.startswith("=") and col(key) is None:
                            errors.append(f"{label}: formula has no saved result. Open and save the workbook in Excel, or enter the value here.")
                        else:
                            errors.append(f"{label}: missing or unreadable value ({_display(col(key)) or 'blank'}). Enter a non-negative number or exclude this row.")
                grp_text = str(col("grp") or "").strip()
                hit = group_to_grp_category(grp_text) if grp_text else None
                if grp_text:
                    grp, category = hit or (grp_text, "")
                elif current_grp:
                    grp, category = current_grp, current_category
                    if grp == 'General Materials' and category in ('Materials', 'Material/Labour'):
                        inferred = infer_group_from_name(name)
                        if inferred and inferred[1] == 'Materials' and inferred[0] != grp:
                            grp = inferred[0]
                            warnings.append('Trade group inferred from the item name under the materials heading; please verify.')
                else:
                    inferred = infer_group_from_name(name)
                    grp, category = inferred or (('General Materials', table_category) if table_category == 'Materials' else ('', ''))
                    warnings.append("Group inferred from item name; please verify." if inferred else "General Materials selected from the table heading. Verify the trade group." if grp else "Group could not be detected; please select it.")
                category = _category_field(col("category") or category)
                if not category and grp:
                    category = "Labour" if grp == "Labour" else "Materials"
                section_text = str(col("section") or "").strip()
                section, matched = canonical_section(section_text) if section_text else (current_section, section_matched)
                if not matched and section:
                    warnings.append("Section did not match a known section.")
                bt = _building_field(col("building_type") or building_type)
                bn = _budget_field(col('budget_no')) if col("budget_no") is not None else budget_number
                scope = str(col('budget_scope') or shared.get('budget_scope') or (ws.title if not explicit_metadata else '')).strip()
                key = (bt, bn, scope)
                if key not in grouped:
                    grouped[key] = ParsedSheet(
                        sheet_name=f"{ws.title} — {bt or '?'} — Budget {bn or '?'}" + (f" — {scope}" if scope else ''),
                        building_type=bt, building_type_confident=bt in {b for b in PROPERTY_TYPES if b},
                        budget_number=bn, budget_confident=bn is not None,
                        budget_scope=scope,
                    )
                grouped[key].items.append(ParsedItem(
                    name=name, qty=qty, unit=str(col("unit") or "").strip(), unit_cost=cost,
                    category=category, grp=grp, section=section, section_matched=matched,
                    budget=_budget_string(bt, bn, grp), sheet_name=ws.title, row_number=row_idx + 1,
                    warnings=warnings, errors=errors,
                    source_amount=amount, amount_cell=f"{get_column_letter(current_mapping['amount'] + 1)}{row_idx + 1}" if 'amount' in current_mapping else '',
                    source_amount_missing='amount' in current_mapping and _number(_cell(formula_rows[row_idx], current_mapping['amount'])) is None
                        and not str(_cell(formula_rows[row_idx], current_mapping['amount']) or '').startswith('='),
                    excluded_by_default=excluded,
                ))
            for sheet in grouped.values():
                if len(grouped) == 1:
                    if not explicit_metadata:
                        sheet.sheet_name = ws.title
                    apply_sheet_control(sheet, ws, formula_wb[ws.title], controls.get(ws.title), calculate)
                else:
                    sheet.warnings.append('This table contains multiple budgets. Confirm the total for each budget before import.')
                    sheet.requires_confirmation = True
            result.sheets.extend(grouped.values())
            if not grouped:
                layout["status"] = "needs_mapping"
                layout["warnings"].append("No item rows were found below the selected header. Check the header row and column mapping, or exclude this sheet.")
            if skipped_rows > 20:
                layout["warnings"] = layout["warnings"][:20] + [f"{skipped_rows} rows with missing names were skipped in total."]
        return result
    finally:
        wb.close()
        formula_wb.close()
