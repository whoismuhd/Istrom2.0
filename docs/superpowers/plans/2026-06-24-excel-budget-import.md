# Excel Budget-Workbook Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload an Istrom budget `.xlsx`, preview/confirm what it will create, and import items that are identical to Manual Entry items.

**Architecture:** A pure, DB-free parser service turns the multi-sheet workbook into structured per-sheet item previews. A `/bulk-upload/analyze` endpoint returns that preview (no writes); a rebuilt `/bulk-upload/commit` endpoint re-validates the admin-confirmed rows and inserts them like `create_item` in one transaction. A 3-step React wizard drives setup → review → confirm.

**Tech Stack:** FastAPI, SQLAlchemy, openpyxl (backend); React + TanStack Query (frontend); pytest + httpx (tests).

**Spec:** `docs/superpowers/specs/2026-06-24-excel-budget-import-design.md`

**Conventions for every backend test command:** run from the `backend/` directory using the repo venv:
```bash
cd backend && ../.venv/bin/python -m pytest <args>
```

---

## File Structure

**Create:**
- `backend/api/services/budget_workbook_parser.py` — pure parser (sheet-name inference, section/group tracking, row classification, item extraction).
- `backend/tests/conftest.py` — pytest fixtures: temp SQLite DB, `TestClient`, admin-auth override, openpyxl workbook builder.
- `backend/tests/test_budget_workbook_parser.py` — parser unit tests.
- `backend/tests/test_bulk_import_endpoints.py` — analyze + commit endpoint tests.
- `backend/requirements-dev.txt` — pytest + httpx.

**Modify:**
- `backend/api/schemas.py` — add workbook-preview schemas; extend `BulkUploadCommitIn`.
- `backend/api/routes/bulk_upload.py` — add `/analyze`; replace the disabled `/commit`.
- `frontend/src/api.js` — add `bulkUpload.analyze`.
- `frontend/src/pages/BulkUpload.jsx` — rebuild as the 3-step import wizard.
- `frontend/src/pages/BulkUpload.css` — wizard styles.
- `frontend/src/App.jsx` — re-enable the `bulk-upload` route + import.
- `frontend/src/components/Layout.jsx` — add the nav link.

**Frontend testing note:** the project has no JS test harness, and adding one (Vitest) is out of scope. Frontend tasks are build + **manual verification in the running app** via screenshots. Backend is strict TDD.

---

## Task 0: Test infrastructure + feature branch

**Files:**
- Create: `backend/requirements-dev.txt`, `backend/tests/conftest.py`, `backend/tests/__init__.py`

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/mohammed/Desktop/Istrom2.0
git checkout -b feature/excel-budget-import
```

- [ ] **Step 2: Add dev requirements and install**

Create `backend/requirements-dev.txt`:
```
pytest==8.3.4
httpx==0.27.2
```

Run:
```bash
.venv/bin/python -m pip install -r backend/requirements-dev.txt -q
```
Expected: installs without error.

- [ ] **Step 3: Create the test package + conftest**

Create `backend/tests/__init__.py` (empty).

Create `backend/tests/conftest.py`:
```python
"""Pytest fixtures: temp DB, TestClient, admin auth override, workbook builder."""
import io
import os
import sys

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# backend/ must be importable as top-level (matches how the app runs).
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import db as db_module  # noqa: E402
from db import Base, get_db  # noqa: E402
import models  # noqa: E402  (registers tables on Base)


@pytest.fixture()
def test_db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


@pytest.fixture()
def admin_user():
    return {
        "username": "admin",
        "full_name": "Administrator",
        "user_type": "admin",
        "project_site": None,
        "is_global_admin": True,
    }


@pytest.fixture()
def client(test_db, admin_user):
    from api.main import app
    from api.dependencies import get_current_user, get_current_admin

    app.dependency_overrides[get_db] = lambda: iter([test_db])
    app.dependency_overrides[get_current_user] = lambda: admin_user
    app.dependency_overrides[get_current_admin] = lambda: admin_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def build_workbook(sheets):
    """sheets: list of (sheet_name, rows) where rows is a list of lists (cells)."""
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

- [ ] **Step 4: Sanity test that infra loads**

Create `backend/tests/test_smoke.py`:
```python
def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
```

Run:
```bash
cd backend && ../.venv/bin/python -m pytest tests/test_smoke.py -v
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/requirements-dev.txt backend/tests/
git commit -m "test: bootstrap pytest infra (temp DB, TestClient, admin override)"
```

---

## Task 1: Parser — sheet-name inference

**Files:**
- Create: `backend/api/services/budget_workbook_parser.py`
- Test: `backend/tests/test_budget_workbook_parser.py`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_budget_workbook_parser.py`:
```python
import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from api.services.budget_workbook_parser import (
    infer_building_type,
    infer_budget_number,
)


def test_building_type_inference():
    assert infer_building_type("FLATS BGT 1") == ("Flats", True)
    assert infer_building_type("FLATS BGT 1 RAFT") == ("Flats", True)
    assert infer_building_type("TER. K&L BGT 2") == ("Terraces", True)
    assert infer_building_type("TERRACES BGT 1") == ("Terraces", True)
    assert infer_building_type("SD 22-25 BGT 1") == ("Semi-detached", True)
    assert infer_building_type("D19-21,27-36 & 43-52BGT 2") == ("Fully-detached", True)
    assert infer_building_type("MYSTERY SHEET") == ("", False)


def test_budget_number_inference():
    assert infer_budget_number("FLATS BGT 1") == (1, True)
    assert infer_budget_number("SD 4,5, SD 19-21 B3") == (3, True)
    assert infer_budget_number("D19-21,27-36 & 43-52BGT 2") == (2, True)
    assert infer_budget_number("SUMMARY PAGE") == (None, False)
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_budget_workbook_parser.py -v
```
Expected: FAIL (ModuleNotFoundError / ImportError).

- [ ] **Step 3: Implement inference**

Create `backend/api/services/budget_workbook_parser.py`:
```python
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
    m = re.search(r"\bB(?:GT|UDGET)?\s*(\d+)", u)
    if m:
        return (int(m.group(1)), True)
    return (None, False)
```

- [ ] **Step 4: Run to verify pass**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_budget_workbook_parser.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/api/services/budget_workbook_parser.py backend/tests/test_budget_workbook_parser.py
git commit -m "feat(parser): infer building type and budget number from sheet name"
```

---

## Task 2: Parser — group + section mapping helpers

**Files:**
- Modify: `backend/api/services/budget_workbook_parser.py`
- Test: `backend/tests/test_budget_workbook_parser.py`

- [ ] **Step 1: Write failing tests** (append)

```python
from api.services.budget_workbook_parser import (
    group_to_grp_category,
    canonical_section,
)


def test_group_mapping():
    assert group_to_grp_category("MATERIAL ONLY") == ("General Materials", "Materials")
    assert group_to_grp_category("MATERIALS") == ("General Materials", "Materials")
    assert group_to_grp_category("WOODS") == ("Woods", "Materials")
    assert group_to_grp_category("IRONS") == ("Irons", "Materials")
    assert group_to_grp_category("PLUMBINGS") == ("Plumbings", "Materials")
    assert group_to_grp_category("LABOUR") == ("Labour", "Labour")
    assert group_to_grp_category("LABOUR ONLY") == ("Labour", "Labour")
    assert group_to_grp_category("TOTAL LABOUR") is None
    assert group_to_grp_category("PEGS") is None


def test_canonical_section_match():
    raw = "SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)"
    value, matched = canonical_section(raw)
    assert matched is True
    assert value == "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)"


def test_canonical_section_no_match():
    value, matched = canonical_section("SOME UNKNOWN STAGE")
    assert matched is False
    assert value == "SOME UNKNOWN STAGE"
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_budget_workbook_parser.py -v
```
Expected: FAIL (ImportError for the new names).

- [ ] **Step 3: Implement helpers** (append to `budget_workbook_parser.py`)

```python
GROUP_MAP = {
    "material": ("General Materials", "Materials"),
    "material_only": ("General Materials", "Materials"),
    "materials": ("General Materials", "Materials"),
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
```

- [ ] **Step 4: Run to verify pass**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_budget_workbook_parser.py -v
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/api/services/budget_workbook_parser.py backend/tests/test_budget_workbook_parser.py
git commit -m "feat(parser): group->grp/category and canonical section helpers"
```

---

## Task 3: Parser — full workbook walk

**Files:**
- Modify: `backend/api/services/budget_workbook_parser.py`
- Test: `backend/tests/test_budget_workbook_parser.py`

- [ ] **Step 1: Write failing tests** (append)

```python
import io
from openpyxl import Workbook
from api.services.budget_workbook_parser import parse_budget_workbook


def _wb(sheets):
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets:
        ws = wb.create_sheet(title=name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _sample_sheet_rows():
    return [
        ["BUDGET  NO. 1"],
        [],
        ["SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)"],
        [],
        ["MATERIAL ONLY"],
        ["S/N", "MATERIALS", "QTY", "UNIT", "RATE", "AMOUNT"],
        [1, "PEGS", None, "pcs", 500, 0],
        [2, "CEMENTS", 803, "bags", 9400, 7548200],
        ["IRONS"],
        [3, "Y16MM", 42, "length", 22000, "AVAILABLE"],
        ["LABOUR"],
        [4, "MASON", 10, "days", 15000, 150000],
        ["TOTAL LABOUR", None, None, None, None, 150000],
    ]


def test_parse_extracts_items_with_mapping():
    content = _wb([("FLATS BGT 1", _sample_sheet_rows())])
    wb = parse_budget_workbook(content)
    assert len(wb.sheets) == 1
    sheet = wb.sheets[0]
    assert sheet.building_type == "Flats"
    assert sheet.budget_number == 1
    names = [i.name for i in sheet.items]
    assert names == ["PEGS", "CEMENTS", "Y16MM", "MASON"]

    pegs = sheet.items[0]
    assert pegs.qty == 0  # blank qty -> 0
    assert pegs.unit == "pcs"
    assert pegs.unit_cost == 500
    assert pegs.category == "Materials"
    assert pegs.grp == "General Materials"
    assert pegs.section == "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)"
    assert pegs.budget == "Budget 1 - Flats(General Materials)"

    y16 = sheet.items[2]
    assert y16.grp == "Irons"
    assert y16.category == "Materials"

    mason = sheet.items[3]
    assert mason.category == "Labour"
    assert mason.grp == "Labour"
    assert mason.budget == "Budget 1 - Flats(Labour)"


def test_parse_skips_non_item_sheets():
    content = _wb([
        ("SUMMARY PAGE", [["whatever"]]),
        ("FLATS BGT 1", _sample_sheet_rows()),
    ])
    wb = parse_budget_workbook(content)
    assert [s.sheet_name for s in wb.sheets] == ["FLATS BGT 1"]
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_budget_workbook_parser.py -v
```
Expected: FAIL (parse_budget_workbook missing).

- [ ] **Step 3: Implement dataclasses + walk** (append to `budget_workbook_parser.py`)

```python
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


def _is_table_header(row) -> bool:
    cells = {_norm(c) for c in row if c is not None}
    return "materials" in cells and bool(cells & {"qty", "rate", "amount"})


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

            # Group sub-header: text in col B that maps to a group, no numeric cols.
            grp_hit = group_to_grp_category(b_text) if b_text else None
            if grp_hit and _to_number(_cell(row, 4)) == 0:
                current_grp, current_category = grp_hit
                continue

            # Section header: a lone text cell (usually col A) and no table columns.
            a_text = str(a).strip() if a is not None else ""
            if a_text and not b_text and not seen_table:
                sec_value, sec_matched = canonical_section(a_text)
                current_section, section_matched = sec_value, sec_matched
                continue

            # Totals / summary rows.
            if "total" in _norm(b_text) or "total" in _norm(a_text):
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
```

- [ ] **Step 4: Run to verify pass**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_budget_workbook_parser.py -v
```
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/api/services/budget_workbook_parser.py backend/tests/test_budget_workbook_parser.py
git commit -m "feat(parser): walk sheets and extract mapped items"
```

---

## Task 4: Preview + commit schemas

**Files:**
- Modify: `backend/api/schemas.py:211-218` (extend `BulkUploadCommitIn`; add preview schemas)
- Test: covered by Task 5/6 endpoint tests.

- [ ] **Step 1: Add schemas** (append near the other bulk-upload schemas in `schemas.py`)

```python
class WorkbookItemPreview(BaseModel):
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
    duplicate: bool = False
    warnings: List[str] = []


class WorkbookSheetPreview(BaseModel):
    sheet_name: str
    building_type: str
    building_type_confident: bool
    budget_number: Optional[int]
    budget_confident: bool
    item_count: int
    warnings: List[str] = []
    items: List[WorkbookItemPreview]


class WorkbookAnalyzeOut(BaseModel):
    file_name: str
    project_site: str
    sheet_count: int
    item_count: int
    duplicate_count: int
    sheets: List[WorkbookSheetPreview]
```

- [ ] **Step 2: Extend `BulkUploadCommitIn`** (replace the existing class at `schemas.py:211-212`)

```python
class BulkUploadCommitIn(BaseModel):
    project_site: str
    skip_existing: bool = True
    rows: List[BulkUploadItemRow]
```

- [ ] **Step 3: Verify import compiles**

```bash
cd backend && ../.venv/bin/python -c "import api.schemas as s; print(s.WorkbookAnalyzeOut.__name__, s.BulkUploadCommitIn.model_fields.keys())"
```
Expected: prints `WorkbookAnalyzeOut dict_keys(['project_site', 'skip_existing', 'rows'])`.

- [ ] **Step 4: Commit**

```bash
git add backend/api/schemas.py
git commit -m "feat(schemas): workbook analyze preview + commit project_site/skip_existing"
```

---

## Task 5: `/bulk-upload/analyze` endpoint

**Files:**
- Modify: `backend/api/routes/bulk_upload.py` (add route + duplicate marking; import parser & schemas)
- Test: `backend/tests/test_bulk_import_endpoints.py`

- [ ] **Step 1: Write failing test**

Create `backend/tests/test_bulk_import_endpoints.py`:
```python
import os
import sys

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


def test_analyze_marks_existing_as_duplicate(client, test_db):
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
    assert body["duplicate_count"] == 1
    assert body["sheets"][0]["items"][0]["duplicate"] is True
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_bulk_import_endpoints.py -v
```
Expected: FAIL (404 on `/bulk-upload/analyze`).

- [ ] **Step 3: Implement the route** (add to `bulk_upload.py`; add imports at top)

Add imports near the existing ones:
```python
from api.services.budget_workbook_parser import parse_budget_workbook
from api.schemas import (
    WorkbookAnalyzeOut,
    WorkbookSheetPreview,
    WorkbookItemPreview,
)
```

Add a duplicate-key helper and the route (place above the `commit` route):
```python
def _existing_item_keys(db: Session, project_site: str) -> set:
    keys = set()
    q = db.query(Item.name, Item.budget, Item.section, Item.building_type).filter(
        Item.project_site == project_site
    )
    for name, budget, section, building_type in q.all():
        keys.add((
            _clean_str(name).lower(),
            _clean_str(budget).lower(),
            _clean_str(section).lower(),
            _clean_str(building_type).lower(),
        ))
    return keys


@router.post("/analyze", response_model=WorkbookAnalyzeOut)
async def analyze_budget_workbook(
    file: UploadFile = File(...),
    project_site: str = Form(...),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    site = _clean_str(project_site)
    if not site:
        raise HTTPException(422, "project_site is required")
    effective_site = enforce_project_site_scope(user, site) or site

    file_name = _clean_str(file.filename) or "upload.xlsx"
    if not file_name.lower().endswith(".xlsx"):
        raise HTTPException(422, "Please upload a .xlsx budget workbook")
    content = await file.read()
    if not content:
        raise HTTPException(422, "Uploaded file is empty")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(422, f"File too large. Max size is {MAX_FILE_BYTES // (1024 * 1024)}MB")

    parsed = parse_budget_workbook(content)
    existing = _existing_item_keys(db, effective_site)

    sheet_previews: List[WorkbookSheetPreview] = []
    total_items = 0
    total_dupes = 0
    for sheet in parsed.sheets:
        item_previews: List[WorkbookItemPreview] = []
        for it in sheet.items:
            dup_key = (it.name.lower(), it.budget.lower(), it.section.lower(), _clean_str(sheet.building_type).lower())
            is_dup = dup_key in existing
            if is_dup:
                total_dupes += 1
            total_items += 1
            item_previews.append(WorkbookItemPreview(
                name=it.name, qty=it.qty, unit=it.unit, unit_cost=it.unit_cost,
                category=it.category, grp=it.grp, section=it.section,
                section_matched=it.section_matched, budget=it.budget,
                sheet_name=it.sheet_name, row_number=it.row_number,
                duplicate=is_dup, warnings=it.warnings,
            ))
        sheet_previews.append(WorkbookSheetPreview(
            sheet_name=sheet.sheet_name,
            building_type=sheet.building_type,
            building_type_confident=sheet.building_type_confident,
            budget_number=sheet.budget_number,
            budget_confident=sheet.budget_confident,
            item_count=len(item_previews),
            warnings=sheet.warnings,
            items=item_previews,
        ))

    return WorkbookAnalyzeOut(
        file_name=file_name,
        project_site=effective_site,
        sheet_count=len(sheet_previews),
        item_count=total_items,
        duplicate_count=total_dupes,
        sheets=sheet_previews,
    )
```

- [ ] **Step 4: Run to verify pass**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_bulk_import_endpoints.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/api/routes/bulk_upload.py backend/tests/test_bulk_import_endpoints.py
git commit -m "feat(api): /bulk-upload/analyze returns workbook preview with duplicate flags"
```

---

## Task 6: `/bulk-upload/commit` — real import

**Files:**
- Modify: `backend/api/routes/bulk_upload.py:567-579` (replace the 410 stub)
- Test: `backend/tests/test_bulk_import_endpoints.py`

- [ ] **Step 1: Write failing tests** (append)

```python
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
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_bulk_import_endpoints.py -k commit -v
```
Expected: FAIL (commit returns 410).

- [ ] **Step 3: Replace the commit route** (`bulk_upload.py`)

Add import at top:
```python
from constants import CATEGORY_OPTIONS as _CATS, PROPERTY_TYPES as _BTYPES
```

Replace the existing `commit_bulk_upload` function body:
```python
@router.post("/commit", response_model=BulkUploadCommitOut)
def commit_bulk_upload(
    payload: BulkUploadCommitIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    site = _clean_str(payload.project_site)
    if not site:
        raise HTTPException(422, "project_site is required")
    effective_site = enforce_project_site_scope(user, site) or site

    valid_btypes = {b for b in _BTYPES if b}
    existing = _existing_item_keys(db, effective_site)

    to_insert = []
    skipped = []
    for idx, row in enumerate(payload.rows, start=1):
        if row.category not in _CATS:
            raise HTTPException(422, f"Row {idx}: invalid category '{row.category}'")
        if row.building_type not in valid_btypes:
            raise HTTPException(422, f"Row {idx}: invalid building_type '{row.building_type}'")
        if row.qty < 0 or row.unit_cost < 0:
            raise HTTPException(422, f"Row {idx}: qty and unit_cost must be non-negative")
        if not _clean_str(row.name):
            raise HTTPException(422, f"Row {idx}: name is required")

        dup_key = (
            row.name.lower(), _clean_str(row.budget).lower(),
            _clean_str(row.section).lower(), _clean_str(row.building_type).lower(),
        )
        if payload.skip_existing and dup_key in existing:
            skipped.append(f"{row.name} ({row.building_type})")
            continue
        existing.add(dup_key)
        to_insert.append(row)

    last_item = db.query(Item.id).order_by(Item.id.desc()).first()
    next_num = (last_item[0] if last_item else 0) + 1

    created_codes = []
    try:
        for row in to_insert:
            code = f"IT-{next_num}"
            db.add(Item(
                code=code, name=row.name, category=row.category, unit=row.unit,
                qty=row.qty, unit_cost=row.unit_cost, budget=row.budget,
                section=row.section, grp=row.grp, building_type=row.building_type,
                project_site=effective_site,
            ))
            created_codes.append(code)
            next_num += 1
        db.commit()
    except Exception:
        db.rollback()
        raise

    return BulkUploadCommitOut(inserted_count=len(created_codes), created_codes=created_codes, skipped=skipped)
```

- [ ] **Step 4: Add `skipped` to the output schema**

In `schemas.py`, replace `BulkUploadCommitOut`:
```python
class BulkUploadCommitOut(BaseModel):
    inserted_count: int
    created_codes: List[str]
    skipped: List[str] = []
```

- [ ] **Step 5: Run to verify pass**

```bash
cd backend && ../.venv/bin/python -m pytest tests/test_bulk_import_endpoints.py -v
```
Expected: all passed (analyze + commit).

- [ ] **Step 6: Commit**

```bash
git add backend/api/routes/bulk_upload.py backend/api/schemas.py backend/tests/test_bulk_import_endpoints.py
git commit -m "feat(api): enable /bulk-upload/commit with validation, scope, txn, dup-skip"
```

---

## Task 7: Frontend API client

**Files:**
- Modify: `frontend/src/api.js:84-102`

- [ ] **Step 1: Add `analyze`** (inside the `bulkUpload` object)

```javascript
    analyze: ({ file, projectSite }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('project_site', projectSite);
      return request('/bulk-upload/analyze', { method: 'POST', body: form });
    },
    commit: ({ projectSite, skipExisting, rows }) =>
      request('/bulk-upload/commit', {
        method: 'POST',
        body: JSON.stringify({ project_site: projectSite, skip_existing: skipExisting, rows }),
      }),
```
(Replace the old `commit` method shape; `analyze` is new.)

- [ ] **Step 2: Verify build compiles**

```bash
cd frontend && npx vite build >/tmp/vitebuild.log 2>&1; tail -3 /tmp/vitebuild.log
```
Expected: "built in ..." with no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.js
git commit -m "feat(web): bulkUpload.analyze client + commit payload shape"
```

---

## Task 8: Import wizard — setup + review + confirm

**Files:**
- Modify: `frontend/src/pages/BulkUpload.jsx` (full rewrite)
- Modify: `frontend/src/pages/BulkUpload.css` (wizard styles)

- [ ] **Step 1: Rewrite `BulkUpload.jsx`**

Replace the file with a 3-step wizard. Full component:
```jsx
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatNaira } from '../api';
import './BulkUpload.css';

const BUILDING_TYPES = ['Flats', 'Terraces', 'Semi-detached', 'Fully-detached'];

export default function BulkUpload() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [projectSite, setProjectSite] = useState('');
  const [file, setFile] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [skipExisting, setSkipExisting] = useState(true);
  const [excluded, setExcluded] = useState(() => new Set());
  const [feedback, setFeedback] = useState({ type: '', message: '' });

  const { data: sites = [] } = useQuery({
    queryKey: ['project-sites'],
    queryFn: () => api.projectSites.list(),
  });

  const analyzeMutation = useMutation({
    mutationFn: () => api.bulkUpload.analyze({ file, projectSite }),
    onSuccess: (data) => {
      setAnalysis(data);
      setExcluded(new Set());
      setStep(2);
      setFeedback({ type: '', message: '' });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Could not read the file.' }),
  });

  const commitMutation = useMutation({
    mutationFn: (rows) =>
      api.bulkUpload.commit({ projectSite, skipExisting, rows }),
    onSuccess: (res) => {
      queryClient.invalidateQueries(['items']);
      setStep(3);
      setFeedback({
        type: 'success',
        message: `Imported ${res.inserted_count} item(s). Skipped ${res.skipped.length}.`,
      });
    },
    onError: (err) =>
      setFeedback({ type: 'error', message: err?.message || 'Import failed.' }),
  });

  const rowKey = (it) => `${it.sheet_name}::${it.row_number}`;

  const includedRows = useMemo(() => {
    if (!analysis) return [];
    const rows = [];
    for (const sheet of analysis.sheets) {
      for (const it of sheet.items) {
        if (excluded.has(rowKey(it))) continue;
        rows.push({
          name: it.name, qty: it.qty, unit: it.unit, unit_cost: it.unit_cost,
          category: it.category, budget: it.budget, section: it.section,
          building_type: sheet.building_type, project_site: projectSite, grp: it.grp,
        });
      }
    }
    return rows;
  }, [analysis, excluded, projectSite]);

  const toggleRow = (it) => {
    const k = rowKey(it);
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  const handleAnalyze = (e) => {
    e.preventDefault();
    if (!projectSite) return setFeedback({ type: 'warning', message: 'Select a project site first.' });
    if (!file) return setFeedback({ type: 'warning', message: 'Choose a .xlsx file.' });
    analyzeMutation.mutate();
  };

  return (
    <div className="bulk-upload-page">
      <div className="card">
        <h2>Import Budget Workbook</h2>
        <p className="caption">Upload an Istrom budget .xlsx; review what it will create; then import.</p>

        {feedback.message && (
          <div className={`alert bulk-alert bulk-alert-${feedback.type}`}>{feedback.message}</div>
        )}

        {step === 1 && (
          <form className="bulk-upload-form" onSubmit={handleAnalyze}>
            <div className="form-row">
              <div className="form-group">
                <label>Project Site (required)</label>
                <select value={projectSite} onChange={(e) => setProjectSite(e.target.value)} required>
                  <option value="">Select project site…</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group form-group-wide">
                <label>Budget Workbook (.xlsx)</label>
                <input type="file" accept=".xlsx"
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setAnalysis(null); }} required />
              </div>
            </div>
            <button className="btn btn-primary" type="submit" disabled={analyzeMutation.isPending}>
              {analyzeMutation.isPending ? 'Reading…' : 'Read & Preview'}
            </button>
          </form>
        )}
      </div>

      {step === 2 && analysis && (
        <div className="card">
          <div className="bulk-upload-head">
            <h3>Preview: {analysis.file_name}</h3>
            <p className="caption">
              {analysis.item_count} item(s) across {analysis.sheet_count} sheet(s).
              {analysis.duplicate_count > 0 && ` ${analysis.duplicate_count} already in inventory.`}
            </p>
          </div>

          <label className="bulk-toggle">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            Skip rows already in inventory ({analysis.duplicate_count})
          </label>

          {analysis.sheets.map((sheet) => (
            <div key={sheet.sheet_name} className="bulk-sheet-block">
              <div className="bulk-sheet-title">
                <strong>{sheet.sheet_name}</strong>
                <span className={`bulk-chip ${sheet.building_type_confident ? '' : 'bulk-chip-warn'}`}>
                  {sheet.building_type || 'building type?'}
                </span>
                <span className={`bulk-chip ${sheet.budget_confident ? '' : 'bulk-chip-warn'}`}>
                  {sheet.budget_number ? `Budget ${sheet.budget_number}` : 'budget?'}
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th></th><th>Item</th><th>Qty</th><th>Unit</th><th>Rate</th>
                      <th>Category</th><th>Group</th><th>Section</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {sheet.items.map((it) => {
                      const k = rowKey(it);
                      const isExcluded = excluded.has(k);
                      return (
                        <tr key={k} className={isExcluded ? 'bulk-row-excluded' : ''}>
                          <td><input type="checkbox" checked={!isExcluded} onChange={() => toggleRow(it)} /></td>
                          <td>{it.name}</td>
                          <td>{it.qty}</td>
                          <td>{it.unit}</td>
                          <td>{formatNaira(it.unit_cost)}</td>
                          <td>{it.category || '—'}</td>
                          <td>{it.grp || '—'}</td>
                          <td className={it.section_matched ? '' : 'bulk-cell-warn'}>{it.section || '—'}</td>
                          <td>{it.duplicate ? <span className="bulk-chip bulk-chip-warn">duplicate</span> : 'new'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="action-bar">
            <button className="btn btn-secondary" type="button" onClick={() => setStep(1)}>Back</button>
            <button className="btn btn-primary" type="button"
              disabled={commitMutation.isPending || includedRows.length === 0}
              onClick={() => commitMutation.mutate(includedRows)}>
              {commitMutation.isPending ? 'Importing…' : `Import ${includedRows.length} item(s)`}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Import complete</h3>
          <p className="caption">{feedback.message}</p>
          <button className="btn btn-primary" type="button"
            onClick={() => { setStep(1); setFile(null); setAnalysis(null); }}>
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add wizard styles** (append to `BulkUpload.css`)

```css
.bulk-toggle { display: flex; align-items: center; gap: 8px; margin: 0.5rem 0 1rem; font-size: 0.9rem; }
.bulk-sheet-block { margin-top: 1.25rem; }
.bulk-sheet-title { display: flex; align-items: center; gap: 10px; margin-bottom: 0.4rem; }
.bulk-chip { font-size: 0.72rem; padding: 2px 8px; border-radius: 6px; background: var(--cement-100); color: var(--text-muted); }
.bulk-chip-warn { background: #fff1e0; color: #9a3412; }
.bulk-row-excluded { opacity: 0.45; }
.bulk-cell-warn { color: #9a3412; }
.bulk-alert-warning { background: #fff7ed; color: #9a3412; }
```

- [ ] **Step 3: Build check**

```bash
cd frontend && npx vite build >/tmp/vitebuild.log 2>&1; tail -3 /tmp/vitebuild.log
```
Expected: "built in ..." with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/BulkUpload.jsx frontend/src/pages/BulkUpload.css
git commit -m "feat(web): 3-step budget-workbook import wizard"
```

---

## Task 9: Re-enable route + nav link

**Files:**
- Modify: `frontend/src/App.jsx:8,44` (uncomment import + route)
- Modify: `frontend/src/components/Layout.jsx` (add nav link)

- [ ] **Step 1: Uncomment in `App.jsx`**

Change line 8 from `// import BulkUpload from './pages/BulkUpload';` to:
```javascript
import BulkUpload from './pages/BulkUpload';
```
Change line 44 from `{/* <Route path="bulk-upload" element={<BulkUpload />} /> */}` to:
```javascript
<Route path="bulk-upload" element={<BulkUpload />} />
```

- [ ] **Step 2: Add nav link in `Layout.jsx`**

Find the admin nav links block (where `Manual Entry` / `Inventory` links are rendered) and add, after the Manual Entry link:
```jsx
<NavLink to="/bulk-upload" className="nav-link" onClick={closeMobileNav}>
  Import Workbook
</NavLink>
```
(Match the exact `NavLink` / class / close-handler pattern already used by the neighbouring links in this file.)

- [ ] **Step 3: Build check**

```bash
cd frontend && npx vite build >/tmp/vitebuild.log 2>&1; tail -3 /tmp/vitebuild.log
```
Expected: "built in ..." with no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx frontend/src/components/Layout.jsx
git commit -m "feat(web): re-enable bulk-upload route and add nav link"
```

---

## Task 10: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

```bash
cd backend && ../.venv/bin/python -m pytest -v
```
Expected: all tests pass.

- [ ] **Step 2: Start backend + frontend, log in as admin, open "Import Workbook"**

Backend: `.venv/bin/python -m uvicorn api.main:app --port 8000` (from `backend/`).
Frontend: `npm run dev` (from `frontend/`). Log in with `Istrom2026`.

- [ ] **Step 3: Import the real sample file**

Upload `~/Downloads/SUPERVISORS LFC5 PLOT 66 KAFE BUDGET 1F…xlsx`, select a project site, preview, confirm import. Screenshot the preview and the resulting Inventory.
Expected: items appear in Inventory with `IT-{n}` codes, correct budget strings, and behave like manual entries.

- [ ] **Step 4: Re-upload the same file to confirm duplicate-skip**

Expected: preview flags all rows as duplicates; importing with skip-on inserts 0.

- [ ] **Step 5: Final commit (if any verification tweaks were needed)**

```bash
git add -A && git commit -m "chore: verification tweaks for budget import"
```

---

## Self-Review Notes

- **Spec coverage:** §4 mapping → Tasks 2–3; §5 group map → Task 2; §6 budget string → Task 3; §7 section match → Task 2; §8 row classification → Task 3; §9 required project site → Tasks 5,6,8; §10 endpoints → Tasks 5,6; frontend wizard → Tasks 8,9; §12 duplicate/txn/validation guards → Tasks 5,6; §14 tests → Tasks 1–6,10.
- **Type consistency:** parser dataclass fields (`ParsedItem`/`ParsedSheet`) match the schema fields (`WorkbookItemPreview`/`WorkbookSheetPreview`); commit reads `BulkUploadItemRow` fields used in Task 6 tests. `building_type` lives on `ParsedSheet`/`WorkbookSheetPreview` (not per-item); the frontend applies it per row at commit time.
```
