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
