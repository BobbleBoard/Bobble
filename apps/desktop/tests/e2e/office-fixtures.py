"""
Office fixtures for the embedding probes — a deck, a report, a workbook and a
two-page PDF whose DATA is on the second page (the user's case: "put a pdf in and
ask the model to slot a chart in with the data on the second page").

Run with the office venv's python (it has python-pptx/docx, openpyxl,
reportlab):

    ~/.cache/bobble/engines/office-venv/bin/python office-fixtures.py <outDir>

Small and plain on purpose: every file has a title, a line of prose and the
same four numbers (units sold 2021-2024: 12, 19, 15, 22), so a chart drawn
from them belongs in each one.
"""
import sys
from pathlib import Path

YEARS = ["2021", "2022", "2023", "2024"]
UNITS = [12, 19, 15, 22]


def deck(out: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    for title, body in [
        ("Solar power this decade", "Some body text about slide 1."),
        (
            "Capacity by year",
            "Units sold grew every year from 12 in 2021 to 22 in 2024, with a dip in 2023.",
        ),
        ("Outlook", "Some body text about slide 3."),
    ]:
        s = prs.slides.add_slide(blank)
        t = s.shapes.add_textbox(Inches(0.8), Inches(0.6), Inches(11.5), Inches(1.1))
        t.text_frame.text = title
        t.text_frame.paragraphs[0].runs[0].font.size = Pt(40)
        t.text_frame.paragraphs[0].runs[0].font.bold = True
        b = s.shapes.add_textbox(Inches(0.8), Inches(2.0), Inches(5.6), Inches(3.5))
        b.text_frame.word_wrap = True
        b.text_frame.text = body
        b.text_frame.paragraphs[0].runs[0].font.size = Pt(20)
    prs.save(out)


def report(out: Path) -> None:
    from docx import Document

    d = Document()
    d.add_heading("Units sold report", level=1)
    d.add_paragraph("Sales grew steadily across the period.")
    d.add_paragraph("The table below lists units sold by year (thousands).")
    t = d.add_table(rows=1, cols=2)
    t.style = "Light Grid Accent 1"
    t.rows[0].cells[0].text = "Year"
    t.rows[0].cells[1].text = "Units"
    for y, u in zip(YEARS, UNITS):
        r = t.add_row().cells
        r[0].text = y
        r[1].text = str(u)
    d.add_paragraph("Outlook: continued growth expected in 2025.")
    d.save(out)


def workbook(out: Path) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append(["Year", "Units"])
    for y, u in zip(YEARS, UNITS):
        ws.append([int(y), u])
    ws.column_dimensions["A"].width = 12
    ws.column_dimensions["B"].width = 12
    wb.save(out)


def brief(out: Path) -> None:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(out), pagesize=letter)
    w, h = letter
    # Page 1: prose only.
    c.setFont("Helvetica-Bold", 22)
    c.drawString(72, h - 90, "Solar brief")
    c.setFont("Helvetica", 12)
    y = h - 130
    for line in [
        "This brief summarises unit sales over the last four years.",
        "Growth was steady with a single soft year in 2023.",
        "The data is on the next page.",
    ]:
        c.drawString(72, y, line)
        y -= 18
    c.showPage()
    # Page 2: the data table in the top half; the lower half is free.
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, h - 90, "Units sold by year")
    c.setFont("Helvetica", 12)
    y = h - 125
    c.drawString(72, y, "Year")
    c.drawString(172, y, "Units")
    for yr, u in zip(YEARS, UNITS):
        y -= 18
        c.drawString(72, y, yr)
        c.drawString(172, y, str(u))
    c.showPage()
    c.save()


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    out.mkdir(parents=True, exist_ok=True)
    deck(out / "deck.pptx")
    report(out / "report.docx")
    workbook(out / "sales.xlsx")
    brief(out / "brief.pdf")
    print(f"fixtures -> {out}")


if __name__ == "__main__":
    main()
