"""A .docx Bobble makes names only the fonts it uses (docx_fonts.own_fonts).

The canvas's font check counts the document defaults and every style; Word's
template named Calibri and Cambria in both, and in its theme, so every report
opened with "Missing document fonts: Cambria, Calibri (substitutes shown)".
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import doc_render  # noqa: E402
import html2docx  # noqa: E402


def _parts(path: Path) -> dict[str, str]:
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n).decode("utf-8", "replace") for n in z.namelist() if n.endswith(".xml")}


def _no_template_fonts(path: Path) -> None:
    parts = _parts(path)
    # What the canvas reads: the body, the styles (with the document defaults)
    # and the theme they resolve through. settings.xml's "Cambria Math" is
    # Word's equation font — not a text font, and not read by the check.
    for name, xml in parts.items():
        if name not in ("word/document.xml", "word/styles.xml") and not name.startswith("word/theme/"):
            continue
        assert "Calibri" not in xml, f"{name} names Calibri"
        assert "Cambria" not in xml, f"{name} names Cambria"
    styles = parts["word/styles.xml"]
    for attr in ("asciiTheme", "hAnsiTheme", "cstheme"):
        assert attr not in styles, f"styles.xml still resolves fonts through the theme ({attr})"
    assert 'w:ascii="Helvetica Neue"' in styles


def test_a_report_from_a_spec_names_only_its_own_fonts(tmp_path):
    spec = {
        "title": "Leak detection",
        "blocks": [
            {"type": "heading", "text": "Summary"},
            {"type": "paragraph", "text": "Water damage is the costliest routine claim."},
        ],
    }
    out = doc_render.build(spec, tmp_path / "r.docx")
    _no_template_fonts(out)


def test_a_document_from_html_names_only_its_own_fonts(tmp_path):
    out = tmp_path / "h.docx"
    html2docx.build([], out)
    _no_template_fonts(out)
