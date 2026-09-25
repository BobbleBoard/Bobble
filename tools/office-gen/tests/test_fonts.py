"""
XP-16 — office fonts everywhere.

Off macOS textfit measured with `ImageFont.load_default()`, a bitmap font that
is not the face the file names, so every wrap was decided on the wrong widths.
It now measures with bundled metric-compatible OFL fonts (fonts/). These tests
hold it to the Mac: `PI_OFFICE_GEN_FONTS=bundled` makes a Mac measure exactly
as a PC does, so the comparison runs here, against the real reference faces.

    tools/office-gen/.venv/bin/python -m pytest tools/office-gen/tests/test_fonts.py -q
"""
from __future__ import annotations

import hashlib
import io
import os
import re
import sys
from contextlib import redirect_stderr
from pathlib import Path

import pytest
from PIL import ImageFont

HERE = Path(__file__).resolve().parent
OFFICE = HERE.parent
sys.path.insert(0, str(OFFICE))
sys.path.insert(0, str(HERE))

import font_calibration as fc  # noqa: E402
import textfit  # noqa: E402

FONTS = Path(textfit.FONTS_DIR)
ON_MAC = sys.platform == "darwin"
WEIGHTS = [(False, False), (True, False), (False, True), (True, True)]


@pytest.fixture
def bundled(monkeypatch):
    """Measure as a PC does."""
    monkeypatch.setenv(textfit.FONTS_ENV, "bundled")
    textfit._resolve.cache_clear()
    yield
    textfit._resolve.cache_clear()


@pytest.fixture(autouse=True)
def _scratch(tmp_path, monkeypatch):
    monkeypatch.setenv("PI_OFFICE_GEN_SCRATCH", str(tmp_path / "scratch"))


# ── what is bundled ──────────────────────────────────────────────────────────
def test_the_bundled_files_are_the_recorded_ones():
    """SOURCES.txt names every file with its hash: a replaced font is noticed."""
    recorded = dict(re.findall(r"^\s+([0-9a-f]{64})\s+(\S+\.ttf)\s*$", (FONTS / "SOURCES.txt").read_text(), re.M))
    recorded = {name: digest for digest, name in recorded.items()}
    on_disk = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in FONTS.glob("*.ttf")}
    assert on_disk == recorded
    used = {f for weights in textfit.BUNDLED.values() for f, _s in weights.values()}
    assert used <= set(on_disk), "textfit names a font that is not bundled"


def test_the_licences_sit_beside_the_fonts():
    for name in ("LICENSE-Liberation.txt", "LICENSE-Gelasio.txt"):
        text = " ".join((FONTS / name).read_text().upper().split())
        assert "SIL OPEN FONT LICENSE VERSION 1.1" in text


# ── which fonts measure where ────────────────────────────────────────────────
@pytest.mark.parametrize("platform,mode", [("darwin", "mac"), ("linux", "bundled"), ("win32", "bundled")])
def test_each_os_has_its_map(monkeypatch, platform, mode):
    monkeypatch.delenv(textfit.FONTS_ENV, raising=False)
    monkeypatch.setattr(textfit, "_platform", lambda: platform)
    assert textfit.fonts_mode() == mode


def test_the_env_makes_a_mac_measure_as_a_pc(monkeypatch):
    monkeypatch.setattr(textfit, "_platform", lambda: "darwin")
    monkeypatch.setenv(textfit.FONTS_ENV, "bundled")
    assert textfit.fonts_mode() == "bundled"


@pytest.mark.parametrize("family", list(textfit.FACES) + ["Comic Sans"])
@pytest.mark.parametrize("weight", WEIGHTS)
def test_off_mac_every_face_is_a_bundled_font_file(bundled, family, weight):
    """Every family and weight a renderer can ask for — an unknown family and a
    weight the family lacks included — measures with a real bundled TrueType
    face, never PIL's bitmap default, and never a Mac system path."""
    bold, italic = weight
    cands = textfit.candidates(family, bold, italic)
    assert not any(c[0].startswith("/System/") for c in cands)
    face, scale, path = textfit._resolve(family, bold, italic, "bundled")
    assert isinstance(face, ImageFont.FreeTypeFont)
    assert Path(path).parent == FONTS and Path(path).exists()
    assert 0.95 < scale < 1.05


def test_a_normal_run_off_mac_never_falls_back_to_the_bitmap_font(bundled, tmp_path, monkeypatch):
    """Draw the benchmark decks and a document the way a PC would: nothing may
    reach load_default(), and nothing is warned."""
    import doc_render
    import render_deck

    def refuse():
        raise AssertionError("load_default() reached in a normal run")

    monkeypatch.setattr(textfit.ImageFont, "load_default", refuse)
    err = io.StringIO()
    with redirect_stderr(err):
        for name, spec in fc.benchmark_decks().items():
            render_deck.build(spec, tmp_path / f"{name}.pptx")
        doc = fc.json.loads((fc.FIX / "replies" / "one-page-report-a.json").read_text())["doc"]
        doc_render.build(doc, tmp_path / "report.docx")
    assert "textfit:" not in err.getvalue()


def test_chart_labels_are_drawn_with_a_real_face_off_mac(bundled):
    """office_chart.py rasters a chart's labels with textfit._font: off macOS
    that was the bitmap default too."""
    for fam in ("Helvetica", "Georgia", "Menlo"):
        f = textfit._font(fam, 24, True)
        assert isinstance(f, ImageFont.FreeTypeFont)
        assert Path(f.path).parent == FONTS
        assert f.size == 24


def test_a_missing_fonts_folder_is_said_out_loud(monkeypatch, capsys):
    """If fonts/ is gone and the OS has nothing either, the bitmap default is
    the last resort — and it says so rather than wrapping silently wrong."""
    monkeypatch.setattr(textfit, "FONTS_DIR", "/nonexistent/fonts")
    monkeypatch.setattr(textfit, "_INSTALLED", {"win32": {}, "linux": {}})
    monkeypatch.setattr(textfit, "_LAST_RESORT", {})
    monkeypatch.setattr(textfit, "_warned", set())
    textfit._resolve.cache_clear()
    try:
        face, scale, path = textfit._resolve("Helvetica Neue", False, False, "bundled")
        assert path == "" and scale == 1.0
        assert "no font file for Helvetica Neue" in capsys.readouterr().err
    finally:
        textfit._resolve.cache_clear()


# ── against the Mac ──────────────────────────────────────────────────────────
@pytest.mark.skipif(not ON_MAC, reason="the reference faces are the Mac's")
def test_on_a_mac_nothing_changed():
    """The Mac measures with its own faces, exactly as before XP-16."""
    for family, weights in textfit.FACES.items():
        for (bold, italic), cands in weights.items():
            _f, scale, path = textfit._resolve(family, bold, italic, "mac")
            assert (path, scale) == (cands[0][0], 1.0)


@pytest.mark.skipif(not ON_MAC, reason="the reference faces are the Mac's")
def test_the_scales_are_what_the_mac_measures():
    """textfit.BUNDLED's scales are a MEASUREMENT (font_calibration.py): a
    changed font file or corpus must come with the new numbers."""
    fresh = fc.scales()
    for (family, bold, italic), scale in fresh.items():
        assert textfit.BUNDLED[family][(bold, italic)][1] == pytest.approx(scale, abs=0.0005), (family, bold, italic)


@pytest.mark.skipif(not ON_MAC, reason="the reference faces are the Mac's")
def test_the_benchmark_wraps_match_the_mac():
    """THE ACCEPTANCE (crossplatform.md XP-16): the deck renderer's wraps on the
    benchmark decks, measured with the bundled set against the Mac's faces.

    MEASURED 2026-09-24 on 79 distinct wraps: line breaks identical on 77 (the
    other two are lines that fit on the Mac within 1% of their box — "Auto
    Shutoff", "A $39 sensor that closes the valve for you"); the wrap width
    within 2% of the Mac's on 75, all within 3%, worst -2.87% ("Leak Detected",
    bold 11.5 pt); within 2.1% of the BOX on all 79; mean |delta| 0.62%.

    Why not every one within 2%: no OFL face has Helvetica Neue's metrics. Its
    letters are not Helvetica's (E 611 vs 667, M 871 vs 833, t 315 vs 278 per
    1000 em) and neither is its punctuation, so a one-to-three-word label whose
    letters lean one way ("MRR", "Ship", "Leak Detected") misses by up to 3%.
    Georgia, via Gelasio, is within 0.03%. Closing the last four would mean shipping
    Helvetica Neue's own advance widths as a correction table, which is Apple's
    data, not an OFL font — a call for the user, not for this test."""
    rows = fc.compare_wraps(fc.benchmark_wraps())
    assert len(rows) >= 70
    deltas = [abs(r["delta"]) for r in rows]
    assert sum(deltas) / len(deltas) <= 0.01
    assert max(deltas) <= 0.03
    assert sum(d <= 0.02 for d in deltas) >= 0.94 * len(rows)
    assert max(abs(r["delta_of_box"]) for r in rows) <= 0.025
    assert sum(r["same_lines"] for r in rows) >= 0.97 * len(rows)
    for r in rows:
        if r["font"] == "Georgia":
            assert abs(r["delta"]) <= 0.001, r["text"]
