# Excel Budget-Workbook Import — Design

**Date:** 2026-06-24
**Status:** Approved (pending spec review)
**Author:** Istrom team + Claude

## 1. Goal

Let an admin upload an Istrom budget workbook (`.xlsx`) and have the app read
every budget sheet and create inventory items that are **identical to items
added through Manual Entry** — same fields, same `IT-{n}` code sequence, same
project-site scoping — so the imported items behave exactly like manually
entered ones across Inventory, Budget Summary, and Actuals.

The import must be reliable on **real, human-formatted workbooks** (merged
headers, spacer rows, blank quantities, inconsistent sheet names), not just a
clean template. Nothing is written to inventory until the admin confirms a
preview.

## 2. Background — current state

The bulk-upload feature is ~90% built but deliberately disabled:

- `backend/api/routes/bulk_upload.py` already parses `.xlsx`/`.csv`, normalizes
  headers, validates rows, and dedupes within a file.
- `POST /bulk-upload/commit` is stubbed to return **HTTP 410 "Bulk import is
  disabled… viewer-only"**.
- `frontend/src/pages/BulkUpload.jsx` is reduced to a **read-only viewer** and is
  **commented out of routing** in `App.jsx`.
- The existing parser reads only one clean sheet with 8 named columns. It does
  **not** understand the real budget-workbook layout.

This design adds a workbook-aware importer alongside the existing viewer. The
existing `/view`, `/preview`, and `/template` endpoints are left intact.

## 3. Real workbook format (from sample)

Sample: `SUPERVISORS LFC5 PLOT 66 KAFE BUDGET 1F…7B + GATEHOUSE`.

- **29 budget sheets** plus `SUMMARY PAGE`, `Sheet1`, `Sheet2` (ignored).
- **Sheet name encodes building type + budget number**:
  - `FLATS BGT 1` → Flats / Budget 1
  - `TER. K&L BGT 2` → Terraces / Budget 2
  - `SD 22-25 BGT 1` → Semi-detached / Budget 1
  - `D19-21…BGT 2` → Fully-detached / Budget 2
  - Naming is inconsistent (e.g. `SD 4,5, SD 19-21 B3` uses `B3` not `BGT 3`;
    `FLATS BGT 1 RAFT` has a trailing qualifier).
- Within a sheet, top-to-bottom:
  - Title rows (project, budget no.).
  - A free-text **section** header, e.g. `SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)`
    (punctuation differs from the app's canonical section list).
  - **Group/category** sub-headers in column B: `MATERIAL ONLY`, `MATERIALS`,
    `IRONS`, `WOODS`, `PLUMBINGS`, `LABOUR`, `LABOUR ONLY`, `TOTAL LABOUR`.
  - A table header row: `S/N | MATERIALS | QTY | UNIT | RATE | AMOUNT` (cols A–F).
  - Data rows. Some have blank `QTY`; some `AMOUNT` is `0` or text like
    `AVAILABLE`; some omit `S/N`; spacer/blank rows appear between items.

## 4. Field mapping

Each material/labour data row becomes one `Item`:

| Item field | Source |
|---|---|
| `name` | `MATERIALS` column (B) |
| `qty` | `QTY` column (C); blank → `0` |
| `unit` | `UNIT` column (D) |
| `unit_cost` | `RATE` column (E) |
| `category` | from current group header (see §5) |
| `grp` | from current group header (see §5) |
| `building_type` | inferred from sheet name |
| `section` | section header, matched to canonical section (see §7) |
| `budget` | composed string (see §6) |
| `project_site` | admin-selected at upload (see §9), applied to every row |

The `AMOUNT` column is **ignored** (it is just `qty × rate`); text values like
`AVAILABLE` therefore never block a row.

## 5. Group → category / grp mapping

The in-sheet sub-header determines both `category` and `grp`. `grp` values match
`BUDGET_CATEGORIES`.

| Sheet sub-header (normalized) | `grp` | `category` |
|---|---|---|
| `MATERIAL`, `MATERIAL ONLY`, `MATERIALS` | General Materials | Materials |
| `WOODS` | Woods | Materials |
| `IRONS` | Irons | Materials |
| `PLUMBING`, `PLUMBINGS` | Plumbings | Materials |
| `ELECTRICAL` | Electrical | Materials |
| `MECHANICAL` | Mechanical | Materials |
| `LABOUR`, `LABOUR ONLY` | Labour | Labour |

`TOTAL LABOUR` and other total/summary rows are treated as non-item rows and
skipped. If a data row appears before any recognized group header, it inherits
the sheet's first group, or is flagged for review if none exists.

## 6. Budget string

Reconstructed to match `ManualEntry.buildBudgetLabels`:

```
budget = "Budget {N} - {buildingType}({grp})"
# e.g. "Budget 1 - Flats(Irons)"
```

- `{N}` from the sheet name (`BGT 3` / `B3` → `3`).
- `{buildingType}` from the sheet name.
- `{grp}` from the group header (§5).

This makes imported items group correctly in Budget Summary, identical to manual
entries.

## 7. Section matching

- Normalize the section header and each `CONSTRUCTION_SECTIONS` value (lowercase,
  collapse non-alphanumerics) and match.
- On confident match → use the canonical section string.
- On no/weak match → keep the raw header text and **flag the sheet's section as
  low-confidence** for admin correction in the review screen (dropdown of
  canonical sections).

## 8. Row classification

A row is an **item** when it has a non-empty `name` (col B) and is under a
detected table header. Skipped automatically:

- Title / project / budget-number banner rows.
- Section header rows and group sub-header rows.
- The repeated `S/N | MATERIALS | …` table-header rows.
- Totals (`TOTAL LABOUR`, `SUB TOTAL`, `GRAND TOTAL`, etc.).
- Fully blank / spacer rows.

A row with a name but blank `qty` is a valid item with `qty = 0` (e.g. `PEGS`).

## 9. Project site selection (required)

Project site is **not** reliably in the file, and a workbook may belong to any
site. The wizard's first step **requires** the admin to choose a project site
from existing sites (`GET /project-sites`). That site is applied to **every**
imported row and is re-checked server-side against the admin's scope. There is no
silent default — the import cannot proceed without an explicit selection.

## 10. Architecture

### 10.1 Parser service — `backend/api/services/budget_workbook_parser.py`

Pure, DB-free, unit-testable.

```
parse_budget_workbook(content: bytes) -> ParsedWorkbook
```

- Iterates worksheets; skips sheets with no detectable item table and the known
  non-item sheets.
- Per sheet: infer `building_type` and `budget_number` from the name (regex),
  each with a confidence flag and the raw token used.
- Walks rows, tracking the current section and current group; emits parsed item
  rows with provenance (`sheet_name`, `row_number`) and per-row warnings.
- Normalizes numbers (strip `₦`, commas, whitespace; blank → 0; ignore AMOUNT).

Returns per-sheet metadata + item rows + warnings; performs **no** validation
against the DB and **no** writes.

### 10.2 Endpoints (extend the `bulk-upload` router, admin-only)

- `POST /bulk-upload/analyze`
  - Input: multipart `file` + `project_site` (form field, required).
  - Parses the workbook, applies the §4–§8 mapping, marks rows that duplicate
    existing inventory, and returns the structured preview. **No writes.**
- `POST /bulk-upload/commit` — **replaces the 410 stub**
  - Input: JSON `{ project_site, skip_existing, rows: [BulkUploadItemRow…] }`
    (the admin-resolved rows from the review screen).
  - **Re-validates every row server-side** against the same constraints Manual
    Entry's `create_item` effectively enforces: `category ∈ CATEGORY_OPTIONS`,
    `building_type ∈ PROPERTY_TYPES`, `qty/unit_cost ≥ 0`, non-empty `name`, and
    project-site scope. The client payload is never trusted blindly. **`section`,
    `budget`, and `grp` are stored as free text and are NOT constrained to a
    fixed list** — `create_item` does not validate them either, and real
    workbooks carry many section spellings outside `CONSTRUCTION_SECTIONS`, so
    rejecting them would block import of otherwise-valid rows. (Revised after the
    final code review; original draft over-specified strict `section`
    validation.)
  - Inserts items exactly like `create_item`: continues the `IT-{n}` sequence,
    sets every field, enforces scope. **Single transaction** — any error rolls
    back the whole import (never a half-import).
  - Returns `{ inserted_count, created_codes, skipped: [...] }`.

`BulkUploadItemRow` and `BulkUploadCommitIn` already exist and are reused
(`BulkUploadCommitIn` extended with `project_site` and `skip_existing: bool =
True`). A new `WorkbookAnalyzeOut` schema describes the richer preview.

### 10.3 Frontend — import wizard (rebuild `BulkUpload.jsx`)

Three steps:

1. **Setup** — required project-site dropdown + file picker → `POST /analyze`.
2. **Review** — per sheet: inferred Building type / Budget / Section / Category
   shown as **editable dropdowns** (low-confidence ones highlighted); the list of
   item rows to be created; warnings (unmatched section, blank qty, duplicate of
   existing inventory). Admin can correct fields and exclude sheets/rows. A
   `skip duplicates` toggle (default on).
3. **Confirm** — `POST /commit` → success summary (items created, codes,
   skipped). Inventory query is invalidated so new items appear immediately.

Re-enable the route in `App.jsx` and add the nav link in `Layout`.

## 11. "As if manually added" guarantee

Imported items are constructed with the identical field set `create_item`
produces, the same `budget` composite as `ManualEntry`, the same `IT-{n}` code
continuation, and the same scope enforcement. After import they are
indistinguishable from manual entries in every view.

## 12. Edge cases & guards

- **Confirm-before-write**: inventory is untouched until the admin approves.
- **Duplicate protection**: rows matching existing inventory by
  `(name, budget, section, building_type, project_site)` are flagged and skipped
  by default (`skip_existing`), with a toggle to import anyway — so re-uploading a
  workbook will not double up.
- **Within-file duplicates**: collapsed/flagged as today.
- **qty 0** is valid (catalog rows like `PEGS`).
- **`AVAILABLE` / non-numeric AMOUNT**: ignored (AMOUNT is not stored).
- **All-or-nothing commit** via a single transaction.
- **Server-side re-validation** at commit for correctness and security.
- **Low-confidence inference** is surfaced, never guessed silently.

## 13. Scope boundaries / non-goals

- Admin-only (same as Manual Entry).
- `.xlsx` only; multi-sheet budget structure cannot be represented in `.csv`.
- The existing simple-template `/view`, `/preview`, `/template` endpoints and the
  viewer remain; this is additive.
- No editing of existing items via import (insert-only), matching Manual Entry.
- No automatic creation of new project sites — the admin selects an existing one.

## 14. Testing

- Parser unit tests against the real sample workbook:
  - building-type/budget inference incl. the messy `B3` and `RAFT` cases.
  - section tracking + canonical matching.
  - group → category/grp mapping across `MATERIAL/IRONS/WOODS/PLUMBINGS/LABOUR`.
  - blank qty, `AVAILABLE` amounts, spacer rows, total rows.
- Commit tests: items insert with correct shape, `IT-{n}` increments, scope
  enforced, transaction rolls back on a bad row, duplicate-skip works.
- A manual end-to-end run uploading the sample file in the running app.

## 15. Open questions

None — project site is a required per-import selection (§9); duplicate-skip
defaults on (§12).
