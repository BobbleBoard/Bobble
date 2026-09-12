/**
 * LOW POWER PACES A GENERATION; IT NEVER REFUSES ONE.
 *
 * the user: "low can't stop image generation requests, it just has to lessen
 * compute intensivity in some way sacrificing speed to keep headroom."
 *
 * A throwaway HOME (the shared settings.json is never touched — powerMode
 * defaults to 'low' there anyway, and the chat model is pinned so the router
 * cannot re-tier), the real model cache, the image studio, one small picture.
 * Proof is three-fold and all observed, not asserted from the code:
 *   1. the main log's `power policy` line carries pace 0.35 / previews false;
 *   2. the pending card's note says the run is paced — and never "Waiting";
 *   3. the mflux child is SEEN in state T (stopped) in a share of `ps` samples
 *      while it runs, and the picture still arrives.
 *
 * Headless and backgrounded like every probe here (PI_E2E_BACKGROUND=1).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/low-power-gen';
const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const POWER = process.env.POWER ?? 'low'; // low | balanced — 'balanced' is the flat-out control
const STEPS = process.env.STEPS ?? '4';
const SIZE = process.env.SIZE ?? ''; // 512 | 768 | 1024 | 1536 — the studio's Size segment
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

const home = mkdtempSync(path.join(tmpdir(), 'pd-home-lowpower-'));
mkdirSync(path.join(home, '.pi', 'desktop'), { recursive: true });
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ powerMode: POWER, modelSelection: { mode: 'model', modelId: MODEL } }),
);

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'lowpower-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'),
    // mflux and uv key their caches off HOME: without these the probe pulls a
    // 4 GB model and a Python into the throwaway HOME (SEEN, 6.5 GB in /tmp).
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    UV_CACHE_DIR: path.join(homedir(), '.cache', 'uv'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_DESKTOP_GEN: '1',
  },
});
const mainLog = [];
for (const st of [app.process().stdout, app.process().stderr]) {
  st?.on('data', (d) => {
    for (const line of String(d).split('\n'))
      if (
        /power policy|guardian|gen-manager|gen worker|pacing|Low power|admit|^\s+(level|pace|previews|reason):/i.test(
          line,
        )
      )
        mainLog.push(line);
  });
}

/** `ps` state letters of every mflux child right now ('T' = stopped). */
function childStates() {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => /mflux/.test(l) && !/ps -axo|grep/.test(l))
      .map((l) => l.trim().split(/\s+/)[1] ?? '');
  } catch {
    return [];
  }
}

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 40000,
  });
  await win.waitForTimeout(2000);
  const settings = await win.evaluate(() => window.piDesktop.invoke('settings:get', undefined));
  say(`powerMode in app: ${settings?.powerMode}`);
  await win.evaluate((v) => window.__modality_store?.().getState().setView(v), 'image');
  await win.waitForTimeout(1500);

  /*
   * Escape in the studio with NO dialog open LEAVES the studio (StudioShell) —
   * which is how an earlier draft of this probe found itself typing into the
   * chat. So the gears are closed only while something with role=dialog is up.
   */
  const closeGears = async () => {
    if ((await win.locator('[role="dialog"]').count()) > 0) {
      await win.keyboard.press('Escape');
      await win.waitForTimeout(400);
    }
  };
  // Fewer steps: the proof is in the pacing, not the picture.
  const field = () => win.locator('[data-testid="image-steps-rail"]');
  if ((await field().count()) === 0) {
    const gears = win.locator('[data-testid="studio-advanced-toggle"]');
    if ((await gears.count()) > 0) {
      await gears.click();
      await win.waitForTimeout(500);
    }
  }
  if ((await field().count()) > 0) {
    await field().fill(STEPS);
    await win.waitForTimeout(250);
    say(`steps: ${await field().inputValue()}`);
    await closeGears();
  }
  if (SIZE !== '') {
    // The gears rail's Size segment: the label is what a person clicks.
    const label = { 512: 'Quick', 768: 'Draft', 1024: 'Standard', 1536: 'Large' }[SIZE];
    const gears = win.locator('[data-testid="studio-advanced-toggle"]');
    if (
      (await win.locator('[data-testid="image-size-rail"]').count()) === 0 &&
      (await gears.count()) > 0
    ) {
      await gears.click();
      await win.waitForTimeout(500);
    }
    const btn = win.locator('[data-testid="image-size-rail"] button', { hasText: label }).first();
    if ((await btn.count()) > 0) {
      await btn.evaluate((el) => el.click());
      await win.waitForTimeout(300);
      say(`size: ${await win.locator('[data-testid="image-pixels-rail"]').textContent()}`);
      await closeGears();
    }
  }
  await win.click('[data-testid="studio-prompt"]');
  await win.keyboard.type('a small red fox under a big tree, storybook style', { delay: 5 });
  await win.click('[data-testid="studio-run"]');
  const pressedAt = Date.now();
  say('pressed Generate');

  const notes = [];
  const samples = { total: 0, stopped: 0 };
  let shot = false;
  let state = {};
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    await win.waitForTimeout(250);
    state = await win
      .evaluate(() => ({
        pending: document.querySelector('[data-testid="pending-media-card"]') !== null,
        note: document.querySelector('[data-testid="pending-pct"]')?.textContent ?? null,
        banner: document.querySelector('[data-testid="guardian-banner"]')?.textContent ?? null,
        error: document.querySelector('[data-testid="studio-error"]')?.textContent ?? null,
        imgs: document.querySelectorAll('.pd-studio-results img').length,
        running: document.querySelector('[data-testid="studio-job"]') !== null,
      }))
      .catch(() => ({ gone: true }));
    if (state.gone) break;
    if (state.note !== null && notes[notes.length - 1] !== state.note) {
      notes.push(state.note);
      say(`note: ${state.note}`);
    }
    if (state.pending && !shot && /Low power/.test(state.note ?? '')) {
      await win.screenshot({ path: path.join(OUT, `${POWER}-01-paced-note.png`) });
      shot = true;
    }
    if (state.pending && /Made room/.test(state.note ?? '') && !notes.includes('__room_shot')) {
      await win.screenshot({ path: path.join(OUT, `${POWER}-01b-made-room.png`) });
      notes.push('__room_shot');
    }
    // A hold that outlives the room-making is the finding, not something to wait out.
    if (/Waiting for memory/.test(state.note ?? '') && Date.now() - pressedAt > 120_000) break;
    const states = childStates();
    if (states.length > 0) {
      samples.total += 1;
      if (states.some((s) => s.startsWith('T'))) samples.stopped += 1;
    }
    if (state.error !== null) break;
    if (!state.running && (state.imgs > 0 || state.error !== null)) break;
  }
  const elapsed = ((Date.now() - pressedAt) / 1000).toFixed(1);
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(OUT, `${POWER}-02-done.png`) });
  // A chat model parked for the picture must be back, on its own, afterwards.
  const parkedNow = async () => {
    const st = await win.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));
    return { parked: st?.parked ?? null, running: st?.serverRunning, phase: st?.phase };
  };
  let back = await parkedNow();
  const t1 = Date.now();
  while (back.parked !== null && Date.now() - t1 < 90_000) {
    await win.waitForTimeout(500);
    back = await parkedNow();
  }
  say(
    `chat model after the job: ${JSON.stringify(back)} (${((Date.now() - t1) / 1000).toFixed(1)}s after done)`,
  );
  /*
   * PROVE IT IS BACK: a chat turn. The time to the first token is the cost of
   * the room that was made — a model reload plus a re-prefill of the prompt —
   * and the user's standing rule is that no chat work is done until that number
   * is looked at.
   */
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  await win.waitForTimeout(800);
  const before = await win.evaluate(() => window.__pi_store().getState().messages.length);
  const editor = win.locator('[contenteditable="true"]').first();
  await editor.click();
  await win.keyboard.type('say hi in three words', { delay: 5 });
  const sentAt = Date.now();
  await win.keyboard.press('Enter');
  let ttft = null;
  const chatDeadline = Date.now() + 180_000;
  while (Date.now() < chatDeadline) {
    const chars = await win.evaluate((b) => {
      let c = 0;
      for (const m of window.__pi_store().getState().messages.slice(b))
        if (m.kind === 'assistant')
          for (const blk of m.blocks ?? [])
            c += blk.type === 'toolCall' ? 1 : (blk.text ?? blk.thinking ?? '').length;
      return c;
    }, before);
    if (chars > 0) {
      ttft = Date.now() - sentAt;
      break;
    }
    await win.waitForTimeout(40);
  }
  say(`chat after the picture: ttft=${ttft === null ? 'NONE (no reply in 180 s)' : `${ttft} ms`}`);
  await win.waitForTimeout(2500);
  await win.screenshot({ path: path.join(OUT, `${POWER}-03-chat-after.png`) });
  say(`RESULT ${JSON.stringify({ ...state, elapsedS: elapsed })}`);
  say(`NOTES ${JSON.stringify(notes)}`);
  say(
    `CHILD SAMPLES ${samples.total}, stopped in ${samples.stopped} (${samples.total > 0 ? Math.round((100 * samples.stopped) / samples.total) : 0}%)`,
  );
  console.log(
    mainLog
      .filter((l) =>
        /power policy|pacing|Low power|hold|shed|^\s+(level|pace|previews|reason):/i.test(l),
      )
      .slice(-12)
      .join('\n'),
  );
} finally {
  await app.close().catch(() => {});
}
