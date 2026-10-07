"""Bulk upload routes for inventory imports."""
from __future__ import annotations

import csv
import io
import json
import math
import re
from typing import Dict, Iterable, List, Optional, Tuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, BackgroundTasks
from openpyxl import load_workbook
from api.services.workbook_security import validate_workbook_archive
from pydantic import ValidationError
from zipfile import BadZipFile
from xml.etree.ElementTree import ParseError
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from db import get_db
from models import Item, ProjectSite, ProjectSiteAccessCode
from constants import CATEGORY_OPTIONS, CONSTRUCTION_SECTIONS, PROPERTY_TYPES
from api.dependencies import enforce_project_site_scope, get_current_admin, get_current_user, require_active_project_site
from api.schemas import (
    BulkUploadCommitIn,
    BulkUploadCommitOut,
    BulkUploadItemRow,
    BulkUploadPreviewOut,
    BulkUploadRowError,
    BulkUploadTemplateOut,
    FileViewerOut,
    FileViewerSheetOut,
    WorkbookAnalyzeOut,
    WorkbookSheetPreview,
    WorkbookItemPreview,
    WorkbookColumnMapping,
)
from api.services.budget_workbook_parser import parse_budget_workbook, COLUMN_FIELDS
from api.services.import_template import build_import_template
from api.services.budget_import_guard import sign_preview, validate_review, import_key
from api.services.notification_hub import notification_hub

router = APIRouter(prefix="/bulk-upload", tags=["bulk-upload"])

MAX_UPLOAD_ROWS = 2000
MAX_RETURNED_ERRORS = 300
SUPPORTED_EXTENSIONS = {".csv", ".xlsx"}
MAX_VIEW_ROWS = 500
MAX_VIEW_SHEETS = 8
MAX_FILE_BYTES = 15 * 1024 * 1024

REQUIRED_FIELDS = [
    "name",
    "qty",
    "unit",
    "unit_cost",
    "category",
    "budget",
    "section",
    "building_type",
]

HEADER_ALIASES = {
    "item": "name",
    "item_name": "name",
    "item_description": "name",
    "quantity": "qty",
    "qnty": "qty",
    "unit_cost_ngn": "unit_cost",
    "unit_price": "unit_cost",
    "price": "unit_cost",
    "group": "grp",
    "category_group": "grp",
    "project": "project_site",
    "projectsite": "project_site",
    "site": "project_site",
    "building": "building_type",
}

CATEGORY_CANON = {
    "materials": "Materials",
    "labour": "Labour",
    "labor": "Labour",
    "material_labour": "Material/Labour",
    "materials_labour": "Material/Labour",
    "material_and_labour": "Material/Labour",
}

BUILDING_TYPE_CANON = {
    re.sub(r"[^a-z0-9]+", "_", bt.strip().lower()).strip("_"): bt
    for bt in PROPERTY_TYPES
    if bt
}

SECTION_CANON = {
    re.sub(r"[^a-z0-9]+", "_", s.strip().lower()).strip("_"): s
    for s in CONSTRUCTION_SECTIONS
}


def _normalize_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text or "").strip().lower()).strip("_")


def _header_to_field(header: str) -> str:
    base = _normalize_key(header)
    return HEADER_ALIASES.get(base, base)


def _clean_str(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _site_key_variants(site_name: str) -> List[str]:
    key = _normalize_key(site_name)
    if not key:
        return []
    variants = {key}
    for suffix in ("_site", "_project", "_project_site"):
        if key.endswith(suffix):
            variants.add(key[: -len(suffix)])
    if key and not key.endswith("_site"):
        variants.add(f"{key}_site")
    return [v for v in variants if v]


def _parse_non_negative_float(value, field_name: str) -> float:
    if value is None or _clean_str(value) == "":
        raise ValueError(f"{field_name} is required")
    if isinstance(value, (int, float)):
        num = float(value)
    else:
        text = _clean_str(value).replace(",", "")
        num = float(text)
    if not math.isfinite(num):
        raise ValueError(f"{field_name} must be a finite number")
    if num < 0:
        raise ValueError(f"{field_name} must be non-negative")
    return num


def _read_csv_rows(content: bytes) -> Tuple[List[str], List[Tuple[int, Dict[str, object]]]]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("utf-16")
        except UnicodeDecodeError:
            text = content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(422, "CSV file does not contain a header row")
    if len(reader.fieldnames) > 100:
        raise HTTPException(422, "Maximum supported column count is 100")

    rows: List[Tuple[int, Dict[str, object]]] = []
    for row_number, row in enumerate(reader, start=2):
        if all(_clean_str(v) == "" for v in row.values()):
            continue
        rows.append((row_number, row))
        if len(rows) > MAX_UPLOAD_ROWS:
            raise HTTPException(422, f"Upload exceeds max rows ({MAX_UPLOAD_ROWS})")
    return reader.fieldnames, rows


def _read_xlsx_rows(content: bytes) -> Tuple[List[str], List[Tuple[int, Dict[str, object]]]]:
    try:
        validate_workbook_archive(content)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    ws = wb.active
    if (ws.max_row or 0) > 10000 or (ws.max_column or 0) > 100:
        wb.close()
        raise HTTPException(422, "Maximum supported sheet size is 10000 rows and 100 columns")
    stream = ws.iter_rows(values_only=True)
    header_tuple = next(stream, None)
    if not header_tuple:
        raise HTTPException(422, "Excel file does not contain a header row")

    headers = [_clean_str(h) for h in header_tuple]
    if all(not h for h in headers):
        raise HTTPException(422, "Excel header row is empty")

    rows: List[Tuple[int, Dict[str, object]]] = []
    for row_number, values in enumerate(stream, start=2):
        row_values = list(values or [])
        while len(row_values) < len(headers):
            row_values.append(None)
        if all(_clean_str(v) == "" for v in row_values):
            continue
        rows.append((row_number, {headers[i]: row_values[i] for i in range(len(headers))}))
        if len(rows) > MAX_UPLOAD_ROWS:
            wb.close()
            raise HTTPException(422, f"Upload exceeds max rows ({MAX_UPLOAD_ROWS})")
    wb.close()
    return headers, rows


def _read_upload_rows(file_name: str, content: bytes) -> Tuple[List[str], List[Tuple[int, Dict[str, object]]]]:
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(422, f"File too large. Max size is {MAX_FILE_BYTES // (1024 * 1024)}MB")
    extension = "." + file_name.lower().rsplit(".", 1)[-1] if "." in file_name else ""
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(422, "Unsupported file type. Please upload .csv or .xlsx")
    if extension == ".csv":
        return _read_csv_rows(content)
    return _read_xlsx_rows(content)


def _cell_to_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        # Keep user-friendly integers as integers instead of trailing .0
        if value.is_integer():
            return str(int(value))
    return str(value)


def _normalized_headers(headers: List[object]) -> List[str]:
    result: List[str] = []
    seen: Dict[str, int] = {}
    for index, raw in enumerate(headers, start=1):
        base = _clean_str(raw) or f"Column {index}"
        count = seen.get(base, 0) + 1
        seen[base] = count
        if count > 1:
            result.append(f"{base} ({count})")
        else:
            result.append(base)
    return result


def _view_csv(file_name: str, content: bytes) -> FileViewerOut:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("utf-16")
        except UnicodeDecodeError:
            text = content.decode("latin-1")

    reader = csv.reader(io.StringIO(text))
    first_row = next(reader, None)
    if first_row is None:
        raise HTTPException(422, "CSV file is empty")
    if len(first_row) > 100:
        raise HTTPException(422, "Maximum supported column count is 100")
    headers = _normalized_headers(first_row)
    total_rows = 0
    normalized_rows: List[List[str]] = []
    for row in reader:
        total_rows += 1
        if len(normalized_rows) >= MAX_VIEW_ROWS:
            continue
        values = [_cell_to_text(v) for v in row]
        while len(values) < len(headers):
            values.append("")
        normalized_rows.append(values[: len(headers)])

    return FileViewerOut(
        file_name=file_name,
        sheets=[
            FileViewerSheetOut(
                sheet_name="CSV",
                headers=headers,
                rows=normalized_rows,
                total_rows=total_rows,
                returned_rows=len(normalized_rows),
                truncated=total_rows > len(normalized_rows),
            )
        ],
    )


def _view_xlsx(file_name: str, content: bytes) -> FileViewerOut:
    try:
        validate_workbook_archive(content)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    sheet_outputs: List[FileViewerSheetOut] = []

    for ws in wb.worksheets[:MAX_VIEW_SHEETS]:
        if (ws.max_row or 0) > 10000 or (ws.max_column or 0) > 100:
            wb.close()
            raise HTTPException(422, "Maximum supported sheet size is 10000 rows and 100 columns")
        stream = ws.iter_rows(values_only=True)
        header_row = next(stream, None)
        if header_row is None:
            headers = []
            rows: List[List[str]] = []
            total_rows = 0
        else:
            headers = _normalized_headers(list(header_row))
            rows = []
            total_rows = 0
            for values in stream:
                line = [_cell_to_text(v) for v in (values or ())]
                while len(line) < len(headers):
                    line.append("")
                if all(_clean_str(v) == "" for v in line):
                    continue
                total_rows += 1
                if len(rows) < MAX_VIEW_ROWS:
                    rows.append(line[: len(headers)])

        sheet_outputs.append(
            FileViewerSheetOut(
                sheet_name=ws.title or "Sheet",
                headers=headers,
                rows=rows,
                total_rows=total_rows,
                returned_rows=len(rows),
                truncated=total_rows > len(rows),
            )
        )

    wb.close()
    if not sheet_outputs:
        raise HTTPException(422, "Excel file contains no sheets")

    return FileViewerOut(file_name=file_name, sheets=sheet_outputs)


def _validate_rows(
    rows: List[Tuple[int, Dict[str, object]]],
    *,
    user: dict,
    db: Session,
    default_project_site: Optional[str] = None,
) -> Tuple[List[BulkUploadItemRow], List[BulkUploadRowError]]:
    site_lookup: Dict[str, str] = {}

    site_rows = db.query(ProjectSite).all()
    for s in site_rows:
        name = _clean_str(s.name)
        if not name or s.is_active is False:
            continue
        for key in _site_key_variants(name):
            site_lookup[key] = name

    for row in db.query(ProjectSiteAccessCode.project_site).all():
        name = _clean_str(row[0])
        if not name:
            continue
        for key in _site_key_variants(name):
            site_lookup.setdefault(key, name)

    for row in db.query(Item.project_site).distinct().all():
        name = _clean_str(row[0])
        if not name:
            continue
        for key in _site_key_variants(name):
            site_lookup.setdefault(key, name)

    user_site = _clean_str(user.get("project_site"))
    if user_site:
        for key in _site_key_variants(user_site):
            site_lookup.setdefault(key, user_site)
    valid_rows: List[BulkUploadItemRow] = []
    errors: List[BulkUploadRowError] = []
    seen_keys: set[Tuple[str, str, str, str, str]] = set()

    for row_number, raw_row in rows:
        canonical = {_header_to_field(k): v for k, v in raw_row.items() if _clean_str(k)}

        row_errors: List[BulkUploadRowError] = []

        for required in REQUIRED_FIELDS:
            if _clean_str(canonical.get(required)) == "":
                row_errors.append(BulkUploadRowError(row_number=row_number, field=required, message=f"{required} is required"))

        name = _clean_str(canonical.get("name"))
        unit = _clean_str(canonical.get("unit"))
        budget = _clean_str(canonical.get("budget"))
        section_raw = _clean_str(canonical.get("section"))
        category_raw = _clean_str(canonical.get("category"))
        building_raw = _clean_str(canonical.get("building_type"))
        grp = _clean_str(canonical.get("grp")) or None
        site_raw = _clean_str(canonical.get("project_site")) or _clean_str(default_project_site)

        for field, value, limit in (
            ('name', name, 255), ('unit', unit, 50), ('budget', budget, 255),
            ('section', section_raw, 255), ('grp', grp or '', 255),
        ):
            if len(value) > limit:
                row_errors.append(BulkUploadRowError(row_number=row_number, field=field,
                    message=f'{field} must be at most {limit} characters.'))

        try:
            qty = _parse_non_negative_float(canonical.get("qty"), "qty")
        except Exception as exc:
            row_errors.append(BulkUploadRowError(row_number=row_number, field="qty", message=str(exc)))
            qty = 0

        try:
            unit_cost = _parse_non_negative_float(canonical.get("unit_cost"), "unit_cost")
        except Exception as exc:
            row_errors.append(BulkUploadRowError(row_number=row_number, field="unit_cost", message=str(exc)))
            unit_cost = 0

        category_key = _normalize_key(category_raw)
        if category_key in CATEGORY_CANON:
            category = CATEGORY_CANON[category_key]
        elif category_raw in CATEGORY_OPTIONS:
            category = category_raw
        else:
            category = ""
            row_errors.append(
                BulkUploadRowError(
                    row_number=row_number,
                    field="category",
                    message=f"Invalid category. Use one of: {', '.join(CATEGORY_OPTIONS)}",
                )
            )

        section_key = _normalize_key(section_raw)
        section = SECTION_CANON.get(section_key)
        if not section:
            row_errors.append(
                BulkUploadRowError(
                    row_number=row_number,
                    field="section",
                    message="Invalid section. Please use values from the template.",
                )
            )
            section = section_raw

        building_key = _normalize_key(building_raw)
        building_type = BUILDING_TYPE_CANON.get(building_key)
        if not building_type:
            row_errors.append(
                BulkUploadRowError(
                    row_number=row_number,
                    field="building_type",
                    message=f"Invalid building_type. Use one of: {', '.join(BUILDING_TYPE_CANON.values())}",
                )
            )
            building_type = building_raw

        if not site_raw:
            row_errors.append(
                BulkUploadRowError(
                    row_number=row_number,
                    field="project_site",
                    message="project_site is required (in file column or selected default site).",
                )
            )
            project_site = ""
        else:
            site_match = site_lookup.get(_normalize_key(site_raw))
            if site_lookup and not site_match:
                row_errors.append(
                    BulkUploadRowError(
                        row_number=row_number,
                        field="project_site",
                        message=f'Unknown or inactive project_site "{site_raw}".',
                    )
                )
                project_site = site_raw
            else:
                project_site = site_match or site_raw
                try:
                    scoped = enforce_project_site_scope(user, project_site)
                    project_site = scoped or project_site
                except HTTPException as exc:
                    row_errors.append(
                        BulkUploadRowError(
                            row_number=row_number,
                            field="project_site",
                            message=str(exc.detail),
                        )
                    )

        if not row_errors:
            dedupe_key = (
                name.lower(),
                budget.lower(),
                section.lower(),
                building_type.lower(),
                project_site.lower(),
            )
            if dedupe_key in seen_keys:
                row_errors.append(
                    BulkUploadRowError(
                        row_number=row_number,
                        field="name",
                        message="Duplicate line detected in upload (same item/budget/section/building/site).",
                    )
                )
            else:
                seen_keys.add(dedupe_key)

        if row_errors:
            errors.extend(row_errors)
            continue

        valid_rows.append(
            BulkUploadItemRow(
                name=name,
                qty=qty,
                unit=unit,
                unit_cost=unit_cost,
                category=category,
                budget=budget,
                section=section,
                building_type=building_type,
                project_site=project_site,
                grp=grp,
            )
        )

    return valid_rows, errors


@router.get("/template", response_model=BulkUploadTemplateOut)
def get_upload_template():
    """Return expected headers and a sample row for CSV/XLSX templates."""
    return BulkUploadTemplateOut(
        headers=[
            "name",
            "qty",
            "unit",
            "unit_cost",
            "category",
            "budget",
            "section",
            "building_type",
            "project_site",
            "grp",
        ],
        sample_row=BulkUploadItemRow(
            name="Sharp Sand",
            qty=120,
            unit="tons",
            unit_cost=18500,
            category="Materials",
            budget="Budget 1 - Flats(General Materials)",
            section=CONSTRUCTION_SECTIONS[0],
            building_type="Flats",
            project_site="Lifecamp Kafe",
            grp="General Materials",
        ),
    )


@router.post("/view", response_model=FileViewerOut)
async def view_uploaded_file(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload and preview Excel/CSV file contents only (no database writes)."""
    _ = user
    file_name = _clean_str(file.filename) or "uploaded-file"
    extension = "." + file_name.lower().rsplit(".", 1)[-1] if "." in file_name else ""
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(422, "Unsupported file type. Please upload .csv or .xlsx")

    content = await file.read(MAX_FILE_BYTES + 1)
    if not content:
        raise HTTPException(422, "Uploaded file is empty")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(422, f"File too large. Max size is {MAX_FILE_BYTES // (1024 * 1024)}MB")

    if extension == ".csv":
        return _view_csv(file_name, content)
    return _view_xlsx(file_name, content)


@router.post("/preview", response_model=BulkUploadPreviewOut)
async def preview_bulk_upload(
    file: UploadFile = File(...),
    default_project_site: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    file_name = _clean_str(file.filename) or "upload"
    content = await file.read(MAX_FILE_BYTES + 1)
    if not content:
        raise HTTPException(422, "Uploaded file is empty")

    _, rows = _read_upload_rows(file_name, content)
    if not rows:
        raise HTTPException(422, "No data rows found in file")
    if len(rows) > MAX_UPLOAD_ROWS:
        raise HTTPException(422, f"Upload exceeds max rows ({MAX_UPLOAD_ROWS})")

    valid_rows, errors = _validate_rows(
        rows,
        user=user,
        db=db,
        default_project_site=default_project_site,
    )

    returned_errors = errors[:MAX_RETURNED_ERRORS]
    if len(errors) > MAX_RETURNED_ERRORS:
        returned_errors.append(
            BulkUploadRowError(
                row_number=0,
                field="file",
                message=f"Only first {MAX_RETURNED_ERRORS} errors are shown.",
            )
        )

    return BulkUploadPreviewOut(
        file_name=file_name,
        total_rows=len(rows),
        valid_rows_count=len(valid_rows),
        error_count=len(errors),
        errors=returned_errors,
        valid_rows=valid_rows,
    )


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


@router.get("/template.xlsx")
def download_import_template(user: dict = Depends(get_current_admin)):
    """Download the standardized, dropdown-validated budget import template."""
    return Response(
        content=build_import_template(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="istrom-import-template.xlsx"'},
    )


@router.post("/analyze", response_model=WorkbookAnalyzeOut)
async def analyze_budget_workbook(
    file: UploadFile = File(...),
    project_site: str = Form(...),
    mappings: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    site = _clean_str(project_site)
    if not site:
        raise HTTPException(422, "project_site is required")
    effective_site = require_active_project_site(db, user, site)

    file_name = _clean_str(file.filename) or "upload.xlsx"
    if not file_name.lower().endswith(".xlsx"):
        raise HTTPException(422, "Please upload a .xlsx budget workbook")
    content = await file.read(MAX_FILE_BYTES + 1)
    if not content:
        raise HTTPException(422, "Uploaded file is empty")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(422, f"File too large. Max size is {MAX_FILE_BYTES // (1024 * 1024)}MB")

    try:
        raw_mappings = json.loads(mappings) if mappings else {}
        if not isinstance(raw_mappings, dict):
            raise ValueError('Column mappings must be an object keyed by sheet name.')
        checked_mappings = {}
        for name, values in raw_mappings.items():
            mapped = WorkbookColumnMapping.model_validate(values)
            if set(mapped.columns) - COLUMN_FIELDS or any(idx < 0 or idx >= 100 for idx in mapped.columns.values()):
                raise ValueError(f'{name}: invalid column selection.')
            if len(set(mapped.columns.values())) != len(mapped.columns):
                raise ValueError(f'{name}: choose a different column for each field.')
            checked_mappings[name] = mapped.model_dump()
        parsed = parse_budget_workbook(content, checked_mappings)
    except (ValidationError, ValueError, TypeError) as exc:
        raise HTTPException(422, f'Could not read workbook: {exc}') from exc
    except (BadZipFile, KeyError, ParseError, OSError) as exc:
        raise HTTPException(422, 'This file is not a readable Excel workbook. Save it as .xlsx and try again.') from exc
    existing = _existing_item_keys(db, effective_site)
    existing_imports = {value for (value,) in db.query(Item.import_key).filter(Item.project_site == effective_site).all() if value}

    sheet_previews: List[WorkbookSheetPreview] = []
    total_items = 0
    total_dupes = 0
    for sheet in parsed.sheets:
        item_previews: List[WorkbookItemPreview] = []
        for it in sheet.items:
            dup_key = (it.name.lower(), it.budget.lower(), it.section.lower(), _clean_str(sheet.building_type).lower())
            is_dup = import_key(parsed.workbook_id, effective_site, it.sheet_name, it.row_number) in existing_imports
            if not is_dup and dup_key in existing:
                it.warnings.append('A similar item is already in inventory. Check its building scope before adding this budget line.')
            if is_dup:
                total_dupes += 1
            total_items += 1
            item_previews.append(WorkbookItemPreview(
                name=it.name, qty=it.qty, unit=it.unit, unit_cost=it.unit_cost,
                category=it.category, grp=it.grp, section=it.section,
                section_matched=it.section_matched, budget=it.budget,
                sheet_name=it.sheet_name, row_number=it.row_number,
                duplicate=is_dup, warnings=it.warnings, errors=it.errors,
                source_amount=it.source_amount, excluded_by_default=it.excluded_by_default,
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
            **{name: getattr(sheet, name) for name in ('budget_scope', 'suggested_multiplier', 'multiplier_evidence', 'source_total', 'source_total_cell', 'source_total_formula', 'source_total_label', 'summary_label', 'total_unreadable', 'requires_confirmation')},
        ))

    return WorkbookAnalyzeOut(
        file_name=file_name,
        project_site=effective_site,
        sheet_count=len(sheet_previews),
        item_count=total_items,
        duplicate_count=total_dupes,
        sheets=sheet_previews, layouts=parsed.layouts, warnings=parsed.warnings,
        preview_token=sign_preview(parsed, effective_site, user),
    )


@router.post("/commit", response_model=BulkUploadCommitOut)
def commit_bulk_upload(
    payload: BulkUploadCommitIn,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_admin),
):
    site = _clean_str(payload.project_site)
    if not site:
        raise HTTPException(422, "project_site is required")
    effective_site = require_active_project_site(db, user, site)
    reviewed_keys = validate_review(payload, effective_site, user)
    previously_imported = {item.import_key: item for item in db.query(Item).filter(Item.project_site == effective_site, Item.import_key.is_not(None)).all()}

    valid_btypes = {b for b in PROPERTY_TYPES if b}
    existing = _existing_item_keys(db, effective_site)

    # NOTE: `section` and `budget`/`grp` are intentionally NOT constrained to a
    # fixed list here. Manual Entry's create_item stores section/budget as free
    # text without validation, and real budget workbooks carry many section
    # spellings outside CONSTRUCTION_SECTIONS — rejecting them would block import
    # of valid rows. Parity with manual entry is the goal, so only the fields
    # create_item effectively constrains (category, building_type, non-negative
    # numbers, required name) are validated.
    to_insert = []
    skipped = []
    for idx, row in enumerate(payload.rows, start=1):
        if _clean_str(row.project_site) != effective_site:
            raise HTTPException(422, f"Row {idx}: project_site does not match the selected project site")
        if not _clean_str(row.budget):
            raise HTTPException(422, f"Row {idx}: budget is required")
        if row.category not in CATEGORY_OPTIONS:
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
        source_key = reviewed_keys.get(idx - 1)
        if source_key in previously_imported:
            saved = previously_imported[source_key]
            if any((saved.name != row.name, saved.budget != row.budget, saved.budget_scope != row.budget_scope,
                    saved.category != row.category, saved.section != row.section, saved.building_type != row.building_type,
                    saved.unit != row.unit, abs(saved.planned_qty - row.qty) > 1e-8, abs(saved.planned_unit_cost - row.unit_cost) > 1e-8)):
                raise HTTPException(422, f'{row.name}: this source row was already imported with different values. Review the existing item before importing again.')
            skipped.append(f"{row.name} ({row.budget_scope})")
            continue
        if payload.skip_existing and not source_key and dup_key in existing:
            skipped.append(f"{row.name} ({row.building_type})")
            continue
        to_insert.append((row, source_key))

    created_codes = []
    try:
        for row, source_key in to_insert:
            item = Item(
                name=row.name, category=row.category, unit=row.unit,
                qty=row.qty, unit_cost=row.unit_cost, budget=row.budget,
                planned_qty=row.qty, planned_unit_cost=row.unit_cost,
                section=row.section, grp=row.grp, building_type=row.building_type,
                project_site=effective_site,
                budget_scope=row.budget_scope, source_sheet=row.source_sheet, source_row=row.source_row, import_key=source_key,
            )
            db.add(item)
            db.flush()
            item.code = f"IT-{item.id}"
            created_codes.append(item.code)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, 'A source row was imported during this review. Preview the workbook again.') from exc
    except Exception:
        db.rollback()
        raise

    if created_codes:
        background_tasks.add_task(notification_hub.broadcast_workspace_changed, effective_site)
    return BulkUploadCommitOut(inserted_count=len(created_codes), created_codes=created_codes, skipped=skipped)
