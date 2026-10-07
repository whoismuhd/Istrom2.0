"""Read budget controls without executing Excel formulas or external links."""
import re
from collections import Counter

from openpyxl.utils.cell import range_boundaries, get_column_letter

REFERENCE = re.compile(r"^=?'((?:[^']|'')+)'!\$?([A-Z]{1,3})\$?(\d+)$", re.I)
TOKEN = re.compile(r'\s*(SUM|\$?[A-Z]{1,3}\$?\d+|\d+(?:\.\d*)?|\.\d+|[()+*/,:%-])', re.I)


def summary_controls(workbook):
    controls = {}
    for sheet in workbook:
        if sheet.sheet_state != 'visible' or not re.search(r'summary', sheet.title, re.I):
            continue
        for row in sheet.iter_rows(max_row=min(sheet.max_row or 10000, 10000), max_col=min(sheet.max_column or 100, 100)):
            labels = [str(cell.value).strip() for cell in row if cell.data_type != 'f' and isinstance(cell.value, str)]
            for cell in row:
                match = REFERENCE.fullmatch(str(cell.value or ''))
                if match:
                    title, col, number = match.groups()
                    title = title.replace("''", "'")
                    if title in workbook.sheetnames:
                        controls[title] = {'cell': f'{col.upper()}{number}', 'summary_label': ' '.join(labels),
                                           'summary_cell': f'{sheet.title}!{cell.coordinate}'}
    return controls


def _combine(left, right, sign=1):
    constant = left[0] + sign * right[0]
    weights = dict(left[1])
    for key, value in right[1].items():
        weights[key] = weights.get(key, 0) + sign * value
    return constant, weights


def _scale(value, factor):
    return value[0] * factor, {key: weight * factor for key, weight in value[1].items()}


def trace_total(sheet, cell, leaves):
    """Return linear weights for amount cells. Reject unsupported formula syntax."""
    cache, visiting = {}, set()
    # Read-only worksheets otherwise re-read XML for every cell reference.
    cells = {f'{get_column_letter(col)}{row}': value for row, values in enumerate(sheet.iter_rows(values_only=True), 1)
             for col, value in enumerate(values, 1) if value is not None}

    def reference(address):
        address = address.replace('$', '').upper()
        if address in leaves:
            return 0, {address: 1}
        if address in cache:
            return cache[address]
        if address in visiting or len(visiting) > 80 or len(cache) > 50000:
            raise ValueError('Circular or overly complex total formula.')
        col, row, _, _ = range_boundaries(address)
        if col > 100 or row > 10000:
            raise ValueError('Total references a cell outside the supported range.')
        visiting.add(address)
        value = cells.get(address)
        if isinstance(value, str) and value.startswith('='):
            result = formula(value[1:])
        elif value is None or isinstance(value, str) and not value.strip():
            result = (0, {})
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            result = (float(value), {})
        else:
            raise ValueError(f'Total references an unreadable value at {address}.')
        visiting.remove(address)
        cache[address] = result
        return result

    def formula(text):
        tokens, pos = [], 0
        while pos < len(text):
            match = TOKEN.match(text, pos)
            if not match:
                if not text[pos:].strip():
                    break
                raise ValueError('Total formula uses an unsupported function or external reference.')
            tokens.append(match.group(1).upper())
            pos = match.end()
        index = 0

        def take(token=None):
            nonlocal index
            if index >= len(tokens) or token and tokens[index] != token:
                raise ValueError('Incomplete total formula.')
            value = tokens[index]
            index += 1
            return value

        def atom():
            nonlocal index
            token = take()
            if token in ('+', '-'):
                return _scale(atom(), -1 if token == '-' else 1)
            if token == '(':
                value = expression()
                take(')')
                return value
            if token == 'SUM':
                take('(')
                value = (0, {})
                while True:
                    if index + 1 < len(tokens) and tokens[index + 1] == ':':
                        start = take().replace('$', '')
                        take(':')
                        end = take().replace('$', '')
                        c1, r1, c2, r2 = range_boundaries(f'{start}:{end}')
                        if c2 > 100 or r2 > 10000 or (c2-c1+1)*(r2-r1+1) > 50000:
                            raise ValueError('Total range is too large.')
                        for row_number in range(r1, r2 + 1):
                            for column in range(c1, c2 + 1):
                                value = _combine(value, reference(f'{get_column_letter(column)}{row_number}'))
                    else:
                        value = _combine(value, expression())
                    if index < len(tokens) and tokens[index] == ',':
                        take(',')
                    else:
                        break
                take(')')
                return value
            if re.fullmatch(r'\$?[A-Z]+\$?\d+', token):
                return reference(token)
            return float(token), {}

        def product():
            nonlocal index
            value = atom()
            if index < len(tokens) and tokens[index] == '%':
                take('%')
                value = _scale(value, .01)
            while index < len(tokens) and tokens[index] in ('*', '/'):
                operator = take()
                right = atom()
                if operator == '/' and right[1] or operator == '*' and value[1] and right[1]:
                    raise ValueError('Total formula multiplies two calculated amounts.')
                if operator == '/' and right[0] == 0:
                    raise ValueError('Total formula divides by zero.')
                if operator == '*' and not value[1] and right[1]:
                    value = _scale(right, value[0])
                else:
                    value = _scale(value, right[0] if operator == '*' else 1 / right[0])
            return value

        def expression():
            value = product()
            while index < len(tokens) and tokens[index] in ('+', '-'):
                operator = take()
                value = _combine(value, product(), -1 if operator == '-' else 1)
            return value

        result = expression()
        if index != len(tokens):
            raise ValueError('Unsupported total formula syntax.')
        return result

    return reference(cell)


def apply_sheet_control(parsed, values, formulas, control=None):
    if not control:
        # Prefer an explicit grand total. A section subtotal is not a sheet total.
        candidates = []
        for row in values.iter_rows():
            label = ' '.join(str(c.value).strip() for c in row if isinstance(c.value, str) and c.data_type != 'e')
            if re.search(r'grand\s+total|total\s+budgeted\s+amount|(?:^|\s)for\s+\d+\s+(?:blocks?|units?)', label, re.I):
                amounts = [c for c in row if isinstance(c.value, (int, float)) and not isinstance(c.value, bool)]
                if amounts:
                    candidates.append({'cell': amounts[-1].coordinate, 'summary_label': '', 'summary_cell': ''})
                else:
                    formula_cells = [c for c in formulas[row[0].row] if c.data_type == 'f']
                    if formula_cells:
                        candidates.append({'cell': formula_cells[-1].coordinate, 'summary_label': '', 'summary_cell': ''})
        control = candidates[-1] if candidates else None
    if not control:
        parsed.warnings.append('No sheet total was found. Confirm the reviewed total before importing.')
        return
    coordinate = control['cell']
    total = values[coordinate].value
    parsed.source_total_cell = coordinate
    parsed.source_total_formula = str(formulas[coordinate].value or '')
    row = values[coordinate].row
    parsed.source_total_label = ' '.join(str(c.value).strip() for c in values[row] if isinstance(c.value, str) and c.data_type != 'e')
    parsed.summary_label = control['summary_label']
    if not isinstance(total, (int, float)) or isinstance(total, bool) or total < 0:
        parsed.warnings.append(f'{coordinate}: the sheet total has no readable saved result. Correct and save the workbook in Excel.')
        parsed.total_unreadable = True
        return
    parsed.source_total = float(total)
    if not parsed.source_total_formula.startswith('='):
        parsed.source_total_formula = ''
        parsed.requires_confirmation = True
        parsed.warnings.append('Saved total has no formula. Verify the quantity multiplier against the building scope.')
        return
    leaves = {item.amount_cell for item in parsed.items if item.amount_cell}
    try:
        constant, weights = trace_total(formulas, coordinate, leaves)
        positive = [round(v, 8) for v in weights.values() if v > 0]
        distinct = set(positive)
        if positive:
            parsed.suggested_multiplier = Counter(positive).most_common(1)[0][0]
        if constant or any(v < 0 for v in weights.values()) or len(distinct) > 1:
            raise ValueError('The Excel total includes adjustments or counts some lines more than once. Review the source formula and quantities.')
        if positive:
            multiplier = Counter(positive).most_common(1)[0][0]
            if not 0 < multiplier <= 10000:
                raise ValueError('The total uses an unsupported multiplier.')
            parsed.suggested_multiplier = multiplier
            parsed.multiplier_evidence = f'{coordinate}: {parsed.source_total_formula}'
            for item in parsed.items:
                if item.amount_cell and not weights.get(item.amount_cell, 0):
                    item.excluded_by_default = True
                    item.warnings.append(f'Excluded: this line is outside the budget formula at {coordinate}.')
        counts = []
        for label in [parsed.source_total_label, parsed.summary_label]:
            match = re.search(r'(\d+)\s*-?\s*(blocks?|units?)\b', label, re.I)
            if match:
                counts.append((int(match.group(1)), match.group(2).rstrip('s').lower()))
        if counts and (len(set(counts)) > 1 or counts[0][0] != parsed.suggested_multiplier and counts[0][1] == 'block'):
            parsed.warnings.append('Building counts in the labels differ from the total formula. Confirm the scope and multiplier below.')
    except (ValueError, TypeError, ZeroDivisionError, RecursionError) as exc:
        parsed.warnings.append(str(exc))
    parsed.requires_confirmation = True
