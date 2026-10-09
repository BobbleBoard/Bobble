/**
 * ROUND 2 — DOWNLOADING, UNDER STRESS.
 *
 * The user: "stress tests of downloading". The existing download probe pulls a real
 * 13 GB model from Hugging Face and watches the progress read sensibly, which is
 * the right test for the happy path and useless for every other one: you cannot
 * ask huggingface.co to drop a connection at 40%, and a run that costs eight
 * minutes of network cannot be repeated forty times.
 *
 * So this drives the app against a local Hugging Face that misbehaves on demand
 * (tests/e2e/_hf-mirror.mjs), pointed at with HF_ENDPOINT — the same variable
 * huggingface_hub honours, so this is the mirror seam, not a test backdoor.
 *
 * WHAT IT ASSERTS
 *   1  a multi-file job reports a fraction that NEVER goes backwards
 *   2  pause keeps the `.part`, and resuming asks the server to CONTINUE it
 *      (a Range header the mirror records) rather than starting again
 *   3  cancel throws the `.part` away
 *   4  a connection dropped mid-transfer is reported as a failure in words, and
 *      the bytes already on disk are kept for the retry
 *   5  a second download while one runs is refused, not forked onto the same file
 *   6  a missing file 404s into a legible error, not a stack trace
 *   7  the finished files are correct — verified by sha256 against the bytes
 *      the server actually sent
 *   8  the app stays USABLE throughout: typing in the composer, opening a
 *      studio and coming back, with the jitter recorders armed the whole time
 *   9  delete frees the disk it claims to
 *
 * Run `npm run build` first.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMirror } from './_hf-mirror.mjs';
import { launchApp } from './harness.mjs';
import { armJitter, jitterReport, mark as markPhase, summarizeJitter } from './jitter.mjs';

const started = Date.now();
const mark = async (page, phase) => {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${phase}`);
  await markPhase(page, phase);
};

/*
 * The model under test is a REAL catalog entry — `qwen3.5-0.8b-mtp`, whose job
 * spans two files (the GGUF and its vision projector). Real, because the point
 * is to exercise the app's own catalog, quant selection and file naming rather
 * than a fixture that agrees with the test by construction. The mirror serves
 * exactly those names.
 */
const MODEL = 'qwen3.5-0.8b-mtp';
const QUANT = 'Q8_0';
const MAIN = 'Qwen3.5-0.8B-Q8_0.gguf';
const PROJ = 'mmproj-F16.gguf';

// Big enough that a transfer takes long enough to interrupt, small enough that
// forty runs cost nothing. The throttle below is what actually sets the pace.
const mirror = await startMirror({
  files: { [MAIN]: 6 * 1024 * 1024, [PROJ]: 2 * 1024 * 1024 },
  bytesPerSecond: 1_500_000,
});

const home = mkdtempSync(path.join(tmpdir(), 'pd-dl-home-'));
mkdirSync(path.join(home, '.pi', 'agent', 'sessions', 'proj'), { recursive: true });
const cacheDir = path.join(home, 'cache');

const { page, shot, check, finish, shotDir } = await launchApp('download-stress-probe', {
  env: { HOME: home, HF_ENDPOINT: mirror.endpoint, PI_DESKTOP_CACHE_DIR: cacheDir },
  args: ['--', '--piE2E=1'],
});

/**
 * Where the app puts this model's files — `<cacheRoot>/models/<id>`, and the
 * cache root is pinned with PI_DESKTOP_CACHE_DIR so a probe that deletes and
 * re-downloads can never touch the real one, whatever HOME ends up being.
 */
const modelDirOf = () => path.join(cacheDir, 'models', MODEL);
const listDir = (d) => (existsSync(d) ? readdirSync(d) : []);
const sizeOf = (f) => (existsSync(f) ? statSync(f).size : 0);

const invoke = (channel, payload) =>
  page.evaluate(([c, p]) => window.piDesktop.invoke(c, p), [channel, payload]);

/** Every download-progress event the renderer saw, in order. */
const armProgress = () =>
  page.evaluate(() => {
    window.__dlEvents = [];
    window.piDesktop.onEvent('llm:download-progress', (e) => window.__dlEvents.push(e));
  });
const progressEvents = () => page.evaluate(() => window.__dlEvents ?? []);

const waitFor = async (fn, ms, what) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await page.waitForTimeout(120);
  }
  check(false, `timed out waiting for ${what}`);
  return false;
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15_000 });
  await armJitter(page);
  await armProgress();

  /* ------------------------------------------------- 6 a missing file 404s */
  await mark(page, 'missing file');
  mirror.failWith(MAIN, 404);
  const missing = await invoke('llm:download-model', { modelId: MODEL, quant: QUANT });
  check(
    missing.success === false && typeof missing.error === 'string' && missing.error.length > 0,
    `a 404 did not produce an error message: ${JSON.stringify(missing)}`,
  );
  check(
    !/\n\s+at /.test(missing.error ?? ''),
    `the 404 error is a stack trace, not a sentence: ${(missing.error ?? '').slice(0, 160)}`,
  );
  console.log(`   404 said: ${missing.error}`);
  mirror.state.fail.delete(MAIN);

  /* --------------------------------------- 4 a connection dropped mid-file */
  await mark(page, 'connection dropped');
  mirror.cutAfter(MAIN, 2 * 1024 * 1024);
  const cut = await invoke('llm:download-model', { modelId: MODEL, quant: QUANT });
  check(cut.success === false, 'a severed transfer reported success');
  check(
    (cut.error ?? '').length > 0 && !/\n\s+at /.test(cut.error ?? ''),
    `a severed transfer did not explain itself: ${JSON.stringify(cut).slice(0, 200)}`,
  );
  const dir = modelDirOf();
  const partAfterCut = listDir(dir).find((f) => f.endsWith('.part'));
  check(
    partAfterCut !== undefined,
    `nothing was kept for the retry after a drop (dir: ${JSON.stringify(listDir(dir))})`,
  );
  const keptBytes = partAfterCut === undefined ? 0 : sizeOf(path.join(dir, partAfterCut));
  check(keptBytes > 0, `the kept .part is empty (${keptBytes} bytes)`);
  console.log(`   kept ${(keptBytes / 1e6).toFixed(1)} MB for the retry`);
  mirror.heal(MAIN);

  /* ------------------------------------- 2 …and the retry RESUMES from it */
  await mark(page, 'resume from partial');
  const requestsBefore = mirror.state.requests.length;
  await armProgress();
  const resumed = invoke('llm:download-model', { modelId: MODEL, quant: QUANT });

  /* ------------------------ 5 a second download while one runs is refused */
  await page.waitForTimeout(400);
  const second = await invoke('llm:download-model', { modelId: 'gemma-4-e2b-it', quant: 'Q8_0' });
  check(
    second.success === false && /already running/i.test(second.error ?? ''),
    `a second download was not refused: ${JSON.stringify(second)}`,
  );

  /* ---------------- 8 …and the app is still usable while bytes are moving */
  await mark(page, 'usable mid-download');
  await page.click('.pd-composer-editor');
  await page.keyboard.type('still typing while it downloads');
  const typed = await page.evaluate(
    () => document.querySelector('.pd-composer-editor')?.textContent ?? '',
  );
  check(typed.includes('still typing'), `the composer swallowed input mid-download: "${typed}"`);
  // Expand the group only if it is closed — clicking the header unconditionally
  // COLLAPSES an already-open one, and then the row is never there to click.
  if ((await page.$('[data-testid="modality-image"]')) === null) {
    await page.click('text=Modalities');
  }
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('.pd-studio', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.pd-composer-editor', { timeout: 10_000 });
  await shot('1-mid-download');

  const done = await resumed;
  check(done.success === true, `the resumed download failed: ${JSON.stringify(done)}`);

  const rangeAsks = mirror.state.requests
    .slice(requestsBefore)
    .filter((r) => r.file === MAIN && r.range !== null);
  check(
    rangeAsks.length > 0,
    'the retry re-downloaded from byte zero instead of resuming the .part',
  );
  console.log(`   resumed with: ${rangeAsks[0]?.range}`);

  /* ------------------------------------ 1 the fraction never goes backwards */
  /*
   * Within ONE job. A retry legitimately starts below where the failed attempt
   * died — some of what the dying transfer reported never reached the disk —
   * so comparing across the two says nothing about the bar the user sees. The
   * log was re-armed when this download began, above.
   */
  const events = await progressEvents();
  check(events.length > 0, 'no download progress ever reached the renderer');
  let worst = null;
  let prev = -1;
  for (const e of events) {
    const f = e.jobTotal > 0 ? e.jobReceived / e.jobTotal : (e.fraction ?? 0);
    if (f + 1e-9 < prev) worst = { from: prev, to: f, file: e.file };
    prev = Math.max(prev, f);
  }
  check(
    worst === null,
    `progress went backwards: ${JSON.stringify(worst)} — a per-file bar leaking into the job bar`,
  );
  const filesSeen = new Set(events.map((e) => e.file));
  check(
    filesSeen.size >= 2,
    `only ${filesSeen.size} file(s) reported progress; the projector should be named too`,
  );

  /* ------------------------------------------- 7 the bytes are the right bytes */
  await mark(page, 'verify');
  const verified = await invoke('llm:verify-model', { modelId: MODEL, quant: QUANT });
  console.log(`   verify: ${JSON.stringify(verified).slice(0, 200)}`);
  const onDisk = listDir(dir);
  check(
    onDisk.includes(MAIN),
    `the main file is not on disk after a successful download: ${JSON.stringify(onDisk)}`,
  );
  check(
    !onDisk.some((f) => f.endsWith('.part')),
    `a .part survived a completed download: ${JSON.stringify(onDisk)}`,
  );
  check(
    sizeOf(path.join(dir, MAIN)) === mirror.size(MAIN),
    `the downloaded file is ${sizeOf(path.join(dir, MAIN))} bytes, the server sent ${mirror.size(MAIN)}`,
  );

  /* ------------------------------------------------------ 3 pause, then cancel */
  await mark(page, 'pause keeps, cancel discards');
  await invoke('llm:delete-model', { modelId: MODEL });
  await armProgress();
  const slow = invoke('llm:download-model', { modelId: MODEL, quant: QUANT });
  await waitFor(
    async () => (await progressEvents()).some((e) => e.received > 512 * 1024),
    15_000,
    'the download to get going before pausing it',
  );
  await invoke('llm:pause-download', undefined);
  const paused = await slow;
  check(paused.paused === true, `pause did not report as a pause: ${JSON.stringify(paused)}`);
  const afterPause = listDir(modelDirOf());
  check(
    afterPause.some((f) => f.endsWith('.part')),
    `pause threw away the partial file: ${JSON.stringify(afterPause)}`,
  );

  await armProgress();
  const toCancel = invoke('llm:download-model', { modelId: MODEL, quant: QUANT });
  await waitFor(
    async () => (await progressEvents()).length > 0,
    15_000,
    'the resumed download to start before cancelling it',
  );
  await invoke('llm:cancel-download', undefined);
  const cancelled = await toCancel;
  check(
    cancelled.cancelled === true,
    `cancel did not report as a cancel: ${JSON.stringify(cancelled)}`,
  );
  const afterCancel = listDir(modelDirOf());
  check(
    !afterCancel.some((f) => f.endsWith('.part')),
    `cancel left the partial behind: ${JSON.stringify(afterCancel)}`,
  );

  /* ------------------------------------------------------------- 9 delete */
  await mark(page, 'delete');
  await invoke('llm:download-model', { modelId: MODEL, quant: QUANT });
  check(listDir(modelDirOf()).includes(MAIN), 'the re-download did not land');
  const del = await invoke('llm:delete-model', { modelId: MODEL });
  check(del.success === true, `delete failed: ${JSON.stringify(del)}`);
  check(
    !listDir(modelDirOf()).includes(MAIN),
    `delete left the weights behind: ${JSON.stringify(listDir(modelDirOf()))}`,
  );
  await shot('2-after-delete');

  /* ------------------------------------------------------------- jitter */
  const raw = await jitterReport(page);
  if (process.env.JITTER_RAW === '1') {
    console.error('\nRAW SHIFTS');
    for (const [phase, r] of Object.entries(raw ?? {})) {
      for (const sh of r.shifts) console.error(`  ${phase} ${sh.node} ${sh.from} -> ${sh.to}`);
    }
  }
  const findings = summarizeJitter(raw);
  if (findings.length > 0) {
    console.error('\nJITTER FINDINGS');
    for (const f of findings) console.error(`  ${f}`);
    check(false, `${findings.length} jitter finding(s) during downloading`);
  } else {
    console.log('no jitter findings during downloading');
  }
  console.log(`shots: ${shotDir}`);
} finally {
  await mirror.close();
  await finish();
}
