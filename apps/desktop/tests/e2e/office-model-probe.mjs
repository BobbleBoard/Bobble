/**
 * the user's acceptance test: ask a MODEL to create a document, then open what it
 * produced in the canvas and look at it. Four independent runs — docx, xlsx,
 * pptx, pdf — because a single prompt that makes all four would tell us nothing
 * about which one broke.
 *
 * This is the end-to-end shape that matters: the model writes a real file to
 * disk with its own tools, and the canvas opens THAT file in a live editor.
 * Fixtures prove the plumbing; this proves the loop.
 *
 * Runs against the real pi + a real model server, so it is slow and serialised.
 *
 *   node tests/e2e/office-model-probe.mjs [docx|xlsx|pptx|pdf]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(homedir(), 'bobble-testbed/office-model');
const SHOTS = path.join(homedir(), 'bobble-testbed/office-shots');

// Literal task prompts. No test plan, no "make sure it works" scaffolding —
// the instruction is the thing a user would actually type.
const CASES = {
  docx: {
    kind: 'docs',
    prompt:
      'Create a Word document at ~/bobble-testbed/office-model/report.docx titled "Quarterly Report" with a heading and two short paragraphs of body text. Use python-docx.',
    out: 'report.docx',
  },
  xlsx: {
    kind: 'sheets',
    prompt:
      'Create a spreadsheet at ~/bobble-testbed/office-model/budget.xlsx with a header row (Item, Cost) and four rows of made-up data, plus a SUM formula totalling the Cost column. Use openpyxl.',
    out: 'budget.xlsx',
  },
  pptx: {
    kind: 'slides',
    prompt:
      'Create a PowerPoint deck at ~/bobble-testbed/office-model/deck.pptx with three slides: a title slide, a bullet slide, and a closing slide. Use python-pptx.',
    out: 'deck.pptx',
  },
  pdf: {
    kind: 'pdf',
    prompt:
      'Create a PDF at ~/bobble-testbed/office-model/summary.pdf with a title and a short paragraph. Use reportlab.',
    out: 'summary.pdf',
  },
};

const only = process.argv[2];
const selected = only ? { [only]: CASES[only] } : CASES;
if (only && !CASES[only]) {
  console.error(`unknown case "${only}" — one of ${Object.keys(CASES).join(', ')}`);
  process.exit(1);
}

mkdirSync(WORK, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  return ok;
}

function imageStats(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null;
  const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), buf };
}

for (const [ext, c] of Object.entries(selected)) {
  console.log(`\n───── ${ext} ─────`);
  const target = path.join(WORK, c.out);
  const userDataDir = mkdtempSync(path.join(tmpdir(), `pi-office-model-${ext}-`));
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appRoot, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, PI_E2E: '1' },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
    await page.waitForTimeout(4000);

    await page.fill('[data-testid="composer-input"]', c.prompt);
    await page.keyboard.press('Enter');

    // The model has to think, write code, and run it. Poll for the artefact
    // rather than guessing a duration.
    const deadline = Date.now() + 8 * 60 * 1000;
    let made = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      if (existsSync(target)) {
        made = true;
        break;
      }
    }
    if (!check(made, `${ext}: the model created ${c.out}`) && existsSync(WORK)) {
      console.log(`      files in workdir: ${readdirSync(WORK).join(', ') || '(none)'}`);
      continue;
    }

    // Open what the MODEL produced — not a fixture — in a live editor.
    const tabId = await page.evaluate(
      ({ filePath, title }) => window.__pi_canvas().openTab({ kind: 'office', title, filePath }),
      { filePath: target, title: c.out },
    );
    await page.waitForTimeout(1500);
    await page.evaluate(
      ({ tabId, kind, filePath }) =>
        window.piDesktop.invoke('office:create', { tabId, kind, filePath }),
      { tabId, kind: c.kind, filePath: target },
    );

    let stats = null;
    const started = Date.now();
    while (Date.now() - started < 30000) {
      await page.waitForTimeout(1500);
      const shot = await page.evaluate(
        ({ tabId }) => window.piDesktop.invoke('office:capture', { tabId }),
        { tabId },
      );
      stats = imageStats(shot?.dataUrl);
      if (stats !== null && stats.bytes > 6000) break;
    }
    if (check(stats !== null, `${ext}: the editor rendered the model's file`)) {
      writeFileSync(path.join(SHOTS, `model-${ext}.png`), stats.buf);
      console.log(`      ${stats.width}x${stats.height}, ${stats.bytes} bytes`);
    }
  } catch (err) {
    failures.push(`${ext}: threw ${err?.message ?? err}`);
    console.error(err);
  } finally {
    await app.close().catch(() => undefined);
  }
}

console.log(`\nshots -> ${SHOTS}`);
if (failures.length) {
  console.error(`\noffice-model-probe FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\noffice-model-probe: all cases passed');
