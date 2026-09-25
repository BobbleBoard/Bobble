/**
 * ANYTHING YOU CAN COPY OR DRAG IN, THE COMPOSER TAKES — and a picture you sent
 * opens in the image viewer.
 *
 * the user (2026-09-24): "why not handle this natively so that any image(s)/files/
 * folders... can be pasted into the input box", and "images clicked on/
 * fullscreened should have the new studio like ui with the left toolbar and
 * such and a centered bottom 'edit image' input bar aswell."
 *
 * Drives the real app, hidden, on a throwaway HOME, with real files on disk
 * under that home's Desktop — deliberately OUTSIDE the folders `pd-file://`
 * serves, where a person's own files are:
 *
 *   01  a screenshot's pixels pasted (no file behind them)
 *   02  a PDF copied in Finder and pasted
 *   03  a folder copied in Finder and pasted
 *   04  four things copied together (picture, text file, PDF, folder) and pasted
 *   05  that message sent: its cards, and the lines the model receives
 *   06  the picture in the sent message clicked
 *   07  a PDF and a folder DROPPED on the window
 *   08  an old message whose picture is only a data URL, clicked (twice)
 *   09  pictures inside a reply's markdown, clicked
 *   10  the composer's picture chip double-clicked
 *   11  the same in dark
 *
 * THE CLIPBOARD IS NEVER TOUCHED. A Finder copy is a paste event carrying
 * path-backed Files — the Files are made from the real paths through a hidden
 * file input (CDP `DOM.setFileInputFiles`, which also takes a folder), exactly
 * what Chromium builds from the pasteboard during a real ⌘V — and `text/plain`
 * holding the names, which is what Finder puts beside them. A drop is CDP's own
 * `Input.dispatchDragEvent` with the paths.
 *
 * Runs against any build: the old one records what each step finds (a skipped
 * note, the old overlay) and those are the BEFORE pictures.
 *
 *   PHASE=before SHOT_DIR=/tmp/attach node scripts/with-lock.mjs probe -- \
 *     node apps/desktop/tests/e2e/attach-anything-probe.mjs
 *
 * `REAL_CLIPBOARD=1` — NEVER BY DEFAULT, and only by the person whose clipboard
 * it is: the pastes go through the SYSTEM pasteboard (the paths written as
 * Finder writes them — a file URL and the name per item — or the pixels, then
 * `webContents.paste()`, the Edit menu's own command). Whatever was copied
 * before is gone and cannot be put back, and because that paste is not a key
 * the person pressed, macOS may show its "would like to paste" alert on their
 * screen. It is the end-to-end check of what paste-files.ts reads from the
 * Chromium source; the pasteboard is cleared after if nothing newer landed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { streamedTurn, writeFixture } from './_mock-turns.mjs';
import { launchApp, probeHome } from './harness.mjs';

const PHASE = process.env.PHASE ?? 'after';
const REAL_CLIPBOARD = process.env.REAL_CLIPBOARD === '1';
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'attach-anything');
mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);

/* ── The person's files: under the home's Desktop, outside every served root ── */
const home = probeHome('attach-anything');
const DESK = path.join(home, 'Desktop');
const PDF = path.join(DESK, 'Q3 report.pdf');
const FOLDER = path.join(DESK, 'garden-project');
const NOTES = path.join(DESK, 'notes.md');
const FOX = path.join(DESK, 'fox.png');
const GEN = path.join(home, 'Bobble', 'generated', 'probe-sunset');
const SUNSET = path.join(GEN, 'sunset.png');
mkdirSync(path.join(FOLDER, 'src'), { recursive: true });
mkdirSync(GEN, { recursive: true });
writeFileSync(
  path.join(FOLDER, 'README.md'),
  '# Garden project\n\nRaised beds, drip irrigation.\n',
);
writeFileSync(path.join(FOLDER, 'src', 'main.py'), 'print("water the beds")\n');
writeFileSync(path.join(FOLDER, 'plan.txt'), 'north bed: tomatoes\nsouth bed: beans\n');
writeFileSync(
  NOTES,
  '# Notes\n\n- the fox visits at dusk\n- report due Friday\n- ask about the drip timer\n',
);
{
  // A real-looking PDF, padded so its size reads like a document.
  const body = [
    '%PDF-1.4',
    '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
    '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
    '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>> endobj',
    `% ${'quarterly figures '.repeat(9000)}`,
    'trailer <</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  writeFileSync(PDF, body);
}

const fixture = writeFixture(path.join(tmpdir(), `attach-anything-${process.pid}.json`), 'attach', [
  streamedTurn('Looking at the report, the folder and your notes now.', { chunks: 6, stepMs: 60 }),
  streamedTurn('Done.', { chunks: 2, stepMs: 60 }),
  streamedTurn('Done again.', { chunks: 2, stepMs: 60 }),
]);

const { app, page, check, finish } = await launchApp('attach-anything', {
  fixture,
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  // The image module shows as installed (as on a Mac that has it) instead of its
  // Download card — read only; nothing is generated here.
  realCache: process.env.REAL_CACHE !== '0',
  waitFor: '[data-testid="composer-input"]',
  timeout: 60_000,
});

const shot = async (label) => {
  const file = path.join(SHOT_DIR, `${PHASE}-${label}.png`);
  await page.screenshot({ path: file });
  log('shot', file);
  return file;
};
const clip = async (label, selector, pad = 20) => {
  const box = await page
    .locator(selector)
    .first()
    .boundingBox()
    .catch(() => null);
  if (box === null) return shot(label);
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const file = path.join(SHOT_DIR, `${PHASE}-${label}.png`);
  await page.screenshot({
    path: file,
    clip: {
      x,
      y,
      width: Math.min(vp.width - x, box.width + pad * 2),
      height: Math.min(vp.height - y, box.height + pad * 2),
    },
  });
  log('shot', file);
  return file;
};
const setTheme = async (mode) => {
  await page.evaluate(
    (m) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode: m } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
  await sleep(300);
};

/* ── Path-backed Files, the way Chromium makes them from the pasteboard ───── */
const cdp = await page.context().newCDPSession(page);
await page.evaluate(() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.id = 'probe-files';
  input.style.display = 'none';
  document.body.appendChild(input);
});
async function loadFiles(paths) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '#probe-files',
  });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: paths });
  // The precondition: each File names its own path, as a real paste's do.
  return page.evaluate(() =>
    [...document.getElementById('probe-files').files].map((f) => ({
      name: f.name,
      size: f.size,
      type: f.type,
      path: window.piDesktop.pathForFile(f),
    })),
  );
}

/*
 * THE SYSTEM PASTEBOARD — REAL_CLIPBOARD=1 only (see the header). Written as
 * Finder writes a copy: one item per path, its file URL and its name.
 */
let lastWrite = null;
const pasteboard = (script, args = []) =>
  execFileSync('osascript', ['-l', 'JavaScript', '-e', script, ...args], {
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const COPY_FILES = `function run(argv) {
  ObjC.import('AppKit');
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const items = $.NSMutableArray.array;
  for (const p of argv) {
    const item = $.NSPasteboardItem.alloc.init;
    item.setStringForType($.NSURL.fileURLWithPath(p).absoluteString, 'public.file-url');
    item.setStringForType(p.split('/').pop(), 'public.utf8-plain-text');
    items.addObject(item);
  }
  pb.writeObjects(items);
  return pb.changeCount;
}`;
const CHANGE_COUNT = "ObjC.import('AppKit'); $.NSPasteboard.generalPasteboard.changeCount";
/** The Edit menu's paste (`role: 'paste'` is this command), into the composer. */
async function realPaste() {
  await page.click('[data-testid="composer-input"]');
  await sleep(150);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.paste());
  await sleep(1200);
}

/** A ⌘V of files copied in Finder: the Files, and their names as text. */
async function pasteFinder(paths) {
  if (REAL_CLIPBOARD) {
    lastWrite = Number(pasteboard(COPY_FILES, paths));
    await realPaste();
    return;
  }
  const files = await loadFiles(paths);
  check(
    files.length === paths.length && files.every((f, i) => f.path === paths[i]),
    `the pasted Files name their own paths: ${JSON.stringify(files)}`,
  );
  await page.click('[data-testid="composer-input"]');
  await sleep(120);
  await page.evaluate(
    (names) => {
      const data = new DataTransfer();
      for (const f of document.getElementById('probe-files').files) data.items.add(f);
      data.setData('text/plain', names.join('\r'));
      const target =
        document.activeElement ?? document.querySelector('[data-testid="composer-input"]');
      target.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    files.map((f) => f.name),
  );
  await sleep(900);
}

/** A ⌘V of pixels with no file behind them — a screenshot, a card's Copy. */
async function pastePixels(dataUrl) {
  if (REAL_CLIPBOARD) {
    await app.evaluate(({ clipboard, nativeImage }, url) => {
      clipboard.writeImage(nativeImage.createFromDataURL(url));
    }, dataUrl);
    lastWrite = Number(pasteboard(CHANGE_COUNT));
    await realPaste();
    return;
  }
  await page.click('[data-testid="composer-input"]');
  await sleep(120);
  await page.evaluate((url) => {
    const [head, b64] = url.split(',');
    const type = /data:([^;,]+)/.exec(head)?.[1] ?? 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type }));
    const target =
      document.activeElement ?? document.querySelector('[data-testid="composer-input"]');
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, dataUrl);
  await sleep(900);
}

/** Files dragged in from Finder and dropped on the chat. */
async function dropFinder(paths) {
  const box = await page.locator('[data-testid="chat-scroll"]').boundingBox();
  const x = Math.round((box?.x ?? 400) + (box?.width ?? 600) / 2);
  const y = Math.round((box?.y ?? 200) + (box?.height ?? 400) / 2);
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
    await sleep(120);
  }
  await sleep(900);
}

/** What the composer holds, as its chips say it. */
const chips = () =>
  page.evaluate(() => ({
    chips: [...document.querySelectorAll('[data-testid="attach-chip"]')].map((el) => ({
      kind: el.getAttribute('data-kind'),
      path: el.getAttribute('data-path'),
      thumb: el.querySelector('img.pd-attach-thumb') !== null,
      glyph:
        el.querySelector('.pd-glyph')?.getAttribute('data-glyph') ??
        el.querySelector('.pd-file-glyph')?.getAttribute('data-ext') ??
        null,
      label: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
    cards: document.querySelectorAll('[data-testid="composer-attachments"] .pd-pasted').length,
    skipped:
      document.querySelector('[data-testid="composer-skipped-note"]')?.textContent?.trim() ?? null,
  }));

async function clearComposer() {
  for (let i = 0; i < 12; i++) {
    const remove = page
      .locator('[data-testid="composer-attachments"] button[aria-label^="Remove"]')
      .first();
    if ((await remove.count()) === 0) break;
    await remove.click({ force: true });
    await sleep(120);
  }
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await sleep(200);
}

/** Select every chip so each one shows its name and size (they open on click). */
async function openAllChips() {
  const n = await page.locator('[data-testid="attach-chip"]').count();
  if (n === 0) return;
  await page
    .locator('[data-testid="attach-chip"]')
    .first()
    .click({ position: { x: 4, y: 4 } });
  if (n > 1) {
    await page
      .locator('[data-testid="attach-chip"]')
      .nth(n - 1)
      .click({ position: { x: 4, y: 4 }, modifiers: ['Shift'] });
  }
  await sleep(450);
}

/** A picture drawn in the page, as a PNG data URL. */
const drawPicture = (w, h, sky, sun, label) =>
  page.evaluate(
    ({ w, h, sky, sun, label }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, sky);
      grad.addColorStop(1, '#f3efe6');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = sun;
      g.beginPath();
      g.ellipse(w * 0.5, h * 0.58, w * 0.18, h * 0.15, 0, 0, Math.PI * 2);
      g.fill();
      if (label) {
        g.fillStyle = '#1d1d1f';
        g.font = `bold ${Math.round(h / 9)}px sans-serif`;
        g.fillText(label, w * 0.06, h * 0.16);
      }
      return c.toDataURL('image/png');
    },
    { w, h, sky, sun, label },
  );
const writeDataUrl = (file, url) => writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

/** The viewer is open on a picture that actually loaded. */
const viewerState = () =>
  page.evaluate(() => {
    const pic = document.querySelector('[data-testid="viewer-picture"]');
    return {
      viewer: document.querySelector('[data-testid="image-viewer"]') !== null,
      oldOverlay:
        document.querySelector(
          '[data-testid="user-image-expanded"], [data-testid="attachment-expanded"], [data-testid="media-expanded"]',
        ) !== null,
      canvasOpened: document.querySelector('[data-testid="canvas-panel"], .pd-canvas-tab') !== null,
      src: pic?.getAttribute('src') ?? null,
      loaded: (pic?.naturalWidth ?? 0) > 0,
      w: pic?.naturalWidth ?? 0,
      rail: document.querySelector('[data-testid="viewer-tools"]') !== null,
      bar: document.querySelector('[data-testid="viewer-edit-input"]') !== null,
    };
  });
const closeOverlay = async () => {
  await page.keyboard.press('Escape');
  await sleep(450);
};

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 30_000,
  });
  await setTheme('light');
  writeDataUrl(FOX, await drawPicture(1200, 800, '#8fb8de', '#d9542b', 'fox.png'));
  writeDataUrl(SUNSET, await drawPicture(960, 640, '#f4a259', '#e76f51', 'sunset'));
  await sleep(600);

  /* ── 01. pixels, no file ──────────────────────────────────────────────── */
  const shotUrl = await drawPicture(640, 400, '#1f6feb', '#f5a623', 'screenshot');
  await pastePixels(shotUrl);
  const p1 = await chips();
  log('01 pixels →', JSON.stringify(p1));
  check(p1.chips.length === 1 && p1.chips[0].thumb, 'pasted pixels did not attach a picture');
  check(
    typeof p1.chips[0]?.path === 'string' &&
      p1.chips[0].path.startsWith(path.join(home, 'Bobble', 'attachments')),
    `the pasted picture has no file of its own in ~/Bobble/attachments: ${p1.chips[0]?.path}`,
  );
  await clip('01-paste-screenshot', '.pd-composer-root', 16);
  await clearComposer();

  /* ── 02. a PDF copied in Finder ───────────────────────────────────────── */
  await pasteFinder([PDF]);
  const p2 = await chips();
  log('02 pdf →', JSON.stringify(p2));
  check(
    p2.chips.length === 1 && p2.chips[0].kind === 'file' && p2.chips[0].path === PDF,
    `the PDF did not attach as a file reference: ${JSON.stringify(p2)}`,
  );
  check(p2.skipped === null, `the PDF was skipped: ${p2.skipped}`);
  await openAllChips();
  await clip('02-paste-pdf', '.pd-composer-root', 16);
  await clearComposer();

  /* ── 03. a folder copied in Finder ────────────────────────────────────── */
  await pasteFinder([FOLDER]);
  const p3 = await chips();
  log('03 folder →', JSON.stringify(p3));
  check(
    p3.chips.length === 1 && p3.chips[0].kind === 'folder' && p3.chips[0].path === FOLDER,
    `the folder did not attach: ${JSON.stringify(p3)}`,
  );
  await openAllChips();
  await clip('03-paste-folder', '.pd-composer-root', 16);
  await clearComposer();

  /* ── 04. four things at once ──────────────────────────────────────────── */
  await pasteFinder([FOX, NOTES, PDF, FOLDER]);
  const p4 = await chips();
  log('04 many →', JSON.stringify(p4));
  check(
    p4.chips.length === 4 &&
      JSON.stringify(p4.chips.map((c) => c.kind)) ===
        JSON.stringify(['image', 'text', 'file', 'folder']),
    `four copied things did not become four attachments: ${JSON.stringify(p4)}`,
  );
  check(
    p4.chips.find((c) => c.kind === 'image')?.path === FOX,
    'the pasted picture file does not carry its own path',
  );
  await clip('04-paste-many', '.pd-composer-root', 16);
  await openAllChips();
  await clip('04b-paste-many-open', '.pd-composer-root', 16);

  /* ── 05. sent ─────────────────────────────────────────────────────────── */
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('What should I do first?');
  await page.keyboard.press('Enter');
  await page
    .waitForFunction(
      () =>
        window
          .__pi_store()
          .getState()
          .messages.some((m) => m.kind === 'assistant' && m.isStreaming !== true),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await sleep(900);
  const sent = await page.evaluate(() => {
    const u = window
      .__pi_store()
      .getState()
      .messages.find((m) => m.kind === 'user');
    return {
      text: u?.text ?? null,
      agentText: u?.agentText ?? null,
      images: (u?.images ?? []).length,
      cards: [...document.querySelectorAll('[data-testid="user-attachments"] > *')].map((el) =>
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      ),
      thumbs: document.querySelectorAll('.pd-user-image').length,
    };
  });
  log('05 sent →', JSON.stringify({ ...sent, agentText: undefined }));
  log('05 the model receives:\n', sent.agentText);
  const body = sent.agentText ?? '';
  check(body.includes(`Attached image: ${FOX} (PNG,`), 'no path line for the picture');
  check(body.includes(`Attached file: ${PDF} (PDF,`), 'no path line for the PDF');
  check(body.includes(`Attached folder: ${FOLDER}`), 'no path line for the folder');
  check(body.includes(`Attached file \`${NOTES}\`:`), 'the text file is not folded with its path');
  check(sent.images === 1, `the picture was not sent for vision (${sent.images})`);
  await shot('05-sent-message');
  await clip('05b-sent-message-cards', '[data-user-turn]', 24);

  /* ── 05c. editing that message keeps what it named by path ────────────── */
  await page.locator('[data-user-turn]').first().hover();
  await sleep(300);
  await page.locator('[data-user-turn] button[aria-label="Edit message"]').first().click();
  const editing = await page
    .waitForSelector('[data-testid="editing-attachments"]', { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  // A folder dropped into the message being edited joins it, by path.
  const PHOTOS = path.join(DESK, 'photos');
  mkdirSync(PHOTOS, { recursive: true });
  writeFileSync(path.join(PHOTOS, 'a.jpg'), 'x');
  if (editing) await dropFinder([PHOTOS]);
  const edit = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="editing-attachments"] > *')].map((el) => ({
      kind: el.getAttribute('data-kind') ?? (el.classList.contains('pd-pasted') ? 'text' : null),
      name: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    })),
  );
  log('05c editing →', JSON.stringify(edit));
  check(
    editing &&
      JSON.stringify(edit.map((e) => e.kind)) ===
        JSON.stringify(['file', 'folder', 'file', 'text', 'folder']),
    `the edit did not keep the PDF, the folder, the picture (as its file) and the notes, plus the dropped folder: ${JSON.stringify(edit)}`,
  );
  await clip('05c-editing-message', '[data-testid="editing-message"]', 24);
  if (editing) {
    await page.locator('[data-testid="editing-message"] button', { hasText: 'Cancel' }).click();
    await sleep(400);
  }

  /* ── 06. the sent picture, clicked ────────────────────────────────────── */
  await page.click('.pd-user-image');
  await sleep(1400);
  const v6 = await viewerState();
  log('06 user image →', JSON.stringify(v6));
  check(
    v6.viewer && v6.loaded && v6.rail && v6.bar,
    `the viewer did not open on it: ${JSON.stringify(v6)}`,
  );
  check(
    (v6.src ?? '').includes(encodeURIComponent('fox.png')),
    `the viewer is not showing the file on the Desktop: ${v6.src}`,
  );
  await shot('06-user-image-open');
  await closeOverlay();

  /* ── 07. dropped ──────────────────────────────────────────────────────── */
  await clearComposer();
  await dropFinder([PDF, FOLDER]);
  const p7 = await chips();
  log('07 drop →', JSON.stringify(p7));
  check(
    p7.chips.length === 2 && p7.chips[0].kind === 'file' && p7.chips[1].kind === 'folder',
    `dropping a PDF and a folder did not attach them: ${JSON.stringify(p7)}`,
  );
  await openAllChips();
  await clip('07-drop-pdf-folder', '.pd-composer-root', 16);
  await clearComposer();

  /* ── 08. an old message: its picture is only a data URL ───────────────── */
  const oldUrl = await drawPicture(800, 520, '#9cc3e6', '#2a9d8f', 'old message');
  await page.evaluate((url) => {
    const s = window.__pi_store().getState();
    window.__pi_store().setState({
      messages: [
        ...s.messages,
        { kind: 'user', id: 'old-u', text: 'what bird is this?', images: [url], timestamp: 9 },
        {
          kind: 'assistant',
          id: 'old-a',
          blocks: [{ type: 'text', text: 'A heron, by the neck.' }],
          timestamp: 10,
          isStreaming: false,
        },
      ],
    });
  }, oldUrl);
  await sleep(700);
  const attachDir = path.join(home, 'Bobble', 'attachments');
  const before8 = existsSync(attachDir) ? readdirSync(attachDir).length : 0;
  await page.locator('[data-user-turn="old-u"] .pd-user-image').click();
  await sleep(1400);
  const v8 = await viewerState();
  const after8 = existsSync(attachDir) ? readdirSync(attachDir) : [];
  log('08 old image →', JSON.stringify(v8), 'attachments', before8, '→', after8.length);
  check(
    v8.viewer && v8.loaded,
    `an old message's picture did not open in the viewer: ${JSON.stringify(v8)}`,
  );
  await shot('08-old-image-open');
  await closeOverlay();
  await page.locator('[data-user-turn="old-u"] .pd-user-image').click();
  await sleep(1200);
  const again8 = existsSync(attachDir) ? readdirSync(attachDir).length : 0;
  check(
    after8.length === before8 + 1 && again8 === after8.length,
    `the same picture must be ONE file (before ${before8}, first open ${after8.length}, second ${again8})`,
  );
  await closeOverlay();

  /* ── 09. pictures in a reply's markdown ───────────────────────────────── */
  const pdUrl = `pd-file://f${SUNSET.split('/').map(encodeURIComponent).join('/')}`;
  await page.evaluate(
    ({ abs, pd }) => {
      const s = window.__pi_store().getState();
      window.__pi_store().setState({
        messages: [
          ...s.messages,
          { kind: 'user', id: 'md-u', text: 'show me the sunset', timestamp: 11 },
          {
            kind: 'assistant',
            id: 'md-a',
            blocks: [
              {
                type: 'text',
                text: `Here it is:\n\n![sunset](${abs})\n\nAnd by its URL:\n\n![sunset again](${pd})`,
              },
            ],
            timestamp: 12,
            isStreaming: false,
          },
        ],
      });
    },
    { abs: SUNSET, pd: pdUrl },
  );
  await sleep(900);
  const mdImages = await page.locator('.pd-md-image').count();
  log('09 markdown images', mdImages);
  await page.locator('.pd-md-image').first().scrollIntoViewIfNeeded();
  await page.locator('.pd-md-image').first().click();
  await sleep(1400);
  const v9 = await viewerState();
  log('09 markdown (path) →', JSON.stringify(v9));
  check(
    v9.viewer && v9.loaded,
    `a reply's picture (by path) did not open the viewer: ${JSON.stringify(v9)}`,
  );
  await shot('09-markdown-image-open');
  if (v9.viewer || v9.oldOverlay) await closeOverlay();
  await page.locator('.pd-md-image').nth(1).click();
  await sleep(1200);
  const v9b = await viewerState();
  log('09 markdown (pd-file URL) →', JSON.stringify(v9b));
  check(
    v9b.viewer && v9b.loaded,
    `a reply's picture (by pd-file URL) did not open the viewer: ${JSON.stringify(v9b)}`,
  );
  if (v9b.viewer || v9b.oldOverlay) await closeOverlay();

  /* ── 10. the composer's picture chip, double-clicked ─────────────────── */
  await pasteFinder([FOX]);
  await page.dblclick('[data-testid="attach-chip"] img.pd-attach-thumb');
  await sleep(1400);
  const v10 = await viewerState();
  log('10 chip →', JSON.stringify(v10));
  check(
    v10.viewer && v10.loaded,
    `the chip's picture did not open in the viewer: ${JSON.stringify(v10)}`,
  );
  await shot('10-chip-open');
  await closeOverlay();
  const focusBack = await page.evaluate(
    () => document.activeElement?.closest('.pd-composer-root') !== null,
  );
  check(focusBack, 'focus did not come back to the composer after the viewer closed');
  await clearComposer();

  /* ── 11. dark ─────────────────────────────────────────────────────────── */
  await setTheme('dark');
  await pasteFinder([FOX, NOTES, PDF, FOLDER]);
  await openAllChips();
  await clip('11a-paste-many-dark', '.pd-composer-root', 16);
  await page.locator('[data-user-turn]').first().scrollIntoViewIfNeeded();
  await sleep(300);
  await clip('11b-sent-message-dark', '[data-user-turn]', 24);
  await page.locator('.pd-user-image').first().click();
  await sleep(1400);
  await shot('11c-user-image-open-dark');
  await closeOverlay();
  await clearComposer();
  await setTheme('light');
} catch (error) {
  check(false, `probe crashed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  // Our fixture paths off the pasteboard — only if nothing newer landed there.
  if (REAL_CLIPBOARD && lastWrite !== null) {
    try {
      if (Number(pasteboard(CHANGE_COUNT)) === lastWrite) {
        pasteboard("ObjC.import('AppKit'); $.NSPasteboard.generalPasteboard.clearContents");
        log('cleared the probe paths off the pasteboard');
      } else {
        log('the pasteboard changed under the probe — left alone');
      }
    } catch {
      /* best effort */
    }
  }
  await finish();
}
