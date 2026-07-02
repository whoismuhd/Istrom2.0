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
