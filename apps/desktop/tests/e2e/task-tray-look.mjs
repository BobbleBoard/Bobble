/**
 * THE TASK TRAY, LOOKED AT — the button beside the sidebar toggle, and its card.
 *
 * the user (2026-09-24): "a little notifications button in the top left … always
 * simply to the right of the collapse sidebar button, this only appears when
 * you leave a running task, eg. chat, generation etc. and clicking on it has a
 * quick little card".
 *
 * Driven through the real app with only the backends stubbed:
 *   - a chat left replying in the background (the pi store's own bgRun, which
 *     is what switching away from a streaming chat produces);
 *   - a picture left running in the Image studio (Generate pressed for real;
 *     main's `gen:generate` stubbed to stream `gen:open`/`gen:update` with the
 *     request id, as the real handler does);
 *   - a 3D job left running in the 3D studio (the studio's own `generate`, with
 *     main's `gen3d:generate` stubbed and `gen3d:job` events played from main).
 * Then they end while you are away — a question, a finished picture, a failed
 * mesh — and the card is shot in light and dark; the sidebar is collapsed to
 * check the button stays and nothing moves; rows are opened, dismissed and
 * cleared until the button is gone.
 *
 *   SHOT_DIR=<dir> node apps/desktop/tests/e2e/task-tray-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { eveningPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page, check, finish, home, shotDir } = await launchApp('task-tray', {
  waitFor: '[data-testid="composer-input"]',
});

/* A picture for the finished run (pd-file:// only serves this home's media). */
const media = path.join(home, 'Bobble', 'generated', 'a-red-fox');
mkdirSync(media, { recursive: true });
const FOX = path.join(media, 'fox-1.png');
writeFileSync(FOX, eveningPng());

const setMode = (mode) =>
  page.evaluate((mode) => {
    const t = window.__pi_theme?.();
    t?.setFlavor?.('bobble');
    t?.setMode?.(mode);
  }, mode);

/** The corner beside the traffic lights, at rest (the pointer off the buttons). */
const corner = async (label) => {
  await page.mouse.move(900, 620);
  await sleep(200);
  await page.screenshot({
    path: path.join(shotDir, `${label}.png`),
    clip: { x: 0, y: 0, width: 460, height: 60 },
  });
};
/** Is the first row lit as the card opens? (It is focused either way.) */
const firstRowLit = () =>
  page.evaluate(() => {
    const row = document.querySelector('[data-testid="task-row"] .pd-task-row-open');
    return {
      focused: row !== null && document.activeElement === row,
      background: row === null ? null : getComputedStyle(row).backgroundColor,
      ring: document.documentElement.getAttribute('data-focus-ring'),
    };
  });

/** The open card with its button, and room around it for the sheet's shadow. */
const cardShot = async (label) => {
  const panel = await page.locator('[data-testid="task-tray-panel"]').boundingBox();
  if (!check(panel !== null, `the card is open for ${label}`)) return;
  const pad = 36;
  await page.screenshot({
    path: path.join(shotDir, `${label}.png`),
    clip: {
      x: 0,
      y: 0,
      width: Math.min(1440, panel.x + panel.width + pad),
      height: Math.min(900, panel.y + panel.height + pad),
    },
  });
};

const button = () => page.$('[data-testid="task-tray"]');
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="task-row"]')].map((r) => ({
      key: r.getAttribute('data-key'),
      state: r.getAttribute('data-state'),
      title: r.querySelector('[data-testid="task-row-title"]')?.textContent ?? '',
      meta: r.querySelector('[data-testid="task-row-meta"]')?.textContent ?? '',
      height: Math.round(r.getBoundingClientRect().height),
    })),
  );
const openCard = async () => {
  if ((await page.$('[data-testid="task-tray-panel"]')) !== null) return;
  await page.click('[data-testid="task-tray"]');
  await page.waitForSelector('[data-testid="task-tray-panel"]', { timeout: 5000 });
  await sleep(350);
};
const closeCard = async () => {
  if ((await page.$('[data-testid="task-tray-panel"]')) === null) return;
  await page.keyboard.press('Escape');
  await sleep(250);
};
/** Where the chrome corner ends and the collapsed title starts. */
const layout = () =>
  page.evaluate(() => {
    const zone = document.querySelector('[data-testid="sidebar-toggle-zone"]');
    const title = document.querySelector('.pd-topbar-section:first-child');
    return {
      zoneRight: Math.round(zone?.getBoundingClientRect().right ?? -1),
      corner: getComputedStyle(document.documentElement).getPropertyValue('--pd-chrome-corner'),
      titleLeft: Math.round(title?.getBoundingClientRect().left ?? -1),
      titlePad: title === null ? null : getComputedStyle(title).paddingLeft,
    };
  });
/** The computed look of the button and the card, printed beside the pixels. */
const computed = () =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid="task-tray"]');
    const toggle = document.querySelector(
      '[data-testid="collapse-sidebar"], [data-testid="expand-sidebar"]',
    );
    const p = document.querySelector('[data-testid="task-tray-panel"]');
    const title = document.querySelector('[data-testid="task-row-title"]');
    const meta = document.querySelector('[data-testid="task-row-meta"]');
    const time = document.querySelector('.pd-task-row-time');
    const cs = (el, keys) =>
      el === null ? null : Object.fromEntries(keys.map((k) => [k, getComputedStyle(el)[k]]));
    const rect = (el) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    return {
      button: { rect: rect(b), ...cs(b, ['color']) },
      toggle: { rect: rect(toggle), ...cs(toggle, ['color']) },
      panel: cs(p, ['backgroundColor', 'boxShadow', 'borderRadius', 'width']),
      title: cs(title, ['fontSize', 'fontWeight', 'color']),
      meta: cs(meta, ['fontSize', 'color']),
      time: cs(time, ['color', 'fontVariantNumeric']),
    };
  });

/* ── the backends, stubbed in MAIN ───────────────────────────────────────── */
await app.evaluate(({ ipcMain, BrowserWindow }) => {
  const g = { jobs: [] };
  globalThis.__probeGen = g;
  g.emit = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('pi-desktop:event', { channel, payload });
    }
  };
  ipcMain.removeHandler('gen:generate');
  ipcMain.handle(
    'gen:generate',
    (_e, req) =>
      new Promise((resolve) => {
        const jobId = `gen_probe_${g.jobs.length + 1}`;
        const job = { req, jobId, tabId: `pi:gen-${jobId}`, resolve };
        job.base = {
          modality: req.kind,
          model: { id: 'probe', label: 'Probe', license: 'Apache-2.0' },
          prompt: req.prompt,
          size: { width: 1024, height: 1024 },
          candidates: [{ seed: 7, status: 'pending' }],
          ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
        };
        g.jobs.push(job);
        g.emit('gen:open', { tabId: job.tabId, payload: { ...job.base, status: 'generating' } });
      }),
  );
  ipcMain.removeHandler('gen3d:generate');
  ipcMain.handle('gen3d:generate', () => ({ ok: true, jobId: 'g3d_probe_1' }));
});
const genProgress = (step, total) =>
  app.evaluate(
    (_e, [step, total]) => {
      const g = globalThis.__probeGen;
      const job = g.jobs[g.jobs.length - 1];
      g.emit('gen:update', {
        tabId: job.tabId,
        payload: { ...job.base, status: 'generating', progress: { candidate: 0, step, total } },
      });
    },
    [step, total],
  );
const genComplete = (file) =>
  app.evaluate((_e, file) => {
    const g = globalThis.__probeGen;
    const job = g.jobs[g.jobs.length - 1];
    job.resolve({ jobId: job.jobId, outputs: [{ path: file, seed: 7, model: 'probe' }] });
  }, file);
const job3d = (update) =>
  app.evaluate((_e, update) => {
    globalThis.__probeGen.emit('gen3d:job', {
      jobId: 'g3d_probe_1',
      stage: 'geometry',
      message: 'Shape (step 12/20)',
      stagePercent: 60,
      overallPercent: 40,
      done: false,
      ...update,
    });
  }, update);

const LISBON = '/probe/sessions/plan-the-lisbon-trip.jsonl';
const CURRENT = '/probe/sessions/current.jsonl';

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => typeof window.__task_tray === 'function', { timeout: 20_000 });
  await setMode('light');
  await sleep(600);

  /* ── 00 nothing left: no button, but its slot is held ─────────────────── */
  check((await button()) === null, 'nothing left running: no button');
  check(
    (await page.$('[data-testid="task-tray-slot"]')) !== null,
    'the slot beside the toggle is there, empty',
  );
  await page.click('[data-testid="collapse-sidebar"]');
  await sleep(700);
  const collapsedEmpty = await layout();
  await corner('00-nothing-left-collapsed');
  await page.click('[data-testid="expand-sidebar"]');
  await sleep(700);
  await corner('00-nothing-left');

  /* ── 01 a chat left replying in the background ────────────────────────── */
  await page.evaluate(
    ([lisbon, current]) => {
      const started = Date.now() - 83_000;
      window.__pi_store().setState({
        session: { sessionFile: current, sessionId: 'current' },
        bgRun: {
          sessionFile: lisbon,
          streaming: true,
          title: 'Plan the Lisbon trip',
          messages: [
            { kind: 'user', id: 'u1', text: 'Plan three days in Lisbon', timestamp: started },
          ],
        },
      });
    },
    [LISBON, CURRENT],
  );
  await page.waitForSelector('[data-testid="task-tray"]', { timeout: 5000 });
  await sleep(500);
  check((await button()) !== null, 'a chat left replying: the button appears');
  await corner('01-bg-chat-running');

  /* ── 02 a picture left running in the Image studio ─────────────────────── */
  if ((await page.$('[data-testid="modality-image"]')) === null) {
    await page.click('text=Modalities');
    await sleep(300);
  }
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('[data-testid="image-studio"]', { timeout: 30_000 });
  await sleep(500);
  await page.click('[data-testid="studio-prompt"]');
  await page.keyboard.type('A red fox asleep in tall grass, low evening sun');
  await page.click('[data-testid="studio-run"]');
  await page.waitForSelector('[data-testid="studio-job"]', { timeout: 15_000 });
  await sleep(300);
  await genProgress(3, 8);
  // In the room: the picture is not listed (you are looking at it).
  const inRoom = await rows();
  check(
    !inRoom.some((r) => r.key === 'studio:image'),
    'in the Image studio its own job is not listed',
  );

  /* ── 03 a 3D job left running ─────────────────────────────────────────── */
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 30_000 });
  await sleep(800);
  await page.evaluate(() =>
    window.__gen3d_store().getState().generate({
      kind: 'text',
      prompt: 'A low-poly lighthouse',
      resolution: 'medium',
      texture: true,
    }),
  );
  await job3d({});
  await sleep(300);
  // Back to the chat you were in. Escape, not a click: the throwaway home has
  // no 3D module, and a click in the middle of the studio lands on the
  // module gate's Download button.
  await page.evaluate(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await sleep(1200);

  const running = await rows();
  console.log('running rows', JSON.stringify(running));
  await openCard();
  const running2 = await rows();
  console.log('running rows', JSON.stringify(running2));
  check(
    running2
      .map((r) => `${r.key}:${r.state}`)
      .sort()
      .join(' ') ===
      [`chat:${LISBON}:running`, 'studio:3d:running', 'studio:image:running'].sort().join(' '),
    `three tasks left running, one row each (${running2.map((r) => r.key).join(', ')})`,
  );
  check(
    running2.every((r) => r.height >= 36 && r.height <= 44),
    `rows are compact, 36–44px (${running2.map((r) => r.height).join(', ')})`,
  );
  const chatRow = running2.find((r) => r.key === `chat:${LISBON}`);
  check(
    chatRow?.title === 'Plan the Lisbon trip',
    `the chat row names the chat (${chatRow?.title})`,
  );
  // One word, one time: "Running · 1m 28s" — the turn began 83 s before the
  // bg run was seeded, so the clock reads from THAT, not from when we looked.
  const meta = (chatRow?.meta ?? '').replace(/\s/g, '');
  const secs = /^Running·(?:(\d+)m)?(?:(\d+)s)?$/.exec(meta);
  check(
    secs !== null && Number(secs[1] ?? 0) * 60 + Number(secs[2] ?? 0) >= 83,
    `status once, with the live elapsed time from the turn's start (${chatRow?.meta})`,
  );
  check(
    (chatRow?.meta.match(/Running/g) ?? []).length === 1,
    'the state word appears once in the row',
  );
  const picRow = running2.find((r) => r.key === 'studio:image');
  check(
    picRow?.title.startsWith('A red fox asleep') === true,
    `the studio row names what was asked for (${picRow?.title})`,
  );
  await sleep(1100);
  const ticked = (await rows()).find((r) => r.key === `chat:${LISBON}`)?.meta;
  check(ticked !== chatRow?.meta, `the elapsed time moves (${chatRow?.meta} → ${ticked})`);
  console.log('look', JSON.stringify(await computed()));
  await cardShot('02-card-running-light');
  await closeCard();
  await corner('02-running-corner');

  /* ── 04 they end while you are away ───────────────────────────────────── */
  // The chat stops to ask something; the picture finishes; the mesh fails.
  // Through the app's own sink — the path pi's ask_user takes — so the
  // request is tagged with the background chat exactly as a real one is.
  await page.evaluate(() =>
    window.__pi_sink().uiRequest({
      id: 'ask-dates',
      method: 'input',
      title: 'Which dates work for you?',
      placeholder: 'e.g. 12–15 May',
    }),
  );
  await genComplete(FOX);
  await job3d({
    stage: 'texture',
    message: 'Out of memory while baking the texture',
    done: true,
    error: 'Out of memory while baking the texture',
  });
  await sleep(900);
  await corner('03-news-corner-light');
  await openCard();
  const mixed = await rows();
  console.log('mixed rows', JSON.stringify(mixed));
  check(
    mixed.map((r) => r.state).join(',') === 'needs-input,failed,done',
    `waiting-on-you first, then what ended (${mixed.map((r) => r.state).join(',')})`,
  );
  check(
    (await page.getAttribute('[data-testid="task-tray"]', 'data-tone')) === 'needs-input',
    "the button's mark is the most urgent row's",
  );
  // Opened with the pointer: the first row takes focus but is not lit — SEEN
  // on the first pass of this probe, a click-opened card arriving with its
  // first row highlighted because the Escape before it had counted as
  // "keyboard".
  const byPointer = await firstRowLit();
  console.log('first row, pointer-opened', JSON.stringify(byPointer));
  check(
    byPointer.background === 'rgba(0, 0, 0, 0)',
    `a click-opened card has no row lit (${byPointer.background})`,
  );
  await cardShot('03-card-mixed-light');
  await closeCard();
  // …and opened from the keyboard, the focused row IS lit.
  await page.focus('[data-testid="task-tray"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="task-tray-panel"]', { timeout: 5000 });
  await sleep(300);
  const byKey = await firstRowLit();
  console.log('first row, keyboard-opened', JSON.stringify(byKey));
  check(
    byKey.focused && byKey.background !== 'rgba(0, 0, 0, 0)',
    `a keyboard-opened card shows where focus is (${byKey.background})`,
  );
  await cardShot('03-card-keyboard-light');
  await closeCard();
  await setMode('dark');
  await sleep(500);
  await openCard();
  console.log('look (dark)', JSON.stringify(await computed()));
  await cardShot('03-card-mixed-dark');
  await closeCard();
  await corner('03-news-corner-dark');

  /* ── 05 collapsed: the button stays, and the title slides clear of it ── */
  await page.click('[data-testid="collapse-sidebar"]');
  await sleep(700);
  const collapsedWith = await layout();
  console.log(
    'collapsed layout, empty vs with button',
    JSON.stringify([collapsedEmpty, collapsedWith]),
  );
  check((await button()) !== null, 'with the sidebar collapsed the button is still there');
  /* The slot opens with the button (TaskTray.tsx) and the title slides aside:
     with a task it starts clear of the bell; with none the corner is narrower,
     so there is no empty gap between the toggle and the title. */
  const textStart = (l) => l.titleLeft + Number.parseFloat(l.titlePad ?? '0');
  check(
    textStart(collapsedWith) >= collapsedWith.zoneRight,
    `the title clears the bell (${textStart(collapsedWith)} ≥ ${collapsedWith.zoneRight})`,
  );
  check(
    collapsedEmpty.zoneRight < collapsedWith.zoneRight &&
      textStart(collapsedEmpty) < textStart(collapsedWith),
    `with nothing in the tray the title sits closer (${textStart(collapsedEmpty)} vs ${textStart(collapsedWith)})`,
  );
  await corner('04-collapsed-dark');
  await openCard();
  await cardShot('04-card-collapsed-dark');
  await closeCard();
  await page.click('[data-testid="expand-sidebar"]');
  await sleep(700);
  await setMode('light');
  await sleep(400);

  /* ── 06 open a finished row: it takes you there and clears ─────────────── */
  await openCard();
  await page.click('[data-testid="task-row"][data-key="studio:image"] .pd-task-row-open');
  await page.waitForSelector('[data-testid="image-studio"]', { timeout: 10_000 });
  await sleep(700);
  const inStudio = await page.evaluate(() => ({
    view: window.__modality_store?.().getState().view,
    results: document.querySelectorAll('[data-testid="studio-results"] img').length,
    card: document.querySelector('[data-testid="task-tray-panel"]') !== null,
  }));
  check(inStudio.view === 'image', 'the picture row opened the Image studio');
  check(inStudio.results >= 1, 'where the finished picture is waiting');
  check(!inStudio.card, 'and the card closed behind it');
  await page.screenshot({ path: path.join(shotDir, '05-opened-the-picture.png') });
  await openCard();
  const afterOpen = await rows();
  check(
    !afterOpen.some((r) => r.key === 'studio:image'),
    'the finished picture is no longer listed — it has been seen',
  );

  /* ── 07 dismiss one, then clear the rest of the finished ─────────────── */
  await page.hover('[data-testid="task-row"][data-key="studio:3d"]');
  await sleep(250);
  await cardShot('06-dismiss-hover');
  await page.click(
    '[data-testid="task-row"][data-key="studio:3d"] [data-testid="task-row-dismiss"]',
  );
  await sleep(300);
  const afterDismiss = await rows();
  check(
    afterDismiss.map((r) => r.key).join(',') === `chat:${LISBON}`,
    `dismissing a finished row leaves the rest (${afterDismiss.map((r) => r.key).join(',')})`,
  );
  check(
    (await page.$('[data-testid="task-tray-clear"]')) === null,
    'nothing finished is left, so there is nothing to clear',
  );

  /* ── 08 go to the chat that is waiting on you: the button goes ────────── */
  await page.click(`[data-testid="task-row"][data-key="chat:${LISBON}"] .pd-task-row-open`);
  await sleep(900);
  const viewed = await page.evaluate(() => window.__pi_store().getState().session?.sessionFile);
  check(viewed === LISBON, `the chat row opened that chat (${viewed})`);
  check((await button()) === null, 'with nothing left, the button is gone');
  await corner('07-all-seen-corner');
  await page.screenshot({ path: path.join(shotDir, '07-in-the-waiting-chat.png') });
} finally {
  const ok = await finish();
  console.log(`task-tray-look: shots in ${shotDir}`);
  if (!ok) process.exitCode = 1;
}
