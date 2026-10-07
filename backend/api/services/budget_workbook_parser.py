"""Parse Istrom multi-sheet budget workbooks into structured item previews.

Pure and DB-free: bytes in, dataclasses out. No validation against the database,
no writes.
"""
from __future__ import annotations

import difflib
import hashlib
import io
import math
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from openpyxl import load_workbook
from api.services.workbook_security import validate_workbook_archive
from api.services.workbook_totals import summary_controls, apply_sheet_control
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
    (re.compile(r"\bY\s?\d{1,2}\s?MM\b|\bBRC\b|BINDING\s*WIRE|\bB\s*/?\s*WIRE\b|REBAR|\bRODS?\b"),
     ("Irons", "Materials")),
    (re.compile(r"PLANK|PLYWOOD|MARINE\s*BOARD|TIMBER|\bWOODS?\b|\b2\s*X\s*[234]\b|\b1\s*X\s*12\b"),
     ("Woods", "Materials")),
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
}


def _cell(row, idx):
    return row[idx] if idx is not None and idx < len(row) else None


def _header_columns(row):
    mapping = {}
    for idx, cell in enumerate(row):
        # Currency suffixes are common in headings (e.g. Rate (₦)).
        key = _norm(re.sub(r"[₦$£€]", "", str(cell or "")))
        key = re.sub(r"_(ngn|naira)$", "", key)
        mapped = HEADER_ALIASES.get(key)
        if mapped and mapped not in mapping:
            mapping[mapped] = idx
    return mapping


def _is_header(row):
    mapping = _header_columns(row)
    return "name" in mapping and bool({"qty", "unit_cost"} & set(mapping))


SHEET_FIELDS = {"building_type", "budget_no", "budget_scope", "section"}


def _sheet_fields(rows):
    """Read shared label/value fields above the item tables."""
    fields = {}
    for row in rows:
        for index, label in enumerate(row[:-1]):
            key = HEADER_ALIASES.get(_norm(label))
            value = _cell(row, index + 1)
            if key in SHEET_FIELDS and value is not None and str(value).strip():
                if HEADER_ALIASES.get(_norm(value)) not in SHEET_FIELDS:
                    fields[key] = value
    return fields


def _budget_string(building_type, budget_number, grp):
    if not building_type or budget_number is None or not grp:
        return ""
    return f"Budget {budget_number} - {building_type}({grp})"


def _number(value):
    """Read a number without discarding arbitrary letters or inventing zeroes."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        text = re.sub(r"^[₦$£€]\s*", "", text)
        if re.fullmatch(r"[+-]?\d{1,3}(,\d{3})+(\.\d+)?", text):
            text = text.replace(",", "")
        if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text):
            return None
        number = float(text)
    return number if math.isfinite(number) and number >= 0 else None


def _legacy_missing_unit_header(mapping, rows, header_index):
    """Handle older budgets whose header omits UNIT but data still contains it."""
    if mapping.get("name") != 1 or mapping.get("qty") != 2 or mapping.get("unit_cost") not in (3, 4) or "unit" in mapping:
        return mapping, False
    samples = [r for r in rows[header_index + 1:header_index + 61]
               if _number(_cell(r, 2)) is not None and _cell(r, 1) and _number(_cell(r, 0)) is not None]
    unit_samples = [r for r in samples if str(_cell(r, 3) or '').strip()]
    if unit_samples and all(_number(_cell(r, 3)) is None and _number(_cell(r, 4)) is not None for r in unit_samples):
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
        for ws in wb.worksheets:
            if (ws.max_row or 0) > MAX_SHEET_ROWS or (ws.max_column or 0) > MAX_SHEET_COLUMNS:
                raise ValueError(f"{ws.title}: maximum supported size is {MAX_SHEET_ROWS} rows and {MAX_SHEET_COLUMNS} columns. Remove unused rows or columns and try again.")
            rows = _bounded_sheet_rows(ws)
            formula_rows = _bounded_sheet_rows(formula_wb[ws.title])
            cell_count += sum(len(row) for row in rows)
            if cell_count > 2000000:
                raise ValueError("Workbook has too many cells. Split it into smaller workbooks.")
            override = mappings.get(ws.title, {})
            header_idx = next((idx for idx, row in enumerate(rows) if _is_header(row)), None)
            mapping = _header_columns(rows[header_idx]) if header_idx is not None else {}
            guessed_unit = False
            if header_idx is not None:
                mapping, guessed_unit = _legacy_missing_unit_header(mapping, rows, header_idx)
            if override and not override.get("skip"):
                header_idx = override["header_row"] - 1
                if header_idx >= len(rows):
                    raise ValueError(f"{ws.title}: selected header row does not exist.")
                mapping = override["columns"]
                if any(idx >= max((len(row) for row in rows), default=0) for idx in mapping.values()):
                    raise ValueError(f"{ws.title}: selected column does not exist.")
            header = rows[header_idx] if header_idx is not None and header_idx >= 0 else []
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
            if header_idx is None or not REQUIRED_COLUMNS <= set(mapping):
                if not override and (re.search(r'\bsummary\b', ws.title, re.I) or ws.title == 'Template options'):
                    layout['status'] = 'skipped'
                    layout['warnings'].append('Template dropdown options excluded.' if ws.title == 'Template options' else 'Summary sheet used for budget total checks; its totals are not inventory items.')
                    continue
                layout["status"] = "needs_mapping"
                layout["warnings"].append("Choose the header row and columns for item name, quantity, and unit cost, then update the preview.")
                continue
            if guessed_unit and not override:
                layout["warnings"].append("The header omits Unit. Unit and rate columns were detected from the data; please verify the mapping.")
            building_type, _ = infer_building_type(ws.title)
            budget_number, _ = infer_budget_number(ws.title)
            shared = _sheet_fields(rows[:max(header_idx, 0)])
            building_type = str(shared.get('building_type') or building_type).strip()
            if shared.get('budget_no') is not None:
                budget_number, _ = infer_budget_number(f"Budget {shared['budget_no']}")
            current_section, section_matched = canonical_section(shared.get('section', ''))
            current_grp, current_category = "", ""
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
                if row_idx == header_idx:
                    if _norm(_cell(row, mapping.get('name'))) in ('labour', 'labor'):
                        current_grp, current_category = 'Labour', 'Labour'
                    elif _norm(_cell(row, mapping.get('name'))) in ('materials', 'material'):
                        table_category = 'Materials'
                    continue
                if row_idx > header_idx and (_is_header(row) or tuple(row) == tuple(header)):
                    if not override:
                        next_mapping = _header_columns(row)
                        current_mapping, _ = _legacy_missing_unit_header(next_mapping, rows, row_idx)
                        if not REQUIRED_COLUMNS <= set(current_mapping):
                            layout['warnings'].append(f'Row {row_idx + 1}: a later table header is missing a required column. Correct its values in the item preview.')
                    if _norm(_cell(row, current_mapping.get('name'))) in ('labour', 'labor'):
                        current_grp, current_category = 'Labour', 'Labour'
                    elif _norm(_cell(row, current_mapping.get('name'))) in ('materials', 'material'):
                        table_category = 'Materials'
                    continue
                def col(key):
                    return _cell(row, current_mapping.get(key))
                name = str(col("name") or "").strip()
                qty, cost = _number(col('qty')), _number(col('unit_cost'))
                amount = _number(col('amount'))
                text_cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
                marker = next((text for text in text_cells if group_to_grp_category(text)), None)
                section_marker = next((text for text in text_cells if _norm(text) in _SECTION_CANON), None)
                no_values = qty is None and cost is None and amount is None
                if not explicit_metadata and no_values and (marker or section_marker):
                    if marker:
                        grp, category = group_to_grp_category(marker)
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
                    if qty is None and cost is None and amount in (None, 0):
                        continue
                    skipped_rows += 1
                    layout["warnings"].append(f"Row {row_idx + 1} skipped: item name is empty.")
                    continue
                warnings, errors = [], []
                excluded = False
                if amount is not None and amount > 0 and qty is None and cost is None:
                    qty, cost = 1.0, amount
                    warnings.append('Amount-only cost: quantity 1 and unit cost equal to the saved amount. Verify this allowance.')
                elif qty is not None and qty > 0 and cost is None and amount is not None:
                    cost = amount / qty
                    warnings.append('Unit cost calculated from the saved amount divided by quantity. Verify this rate.')
                elif qty is None and cost is not None and cost > 0 and amount is not None and amount > 0:
                    qty = amount / cost
                    warnings.append('Quantity calculated from the saved amount divided by unit cost. Verify this quantity.')
                if (qty is None or cost is None) and (amount == 0 or amount is None and (qty is None or qty == 0)):
                    excluded = True
                    warnings.append('Unpriced or unused line excluded. Enter its quantity and cost to include it.')
                if 'amount' in current_mapping and qty is not None and cost is not None and qty * cost > 0 and amount in (None, 0):
                    excluded = True
                    warnings.append('Excluded: the source amount is blank or zero despite a priced quantity. Verify whether this line belongs in the budget.')
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
                else:
                    inferred = infer_group_from_name(name)
                    grp, category = inferred or (('General Materials', table_category) if table_category == 'Materials' else ('', ''))
                    warnings.append("Group inferred from item name; please verify." if inferred else "General Materials selected from the table heading. Verify the trade group." if grp else "Group could not be detected; please select it.")
                category = str(col("category") or category).strip()
                if not category and grp:
                    category = "Labour" if grp == "Labour" else "Materials"
                section_text = str(col("section") or "").strip()
                section, matched = canonical_section(section_text) if section_text else (current_section, section_matched)
                if not matched and section:
                    warnings.append("Section did not match a known section.")
                bt = str(col("building_type") or building_type).strip()
                bn = infer_budget_number(f"Budget {col('budget_no')}")[0] if col("budget_no") is not None else budget_number
                scope = str(col('budget_scope') or shared.get('budget_scope') or (ws.title if not explicit_metadata else '')).strip()
                key = (bt, bn, scope)
                if key not in grouped:
                    grouped[key] = ParsedSheet(
                        sheet_name=f"{ws.title} — {bt or '?'} — Budget {bn or '?'}" if explicit_metadata else ws.title,
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
                    excluded_by_default=excluded,
                ))
            for sheet in grouped.values():
                if len(grouped) == 1:
                    apply_sheet_control(sheet, ws, formula_wb[ws.title], controls.get(ws.title))
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
