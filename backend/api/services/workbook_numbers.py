"""Read non-negative budget numbers without stripping unknown text."""
import math
import re


def budget_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        text = re.sub(r'^(?:[₦$£€]|NGN\b|NAIRA\b)\s*', '', text, flags=re.I)
        text = re.sub(r'\s*(?:[₦$£€]|\bNGN|\bNAIRA)$', '', text, flags=re.I).strip()
        # Spaces, NBSPs and apostrophes may separate complete groups of thousands.
        if re.fullmatch(r"[+]?\d{1,3}(?:[\s\u00a0\u202f']\d{3})+(?:[.,]\d+)?", text):
            text = re.sub(r"[\s\u00a0\u202f']", '', text)
        if re.fullmatch(r'[+]?\d{1,3}(,\d{3})+(\.\d+)?', text):
            text = text.replace(',', '')
        elif re.fullmatch(r'[+]?\d{1,3}(\.\d{3})+,\d+', text):
            text = text.replace('.', '').replace(',', '.')
        elif re.fullmatch(r'[+]?\d+,\d{1,2}', text):
            text = text.replace(',', '.')
        if not re.fullmatch(r'[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?', text):
            return None
        number = float(text)
    return number if math.isfinite(number) and number >= 0 else None
