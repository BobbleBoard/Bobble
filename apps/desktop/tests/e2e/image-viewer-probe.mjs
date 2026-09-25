/**
 * A FINISHED PICTURE IN THE CHAT: click it, edit it, copy it, paste it.
 *
 * the user (2026-09-24): "clicking on a card (eg image once finished generating)
 * does not expand/open it, copy and then attempting pasting into our own apps
 * input bar doesn't work", and "images clicked on/fullscreened should have the
 * new studio like ui with the left toolbar and such and a centered bottom 'edit
 * image' input bar aswell."
 *
 * Drives the real app, hidden, on a throwaway HOME, with a real picture seeded
 * into a chat as a finished `generate_image` result, and LOOKS at every step:
 *
 *   1. a click on the picture (not the corner button) opens the image viewer;
 *   2. the viewer is the studio-shaped room: the tool rail at the left edge,
 *      the picture centred, the "Edit image" bar centred at the bottom, focused;
 *   3. an edit runs through `gen:generate` with THIS picture as `inputImage`,
 *      the waiting card holds the picture's box, and the result lands as a new
 *      version in the viewer's History (and not in the transcript);
 *   4. the copy → paste round trip through the SYSTEM clipboard: a card's Copy,
 *      ⌘V in the composer → an image attachment with the picture's pixels; and
 *      a PNG put on the clipboard from outside the renderer → the same.
 *
 * Runs against any build, so the same steps give the BEFORE shots on the old
 * one: a step that finds nothing records it and moves on.
 *
 *   SHOT_DIR=/tmp/viewer PHASE=after FIXTURE=/path/to/picture.png \
 *     node scripts/with-lock.mjs probe -- node apps/desktop/tests/e2e/image-viewer-probe.mjs
 *
 *   REAL=1 …  runs a REAL edit (Qwen-Image 2.1 through the image module, on the
 *             real weights): wrap it in `with-lock.mjs heavy`. Without it the
 *             generator is stubbed IN MAIN (a renderer-side stub cannot hold —
 *             contextBridge objects are frozen), and the stub says so.
 *
 * THE CLIPBOARD IS THE SYSTEM ONE. The round trip is only real through it, so
 * this writes it twice (the card's Copy, then a PNG from main). It never READS
 * what someone else put there — macOS asks the person before an app reads
 * another app's pasteboard, and that dialog would be the screen taken — so the
 * previous contents cannot be restored; the probe clears its own picture off
 * at the end when nothing newer has been copied (the change count says so).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const PHASE = process.env.PHASE ?? 'after';
const REAL = process.env.REAL === '1';
const CAP_MS = Number(process.env.MAX_MIN ?? 12) * 60_000;
const SHOT_DIR = process.env.SHOT_DIR ?? path.join(tmpdir(), 'pd-shots', 'image-viewer');
mkdirSync(SHOT_DIR, { recursive: true });

const INSTRUCTION = process.env.INSTRUCTION ?? 'make it golden hour, warm low sun';

/* The picture lives where a real generation puts it — inside the pd-file fence,
   which is scoped to the home the app runs in. */
const home = probeHome('image-viewer-probe');
const GEN = path.join(home, 'Bobble', 'generated', 'red-fox-in-deep-snow');
mkdirSync(GEN, { recursive: true });
const PICTURE = path.join(GEN, 'fox-in-snow.png');

const { app, page, check, finish } = await launchApp('image-viewer-probe', {
  env: { HOME: home, PI_DESKTOP_GEN: '1', PI_E2E_NO_SERVER: '1' },
  /* The real weights for a real edit. REAL_CACHE=1 also points a UI run at them
     — read only, the generator stays stubbed — so the room shows the image
     module as installed (as on a Mac that has it) instead of its Download card. */
  realCache: REAL || process.env.REAL_CACHE === '1',
  waitFor: '[data-testid="composer-input"]',
  timeout: 60_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ', ...a);
const shot = async (label) => {
  const file = path.join(SHOT_DIR, `${PHASE}-${label}.png`);
  await page.screenshot({ path: file });
  log('shot', file);
  return file;
};
const clip = async (label, selector, pad = 24) => {
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
const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel);
const waitFor = async (sel, ms) =>
  page
    .waitForSelector(sel, { timeout: ms })
    .then(() => true)
    .catch(() => false);
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

/** The pasteboard's change count: counts writes, reads nobody's data. */
function pasteboardCount() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        "ObjC.import('AppKit'); $.NSPasteboard.generalPasteboard.changeCount",
      ],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return Number(out.trim());
  } catch {
    return null;
  }
}

/** A picture for the chat: FIXTURE when given (a real Bobble output reads as
 * one), else one drawn in the page. */
async function writePicture() {
  const src = process.env.FIXTURE;
  if (src !== undefined && existsSync(src)) {
    copyFileSync(src, PICTURE);
    return;
  }
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 1024;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 1024);
    sky.addColorStop(0, '#9cc3e6');
    sky.addColorStop(1, '#eef3f8');
    g.fillStyle = sky;
    g.fillRect(0, 0, 1024, 1024);
    g.fillStyle = '#d9542b';
    g.beginPath();
    g.ellipse(512, 600, 190, 150, 0, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  writeFileSync(PICTURE, Buffer.from(b64, 'base64'));
}

/** The chat as it stands after a finished `generate_image`. */
async function seedChat() {
  const pdUrl = `pd-file://f${PICTURE.split('/').map(encodeURIComponent).join('/')}`;
  await page.evaluate(
    ({ pdUrl, picture }) => {
      window.__pi_store().setState({
        messages: [
          {
            kind: 'user',
            id: 'u1',
            text: 'make me a picture of a red fox sitting in deep snow',
            timestamp: 1,
          },
          {
            kind: 'assistant',
            id: 'a1',
            blocks: [
              {
                type: 'toolCall',
                id: 'g1',
                name: 'generate_image',
                arguments: { prompt: 'a red fox sitting in deep snow, soft winter light' },
              },
            ],
            timestamp: 2,
            isStreaming: false,
          },
          {
            kind: 'toolResult',
            id: 'tr-g1',
            toolCallId: 'g1',
            toolName: 'generate_image',
            text: `${pdUrl}\nGenerated image saved at ${picture}`,
            isError: false,
            timestamp: 3,
          },
          {
            kind: 'assistant',
            id: 'a2',
            blocks: [{ type: 'text', text: 'Here it is — a fox in deep snow.' }],
            timestamp: 4,
            isStreaming: false,
          },
        ],
      });
    },
    { pdUrl, picture: PICTURE },
  );
  const card = await waitFor('[data-testid="media-card"] [data-testid="media-image"]', 15_000);
  check(card, 'the finished picture never mounted as a card in the chat');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="media-image"]')?.naturalWidth ?? 0) > 0,
    undefined,
    { timeout: 15_000 },
  );
  await sleep(700);
}

/** Click the PICTURE itself — the middle of the image, not a corner control. */
async function clickPicture() {
  const box = await page
    .locator('[data-testid="media-card"] [data-testid="media-image"]')
    .boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Where the viewer's pieces are. */
const viewerLayout = () =>
  page.evaluate(() => {
    const r = (s) => {
      const b = document.querySelector(s)?.getBoundingClientRect();
      return b === undefined ? null : { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const input = document.querySelector('[data-testid="viewer-edit-input"]');
    return {
      vw: innerWidth,
      vh: innerHeight,
      rail: r('[data-testid="viewer-tools"] .tp-float-group'),
      picture: r('[data-testid="viewer-picture"]'),
      bar: r('[data-testid="viewer-bar"] .pd-studio-composer'),
      placeholder: input?.getAttribute('placeholder') ?? null,
      focused: document.activeElement === input,
      tools: [...document.querySelectorAll('[data-testid="viewer-tools"] button')].map((b) =>
        b.getAttribute('aria-label'),
      ),
      railFill: (() => {
        const g = document.querySelector('[data-testid="viewer-tools"] .tp-float-group');
        if (g === null) return null;
        const cs = getComputedStyle(g);
        return { bg: cs.backgroundColor, border: cs.borderTopColor, shadow: cs.boxShadow };
      })(),
      composerHeight: r('[data-testid="viewer-bar"] .pd-studio-composer')?.h ?? null,
    };
  });

/** The composer's attachments: count, and the first one's pixel size. */
const attachments = () =>
  page.evaluate(async () => {
    const chips = [...document.querySelectorAll('[data-testid="attach-chip"]')];
    const src = chips[0]?.querySelector('img.pd-attach-thumb')?.getAttribute('src') ?? '';
    let w = 0;
    let h = 0;
    if (src.startsWith('data:image/')) {
      const img = new Image();
      img.src = src;
      await img.decode().catch(() => undefined);
      w = img.naturalWidth;
      h = img.naturalHeight;
    }
    return { count: chips.length, image: src.startsWith('data:image/'), w, h };
  });

async function clearAttachments() {
  for (let i = 0; i < 6; i++) {
    const remove = page.locator('[data-testid="attach-chip"] .pd-attach-remove').first();
    if ((await remove.count()) === 0) break;
    await remove.click({ force: true });
    await sleep(150);
  }
}

/** Paste into the composer the way a person does: focus it, ⌘V. */
async function pasteIntoComposer() {
  await page.click('[data-testid="composer-input"]');
  await sleep(150);
  await page.keyboard.press('Meta+V');
  await sleep(900);
}

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 30_000,
  });
  await writePicture();
  await setTheme('light');
  await seedChat();
  await shot('01-chat-card-light');

  /* ── 1. a click on the picture opens it ─────────────────────────────── */
  await clickPicture();
  const opened = await waitFor('[data-testid="image-viewer"]', 4000);
  const oldExpanded = opened ? false : await exists('[data-testid="media-expanded"]');
  log('card click →', opened ? 'image viewer' : oldExpanded ? 'old expanded view' : 'nothing');
  check(opened, 'clicking the finished picture did not open it');
  await sleep(700);
  await shot('02-card-click-light');

  if (opened) {
    /* ── 2. the room: rail left, picture centred, Edit bar bottom-centre ── */
    const L = await viewerLayout();
    log('viewer', JSON.stringify(L));
    check(
      L.rail !== null && L.rail.x < 40,
      `the tool rail is not at the left edge: ${JSON.stringify(L.rail)}`,
    );
    check(
      L.picture !== null && Math.abs(L.picture.x + L.picture.w / 2 - L.vw / 2) < 4,
      `the picture is not centred: ${JSON.stringify(L.picture)}`,
    );
    check(
      L.bar !== null &&
        Math.abs(L.bar.x + L.bar.w / 2 - L.vw / 2) < 4 &&
        L.bar.y + L.bar.h > L.vh - 90,
      `the edit bar is not centred at the bottom: ${JSON.stringify(L.bar)}`,
    );
    check(L.placeholder === 'Edit image', `the bar says "${L.placeholder}", not "Edit image"`);
    check(L.focused, 'the Edit bar is not focused when the viewer opens');
    check(
      JSON.stringify(L.tools) ===
        JSON.stringify([
          'Copy image',
          'Export…',
          'Show in Finder',
          'Send to chat',
          'Open in Image Studio',
        ]),
      `the rail's tools are ${JSON.stringify(L.tools)}`,
    );
    check(
      L.composerHeight !== null && L.composerHeight <= 52,
      `the edit bar is ${L.composerHeight}px tall — keep controls compact`,
    );

    // A tool's name on hover — the rail is glyphs, so the tooltip is its label.
    await page.hover('[data-testid="viewer-copy"]');
    await sleep(700);
    // (Radix repeats the label in a visually-hidden role="tooltip" child, so
    // the text is "Copy imageCopy image" — hence `includes`.)
    check(
      (
        (await page
          .locator('.pd-tooltip')
          .first()
          .textContent()
          .catch(() => '')) ?? ''
      ).includes('Copy image'),
      'hovering a rail tool shows no label',
    );
    await shot('03-viewer-rail-hover-light');
    /* Away the way a hand moves — in steps. One jump never lets the tooltip
       judge its grace area, so it stays open and (rightly) takes the next
       Escape for itself: one press, one layer. */
    await page.mouse.move(400, 450, { steps: 8 });
    await page
      .waitForSelector('.pd-tooltip', { state: 'detached', timeout: 3000 })
      .catch(() => undefined);

    await page.fill('[data-testid="viewer-edit-input"]', INSTRUCTION);
    await sleep(300);
    await shot('04-viewer-edit-focused-light');
    await page.fill('[data-testid="viewer-edit-input"]', '');

    /* The strength picker's dropup opens ABOVE the room (menus are z 50, the
       room 60), and its Escape closes the menu, not the room. */
    await page.click('[data-testid="viewer-strength"]');
    const menu = await waitFor('[data-testid="viewer-strength-0.85"]', 3000);
    const onTop = menu
      ? await page.evaluate(() => {
          const item = document.querySelector('[data-testid="viewer-strength-0.85"]');
          const b = item.getBoundingClientRect();
          return (
            document
              .elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
              ?.closest('[data-testid="viewer-strength-0.85"]') !== null
          );
        })
      : false;
    check(onTop, 'the strength menu did not open above the viewer');
    await shot('04b-viewer-strength-menu-light');
    await page.keyboard.press('Escape');
    await sleep(400);
    check(
      (await exists('[data-testid="image-viewer"]')) &&
        !(await exists('[data-testid="viewer-strength-0.85"]')),
      'Escape in the strength menu did not close just the menu',
    );

    /* Tab stays in the room: the page behind is inert while it is open, so
       focus cannot walk into the chat composer under it. */
    check(
      await page.evaluate(() => document.getElementById('root')?.inert === true),
      'the page behind the viewer is not inert',
    );
    const strayed = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.closest('[data-testid="image-viewer"]') !== null
          ? null
          : (el?.outerHTML.slice(0, 90) ?? 'nothing');
      });
      if (where !== null) strayed.push(where);
    }
    check(strayed.length === 0, `Tab left the viewer: ${strayed[0]}`);
    // Back in the field (a focused rail button shows its label, and Escape
    // closes that label first — one press, one layer).
    await page.click('[data-testid="viewer-edit-input"]');
    const layers = await page
      .waitForFunction(
        () => document.querySelectorAll('[data-radix-popper-content-wrapper]').length === 0,
        undefined,
        { timeout: 3000 },
      )
      .then(() => 0)
      .catch(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].map((w) =>
            (w.textContent ?? '').slice(0, 40),
          ),
        ),
      );
    if (layers !== 0) log('still floating before Escape:', JSON.stringify(layers));

    // Escape closes it, and only it.
    await page.keyboard.press('Escape');
    await sleep(500);
    check(!(await exists('[data-testid="image-viewer"]')), 'Escape did not close the viewer');
    check(await exists('[data-testid="media-card"]'), 'Escape took the chat with it');
    check(
      await page.evaluate(() => document.getElementById('root')?.inert === false),
      'the page stayed inert after the viewer closed',
    );
  } else if (oldExpanded) {
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  /* The old corner button, for the record of what "open" used to be. */
  await page.locator('[data-testid="media-card"]').first().hover();
  await sleep(400);
  if (await exists('[data-testid="media-expand"]')) {
    await page.click('[data-testid="media-expand"]');
    await sleep(900);
    await shot('05-open-larger-button-light');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  /* ── dark ───────────────────────────────────────────────────────────── */
  await setTheme('dark');
  await shot('06-chat-card-dark');
  await clickPicture();
  const openedDark = await waitFor('[data-testid="image-viewer"]', 4000);
  await sleep(800);
  await shot('07-card-click-dark');
  if (openedDark) {
    await page.fill('[data-testid="viewer-edit-input"]', INSTRUCTION);
    await sleep(250);
    await shot('08-viewer-edit-focused-dark');
    await page.fill('[data-testid="viewer-edit-input"]', '');
    await page.keyboard.press('Escape');
    await sleep(400);
  }
  await setTheme('light');

  /* ── 4. copy → paste, through the system clipboard ──────────────────── */
  const count0 = pasteboardCount();
  await clearAttachments();
  const before = await attachments();
  check(before.count === 0, `the composer already holds ${before.count} attachment(s)`);
  await page.locator('[data-testid="media-card"]').first().hover();
  await sleep(400);
  await page.click('[data-testid="media-copy"]');
  await sleep(600);
  const count1 = pasteboardCount();
  log('pasteboard change count', count0, '→', count1, '(the card wrote it)');
  await pasteIntoComposer();
  const fromCard = await attachments();
  log('paste from the card →', JSON.stringify(fromCard));
  check(
    fromCard.count === 1 && fromCard.image && fromCard.w === 1024 && fromCard.h === 1024,
    `pasting the card's copy did not attach the picture: ${JSON.stringify(fromCard)}`,
  );
  await shot('09-paste-from-card-light');
  await clip('09b-paste-from-card-composer', '.pd-composer-root', 16);

  /* The composer's own look-closer view (the other user of the shared scrim):
     double-click the pasted picture, Escape, and focus is back in the box. */
  await page.dblclick('[data-testid="attach-chip"] img.pd-attach-thumb');
  const preview = await waitFor('[data-testid="attachment-expanded"]', 3000);
  check(preview, 'double-clicking the pasted picture did not open it');
  if (preview) {
    await sleep(400);
    await page.keyboard.press('Escape');
    await sleep(400);
    const back = await page.evaluate(() => ({
      closed: document.querySelector('[data-testid="attachment-expanded"]') === null,
      inComposer: document.activeElement?.closest('.pd-composer-root') !== null,
      inert: document.getElementById('root')?.inert === true,
    }));
    check(
      back.closed && !back.inert,
      `the attachment preview did not close cleanly: ${JSON.stringify(back)}`,
    );
    check(back.inComposer, 'focus did not come back to the composer after the preview closed');
  }

  await clearAttachments();
  // A picture from OUTSIDE the renderer — put on the clipboard by main, the
  // way any other app's copy arrives.
  const outside = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#1f6feb';
    g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#f5a623';
    g.fillRect(40, 40, 120, 120);
    g.fillStyle = '#ffffff';
    g.font = 'bold 28px sans-serif';
    g.fillText('pasted', 180, 110);
    return c.toDataURL('image/png');
  });
  await app.evaluate(({ clipboard, nativeImage }, url) => {
    clipboard.writeImage(nativeImage.createFromDataURL(url));
  }, outside);
  const count2 = pasteboardCount();
  await pasteIntoComposer();
  const fromOutside = await attachments();
  log('paste from outside →', JSON.stringify(fromOutside));
  check(
    fromOutside.count === 1 && fromOutside.image && fromOutside.w === 320 && fromOutside.h === 200,
    `pasting an outside PNG did not attach it: ${JSON.stringify(fromOutside)}`,
  );
  await shot('10-paste-from-outside-light');
  await clip('10b-paste-from-outside-composer', '.pd-composer-root', 16);

  /*
   * THE NEWEST COPY WINS ⌘V. Copy the chip with the composer's own clipboard
   * (click it, ⌘C), then copy the card: ⌘V must paste the CARD's picture. The
   * chip clipboard used to claim every ⌘V once it held anything, so this pasted
   * the 320×200 chip again. Told apart by size.
   */
  await page.locator('[data-testid="attach-chip"]').first().click();
  await sleep(200);
  await page.keyboard.press('Meta+c');
  await sleep(200);
  await page.locator('[data-testid="media-card"]').first().hover();
  await sleep(400);
  await page.click('[data-testid="media-copy"]');
  await sleep(600);
  const lastWrite = pasteboardCount();
  await pasteIntoComposer();
  const newest = await page.evaluate(async () => {
    const chips = [...document.querySelectorAll('[data-testid="attach-chip"] img.pd-attach-thumb')];
    const src = chips[chips.length - 1]?.getAttribute('src') ?? '';
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => undefined);
    return { count: chips.length, w: img.naturalWidth, h: img.naturalHeight };
  });
  log('chip copied, then the card copied, ⌘V →', JSON.stringify(newest));
  check(
    newest.count === 2 && newest.w === 1024 && newest.h === 1024,
    `⌘V after a newer card copy did not paste the card's picture: ${JSON.stringify(newest)}`,
  );

  // Our picture off the clipboard, if nothing newer landed there meanwhile.
  const count3 = pasteboardCount();
  if (lastWrite !== null && count3 === lastWrite) {
    await app.evaluate(({ clipboard }) => clipboard.clear());
    log('cleared the probe picture off the clipboard');
  } else {
    log('the clipboard changed under the probe — left alone', count2, count3);
  }
  await clearAttachments();

  /* ── 3. an edit ─────────────────────────────────────────────────────── */
  const EDITED = path.join(GEN, 'fox-in-snow-golden.png');
  if (!REAL) {
    /* The STUB's picture: the fixture, warmed in a canvas. Says nothing about
       any model — only how the viewer shows a run and its result. */
    const b64 = await page.evaluate(
      (dataUrl) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext('2d');
            g.filter = 'sepia(0.45) saturate(1.35) hue-rotate(-12deg) brightness(0.95)';
            g.drawImage(img, 0, 0);
            resolve(c.toDataURL('image/png').split(',')[1]);
          };
          img.src = dataUrl;
        });
      },
      `data:image/png;base64,${readFileSync(PICTURE).toString('base64')}`,
    );
    writeFileSync(EDITED, Buffer.from(b64, 'base64'));
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, { out }) => {
        globalThis.__probeGenRequests = [];
        ipcMain.removeHandler('gen:generate');
        ipcMain.handle('gen:generate', async (_e, req) => {
          globalThis.__probeGenRequests.push(req);
          const wc = BrowserWindow.getAllWindows()[0]?.webContents;
          const send = (channel, payload) => wc?.send('pi-desktop:event', { channel, payload });
          const tabId = 'pi:gen-probe_stub';
          const base = {
            modality: 'image',
            model: { id: 'stub', label: 'stub', license: 'none' },
            prompt: req.prompt,
            candidates: [{ status: 'generating' }],
            status: 'generating',
          };
          send('gen:open', { tabId, payload: base });
          for (let step = 1; step <= 15; step++) {
            await new Promise((r) => setTimeout(r, 400));
            send('gen:update', {
              tabId,
              payload: { ...base, progress: { candidate: 0, step, total: 15 } },
            });
          }
          return { jobId: 'probe_stub', outputs: [{ path: out }] };
        });
      },
      { out: EDITED },
    );
    log('gen:generate is STUBBED in main (no model runs) — set REAL=1 for a real edit');
  }

  await clickPicture();
  const openedForEdit = await waitFor('[data-testid="image-viewer"]', 4000);
  if (openedForEdit) {
    await sleep(600);
    const pictureBox = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="viewer-picture"]')?.getBoundingClientRect();
      return b === undefined ? null : { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    if (process.env.STRENGTH !== undefined) {
      await page.click('[data-testid="viewer-strength"]');
      await page.click(`[data-testid="viewer-strength-${process.env.STRENGTH}"]`);
      await sleep(300);
    }
    await page.fill('[data-testid="viewer-edit-input"]', INSTRUCTION);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    const waiting = await waitFor(
      '[data-testid="image-viewer"] [data-testid="pending-media-card"]',
      8000,
    );
    check(waiting, 'no waiting card appeared in the viewer while the edit ran');
    if (REAL) {
      /* MID-RUN ON A CLOCK. Qwen-Image 2.1 runs without step previews, and its
         step counter only reaches the bar in a burst at the end — waiting for
         20% caught the reveal, not the run (SEEN on the first real run). */
      await sleep(Number(process.env.RUNNING_SHOT_S ?? 30) * 1000);
    } else {
      // Past the first steps, so the bar and the phrase are showing progress.
      await page
        .waitForFunction(
          () =>
            Number(
              document
                .querySelector('[data-testid="image-viewer"] [role="progressbar"]')
                ?.getAttribute('aria-valuenow') ?? '0',
            ) >= 20,
          undefined,
          { timeout: 15_000, polling: 500 },
        )
        .catch(() => undefined);
    }
    await shot('11-edit-running-light');
    log(
      'the waiting card says',
      JSON.stringify(
        await page.evaluate(() => ({
          phase: document.querySelector(
            '[data-testid="image-viewer"] [data-testid="pending-phase"]',
          )?.textContent,
          caption: document.querySelector(
            '[data-testid="image-viewer"] [data-testid="pending-pct"]',
          )?.textContent,
        })),
      ),
    );
    const pendingBox = await page.evaluate(() => {
      const card = document.querySelector(
        '[data-testid="image-viewer"] [data-testid="pending-media-card"]',
      );
      const f = card?.querySelector('.pd-media-frame')?.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="viewer-bar"]')?.getBoundingClientRect();
      return f === undefined
        ? null
        : {
            x: f.x,
            y: f.y,
            w: f.width,
            h: f.height,
            // The card's own bar and caption hang under the frame; they must
            // clear the edit bar (and a Download card on top of it).
            tailClear: (card?.getBoundingClientRect().bottom ?? 0) <= (bar?.top ?? 0) + 0.5,
          };
    });
    log('picture', JSON.stringify(pictureBox), '→ waiting card frame', JSON.stringify(pendingBox));
    /* The card holds the picture's box — same place, same size — so the result
       is uncovered exactly where the picture was. */
    // The frame's 1px border lands on the picture's 1px ring: the picture's
    // box, one pixel out on every side.
    const near = (a, b) => Math.abs(a - b) <= 0.75;
    check(
      pictureBox !== null &&
        pendingBox !== null &&
        near(pictureBox.x - 1, pendingBox.x) &&
        near(pictureBox.y - 1, pendingBox.y) &&
        near(pictureBox.w + 2, pendingBox.w) &&
        near(pictureBox.h + 2, pendingBox.h) &&
        pendingBox.tailClear,
      `the waiting card does not hold the picture's box: ${JSON.stringify({ pictureBox, pendingBox })}`,
    );

    // The result: a second version in the History, on the stage.
    const landed = await page
      .waitForFunction(
        () =>
          document.querySelectorAll('[data-testid="viewer-history"] .tp-history-node').length ===
            2 && document.querySelector('[data-testid="viewer-picture"]') !== null,
        undefined,
        { timeout: REAL ? CAP_MS : 30_000, polling: 500 },
      )
      .then(() => true)
      .catch(() => false);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const err = await page
      .locator('[data-testid="viewer-edit-error"]')
      .textContent()
      .catch(() => null);
    log(`edit ${landed ? 'landed' : 'did not land'} after ${secs}s`, err ?? '');
    check(landed, `the edit never landed in the viewer (${err ?? 'no error shown'})`);
    await sleep(900);
    await shot('12-edit-result-light');

    const onStage = await page.evaluate(
      () => document.querySelector('[data-testid="viewer-picture"]')?.getAttribute('src') ?? '',
    );
    log('on stage', onStage);
    if (!REAL) {
      const reqs = await app.evaluate(() => globalThis.__probeGenRequests ?? []);
      log('gen:generate asked for', JSON.stringify(reqs));
      const q = reqs[0] ?? {};
      check(q.inputImage === PICTURE, `the edit did not start from the picture: ${q.inputImage}`);
      check(q.prompt === INSTRUCTION, `the edit's words were "${q.prompt}"`);
      check(
        q.strength === Number(process.env.STRENGTH ?? 0.6) && q.size === '1024x1024',
        `strength/size: ${q.strength} ${q.size}`,
      );
      check(
        onStage.includes('fox-in-snow-golden.png'),
        'the result is not the picture on the stage',
      );
    } else if (landed) {
      /* DERIVED FROM THE INPUT, not a fresh picture of the words: the layout
         of light and dark survives an edit and does not survive a new
         generation. 32×32 luminance, Pearson r. */
      const made = decodeURIComponent(onStage.replace(/^pd-file:\/\/f/, ''));
      copyFileSync(PICTURE, path.join(SHOT_DIR, `${PHASE}-edit-input.png`));
      copyFileSync(made, path.join(SHOT_DIR, `${PHASE}-edit-output.png`));
      const stats = await page.evaluate(
        async ([a, b]) => {
          const read = async (p) => {
            const res = await fetch(`pd-file://f${p.split('/').map(encodeURIComponent).join('/')}`);
            const bmp = await createImageBitmap(await res.blob());
            const c = new OffscreenCanvas(32, 32);
            const g = c.getContext('2d');
            g.drawImage(bmp, 0, 0, 32, 32);
            const d = g.getImageData(0, 0, 32, 32).data;
            const lum = [];
            for (let i = 0; i < d.length; i += 4)
              lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
            return { lum, w: bmp.width, h: bmp.height };
          };
          const [x, y] = await Promise.all([read(a), read(b)]);
          const mean = (v) => v.reduce((s, n) => s + n, 0) / v.length;
          const mx = mean(x.lum);
          const my = mean(y.lum);
          let sxy = 0;
          let sxx = 0;
          let syy = 0;
          let diff = 0;
          for (let i = 0; i < x.lum.length; i++) {
            sxy += (x.lum[i] - mx) * (y.lum[i] - my);
            sxx += (x.lum[i] - mx) ** 2;
            syy += (y.lum[i] - my) ** 2;
            diff += Math.abs(x.lum[i] - y.lum[i]);
          }
          return {
            r: sxy / Math.sqrt(sxx * syy),
            meanAbs: diff / x.lum.length,
            outW: y.w,
            outH: y.h,
          };
        },
        [PICTURE, made],
      );
      log('real edit vs input', JSON.stringify(stats));
      check(stats.meanAbs > 2, `the edit is the input unchanged (Δ ${stats.meanAbs.toFixed(1)})`);
      check(stats.r > 0.5, `the edit does not keep the input's layout (r ${stats.r.toFixed(2)})`);
      check(
        stats.outW === 1024 && stats.outH === 1024,
        `the edit came back ${stats.outW}×${stats.outH}`,
      );
    }

    // The original is one click back in the History.
    if (landed) {
      await page.click('[data-testid="viewer-version-0"]');
      await sleep(600);
      const back = await page.evaluate(
        () => document.querySelector('[data-testid="viewer-picture"]')?.getAttribute('src') ?? '',
      );
      check(
        back.includes('fox-in-snow.png') && !back.includes('golden'),
        'History did not go back to the original',
      );
      await shot('13-history-original-light');
      await page.click('[data-testid="viewer-version-1"]');
      await sleep(400);
    }

    // Closed and opened again: the history is still there.
    await page.keyboard.press('Escape');
    await sleep(400);
    await clickPicture();
    await waitFor('[data-testid="image-viewer"]', 4000);
    await sleep(600);
    const kept = await page.evaluate(
      () => document.querySelectorAll('[data-testid="viewer-history"] .tp-history-node').length,
    );
    check(!landed || kept === 2, `reopening lost the edit history (${kept} versions)`);
    await setTheme('dark');
    await sleep(300);
    await shot('14-edit-result-dark');
    await setTheme('light');

    // The edit is not in the transcript: still one card there.
    const cards = await page.evaluate(
      () =>
        document.querySelectorAll(
          '.pd-thread [data-testid="media-card"], [data-testid="thread-media"] [data-testid="media-card"]',
        ).length,
    );
    check(cards === 1, `the transcript now shows ${cards} cards — the edit was posted into it`);

    // Send to chat: the version on screen becomes a composer attachment.
    await page.click('[data-testid="viewer-send-chat"]');
    await sleep(900);
    const sent = await attachments();
    check(!(await exists('[data-testid="image-viewer"]')), 'Send to chat left the viewer open');
    check(
      sent.count === 1 && sent.image,
      `Send to chat did not attach the picture: ${JSON.stringify(sent)}`,
    );
    await shot('15-sent-to-chat-light');
  }
} catch (err) {
  console.error('image-viewer-probe threw:', err);
  process.exitCode = 1;
  await shot('zz-error').catch(() => undefined);
} finally {
  await finish();
}
