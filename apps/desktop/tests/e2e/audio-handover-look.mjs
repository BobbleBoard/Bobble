/**
 * A SOUND'S HANDOVER — does the finished card's border and ground arrive all at
 * once?
 *
 * From the review of the 2026-09-23 wave (renderer-ui): the waiting audio strip
 * is borderless with no ground, and the finished audio card's frame has a 1px
 * border and the sunken ground. For a picture or a clip the frame takes that
 * chrome while the reveal plays (`data-revealing`), so the finished card that
 * replaces it has nothing left to change; the rule doing that skipped audio.
 *
 * Every animation frame across the handover is recorded — which card holds the
 * sound, and its frame's border and ground — in the chat (generate_music) and in
 * the Audio studio (`gen:generate` stubbed in MAIN, as studio-leave-return does).
 * A pop is the last frame of the waiting card and the first frame of the
 * finished one disagreeing. A screencast of the studio handover is kept as a
 * filmstrip.
 *
 * The checks assert the fixed behaviour, so the unmodified app fails them.
 *
 *   OUT=<dir> node apps/desktop/tests/e2e/audio-handover-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { cropPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page, check, finish, home, shotDir } = await launchApp('audio-handover', {
  waitFor: '[data-testid="composer-input"]',
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });

/** One second of a swelling 440 Hz tone: 16-bit mono 8 kHz PCM, so the bars have peaks to find. */
function wav() {
  const rate = 8000;
  const n = rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.abs(Math.sin((i / n) * Math.PI * 3));
    buf.writeInt16LE(
      Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * env * 26000),
      44 + i * 2,
    );
  }
  return buf;
}
const media = path.join(home, 'Bobble', 'generated', 'fast-dubstep');
mkdirSync(media, { recursive: true });
const SONG = path.join(media, 'song-1.wav');
writeFileSync(SONG, wav());

const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);

/** Record every frame: which card holds the sound, and its frame's chrome. */
const record = () =>
  page.evaluate(() => {
    window.__rec = [];
    const t0 = performance.now();
    const read = (el) => {
      if (el === null) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        border: cs.borderTopColor,
        ground: cs.backgroundColor,
        box: [r.left, r.top, r.width, r.height].map(Math.round),
      };
    };
    const tick = () => {
      const pending = document.querySelector(
        '[data-testid="pending-media-card"][data-kind="audio"] .pd-media-frame',
      );
      const done = document.querySelector(
        '[data-testid="media-card"][data-kind="audio"] .pd-media-frame',
      );
      window.__rec.push({
        t: Math.round(performance.now() - t0),
        pending: read(pending),
        state:
          document.querySelector('[data-testid="audio-pending"]')?.getAttribute('data-state') ??
          (pending !== null ? 'swept' : null),
        done: read(done),
      });
      if (window.__rec.length < 2000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopRecord = () =>
  page.evaluate(() => {
    const rec = window.__rec;
    window.__rec = [];
    return rec;
  });
/** The handover: the waiting card's last frame and the finished card's first. */
const handover = (rec) => {
  const firstDone = rec.findIndex((r) => r.done !== null && r.pending === null);
  const lastPending = firstDone > 0 ? rec[firstDone - 1] : null;
  const firstWithItem = rec.find((r) => r.pending !== null && r.state !== 'pulsing') ?? null;
  return {
    frames: rec.length,
    handoverAtMs: firstDone >= 0 ? rec[firstDone].t : null,
    resolving: firstWithItem?.pending ?? null,
    lastWaiting: lastPending?.pending ?? null,
    firstFinished: firstDone >= 0 ? rec[firstDone].done : null,
  };
};
/* The chrome only: the chat's finished card is filed into the chain (a
   different box, reached by a View Transition), so boxes are printed, not
   compared. */
const same = (a, b) => a !== null && b !== null && a.border === b.border && a.ground === b.ground;

const cardShot = async (label, selector) => {
  const buf = await page.screenshot();
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) {
    writeFileSync(path.join(OUT, `${label}.png`), buf);
    return;
  }
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  writeFileSync(
    path.join(OUT, `${label}.png`),
    cropPng(buf, {
      x: Math.max(0, Math.round((box.x - 32) * dpr)),
      y: Math.max(0, Math.round((box.y - 32) * dpr)),
      width: Math.round((box.width + 64) * dpr),
      height: Math.round((box.height + 64) * dpr),
    }),
  );
};

try {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });
  await page.evaluate(() => {
    window.__pi_theme?.()?.setFlavor?.('bobble');
    window.__pi_theme?.()?.setMode?.('dark');
  });
  await sleep(800);

  /* ── the chat: generate_music ─────────────────────────────────────────── */
  const user = { kind: 'user', id: 'u1', text: 'a fast paced dubstep song', timestamp: 1 };
  const call = {
    type: 'toolCall',
    id: 'm1',
    name: 'generate_music',
    arguments: { prompt: 'fast paced dubstep song', seconds: 20 },
  };
  const a1 = { kind: 'assistant', id: 'a1', blocks: [call], timestamp: 2, isStreaming: true };
  await set({
    session: { cwd: media },
    agent: { isStreaming: true },
    messages: [user, a1],
    runningToolCalls: ['m1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"][data-kind="audio"]', {
    timeout: 10_000,
  });
  await sleep(1200);
  await cardShot('chat-1-waiting', '[data-testid="pending-media-card"]');
  await record();
  await set({
    messages: [
      user,
      { ...a1, isStreaming: false },
      {
        kind: 'toolResult',
        id: 'tr-a1-m1',
        toolCallId: 'm1',
        assistantId: 'a1',
        toolName: 'generate_music',
        text: `pd-file://f${SONG}\nMusic saved at ${SONG}`,
        isError: false,
        timestamp: 3,
      },
      {
        kind: 'assistant',
        id: 'a2',
        blocks: [{ type: 'thinking', thinking: 'Done — tell the user.' }],
        timestamp: 4,
        isStreaming: true,
      },
    ],
    runningToolCalls: [],
  });
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="media-card"][data-kind="audio"]') !== null &&
        document.querySelector('[data-testid="pending-media-card"]') === null,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await sleep(600);
  const chat = handover(await stopRecord());
  await cardShot('chat-2-finished', '[data-testid="media-card"][data-kind="audio"]');
  console.log('chat handover:', JSON.stringify(chat));
  check(chat.handoverAtMs !== null, 'the chat handed the sound over to its finished card');
  check(
    same(chat.lastWaiting, chat.firstFinished),
    `chat: the waiting card already wears the finished card's chrome at the swap (${JSON.stringify(chat.lastWaiting)} → ${JSON.stringify(chat.firstFinished)})`,
  );

  /* ── the Audio studio ─────────────────────────────────────────────────── */
  await set({ messages: [], runningToolCalls: [], agent: { isStreaming: false } });
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
            candidates: [{ seed: 7, status: 'pending' }],
            ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
          };
          g.jobs.push(job);
          g.emit('gen:open', { tabId: job.tabId, payload: { ...job.base, status: 'generating' } });
        }),
    );
  });
  if ((await page.$('[data-testid="modality-audio"]')) === null) {
    await page.click('text=Modalities');
    await sleep(300);
  }
  await page.click('[data-testid="modality-audio"]');
  await page.waitForSelector('[data-testid="audio-studio"]', { timeout: 30_000 });
  await sleep(700);
  await page.click('[data-testid="studio-prompt"]');
  await page.keyboard.type('A fast paced dubstep song');
  await page.click('[data-testid="studio-run"]');
  await page.waitForSelector('[data-testid="studio-job"] [data-testid="audio-pending"]', {
    timeout: 15_000,
  });
  await sleep(1200);
  await cardShot('studio-1-waiting', '[data-testid="studio-job"] .pd-media-frame');
  // A filmstrip of the handover itself.
  const cdp = await page.context().newCDPSession(page);
  const film = [];
  cdp.on('Page.screencastFrame', (f) => {
    film.push({ t: f.metadata.timestamp, cssWidth: f.metadata.deviceWidth, data: f.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await record();
  await app.evaluate((_e, file) => {
    const g = globalThis.__probeGen;
    const job = g.jobs[g.jobs.length - 1];
    g.emit('gen:update', {
      tabId: job.tabId,
      payload: { ...job.base, status: 'done', candidates: [{ seed: 7, status: 'done' }] },
    });
    job.resolve({ jobId: job.jobId, outputs: [{ path: file, seed: 7, model: 'probe' }] });
  }, SONG);
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="studio-job"]') === null &&
        document.querySelector('[data-testid="media-card"][data-kind="audio"]') !== null,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await sleep(700);
  await cdp.send('Page.stopScreencast').catch(() => undefined);
  const studio = handover(await stopRecord());
  await cardShot(
    'studio-2-finished',
    '[data-testid="media-card"][data-kind="audio"] .pd-media-frame',
  );
  // The filmstrip: every frame the compositor produced, cut to the card's row.
  const box = await page
    .locator('[data-testid="media-card"][data-kind="audio"] .pd-media-frame')
    .first()
    .boundingBox();
  if (box !== null && film.length > 0) {
    const dir = path.join(OUT, 'studio-film');
    mkdirSync(dir, { recursive: true });
    const t0 = film[0].t;
    for (const [i, f] of film.entries()) {
      const buf = Buffer.from(f.data, 'base64');
      // A screencast frame is not at the window's device scale: read its own.
      const scale = buf.readUInt32BE(16) / f.cssWidth;
      try {
        writeFileSync(
          path.join(dir, `${String(i).padStart(3, '0')}-${Math.round((f.t - t0) * 1000)}ms.png`),
          cropPng(buf, {
            x: Math.max(0, Math.round((box.x - 24) * scale)),
            y: Math.max(0, Math.round((box.y - 24) * scale)),
            width: Math.round((box.width + 48) * scale),
            height: Math.round((box.height + 48) * scale),
          }),
        );
      } catch {
        writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}-full.png`), buf);
      }
    }
  }
  console.log('studio handover:', JSON.stringify({ ...studio, film: film.length }));
  check(studio.handoverAtMs !== null, 'the studio handed the sound over to its finished card');
  check(
    same(studio.lastWaiting, studio.firstFinished),
    `studio: the waiting card already wears the finished card's chrome at the swap (${JSON.stringify(studio.lastWaiting)} → ${JSON.stringify(studio.firstFinished)})`,
  );
} finally {
  await finish();
}
