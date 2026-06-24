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
