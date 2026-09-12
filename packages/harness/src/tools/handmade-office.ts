/**
 * AN OFFICE FILE WRITTEN BY SCRIPT WHILE THE DOCUMENT PIPELINE IS INSTALLED.
 *
 * the user, reading the canvas assessment: "model should not be using python-pptx,
 * there is a dedicated subagent for each pptx/docx/xlsx creation and editing
 * right?" There is — tools/office-gen, driven by the `office` tool — and the
 * model reached past it for `from pptx import Presentation` inside a heredoc
 * anyway, twelve times in a row, because that is what a model already knows
 * how to type. The same finding as handwritten-svg.ts and handmade-media.ts,
 * one modality over: a line among nine abilities does not outweigh a habit.
 *
 * What a hand-driven python-pptx script produces is not wrong the way a Pillow
 * mug is wrong — it may open. It is wrong the way every hand-written format in
 * this project has been: unstyled, unfitted (python-pptx has no font metrics),
 * uneditable by the pipeline's inspect/apply, and one exception away from a
 * file that will not open. The pipeline owns every byte for a reason.
 *
 * ## What makes this narrow enough to be safe
 * The test is the conjunction of:
 *   1. the text drives an OFFICE-WRITING library (python-pptx, python-docx,
 *      openpyxl, xlsxwriter, reportlab, fpdf) or hand-assembles OOXML with
 *      zipfile, and
 *   2. it SAVES an office file (`.save(`, `Presentation(…)`, `Document()`,
 *      `Workbook()`, a `ppt/slides` or `word/document.xml` part), and
 *   3. the `office` tool is actually registered.
 *
 * READING a deck with python-pptx to quote its text fails (2) and goes through
 * — that is analysis, not authoring. A `pip install python-pptx` is refused on
 * its own: nothing else that line can be leading to is something the pipeline
 * does not already do, and stopping there saves the loop that follows.
 *
 * Same crossable fence as its siblings: the `write` guard's identical-bytes
 * escape applies (a script that IS the deliverable can be written again
 * unchanged); a bash heredoc has no escape because the pipeline is one command
 * away and the heredoc is exactly the reflex this exists to interrupt.
 */

export type OfficeKind = 'pptx' | 'docx' | 'xlsx' | 'pdf';

/** Drives a library that writes the format — not one that merely reads it. */
const OFFICE_LIBS = [
  /\bfrom\s+pptx(?:\.[\w.]+)?\s+import\b|\bimport\s+pptx\b/,
  /\bfrom\s+docx(?:\.[\w.]+)?\s+import\b|\bimport\s+docx\b/,
  /\bfrom\s+openpyxl(?:\.[\w.]+)?\s+import\b|\bimport\s+openpyxl\b/,
  /\bimport\s+xlsxwriter\b|\bfrom\s+xlsxwriter\b/,
  /\bfrom\s+reportlab(?:\.[\w.]+)?\s+import\b|\bimport\s+reportlab\b/,
  /\bfrom\s+fpdf\s+import\b|\bimport\s+fpdf\b/,
  /\bpptxgenjs\b|\bdocx4j\b|\bfrom\s+['"]docx['"]/,
] as const;

/** …and it authors a file rather than reading one. */
const SAVES_OFFICE = [
  /\.save\s*\(\s*[^)]*\.(pptx|docx|xlsx)\b/i,
  /\.save\s*\(/,
  /\bPresentation\s*\(\s*\)/,
  /\bDocument\s*\(\s*\)/,
  /\bWorkbook\s*\(\s*\)/,
  /\bxlsxwriter\.Workbook\s*\(/,
  /\bcanvas\.Canvas\s*\(|\bSimpleDocTemplate\s*\(|\bFPDF\s*\(/,
  /\.output\s*\(\s*['"][^'"]*\.pdf/i,
] as const;

/** Hand-assembled OOXML: a zip with the parts an Office file is made of. */
const HANDMADE_OOXML =
  /\bzipfile\b[\s\S]*\b(ppt\/slides|word\/document\.xml|xl\/workbook\.xml|\[Content_Types\]\.xml)/;

/** Installing the library is the first step of the same road. */
const INSTALLS_LIB =
  /\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b[^\n|;&]*\b(python-pptx|python-docx|openpyxl|xlsxwriter|reportlab|fpdf2?)\b/i;

const KIND_HINT: readonly { kind: OfficeKind; re: RegExp }[] = [
  { kind: 'pptx', re: /\bpptx\b|\bPresentation\b|ppt\/slides/ },
  { kind: 'xlsx', re: /\bopenpyxl\b|\bxlsxwriter\b|\.xlsx\b|xl\/workbook/i },
  { kind: 'pdf', re: /\breportlab\b|\bfpdf\b|\.pdf\b/i },
  { kind: 'docx', re: /\bdocx\b|word\/document|\bDocument\s*\(/ },
];

/** The format this text is authoring by hand, or null when it is not. */
export function handmadeOfficeKind(content: string): OfficeKind | null {
  if (INSTALLS_LIB.test(content)) {
    return KIND_HINT.find((k) => k.re.test(content))?.kind ?? 'pptx';
  }
  if (HANDMADE_OOXML.test(content)) {
    return KIND_HINT.find((k) => k.re.test(content))?.kind ?? 'docx';
  }
  if (!OFFICE_LIBS.some((re) => re.test(content))) return null;
  if (!SAVES_OFFICE.some((re) => re.test(content))) return null;
  return KIND_HINT.find((k) => k.re.test(content))?.kind ?? 'docx';
}

/**
 * Should this be refused? Only when the pipeline that would have done the job
 * is registered — with no `office` tool there is nothing to point at, and the
 * script is the only way the model has.
 */
export function isHandmadeOffice(input: {
  content: string;
  officeAvailable: boolean;
}): OfficeKind | null {
  if (!input.officeAvailable) return null;
  return handmadeOfficeKind(input.content);
}

const NOUN: Record<OfficeKind, string> = {
  pptx: 'a slide deck',
  docx: 'a document',
  xlsx: 'a workbook',
  pdf: 'a PDF',
};

/**
 * The refusal: name the tool, give the call in the shape this mode uses, and
 * say what the brief has to carry — the pipeline invents nothing, so a brief
 * without the facts makes a pretty file about nothing.
 */
export function handmadeOfficeRefusal(kind: OfficeKind, opts: { cli: boolean }): string {
  const make = opts.cli
    ? `office make ${kind} --out <where/name.${kind}> --brief "<what it is, with the real content: names, numbers, sections>"`
    : `office_make { kind: "${kind}", out: "<where/name.${kind}>", brief: "<what it is, with the real content>" }`;
  const edit = opts.cli
    ? 'office edit <file> --instruction "<the change>"'
    : 'office_edit { file, instruction }';
  return [
    `Not run: this writes ${NOUN[kind]} by hand with a library, and this machine has the document pipeline for that — designed layouts, real font fitting, a file the app can open and edit afterwards. Hand-driven python-pptx/docx/openpyxl output is none of those and is the thing that breaks.`,
    '',
    'Make it with:',
    `  ${make}`,
    'Change an existing file with:',
    `  ${edit}`,
    '',
    'Put EVERYTHING the file should say in the brief — the pipeline writes only what you give it. It reports back what it made; read that and fix the brief if something is missing.',
  ].join('\n');
}
