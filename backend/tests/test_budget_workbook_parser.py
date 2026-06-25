import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from api.services.budget_workbook_parser import (
    infer_building_type,
    infer_budget_number,
    group_to_grp_category,
    infer_group_from_name,
    canonical_section,
    parse_budget_workbook,
)


def test_infer_group_from_item_name():
    assert infer_group_from_name("Y16MM") == ("Irons", "Materials")
    assert infer_group_from_name("B/WIRE(20kg)") == ("Irons", "Materials")
    assert infer_group_from_name("MARINE BOARD") == ("Woods", "Materials")
    assert infer_group_from_name("CEMENTS") == ("General Materials", "Materials")
    assert infer_group_from_name('1/2" PVC PIPE') == ("Plumbings", "Materials")
    assert infer_group_from_name("MASON (per day)") == ("Labour", "Labour")
    assert infer_group_from_name("DUCT COVER") is None  # ambiguous -> not guessed


def test_canonical_section_fuzzy_match():
    value, matched = canonical_section("SUBSTRUCTURE; (GROUND UP TO DPC LEVEL)")
    assert matched is True
    assert value == "SUBSTRUCTURE (GROUND TO DPC LEVEL)"


def test_canonical_section_fuzzy_rejects_far_text():
    value, matched = canonical_section("COMPLETELY DIFFERENT RANDOM HEADING")
    assert matched is False
    assert value == "COMPLETELY DIFFERENT RANDOM HEADING"


def test_group_inferred_when_no_header_in_sheet():
    rows = [
        ["SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)"],
        ["S/N", "MATERIALS", "QTY", "UNIT", "RATE", "AMOUNT"],
        [1, "Y16MM", 42, "length", 22000, 924000],
        [2, "MARINE BOARD", 3, "sht", 47000, 141000],
    ]
    content = _wb([("FLATS BGT 1", rows)])
    wb = parse_budget_workbook(content)
    by_name = {i.name: i for i in wb.sheets[0].items}
    assert by_name["Y16MM"].grp == "Irons"
    assert by_name["Y16MM"].category == "Materials"
    assert by_name["Y16MM"].budget == "Budget 1 - Flats(Irons)"
    assert by_name["MARINE BOARD"].grp == "Woods"


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


import io
from openpyxl import Workbook


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


def test_parse_recognizes_description_header_variant():
    # Budget 5/6/7 sheets label the name column "DESCRITION" (sic) with an
    # "S/NO" serial header and no UNIT header, though unit data is still in col D.
    rows = [
        ["BUDGET 5"],
        ["FASCIA CASTING, ROOF SLAB AND BLOCK WORK ABOVE ROOF BEAM"],
        ["MATERIALS ONLY"],
        ["S/NO", "DESCRITION", "QTY", "RATE", "AMOUNT"],
        [1, "PLANKS(1X12)", 50, "length", 2700, 135000],
        [2, "3'' NAILS", 1, "bag", 31000, 31000],
    ]
    content = _wb([("D15,18,37-40 BGT 5", rows)])
    wb = parse_budget_workbook(content)
    assert len(wb.sheets) == 1
    sheet = wb.sheets[0]
    assert sheet.building_type == "Fully-detached"
    assert sheet.budget_number == 5
    assert [i.name for i in sheet.items] == ["PLANKS(1X12)", "3'' NAILS"]
    first = sheet.items[0]
    assert first.qty == 50
    assert first.unit == "length"
    assert first.unit_cost == 2700
    assert first.grp == "General Materials"


def test_group_mapping_spelling_and_combined_variants():
    assert group_to_grp_category("LABOR ONLY") == ("Labour", "Labour")
    assert group_to_grp_category("MATERIALS/LABOR") == ("General Materials", "Material/Labour")
    assert group_to_grp_category("MATERIAL/LABOUR") == ("General Materials", "Material/Labour")


def test_parse_skips_summary_and_separator_rows():
    rows = [
        ["SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)"],
        ["MATERIALS/LABOR"],
        ["S/N", "MATERIALS", "QTY", "UNIT", "RATE", "AMOUNT"],
        [1, "EXCAVATION", 5, "m3", 1000, 5000],
        ["……..", None, None, None, None, None],
        ["BUDGET SUMMARY", None, None, None, None, None],
        [2, "FILLING", 3, "m3", 800, 2400],
    ]
    content = _wb([("FLATS BGT 1", rows)])
    wb = parse_budget_workbook(content)
    items = wb.sheets[0].items
    assert [i.name for i in items] == ["EXCAVATION", "FILLING"]
    # The combined header set category to Material/Labour with a real group, and
    # the junk rows did NOT overwrite the section.
    assert items[0].category == "Material/Labour"
    assert items[0].grp == "General Materials"
    assert items[1].section == "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)"


def test_parse_tracks_multiple_sections_per_sheet():
    rows = [
        ["SUBSTRUCTURE; (EXCAVATION TO DPC LEVEL)"],
        ["MATERIAL ONLY"],
        ["S/N", "MATERIALS", "QTY", "UNIT", "RATE", "AMOUNT"],
        [1, "PEGS", 10, "pcs", 500, 5000],
        ["TOTAL", None, None, None, None, 5000],
        ["EXTERNAL PAINTING"],
        ["MATERIAL ONLY"],
        ["S/N", "MATERIALS", "QTY", "UNIT", "RATE", "AMOUNT"],
        [1, "PAINT", 4, "buckets", 20000, 80000],
    ]
    content = _wb([("FLATS BGT 2", rows)])
    wb = parse_budget_workbook(content)
    items = wb.sheets[0].items
    # Both sections' items are captured, each tagged with its OWN section.
    assert [i.name for i in items] == ["PEGS", "PAINT"]
    assert items[0].section == "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)"
    assert items[1].section == "EXTERNAL PAINTING"
