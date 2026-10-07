"""Bind import review to the workbook and enforce its totals on the server."""
import hashlib
import math
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from jose import JWTError, jwt
from api.settings import JWT_SECRET


def import_key(workbook_id, site, sheet, row):
    value = '\0'.join([workbook_id, site, sheet, str(row)])
    return hashlib.sha256(value.encode()).hexdigest()


def sign_preview(parsed, site, user):
    return jwt.encode({
        'purpose': 'budget-import-review', 'site': site, 'owner': user['username'],
        'workbook': parsed.workbook_id,
        'exp': datetime.now(timezone.utc) + timedelta(hours=2),
        'sheets': {s.sheet_name: {'total': s.source_total, 'unreadable': s.total_unreadable,
                               'rows': [[i.sheet_name, i.row_number] for i in s.items]}
                   for s in parsed.sheets},
    }, JWT_SECRET, algorithm='HS256')


def validate_review(payload, site, user):
    if not payload.preview_token:
        if payload.sheet_checks or any(r.source_sheet or r.source_row or r.import_sheet for r in payload.rows):
            raise HTTPException(422, 'Preview the workbook before importing source rows.')
        return {}
    try:
        manifest = jwt.decode(payload.preview_token, JWT_SECRET, algorithms=['HS256'], options={'require_exp': True})
    except JWTError as exc:
        raise HTTPException(422, 'The workbook preview expired or is invalid. Preview the workbook again.') from exc
    if manifest.get('purpose') != 'budget-import-review' or manifest.get('site') != site or manifest.get('owner') != user['username']:
        raise HTTPException(422, 'The workbook preview does not belong to this import.')
    checks = {c.sheet_name: c for c in payload.sheet_checks}
    if len(checks) != len(payload.sheet_checks) or not checks:
        raise HTTPException(422, 'Review and confirm each selected budget before importing.')
    grouped = {name: [] for name in checks}
    keys, seen = {}, set()
    for index, row in enumerate(payload.rows):
        source = manifest['sheets'].get(row.import_sheet)
        check = checks.get(row.import_sheet)
        if not source or not check or [row.source_sheet, row.source_row] not in source['rows']:
            raise HTTPException(422, f'Row {index + 1}: source row does not match the workbook preview.')
        if row.budget_scope != check.budget_scope.strip():
            raise HTTPException(422, f'Row {index + 1}: building scope does not match its reviewed budget.')
        if row.source_qty is None or not math.isclose(row.qty, row.source_qty * check.multiplier, rel_tol=1e-10, abs_tol=1e-8):
            raise HTTPException(422, f'Row {index + 1}: quantity does not match the confirmed multiplier.')
        key = import_key(manifest['workbook'], site, row.source_sheet, row.source_row)
        if key in seen:
            raise HTTPException(422, 'The same source row was submitted more than once.')
        seen.add(key)
        keys[index] = key
        grouped[row.import_sheet].append(row.qty * row.unit_cost)
    for name, check in checks.items():
        source = manifest['sheets'].get(name)
        if not source or source['unreadable']:
            raise HTTPException(422, f'{name}: correct the unreadable total in Excel and preview again.')
        if not check.confirmed:
            raise HTTPException(422, f'{name}: confirm the building scope, multiplier and total.')
        expected = source['total'] if source['total'] is not None else check.reviewed_total
        if expected is None:
            raise HTTPException(422, f'{name}: enter and confirm the reviewed total.')
        try:
            actual = math.fsum(grouped[name])
        except OverflowError:
            actual = float('inf')
        if not math.isfinite(actual) or abs(actual - expected) > .01:
            raise HTTPException(422, f'{name}: imported total differs from the reviewed budget. Correct the rows before importing.')
    return keys
