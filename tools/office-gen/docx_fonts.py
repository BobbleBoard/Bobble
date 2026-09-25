"""A .docx names the fonts it uses, and nothing else.

python-docx starts every document from Word's default template, which names
Calibri (body) and Cambria (headings) three ways: in its theme (major/minor
fonts), in the document defaults (as theme references), and in its styles (as
theme references too). Bobble sets every run in its own fonts, so none of that
is ever drawn — but the canvas's font check counts the defaults and every
style, and a report set entirely in Helvetica Neue opened with "Missing
document fonts: Cambria, Calibri (substitutes shown)" (the render-from-spec
report, 2026-09-25). `own_fonts` points all three at the document's own fonts.
"""
from __future__ import annotations

from docx.oxml.ns import qn

_THEME_ATTRS = ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme")
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _set_fonts(rfonts, body: str, heading: str) -> None:
    """One w:rFonts: a theme reference becomes the font it stands for."""
    major = any("major" in (rfonts.get(qn(a)) or "") for a in _THEME_ATTRS)
    face = heading if major else body
    had = any(rfonts.get(qn(a)) is not None for a in _THEME_ATTRS)
    for a in _THEME_ATTRS:
        if rfonts.get(qn(a)) is not None:
            del rfonts.attrib[qn(a)]
    for a in ("w:ascii", "w:hAnsi", "w:cs"):
        if had or rfonts.get(qn(a)) in ("Calibri", "Cambria", "Calibri Light"):
            rfonts.set(qn(a), face)


def own_fonts(doc, body: str, heading: str | None = None) -> None:
    heading = heading or body
    styles = doc.styles.element
    # The document defaults: explicit, never a theme reference.
    rpr_default = styles.find(qn("w:docDefaults") + "/" + qn("w:rPrDefault") + "/" + qn("w:rPr"))
    if rpr_default is not None:
        rfonts = rpr_default.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = rpr_default.makeelement(qn("w:rFonts"), {})
            rpr_default.insert(0, rfonts)
        _set_fonts(rfonts, body, heading)
        for a in ("w:ascii", "w:hAnsi", "w:cs"):
            rfonts.set(qn(a), body)
    # Every style's own reference.
    for rfonts in styles.iter(qn("w:rFonts")):
        _set_fonts(rfonts, body, heading)
    # The theme's major and minor fonts (anything that still resolves through it).
    for rel in doc.part.rels.values():
        if not rel.reltype.endswith("/theme"):
            continue
        part = rel.target_part
        blob = part.blob
        try:
            from lxml import etree
            root = etree.fromstring(blob)
        except Exception:
            continue
        for kind, face in (("majorFont", heading), ("minorFont", body)):
            for latin in root.iter("{%s}%s" % (_A, kind)):
                el = latin.find("{%s}latin" % _A)
                if el is not None:
                    el.set("typeface", face)
        part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
