"""Generate the standardized Istrom budget import template (.xlsx).

The template is a single flat "Items" sheet — one row per line item — with
data-validation dropdowns on every constrained field (building type, budget
number, section, group, category). Because every field is chosen from a valid
list, files authored in this template import with zero ambiguity (no inference,
no manual correction). A hidden "Lists" sheet backs the dropdowns and an
"Instructions" sheet explains usage.
"""
from __future__ import annotations

import io
from typing import List

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from constants import (
    BUDGET_CATEGORIES,
    CATEGORY_OPTIONS,
    CONSTRUCTION_SECTIONS,
    PROPERTY_TYPES,
)

# Column order of the flat template. Header text is human-friendly; the parser
# matches these (and common aliases) case-insensitively.
TEMPLATE_HEADERS = [
    "Building Type",
    "Budget No",
    "Section",
    "Group",
    "Category",
    "Item Name",
    "Unit",
    "Qty",
    "Unit Cost",
]

_DATA_ROWS = 500  # how many rows the dropdowns cover


def _building_types() -> List[str]:
    return [b for b in PROPERTY_TYPES if b]


def build_import_template() -> bytes:
    wb = Workbook()

    items = wb.active
    items.title = "Items"

    lists = wb.create_sheet("Lists")
    instructions = wb.create_sheet("Instructions")

    # --- Lists sheet (dropdown sources) ---
    columns = {
        "A": _building_types(),
        "B": [str(n) for n in range(1, 21)],
        "C": list(CATEGORY_OPTIONS),
        "D": list(BUDGET_CATEGORIES),
        "E": list(CONSTRUCTION_SECTIONS),
    }
    headers = {"A": "BuildingTypes", "B": "BudgetNos", "C": "Categories", "D": "Groups", "E": "Sections"}
    for col, head in headers.items():
        lists[f"{col}1"] = head
        lists[f"{col}1"].font = Font(bold=True)
    for col, values in columns.items():
        for i, v in enumerate(values, start=2):
            lists[f"{col}{i}"] = v
    lists.sheet_state = "hidden"

    def _range(col: str, count: int) -> str:
        return f"Lists!${col}$2:${col}${count + 1}"

    # --- Items sheet header ---
    header_fill = PatternFill("solid", fgColor="1F2A36")
    header_font = Font(bold=True, color="FFFFFF")
    for idx, name in enumerate(TEMPLATE_HEADERS, start=1):
        cell = items.cell(row=1, column=idx, value=name)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")
    widths = [16, 10, 46, 18, 16, 34, 10, 8, 14]
    for idx, w in enumerate(widths, start=1):
        items.column_dimensions[get_column_letter(idx)].width = w
    items.freeze_panes = "A2"

    # --- Dropdowns (column -> Lists range) ---
    dropdowns = {
        1: _range("A", len(columns["A"])),   # Building Type
        2: _range("B", len(columns["B"])),    # Budget No
        3: _range("E", len(columns["E"])),    # Section
        4: _range("D", len(columns["D"])),    # Group
        5: _range("C", len(columns["C"])),    # Category
    }
    for col_idx, formula in dropdowns.items():
        dv = DataValidation(type="list", formula1=f"={formula}", allow_blank=True)
        dv.error = "Pick a value from the dropdown list."
        dv.errorTitle = "Invalid value"
        col = get_column_letter(col_idx)
        dv.add(f"{col}2:{col}{_DATA_ROWS + 1}")
        items.add_data_validation(dv)

    # --- Example rows ---
    examples = [
        ["Flats", 1, CONSTRUCTION_SECTIONS[0], "General Materials", "Materials", "Cement (50kg)", "bags", 803, 9400],
        ["Flats", 1, CONSTRUCTION_SECTIONS[0], "Irons", "Materials", "Y16mm reinforcement", "length", 42, 22000],
        ["Terraces", 2, CONSTRUCTION_SECTIONS[0], "Labour", "Labour", "Masonry (per day)", "day", 24, 15000],
    ]
    for r, row in enumerate(examples, start=2):
        for c, val in enumerate(row, start=1):
            items.cell(row=r, column=c, value=val)

    # --- Instructions ---
    lines = [
        "Istrom budget import template",
        "",
        "1. Enter ONE line item per row on the 'Items' sheet.",
        "2. Building Type, Budget No, Section, Group and Category MUST be chosen",
        "   from the dropdown in each cell — do not type free text in those columns.",
        "3. Item Name, Unit, Qty and Unit Cost are free text / numbers.",
        "4. Leave Qty or Unit Cost as 0 for placeholder/catalogue rows.",
        "5. The three example rows can be overwritten or deleted.",
        "6. Save as .xlsx and upload via Inventory > Import Workbook.",
        "",
        "Budget is built automatically as 'Budget {No} - {Building Type}({Group})',",
        "matching items added through Manual Entry.",
    ]
    for i, line in enumerate(lines, start=1):
        cell = instructions.cell(row=i, column=1, value=line)
        if i == 1:
            cell.font = Font(bold=True, size=14)
    instructions.column_dimensions["A"].width = 80

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
