/**
 * LEAVE A STUDIO MID-GENERATION, COME BACK — is the job still there?
 *
 * the user (2026-09-24): "leaving a studio with a generation running and then going
 * back doesn't keep it going, or maybe it does but the UI resets".
 *
 * It was the second: the job ran on in main the whole time, and the room forgot
 * it. Everything the Image studio knew about its run lived in `useState` inside
 * the room, and App renders a studio INSTEAD of the chat, so Escape (or picking
 * a chat) unmounted the room and threw the job away with it. Coming back drew
 * an empty room with a live Generate button over a GPU that was still busy — and
 * a result that landed while you were out was held in a ref of the dead room,
 * so it never reached the list either.
 *
 * The steps, the same on the old build and the new one so the shots pair up:
 *   01  start a picture in the Image studio, three steps in
 *   02  leave (Escape) — the chat, and the corner beside the sidebar toggle
 *   03  the job moves on while you are away; come back through the sidebar
 *   04  leave again, and let it finish while you are gone
 *   05  come back: the picture should be in the list
 *   06  a job that FAILS while you are away says so when you return, over the
 *       line it failed on (the composer and knobs are kept too)
 *   07  the 3D studio: its job always lived in a store, but its elapsed clock
 *       restarted at 0 on every return
 *
 * The backend is stubbed in MAIN (a `gen:generate` that answers when the probe
 * says so, streaming `gen:open`/`gen:update` on the app's own event channel);
 * the studio, its store and every component on screen are the real ones.
 *
 *   SHOT_DIR=<dir> node apps/desktop/tests/e2e/studio-leave-return-probe.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';
import { eveningPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page, shot, check, finish, home, shotDir } = await launchApp('studio-leave-return', {
  waitFor: '[data-testid="composer-input"]',
});

/* A real picture for the finished run — pd-file:// is fenced to the home's own
   generated-media root, so it has to live under THIS run's home. */
const media = path.join(home, 'Bobble', 'generated', 'a-red-fox');
mkdirSync(media, { recursive: true });
const FOX = path.join(media, 'fox-1.png');
writeFileSync(FOX, eveningPng());

/** The corner beside the traffic lights, where the task button lives. */
const corner = async (label) => {
  await page.mouse.move(900, 620);
  await sleep(150);
  return page.screenshot({
    path: path.join(shotDir, `${label}.png`),
    clip: { x: 0, y: 0, width: 420, height: 64 },
  });
};

/*
 * THE BACKEND, STUBBED IN MAIN. `contextBridge` objects are frozen in the page,
 * so the handler is the seam that holds (see gen-inline-card-probe). The stub
 * echoes `requestId` when the renderer sends one — that is the wire contract
 * main's real handlers keep — and is ignored by a build that does not.
 */
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
  // The 3D studio's engine: accept the job; its progress is played below.
  ipcMain.removeHandler('gen3d:generate');
  ipcMain.handle('gen3d:generate', () => ({ ok: true, jobId: 'g3d_probe_1' }));
});
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
/** The 3D studio's elapsed clock under its bar, as drawn. */
const clock3d = () =>
  page.evaluate(() => {
    const dims = [...document.querySelectorAll('[data-testid="tp-genstage"] .tp-genfoot-dim')];
    const t = dims.map((d) => d.textContent ?? '').find((s) => /\d+s$/.test(s.trim()));
    return t === undefined ? null : t.replace(/^[\s·]+/, '').trim();
  });
const secondsOf = (clock) => {
  const m = /^(?:(\d+)m\s*)?(\d+)s$/.exec(clock ?? '');
  return m === null ? 0 : Number(m[1] ?? 0) * 60 + Number(m[2]);
};
const progress = (step, total) =>
  app.evaluate(
    (_e, [step, total]) => {
      const g = globalThis.__probeGen;
      const job = g.jobs[g.jobs.length - 1];
      g.emit('gen:update', {
        tabId: job.tabId,
        payload: {
          ...job.base,
          status: 'generating',
          candidates: [{ seed: 7, status: 'generating' }],
          progress: { candidate: 0, step, total },
        },
      });
    },
    [step, total],
  );
const complete = (file) =>
  app.evaluate((_e, file) => {
    const g = globalThis.__probeGen;
    const job = g.jobs[g.jobs.length - 1];
    g.emit('gen:update', {
      tabId: job.tabId,
      payload: {
        ...job.base,
        status: 'done',
        candidates: [{ seed: 7, status: 'done', finalSrc: `pd-file://f${file}` }],
      },
    });
    job.resolve({ jobId: job.jobId, outputs: [{ path: file, seed: 7, model: 'probe' }] });
  }, file);
const fail = (message) =>
  app.evaluate((_e, message) => {
    const g = globalThis.__probeGen;
    const job = g.jobs[g.jobs.length - 1];
    g.emit('gen:update', {
      tabId: job.tabId,
      payload: { ...job.base, status: 'error', error: message },
    });
    job.resolve({ jobId: '', outputs: [], error: message });
  }, message);
const jobCount = () => app.evaluate(() => globalThis.__probeGen.jobs.length);

/** What the room is showing right now. */
const room = () =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const run = q('[data-testid="studio-run"]');
    const bar = q('[data-testid="studio-job"] [role="progressbar"]');
    return {
      inStudio: q('[data-testid="image-studio"]') !== null,
      pendingCard: q('[data-testid="studio-job"]') !== null,
      runLabel: run?.textContent?.trim() ?? null,
      runDisabled: run?.hasAttribute('disabled') ?? null,
      stop: run?.getAttribute('data-stop') === 'true',
      progress: bar?.getAttribute('aria-valuenow') ?? null,
      pct: q('[data-testid="studio-job"] [data-testid="pending-pct"]')?.textContent ?? null,
      finishedRuns: document.querySelectorAll('.pd-studio-run:not([data-testid="studio-job"])')
        .length,
      images: [...document.querySelectorAll('[data-testid="studio-results"] img')].map((i) =>
        i.getAttribute('src'),
      ),
      error: q('[data-testid="studio-error"]')?.textContent ?? null,
      empty: q('[data-testid="studio-empty"]') !== null,
      promptKept: q('[data-testid="studio-prompt"]')?.value ?? null,
      taskButton: q('[data-testid="task-tray"]') !== null,
    };
  });

const enterImageStudio = async () => {
  if ((await page.$('[data-testid="modality-image"]')) === null) {
    await page.click('text=Modalities');
    await sleep(300);
  }
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('[data-testid="image-studio"]', { timeout: 30_000 });
  await sleep(700);
};
const leave = async () => {
  // Focus the page body first: Escape from inside a menu would close the menu.
  await page.mouse.click(700, 420);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await sleep(600);
};

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20_000 });
  await page.evaluate(() => {
    const t = window.__pi_theme?.();
    t?.setFlavor?.('bobble');
    t?.setMode?.('light');
  });
  await sleep(600);

  /* ── 01 a picture, three steps in ─────────────────────────────────────── */
  await enterImageStudio();
  await page.click('[data-testid="studio-prompt"]');
  await page.keyboard.type('A red fox asleep in tall grass, low evening sun');
  await page.click('[data-testid="studio-run"]');
  await page.waitForSelector('[data-testid="studio-job"]', { timeout: 15_000 });
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && (await jobCount()) === 0; i++) await sleep(100);
  check((await jobCount()) === 1, 'the studio asked main for one generation');
  await progress(3, 8);
  await sleep(900);
  const r1 = await room();
  console.log('01 running  ', JSON.stringify(r1));
  check(r1.pendingCard, 'the pending card is up while the job runs');
  await shot('01-studio-running');

  /* ── 02 leave ─────────────────────────────────────────────────────────── */
  await leave();
  const r2 = await room();
  console.log('02 left     ', JSON.stringify(r2));
  await shot('02-left-studio');
  await corner('02-left-studio-corner');

  /* ── 03 the job moves on while you are away; come back ────────────────── */
  await progress(6, 8);
  await sleep(400);
  await enterImageStudio();
  const r3 = await room();
  console.log('03 returned ', JSON.stringify(r3));
  check(r3.pendingCard, 'coming back, the running job is still on screen');
  /* The pill maps the steps onto 0–94% (the rest is the decode) and moves
     toward the next step at the measured speed, so 6 of 8 steps (70.5) reads
     somewhere short of step 7 (82.25) — never at or past it (see
     media/progress-estimate). */
  check(
    Number(r3.progress) >= 60 && Number(r3.progress) < 82,
    `showing the progress it made while away (6/8 steps → ${r3.progress} on the pill)`,
  );
  check(r3.stop, 'and the run button offers Stop, not a second Generate');
  check(r3.empty === false, 'the room is not reset to its empty state');
  check(
    r3.promptKept === 'A red fox asleep in tall grass, low evening sun',
    `the composer still holds what you typed (${r3.promptKept})`,
  );
  await shot('03-returned-while-running');
  await progress(7, 8);
  await sleep(600);
  const r3b = await room();
  console.log('03 live     ', JSON.stringify(r3b));
  await shot('03b-progress-continues');

  /* ── 04 leave again; it finishes while you are away ───────────────────── */
  await leave();
  await complete(FOX);
  await sleep(900);
  const r4 = await room();
  console.log('04 finished away', JSON.stringify(r4));
  await shot('04-finished-while-away');
  await corner('04-finished-while-away-corner');

  /* ── 05 come back: the picture is in the list ─────────────────────────── */
  await enterImageStudio();
  await sleep(600);
  const r5 = await room();
  console.log('05 back     ', JSON.stringify(r5));
  check(
    r5.finishedRuns >= 1,
    `the result that landed while away is in the room (${r5.finishedRuns})`,
  );
  check(
    r5.images.some((s) => s?.includes('fox-1.png')),
    `and it is the picture that was made (${JSON.stringify(r5.images)})`,
  );
  check(!r5.pendingCard, 'and no stale pending card sits over it');
  check(
    !r5.stop && r5.runLabel === 'Generate',
    `the room is ready for the next one (${r5.runLabel})`,
  );
  await shot('05-result-after-return');

  /* ── 06 a job that fails while you are away ───────────────────────────── */
  await page.click('[data-testid="studio-prompt"]');
  await page.keyboard.press('Meta+A');
  await page.keyboard.type('A paper lantern on a wet street at night');
  await page.click('[data-testid="studio-run"]');
  await page.waitForSelector('[data-testid="studio-job"]', { timeout: 15_000 });
  for (let i = 0; i < 40 && (await jobCount()) < 2; i++) await sleep(100);
  await progress(1, 8);
  await sleep(400);
  await leave();
  await fail('Not enough free memory to run this at 1024 × 1024.');
  await sleep(700);
  await corner('06-failed-while-away-corner');
  await enterImageStudio();
  const r6 = await room();
  console.log('06 failed   ', JSON.stringify(r6));
  check(
    r6.error !== null && /free memory/.test(r6.error),
    `the failure is on screen when you come back (${r6.error})`,
  );
  check(!r6.pendingCard, 'and the pending card is gone');
  check(
    r6.promptKept === 'A paper lantern on a wet street at night',
    `and the composer still holds the line that failed, for Try again (${r6.promptKept})`,
  );
  await shot('06-failed-after-return');

  /* ── 07 the 3D studio: its clock survives leaving too ────────────────── */
  // Its job was always in a store; its elapsed clock was not — a ref inside the
  // bar restarted it at 0 on every return.
  /* The throwaway home has no 3D module, so the studio is behind its gate;
     "View" lifts the blur (it downloads nothing) so the bar can be seen. */
  const lookPast3dGate = async () => {
    if ((await page.$('[data-testid="tp-gate-view"]')) !== null) {
      await page.click('[data-testid="tp-gate-view"]');
      await sleep(500);
    }
  };
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-root"]', { timeout: 30_000 });
  await sleep(800);
  await lookPast3dGate();
  await page.evaluate(() =>
    window.__gen3d_store().getState().generate({
      kind: 'text',
      prompt: 'A low-poly lighthouse',
      resolution: 'medium',
      texture: true,
    }),
  );
  await job3d({});
  await sleep(4500);
  await job3d({ stagePercent: 70 });
  await sleep(300);
  const before3d = await clock3d();
  console.log('07 3d clock in the room', before3d);
  await shot('07a-3d-running');
  // Leave with Escape: the throwaway home has no 3D module, and a click in the
  // middle of the studio lands on the module gate's Download button.
  await page.evaluate(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined,
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await sleep(6000);
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-genstage"]', { timeout: 10_000 });
  await lookPast3dGate();
  await sleep(300);
  const after3d = await clock3d();
  console.log('07 3d clock after 6 s away', after3d);
  check(
    secondsOf(after3d) >= secondsOf(before3d) + 5,
    `the 3D job's clock kept counting while you were away (${before3d} → ${after3d})`,
  );
  await shot('07b-3d-returned');
} finally {
  const ok = await finish();
  console.log(`studio-leave-return: shots in ${shotDir}`);
  if (!ok) process.exitCode = 1;
}
