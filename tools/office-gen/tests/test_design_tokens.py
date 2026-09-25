"""
VQ-04 — Python and TypeScript read the same design tokens.

design_tokens.json is generated from packages/design-kit/src/kits/*.json (the
TypeScript side holds the file to the kits byte for byte: export.test.ts).
This is the other half: the Python reader returns exactly the values in the
kit files, and the arithmetic agrees — the contrast gates the TS validator
enforces hold when Python computes them.

    tools/office-gen/.venv/bin/python -m pytest tools/office-gen/tests/test_design_tokens.py -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
OFFICE = HERE.parent
KITS_DIR = OFFICE.parents[1] / "packages" / "design-kit" / "src" / "kits"
sys.path.insert(0, str(OFFICE))

import design_tokens as dt  # noqa: E402

KIT_FILES = sorted(KITS_DIR.glob("*.json"))


def test_the_export_holds_every_kit_file_and_nothing_else():
    assert len(KIT_FILES) >= 6
    assert sorted(dt.kit_ids()) == sorted(p.stem for p in KIT_FILES)
    assert dt.kit_ids()[0] == dt.load()["default"] == "paper-teal"


@pytest.mark.parametrize("path", KIT_FILES, ids=lambda p: p.stem)
def test_python_reads_exactly_what_the_kit_file_says(path):
    source = json.loads(path.read_text(encoding="utf-8"))
    assert dt.kit(source["id"]) == source


@pytest.mark.parametrize("path", KIT_FILES, ids=lambda p: p.stem)
def test_the_gates_hold_in_python_arithmetic_too(path):
    kit = json.loads(path.read_text(encoding="utf-8"))
    for mode in ("light", "dark"):
        c = kit[mode]
        for role in dt.ROLES:
            assert c[role].startswith("#") and len(c[role]) == 7, (kit["id"], mode, role)
        for ground in ("paper", "surface"):
            assert dt.contrast(c["ink"], c[ground]) >= 7, (kit["id"], mode, "ink", ground)
            assert dt.contrast(c["mute"], c[ground]) >= 4.5, (kit["id"], mode, "mute", ground)
            for s in c["series"]:
                assert dt.contrast(s, c[ground]) >= 3, (kit["id"], mode, s, ground)
        assert dt.contrast(c["onAccent"], c["accent"]) >= 4.5, (kit["id"], mode)
        for ground in ("paper", "surface", "tint"):
            assert dt.contrast(c["accentInk"], c[ground]) >= 4.5, (kit["id"], mode, "accentInk", ground)


def test_lookup_is_forgiving_and_falls_back_to_the_default():
    assert dt.kit("Paper & teal")["id"] == "paper-teal"
    assert dt.kit("slate_cobalt")["id"] == "slate-cobalt"
    assert dt.kit("no-such-kit")["id"] == "paper-teal"
    assert dt.colours("fog", "dark")["paper"] == "#161718"
    with pytest.raises(ValueError):
        dt.colours("fog", "sepia")


def test_a_document_names_a_family_it_can_carry():
    # sage & moss: SF Pro Rounded is macOS-private — a deck naming it got Times.
    assert dt.first_family("'SF Pro Rounded', ui-rounded, 'Avenir Next', 'Helvetica Neue', sans-serif") == "Avenir Next"
    assert dt.first_family("-apple-system, 'SF Pro Display', 'Helvetica Neue', Helvetica") == "Helvetica Neue"
    assert dt.first_family("'New York', 'Iowan Old Style', serif") == "Iowan Old Style"
    assert dt.first_family("system-ui, sans-serif") == "Helvetica Neue"
    assert dt.first_family("Charter, Georgia, serif") == "Charter"
    for kit_id in dt.kit_ids():
        for role in ("display", "text"):
            name = dt.first_family(dt.font_stack(kit_id, role, "mac")).lower()
            assert not name.startswith(("sf ", "ui-", "-apple")) and name not in ("serif", "sans-serif"), (kit_id, role, name)


def test_fonts_and_the_renderers_own_palette():
    assert dt.first_family(dt.font_stack("bone-oxblood", "display", "mac")) == "Iowan Old Style"
    assert dt.first_family(dt.font_stack("fog", "text", "mac")) == "Helvetica Neue"
    p = dt.kit_palette("paper-teal")
    assert (p.primary, p.accent, p.paper) == ("#00756E", "#D0661C", "#FBFAF7")
    assert p.on(p.deep) == p.paper
    # Every kit's primary reads as a heading — palette.build()'s own 4.5:1 rule.
    for kit_id in dt.kit_ids():
        k = dt.kit_palette(kit_id)
        assert dt.contrast(k.primary, k.paper) >= 4.5, kit_id
    assert dt.kit_palette("graphite-amber").primary == "#935D00"
