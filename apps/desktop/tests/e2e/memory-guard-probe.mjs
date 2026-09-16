/**
 * THE MEMORY GUARD, AGAINST REAL PRESSURE — the user (2026-09-16): "these memory
 * safeguards should just not let ooms happen for sure … stop generations/runs
 * of any sort ideally pausing them rather than terminating where possible …
 * even mid diffusion generation … kernel level hangs are 100% unacceptable,
 * runs should be paused and even totally terminated if pausing fails".
 *
 * A real heavy job (image → 3D on ComfyUI, ~10 GB wired) and a designated
 * victim (_memory-hog.mjs) that eats memory in random-filled 256 MB chunks the
 * compressor cannot take back, until the machine crosses the guard's pause
 * line. What is asserted is what a person would see and what the kernel
 * would feel:
 *
 *   MODE=pause  the job's process is STOPPED (ps state T) the reading the line
 *               is crossed, the banner says so and names the job; the hog lets
 *               go; the job RESUMES and finishes with its model.
 *   MODE=shed   the hog keeps holding; the pause does not bring memory back;
 *               the guard ENDS the job with the reason, and the machine is
 *               calm again once the hog is gone.
 *
 *   MODE=pause SHOT_DIR=/tmp/guard node apps/desktop/tests/e2e/memory-guard-probe.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE ?? 'pause';
const SHOT_DIR = process.env.SHOT_DIR ?? `/tmp/guard-${MODE}`;
mkdirSync(SHOT_DIR, { recursive: true });
const IMAGE =
  process.env.IMAGE ?? path.join(homedir(), 'Bobble/generated/a-blue-mug/cand0_seed602697309.png');

const freePct = () => {
  try {
    const out = execFileSync('memory_pressure', [], { encoding: 'utf8', timeout: 3000 });
    const m = /free percentage:\s*(\d+)%/.exec(out);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
};
const procState = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/*
 * The shed mode proves the ESCALATION — a pause that does not lift becomes a
 * stop. The hog keeps eating past the pause line to 12% free and HOLDS it
 * there: the reading stays pause-grade for the twenty readings it takes, and
 * the guard ends the job — freeing its wired memory, which is the point.
 * (A raised line through the probe seam was tried first and the job's own
 * load crossed it; the real line and a real hog are the honest test.)
 */
const { app, page, shot, check, finish, home } = await launchApp('memory-guard', {
  realCache: true,
  args: ['--', '--piE2E=1'],
  env: { PI_E2E_NO_SERVER: '1' },
});
const STOP_EATING_AT = MODE === 'shed' ? 12 : 13;
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
let hog = null;
const hogHeld = [];
const growHog = async () => {
  if (hog === null) {
    hog = spawn(process.execPath, [path.join(HERE, '_memory-hog.mjs')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    hog.stdout.setEncoding('utf8');
    hog.stdout.on('data', (t) => hogHeld.push(...String(t).trim().split('\n')));
    await sleep(300);
  }
  const before = hogHeld.length;
  hog.stdin.write('grow\n');
  for (let i = 0; i < 100 && hogHeld.length === before; i += 1) await sleep(50);
};
const releaseHog = () => {
  if (hog === null) return;
  hog.kill('SIGKILL');
  hog = null;
  log('hog released');
};

try {
  const dir = path.join(home, 'Bobble', 'generated', 'probe');
  mkdirSync(dir, { recursive: true });
  const image = path.join(dir, 'mug.png');
  copyFileSync(IMAGE, image);
  await page.click('[data-testid="modality-3d"]');
  await page.waitForSelector('[data-testid="tp-viewport"]', { timeout: 20_000 });
  await sleep(1500);
  await page.evaluate(() => {
    window.__guard = [];
    window.__jobs = [];
    window.piDesktop.onEvent('gen:guardian', (e) => window.__guard.push({ ...e, at: Date.now() }));
    window.piDesktop.onEvent('gen3d:job', (u) => window.__jobs.push({ ...u, at: Date.now() }));
  });
  const started = await page.evaluate(
    (imagePath) =>
      window.piDesktop.invoke('gen3d:generate', {
        kind: 'image',
        imagePaths: [imagePath],
        resolution: 'low',
        texture: false,
        finish: 'grey',
        engine: 'comfy',
      }),
    image,
  );
  check(started.ok === true, `the 3D job started (${JSON.stringify(started)})`);
  const t0 = Date.now();

  // Wait for the samplers: the job is in ComfyUI and its memory is wired.
  let comfyPid = null;
  let sampling = false;
  while (Date.now() - t0 < 6 * 60_000) {
    await sleep(2000);
    const jobs = await page.evaluate(() => window.__jobs ?? []);
    const latest = jobs.at(-1);
    if (latest?.message && /step \d+\/\d+/.test(latest.message)) {
      sampling = true;
      break;
    }
    if (latest?.done) break;
  }
  check(sampling, 'the job reached its samplers');
  try {
    comfyPid = Number(
      execFileSync('pgrep', ['-f', 'engines/comfyui/'], { encoding: 'utf8' }).trim().split('\n')[0],
    );
  } catch {
    comfyPid = null;
  }
  check(comfyPid !== null && comfyPid > 0, `ComfyUI's pid is known (${comfyPid})`);
  log(`job sampling, ComfyUI pid ${comfyPid}, free ${freePct()}%`);

  // Eat memory until the guard pauses the job (or the floor). In shed mode
  // keep going to the floor so the pause has nothing to lift on.
  let paused = false;
  for (let i = 0; i < 120; i += 1) {
    await growHog();
    const events = await page.evaluate(() => window.__guard ?? []);
    if (events.some((e) => e.verdict === 'pause')) paused = true;
    if (paused && MODE === 'pause') break;
    const f = freePct();
    if (f !== null && f <= STOP_EATING_AT) {
      log(`free ${f}% — not eating further`);
      break;
    }
  }
  const t1 = Date.now();
  log(`hog holds ${hogHeld.length} × 256 MB, free ${freePct()}%`);
  // The pause verdict arrives within a reading or two of the line.
  for (let i = 0; i < 20 && !paused; i += 1) {
    await sleep(500);
    const events = await page.evaluate(() => window.__guard ?? []);
    paused = events.some((e) => e.verdict === 'pause');
  }
  const events = await page.evaluate(() => window.__guard ?? []);
  const pauseEvent = events.find((e) => e.verdict === 'pause');
  check(paused, `the guard paused the running work (${pauseEvent?.reason ?? 'no pause verdict'})`);
  check(
    (pauseEvent?.paused ?? []).some((l) => /3D/.test(l)),
    `the pause names the job (${JSON.stringify(pauseEvent?.paused)})`,
  );
  await sleep(700);
  const stateWhilePaused = comfyPid === null ? '' : procState(comfyPid);
  const banner = await page.evaluate(
    () => document.querySelector('[data-testid="guardian-banner"]')?.textContent ?? '',
  );
  if (MODE === 'pause') {
    check(
      /T/.test(stateWhilePaused),
      `ComfyUI is stopped in place (ps state "${stateWhilePaused}")`,
    );
    check(/Paused .*keep your Mac responsive/.test(banner), `the banner says so ("${banner}")`);
  } else {
    // A hog eating flat out can take the kernel to "critical" within a
    // reading of the pause, and critical is a stop — either is the guard
    // doing its job; what must not happen is nothing.
    check(
      /T/.test(stateWhilePaused) || stateWhilePaused === '',
      `ComfyUI is stopped in place or already gone (ps state "${stateWhilePaused}")`,
    );
    check(
      /(Paused|Stopped) .*keep your Mac responsive/.test(banner),
      `the banner says so ("${banner}")`,
    );
  }
  await shot('01-paused');

  if (MODE === 'pause') {
    releaseHog();
    // Resumed within a few readings.
    let resumed = false;
    for (let i = 0; i < 40 && !resumed; i += 1) {
      await sleep(500);
      const ev = await page.evaluate(() => window.__guard ?? []);
      resumed = ev.some((e) => (e.resumed ?? []).length > 0);
    }
    check(
      resumed,
      `the job was resumed once the memory came back (${Math.round((Date.now() - t1) / 1000)}s after the pause)`,
    );
    const stateAfter = comfyPid === null ? '' : procState(comfyPid);
    check(!/T/.test(stateAfter), `ComfyUI runs again (ps state "${stateAfter}")`);
    await shot('02-resumed');
    // …and the model arrives.
    let last = null;
    while (Date.now() - t0 < 15 * 60_000) {
      await sleep(3000);
      const jobs = await page.evaluate(() => window.__jobs ?? []);
      last = jobs.at(-1);
      if (last?.done) break;
    }
    check(
      last?.done === true && last?.error === undefined,
      `the job finished after the pause (${last?.error ?? 'ok'})`,
    );
    check(typeof last?.artifact?.path === 'string', 'with its model');
    const shed = (await page.evaluate(() => window.__guard ?? [])).some(
      (e) => e.verdict === 'shed',
    );
    check(!shed, 'nothing was terminated');
  } else {
    // Keep holding: the pause cannot bring the memory back, so the guard ends the job.
    let shedEvent = null;
    for (let i = 0; i < 120 && shedEvent === null; i += 1) {
      await sleep(500);
      const ev = await page.evaluate(() => window.__guard ?? []);
      shedEvent = ev.find((e) => e.verdict === 'shed') ?? null;
    }
    check(shedEvent !== null, `the pause escalated to a stop (${shedEvent?.reason ?? 'no shed'})`);
    releaseHog();
    await sleep(3000);
    const jobs = await page.evaluate(() => window.__jobs ?? []);
    const last = jobs.at(-1);
    check(
      last?.done === true && /keep your Mac responsive/.test(last?.error ?? ''),
      `the job ended with the reason (${last?.error ?? ''})`,
    );
    const gone =
      comfyPid === null ? true : procState(comfyPid) === '' || !/T/.test(procState(comfyPid));
    check(gone, 'nothing is left stopped');
    await shot('02-stopped');
  }
  log(`free now ${freePct()}%`);
} finally {
  releaseHog();
  await finish();
}
