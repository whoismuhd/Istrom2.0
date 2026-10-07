"""Serve the blank, section-based budget workbook bundled with the app."""
from pathlib import Path


TEMPLATE_PATH = Path(__file__).resolve().parents[1] / "assets" / "istrom-import-template.xlsx"


def build_import_template() -> bytes:
    return TEMPLATE_PATH.read_bytes()
