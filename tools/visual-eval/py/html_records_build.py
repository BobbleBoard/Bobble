"""
Measured HTML element records (html_measure.mjs) -> a NATIVE file through the
repo's own dormant emitters in tools/office-gen:

  pptx: html2pptx.build, one slide per record list, then the post-pass the
        research found necessary (visual-quality.md §2.2.1 (c), D36): letter
        spacing onto the run (`spc`), each one-line box widened 12% so a
        renderer that wraps anyway never breaks a word the browser kept whole,
        and a full-radius square drawn as an ellipse.
  pdf:  html2pdf.build, one page per record list (only the first is used for a
        single-page document), at the page size given.

    python html_records_build.py pptx records.json out.pptx
    python html_records_build.py pdf  records.json out.pdf [w_pt h_pt]
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "office-gen"))

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def build_pptx(slides: list, out: Path) -> None:
    import html2pptx
    from pptx import Presentation
    from pptx.util import Emu

    prs = None
    for recs in slides:
        html2pptx.build(recs, out, existing=prs)
        prs = Presentation(str(out))
        sl = prs.slides[len(prs.slides) - 1]
        texts = [r for r in recs if r.get("tag") not in html2pptx.SKIP and (r.get("text") or "").strip()
                 and r.get("tag") not in ("path", "polyline", "polygon", "circle")]
        boxes = [s for s in sl.shapes if s.has_text_frame and s.name.startswith("TextBox")]
        for rec, box in zip(texts, boxes):
            ls = rec.get("letterSpacing") or "normal"
            if ls.endswith("px"):
                for p in box.text_frame.paragraphs:
                    for r in p.runs:
                        r.font._rPr.set("spc", str(int(float(ls[:-2]) * 0.75 * 100)))
            grow = int(box.width * 0.12)
            align = rec.get("align")
            box.width = Emu(box.width + grow)
            if align == "center":
                box.left = Emu(box.left - grow // 2)
            elif align == "right":
                box.left = Emu(box.left - grow)
        for s in sl.shapes:
            geom = s._element.spPr.find(f"{A}prstGeom")
            if geom is not None and geom.get("prst") == "roundRect" and abs(s.width - s.height) < 12700:
                try:
                    if s.adjustments[0] >= 0.499:
                        geom.set("prst", "ellipse")
                        for av in geom.findall(f"{A}avLst"):
                            for gd in list(av):
                                av.remove(gd)
                except (IndexError, ValueError):
                    pass
        prs.save(str(out))


def build_pdf(pages: list, out: Path, w_pt: float, h_pt: float) -> None:
    import html2pdf
    html2pdf.build(pages[0], out, w_pt=w_pt, h_pt=h_pt)


if __name__ == "__main__":
    kind, src, dst = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    data = json.loads(src.read_text())
    dst.parent.mkdir(parents=True, exist_ok=True)
    if kind == "pptx":
        build_pptx(data, dst)
    else:
        w = float(sys.argv[4]) if len(sys.argv) > 4 else 612.0
        h = float(sys.argv[5]) if len(sys.argv) > 5 else 792.0
        build_pdf(data, dst, w, h)
    print(json.dumps({"ok": True, "path": str(dst), "items": len(data)}))
