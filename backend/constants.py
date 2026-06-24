"""Constants and reference data for Istrom Inventory Management System."""

PROPERTY_TYPES = ["", "Flats", "Terraces", "Semi-detached", "Fully-detached"]

BUILDING_SUBTYPE_OPTIONS = {
    "Flats": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13"],
    "Terraces": [
        "A (T1-T6)", "B (T7-T12)", "C (T13-T18)", "D (T19-T24)", "E (T25-T30)", "F (T31-T36)",
        "G (T37-T42)", "H (T43-T48)", "I (T49-T53)", "J (T54-T58)", "K (T59-T64)", "L (T65-T70)",
        "M (T71-T76)", "N (T77-T82)", "O (T83-T88)", "P (T89-T94)", "Q (T95-T100)", "R (T101-T106)",
        "S (T107-T112)", "T (T113-T118)", "U (T119-T124)", "V (T125-T130)", "W (T131-T136)", "X (T137-T142)"
    ],
    "Semi-detached": [f"SD {i}" for i in range(1, 30)],
    "Fully-detached": [f"D{i}" for i in range(1, 53)],
}

BUILDING_SUBTYPE_LABELS = {
    "Flats": "Select Block (Flats)",
    "Terraces": "Select Terrace Cluster",
    "Semi-detached": "Select Semi-detached Unit",
    "Fully-detached": "Select Fully-detached Plot",
}

CONSTRUCTION_SECTIONS = [
    "SUBSTRUCTURE (GROUND TO DPC LEVEL)",
    "SUBSTRUCTURE (EXCAVATION TO DPC LEVEL)",
    "TERRACES (6-UNITS) DPC(TERRACE SUBSTRUCTURE)",
    "SUPERSTRUCTURE: GROUND FLOOR; (COLUMN, LINTEL AND BLOCK WORK)",
    "SUPERSTRUCTURE, GROUND FLOOR; (SLAB,BEAMS AND STAIR CASE)",
    "SUPERSTRUCTURE, FIRST FLOOR; (COLUMN, LINTEL AND BLOCK WORK)",
    "SUPERSTRUCTURE FIRST FLOOR SLAB WORK (SLAB, BEAMS & STAIRCASE)",
    "SUPERSTRUCTURE, 1ST FLOOR; (COLUMN, LINTEL, BLOCK WORK AND LIFT SHIFT)",
    "SUPERSTRUCTURE, SECOND FLOOR; (SLAB,BEAMS AND STAIR CASE)",
    "FASCIA CASTING, ROOF SLAB AND BLOCK WORK ABOVE ROOF BEAM",
    "ROOF BEAMS, CONCRETE FASCIA, ROOF SLAB & PARAPET WALL",
    "TERRACE BEAM, BLOCK WORK, COLUMN & SHORT ROOF",
    "ROOF CARCASS AND ROOF COVERING",
    "ROOF COVERING",
    "TIMBER CARCASS AND ROOF COVERING",
    "AC PIPING",
    "FELTING & TILING OF ROOF SLAB",
    "HAND RAILS",
    "EXTERNAL PLASTERING",
    "TYROLINE",
    "SCREEDING",
    "EXTERNAL PAINTING",
    "SCAFFOLDING",
    "WINDOWS & ALUMINIUM GLAZING",
    "DOORS",
    "EXTERNAL SEWING & GUAGING",
    "BLOCK WORK TO FINAL HEIGHT",
    "DESIGN WALL & ENTRANCE",
    "EXTERNAL ELECTRICAL DROPPINGS",
    "RAILINGS",
]

BUDGET_5_SUBCATEGORIES = [
    "BLOCKWORK ABOVE ROOF BEAM",
    "ROOF BEAM & FASCIA CASTING",
    "ROOF CARCASS AND ROOF COVERING",
    "ROOF COVERING",
    "FELTING & TILING OF ROOF SLAB",
]

CATEGORY_OPTIONS = ["Materials", "Labour", "Material/Labour"]

BUDGET_CATEGORIES = ["General Materials", "Woods", "Plumbings", "Irons", "Labour", "Electrical", "Mechanical"]

DEFAULT_ADMIN_CODE = "Istrom2026"
DEFAULT_USER_CODE = "user123"
