"""Parse Istrom multi-sheet budget workbooks into structured item previews.

Pure and DB-free: bytes in, dataclasses out. No validation against the database,
no writes.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from openpyxl import load_workbook

from constants import CONSTRUCTION_SECTIONS

SKIP_SHEETS = {"summary page", "sheet1", "sheet2"}


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
}

_SECTION_CANON = {_norm(s): s for s in CONSTRUCTION_SECTIONS}


def group_to_grp_category(text) -> Optional[Tuple[str, str]]:
    return GROUP_MAP.get(_norm(text))


def canonical_section(text) -> Tuple[str, bool]:
    raw = str(text or "").strip()
    hit = _SECTION_CANON.get(_norm(raw))
    if hit:
        return (hit, True)
    return (raw, False)


@dataclass
class ParsedItem:
    name: str
    qty: float
    unit: str
    unit_cost: float
    category: str
    grp: str
    section: str
    section_matched: bool
    budget: str
    sheet_name: str
    row_number: int
    warnings: List[str] = field(default_factory=list)


@dataclass
class ParsedSheet:
    sheet_name: str
    building_type: str
    building_type_confident: bool
    budget_number: Optional[int]
    budget_confident: bool
    items: List[ParsedItem] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class ParsedWorkbook:
    sheets: List[ParsedSheet] = field(default_factory=list)


def _cell(row, idx):
    return row[idx] if idx < len(row) else None


def _to_number(value) -> float:
    if value is None or str(value).strip() == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = re.sub(r"[^0-9.\-]", "", str(value))
    if text in ("", "-", "."):
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


# The item-name column is headed differently across budgets: "MATERIALS" in
# budgets 1-4, "DESCRITION"/"DESCRIPTION" (sic) in budgets 5-7.
_NAME_HEADER_TOKENS = {
    "materials", "material", "description", "descriptions",
    "descrition", "descritions", "item", "items", "particulars",
}


def _is_table_header(row) -> bool:
    cells = {_norm(c) for c in row if c is not None}
    return bool(cells & _NAME_HEADER_TOKENS) and bool(cells & {"qty", "rate", "amount"})


def _budget_string(building_type, budget_number, grp) -> str:
    if not building_type or budget_number is None or not grp:
        return ""
    return f"Budget {budget_number} - {building_type}({grp})"


def parse_budget_workbook(content: bytes) -> ParsedWorkbook:
    wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    result = ParsedWorkbook()

    for ws in wb.worksheets:
        if _norm(ws.title) in {_norm(s) for s in SKIP_SHEETS}:
            continue

        building_type, bt_conf = infer_building_type(ws.title)
        budget_number, bn_conf = infer_budget_number(ws.title)
        sheet = ParsedSheet(
            sheet_name=ws.title,
            building_type=building_type,
            building_type_confident=bt_conf,
            budget_number=budget_number,
            budget_confident=bn_conf,
        )

        current_section = ""
        section_matched = False
        current_grp = ""
        current_category = ""
        seen_table = False

        for row_idx, raw in enumerate(ws.iter_rows(values_only=True), start=1):
            row = list(raw or [])
            if all((c is None or str(c).strip() == "") for c in row):
                continue
            if _is_table_header(row):
                seen_table = True
                continue

            a = _cell(row, 0)
            b = _cell(row, 1)
            b_text = str(b).strip() if b is not None else ""
            a_text = str(a).strip() if a is not None else ""

            # Group sub-header: text in col B that maps to a group, no numeric cols.
            grp_hit = group_to_grp_category(b_text) if b_text else None
            if grp_hit and _to_number(_cell(row, 4)) == 0:
                current_grp, current_category = grp_hit
                continue

            # Also check col A for group sub-headers (e.g. "IRONS", "LABOUR" alone in col A)
            if not b_text and a_text:
                a_grp_hit = group_to_grp_category(a_text)
                if a_grp_hit and _to_number(_cell(row, 4)) == 0:
                    current_grp, current_category = a_grp_hit
                    continue

            # Totals / summary rows (checked before section so a "TOTAL" line in
            # col A is never mistaken for a section header).
            if "total" in _norm(b_text) or "total" in _norm(a_text):
                continue

            # Section header: a lone, non-numeric text cell in col A with empty
            # col B. Tracked anywhere in the sheet — a single sheet holds several
            # sections, each with its own table — so this must not be gated on
            # whether a table has already appeared. Numeric-only col A (an S/N) is
            # not a section.
            if a_text and not b_text and not re.match(r"^\d+$", a_text):
                sec_value, sec_matched = canonical_section(a_text)
                current_section, section_matched = sec_value, sec_matched
                continue

            # Item row: needs a name in col B and we are inside a table.
            if not seen_table or not b_text:
                continue

            warnings: List[str] = []
            if not current_grp:
                warnings.append("No group header above this row; group is unset.")
                grp, category = "", ""
            else:
                grp, category = current_grp, current_category
            if not section_matched and current_section:
                warnings.append("Section did not match a known section.")

            item = ParsedItem(
                name=b_text,
                qty=_to_number(_cell(row, 2)),
                unit=str(_cell(row, 3) or "").strip(),
                unit_cost=_to_number(_cell(row, 4)),
                category=category,
                grp=grp,
                section=current_section,
                section_matched=section_matched,
                budget=_budget_string(building_type, budget_number, grp),
                sheet_name=ws.title,
                row_number=row_idx,
                warnings=warnings,
            )
            sheet.items.append(item)

        if sheet.items:
            result.sheets.append(sheet)

    return result
