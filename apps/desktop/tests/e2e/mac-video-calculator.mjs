/**
 * THE REAL PROOF: a prompt typed into Bobble's composer, and a LOCAL 4B MODEL
 * deciding every Mac control call that follows.
 *
 * An earlier recording drove the tools from the probe. That proves the mechanism
 * and nothing about whether a model can use it — the user spotted the difference at
 * once ("you just had it start in the canvas on its own with a hardcoded I
 * assume invisible prompt"). Here nothing is scripted after the keystrokes: the
 * probe types, presses Return, and then only watches and records.
 *
 * WHY CALCULATOR, after TextEdit and Reminders.
 *
 * TextEdit is out — it stole focus, and a text file is a plausible substitute
 * for a document, so a model that writes one looks like it succeeded while never
 * touching the app. Reminders has the opposite problem: the `personal` connector
 * is the RIGHT way to add a reminder, so proving computer use meant deleting the
 * connector's commands after the prompt was built — leaving the model reading
 * about a command that was no longer there.
 *
 * Calculator needs nothing removed. There is no connector, no shell equivalent
 * and no file that stands in for it: the arithmetic either happened in the app
 * or it did not. Nothing is restricted here, so the prompt the model reads is
 * exactly the shipped one, and reaching for `mac` is its own choice.
 *
 * It also exercises the half of computer use that only just started working —
 * READING THE APP BACK. The display is AXStaticText, which no snapshot used to
 * return, so the answer had to come from the model's head. Now the snapshot
 * carries a "Showing:" line and the answer can be read off the app that computed
 * it.
 *
 * Recorded from Bobble's own window, which needs no capture grant.
 */
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
const osa = (s) => run('osascript', ['-e', s]).catch(() => undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUNDLE = process.env.BOBBLE_APP ?? '/Applications/Bobble.app';
const OUT =
  process.env.OUT_DIR ?? '/Users/user/Desktop/OSS-harness/scratchpad/mac-video-calculator';
const FPS = Number(process.env.FPS ?? 8);
const MODEL_ID = process.env.MAC_CU_MODEL ?? 'qwen3.5-4b-mtp';
/*
 * RANDOM EVERY RUN, and that is not decoration.
 *
 * macOS restores Calculator's last expression across a quit, so the first run
 * that checked a fixed 37 x 24 found "37 × 24 | 888" on the display and passed —
 * on arithmetic left there by an earlier hand-driven test, from a model that had
 * clicked nothing. Fresh operands make a stale display fail, and the expression
 * line says which calculation is actually on screen.
 */
const rand = () => 12 + Math.floor(Math.random() * 76);
const LHS = Number(process.env.LHS ?? rand());
const RHS = Number(process.env.RHS ?? rand());
const ANSWER = String(LHS * RHS);
/*
 * THE ASK NAMES THE APP AS THE DELIVERABLE, and that is not a probe trick.
 *
 * "Work out 16 x 23" has a computable answer, and a model with `bash` will
 * always have `python3` — MEASURED, it computed 368 first and every later step
 * was redundant work it declined to do, ending with "you can verify it
 * yourself: type 16, then *, then 23". Fair, for that question.
 *
 * Someone who wants computer use asks for the app's STATE, not for a number:
 * they want to look over and see it there. That is the request being tested, and
 * it is the one the harness has to honour — the answer only exists once the app
 * has been driven.
 */
const PROMPT =
  process.env.PROMPT ??
  `Use the Calculator app to work out ${LHS} x ${RHS} — I want the answer showing on the ` +
    `Calculator itself, not just told to me. Then tell me what its display reads.`;
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 300_000);

const log = [];
const started = Date.now();
const say = (m) => {
  log.push(`${((Date.now() - started) / 1000).toFixed(1)}s  ${m}`);
  console.log(m);
};

rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
mkdirSync(path.join(OUT, 'frames'), { recursive: true });

/*
 * START FROM ZERO, visibly. Quitting is not enough — the app comes back with
 * whatever was last on it — so open it in the background, press All Clear
 * through the same helper the model uses, and leave it closed and blank.
 */
const HELPER =
  process.env.PI_MAC_BIN ??
  path.join(
    BUNDLE,
    'Contents/Resources/app.asar.unpacked/node_modules/@pi-desktop/pi-mac/swift/.build/release/pi-mac',
  );
await osa('tell application "Calculator" to quit');
await sleep(900);
await run('/usr/bin/open', ['-g', '-a', 'Calculator']).catch(() => undefined);
await sleep(1800);
/*
 * All Clear through the SERVE loop, by index.
 *
 * A one-shot coordinate act is posted to the app's pid and Calculator ignores
 * it; only AXPress moves it, and AXPress needs the index map a snapshot builds
 * — which lives inside one serve process. So do the whole clear in one.
 */
await new Promise((resolve) => {
  const helper = spawn(HELPER, ['--serve']);
  let buf = '';
  let id = 0;
  const pending = new Map();
  const call = (method, params) =>
    new Promise((r) => {
      id += 1;
      pending.set(id, r);
      helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  helper.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg.result ?? msg);
        pending.delete(msg.id);
      } catch {
        /* not our line */
      }
    }
  });
  (async () => {
    try {
      const snap = await call('snapshot', { app: 'Calculator' });
      const ac = (snap.elements ?? []).find((e) => e.name === 'All Clear');
      if (ac !== undefined) await call('click', { index: ac.index, app: 'Calculator' });
      const after = await call('snapshot', { app: 'Calculator' });
      say(`pre-clean: display now ${JSON.stringify((after.text ?? []).join(' | '))}`);
    } catch (err) {
      say(`pre-clean failed: ${String(err).slice(0, 80)}`);
    }
    helper.stdin.end();
    resolve();
  })();
});
await sleep(600);
await osa('tell application "Calculator" to quit');
await sleep(1200);

/*
 * A throwaway HOME keeps settings and conversations out of the user's, but the
 * downloaded models live in the real cache — without this the run dies on
 * "model not downloaded" having proved nothing. Link the cache in; everything
 * else stays isolated.
 */
const HOME = probeHome('mac-video-calculator');
mkdirSync(path.join(HOME, '.cache'), { recursive: true });
const realCache = path.join(homedir(), '.cache/bobble');
if (existsSync(realCache)) symlinkSync(realCache, path.join(HOME, '.cache/bobble'));

const app = await electron.launch({
  executablePath: path.join(BUNDLE, 'Contents/MacOS/Bobble'),
  env: {
    ...process.env,
    HOME,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_MAC_PRECONSENT: '1',
    /*
     * SHOW THE PHANTOM CURSOR AND ITS BUBBLE, for once.
     *
     * Background mode hides the overlay window — right for a test suite, and the
     * reason the user watched a live run and saw none of it: "no fake cursor window
     * overlay either idling or clicking with the thinking clicking acting.. pill
     * that was present in the demo video". This recording's whole subject is the
     * agent driving an app, so the overlay opts back in. It is click-through and
     * shown with showInactive(), so the focus guard below still has to pass.
     */
    PI_MAC_OVERLAY: process.env.PI_MAC_OVERLAY ?? '1',
  },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-vmodel-'))}`],
});

let shooting = true;
let shot = 0;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30_000,
  });
  const dbg = async (op, params) => {
    const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
    if (res.ok !== true) throw new Error(`${op}: ${res.error}`);
    return res.result;
  };

  void (async () => {
    while (shooting) {
      const at = Date.now();
      try {
        await page.screenshot({
          path: path.join(OUT, 'frames', `f-${String(++shot).padStart(5, '0')}-${at}.png`),
          animations: 'allow',
        });
      } catch {
        /* mid-layout; skip */
      }
      await sleep(Math.max(0, 1000 / FPS - (Date.now() - at)));
    }
  })();

  say(`grants: ${JSON.stringify(await dbg('check'))}`);

  /*
   * BASH-CLI MODE, because that is the interface the user is using and the one that
   * failed. Set before pi starts, since pi-main reads the setting when it
   * spawns the child.
   */
  if (process.env.TOOL_INTERFACE !== 'schemas') {
    await page.evaluate(() =>
      window.piDesktop.invoke('settings:set', { patch: { toolInterface: 'bash-cli' } }),
    );
    say('tool interface: bash-cli');
  }

  // ── the model ────────────────────────────────────────────────────────────
  const startedServer = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL_ID,
  );
  if (startedServer.success !== true) throw new Error(`llm:start-server: ${startedServer.error}`);
  say(`model server up: ${MODEL_ID}`);
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  if (target === undefined) throw new Error('no llamacpp model registered');
  await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  say(`model selected: ${target.id}`);
  await sleep(2500);

  /*
   * NOTHING IS RESTRICTED. Calculator has no connector and no shell equivalent,
   * so the full shipped command set is in front of the model and reaching for
   * `mac` is a choice it makes, not one the probe made for it.
   */
  say('commands: the full shipped set (nothing removed)');

  // ── the prompt, typed like a person types it ─────────────────────────────
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type(PROMPT, { delay: 45 });
  await sleep(700);
  await page.keyboard.press('Enter');
  say(`sent: ${JSON.stringify(PROMPT)}`);

  // ── watch, do not touch ──────────────────────────────────────────────────
  const readState = () =>
    page.evaluate(() => {
      const ps = window.__pi_store().getState();
      return {
        streaming: ps.agent.isStreaming,
        tools: ps.messages
          .filter((m) => m.kind === 'assistant')
          .flatMap((m) =>
            m.blocks
              .filter((b) => b.type === 'toolCall')
              .map((b) => `${b.name} ${JSON.stringify(b.args ?? b.arguments ?? {}).slice(0, 160)}`),
          ),
        results: ps.messages
          .filter((m) => m.kind === 'toolResult')
          .map((m) => ({
            name: m.toolName,
            isError: m.isError === true,
            text: String(m.text ?? '').slice(0, 200),
          })),
        text: ps.messages
          .filter((m) => m.kind === 'assistant')
          .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
          .join(' '),
      };
    });

  /*
   * THE FOCUS GUARD. the user's whole rule for this feature is that driving an app
   * never takes his screen, and the last run broke it — the model shelled out
   * to `open -a`, which activates. Sample continuously and report every moment
   * TextEdit was in front, rather than claiming it never was.
   */
  const frontSamples = [];
  const watcher = setInterval(async () => {
    try {
      frontSamples.push((await dbg('frontmost')).app);
    } catch {
      /* helper busy */
    }
  }, 500);

  const deadline = Date.now() + DEADLINE_MS;
  let seen = 0;
  let last = await readState();
  while (Date.now() < deadline) {
    last = await readState();
    if (last.tools.length > seen) {
      for (const name of last.tools.slice(seen)) say(`model called ${name}`);
      seen = last.tools.length;
    }
    if (!last.streaming && last.tools.length > 0 && last.text.trim().length > 0) break;
    await sleep(700);
  }
  clearInterval(watcher);
  try {
    const ov = await dbg('overlay-info');
    say(
      `overlay: visible=${ov.visible} engaged=${ov.engaged} wantsVisible=${ov.wantsVisible} ` +
        `trackingPid=${ov.trackingPid}`,
    );
  } catch (err) {
    say(`overlay state unavailable: ${String(err).slice(0, 70)}`);
  }
  const stole = frontSamples.filter((a) => /calculator/i.test(String(a)));
  say(
    `focus guard: ${frontSamples.length} samples, Calculator was frontmost ${stole.length} of them`,
  );
  say(`tool calls: ${JSON.stringify(last.tools)}`);
  say(`tool results: ${JSON.stringify(last.results)}`);
  say(`model said: ${JSON.stringify(last.text.slice(0, 220))}`);

  /*
   * DID IT HAPPEN — asked of the app, not of the transcript.
   *
   * The display is the whole verification. A model that answered from its head
   * leaves Calculator reading 0; a model that drove it leaves 888 on screen.
   */
  try {
    const snap = await dbg('snapshot', { app: 'Calculator' });
    // Calculator groups thousands ("1,566"), so compare digits to digits — the
    // separator is presentation, and a probe that reads it as a mismatch reports
    // NOT PROVEN on a run that plainly worked.
    const bare = (t) => String(t).replace(/[\u202f\u00a0,\s]/g, '');
    const shown = (snap.text ?? []).join(' | ');
    const shownBare = bare(shown);
    say(`Calculator display reads: ${JSON.stringify(shown)}`);
    // BOTH halves, because either alone can be satisfied by a display nobody
    // touched: the operands prove it is THIS run's sum, the answer proves it
    // finished.
    const hasOperands = shownBare.includes(String(LHS)) && shownBare.includes(String(RHS));
    say(`display shows this run's ${LHS} and ${RHS}: ${hasOperands}`);
    say(`display shows ${ANSWER}: ${shownBare.includes(ANSWER)}`);
    say(`model's answer contains ${ANSWER}: ${bare(last.text).includes(ANSWER)}`);
    say(
      `VERDICT: ${
        hasOperands && shownBare.includes(ANSWER) && bare(last.text).includes(ANSWER)
          ? 'the model drove Calculator and reported what it read'
          : 'NOT PROVEN'
      }`,
    );
  } catch (err) {
    say(`could not read Calculator back: ${String(err).slice(0, 90)}`);
  }
  say(`frontmost at the end: ${(await dbg('frontmost')).app}`);
  await sleep(1500);
} finally {
  shooting = false;
  await sleep(1000 / FPS + 200);
  await app.close().catch(() => {});
  // Calculator keeps nothing, so quitting is the whole cleanup.
  await osa('tell application "Calculator" to quit');
}

const dir = path.join(OUT, 'frames');
const frames = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort()
  .map((f) => ({ file: path.join(dir, f), t: Number(f.split('-')[2]?.replace('.png', '') ?? 0) }));
if (frames.length === 0) throw new Error('no frames were captured');
const lines = [];
for (let i = 0; i < frames.length; i += 1) {
  const next = frames[i + 1]?.t ?? frames[i].t + 1000 / FPS;
  lines.push(
    `file '${frames[i].file}'`,
    `duration ${Math.min(3, Math.max(0.03, (next - frames[i].t) / 1000)).toFixed(3)}`,
  );
}
lines.push(`file '${frames[frames.length - 1].file}'`);
const list = path.join(OUT, 'frames.txt');
writeFileSync(list, lines.join('\n'));
const video = path.join(OUT, 'bobble-model-drives-calculator.mp4');
await run('ffmpeg', [
  '-y',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  list,
  '-vf',
  'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-preset',
  'veryfast',
  '-crf',
  '20',
  video,
]);
writeFileSync(path.join(OUT, 'run-log.txt'), log.join('\n'));
console.log(`\n${frames.length} frames → ${video}`);
