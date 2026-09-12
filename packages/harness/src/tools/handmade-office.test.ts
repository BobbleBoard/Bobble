import { describe, expect, it } from 'vitest';
import { handmadeOfficeKind, handmadeOfficeRefusal, isHandmadeOffice } from './handmade-office.js';

const HEREDOC = `python3 << 'EOF'
from pptx import Presentation
from pptx.util import Inches
prs = Presentation()
s = prs.slides.add_slide(prs.slide_layouts[5])
prs.save('./docs/pitch.pptx')
EOF`;

describe('handmadeOfficeKind — what the assessment saw', () => {
  it('names a python-pptx deck built inside a heredoc', () => {
    expect(handmadeOfficeKind(HEREDOC)).toBe('pptx');
  });
  it('names a python-docx document and an openpyxl workbook', () => {
    expect(handmadeOfficeKind('from docx import Document\nd = Document()\nd.save("a.docx")')).toBe(
      'docx',
    );
    expect(handmadeOfficeKind('import openpyxl\nwb = openpyxl.Workbook()\nwb.save("x.xlsx")')).toBe(
      'xlsx',
    );
    expect(
      handmadeOfficeKind(
        'from reportlab.pdfgen import canvas\nc = canvas.Canvas("r.pdf")\nc.save()',
      ),
    ).toBe('pdf');
  });
  it('catches OOXML assembled by hand with zipfile', () => {
    expect(
      handmadeOfficeKind(
        'import zipfile\nz = zipfile.ZipFile("deck.pptx", "w")\nz.writestr("ppt/slides/slide1.xml", xml)',
      ),
    ).toBe('pptx');
  });
  it('refuses the pip install that starts the same road', () => {
    expect(handmadeOfficeKind('pip install python-pptx')).toBe('pptx');
    expect(handmadeOfficeKind('python3 -m pip install openpyxl pandas')).toBe('xlsx');
  });
  it('lets READING a deck through — that is analysis, not authoring', () => {
    expect(
      handmadeOfficeKind(
        'from pptx import Presentation\nprs = Presentation("deck.pptx")\nfor s in prs.slides: print(len(s.shapes))',
      ),
    ).toBeNull();
  });
  it('ignores ordinary scripts and ordinary pip installs', () => {
    expect(handmadeOfficeKind('import json\njson.dump(x, open("a.json","w"))')).toBeNull();
    expect(handmadeOfficeKind('pip install requests')).toBeNull();
    expect(handmadeOfficeKind('ls -la docs/')).toBeNull();
  });
});

describe('isHandmadeOffice', () => {
  it('only refuses when the office tool is registered', () => {
    expect(isHandmadeOffice({ content: HEREDOC, officeAvailable: false })).toBeNull();
    expect(isHandmadeOffice({ content: HEREDOC, officeAvailable: true })).toBe('pptx');
  });
});

describe('handmadeOfficeRefusal', () => {
  it('names the command in CLI mode and the tool in schema mode', () => {
    const cli = handmadeOfficeRefusal('pptx', { cli: true });
    expect(cli).toContain('office make pptx');
    expect(cli).toContain('office edit');
    const schema = handmadeOfficeRefusal('xlsx', { cli: false });
    expect(schema).toContain('office_make');
    expect(schema).toContain('"xlsx"');
    expect(schema).toContain('office_edit');
  });
  it('says the brief has to carry the content', () => {
    expect(handmadeOfficeRefusal('docx', { cli: true })).toMatch(/EVERYTHING the file should say/);
  });
});
