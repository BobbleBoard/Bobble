/**
 * The REAL proof: a prompt typed into Bobble's composer, and a LOCAL MODEL
 * deciding the Mac control calls that follow.
 *
 * The earlier recording drove the tools directly from the probe. That proves
 * the mechanism and nothing about whether a model can use it, which is the
 * question worth answering — the user spotted the difference immediately ("you just
 * had it start in the canvas on its own with a hardcoded I assume invisible
 * prompt"). Here nothing is scripted after the keystrokes: the probe types,
 * presses Return, and then only watches and records.
 *
 * Recorded from Bobble's own window, which needs no capture grant.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
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
const OUT = process.env.OUT_DIR ?? '/Users/user/Desktop/OSS-harness/scratchpad/mac-video-reminders';
const FPS = Number(process.env.FPS ?? 8);
const MODEL_ID = process.env.MAC_CU_MODEL ?? 'qwen3.5-4b-mtp';
const MARKER = process.env.MARKER ?? `Buy milk ${Date.now().toString(36).slice(-4)}`;
/*
 * Reminders, not a text editor.
 *
 * A text file is a plausible substitute for a TextEdit document, so a model that
 * writes one and opens it looks like it succeeded while never touching the
 * feature. A reminder has no shell equivalent: either the app was driven or it
 * was not.
 */
const PROMPT = process.env.PROMPT ?? `Use the Reminders app to add a reminder: ${MARKER}`;
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 300_000);

const log = [];
const started = Date.now();
const say = (m) => {
  log.push(`${((Date.now() - started) / 1000).toFixed(1)}s  ${m}`);
  console.log(m);
};

rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
mkdirSync(path.join(OUT, 'frames'), { recursive: true });

await osa('tell application "Reminders" to quit');
await sleep(1200);

/*
 * A throwaway HOME keeps settings and conversations out of the user's, but the
 * downloaded models live in the real cache — without this the run dies on
 * "model not downloaded" having proved nothing. Link the cache in; everything
 * else stays isolated.
 */
const HOME = probeHome('mac-video-reminders');
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
   * ONLY THE MAC COMMANDS. the user: "drive reminders given only the mac tools".
   *
   * Reminders is also reachable through the `personal` connector, which is the
   * right product behaviour normally and the wrong thing to demonstrate here.
   * The shims are files on a PATH, so the run removes the ones it is not
   * testing — test-side only, nothing in the product changes.
   */
  const shimDirs = readdirSync(tmpdir())
    .filter((d) => d.startsWith('pi-toolcli-') && !d.endsWith('.sock'))
    .map((d) => path.join(tmpdir(), d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const shimDir = shimDirs[0];
  if (shimDir !== undefined) {
    const keep = new Set(['mac', 'dispatcher.js', 'open', 'say', 'espeak', 'festival']);
    const removed = [];
    for (const f of readdirSync(shimDir)) {
      if (keep.has(f)) continue;
      rmSync(path.join(shimDir, f), { force: true });
      removed.push(f);
    }
    say(`shims kept: mac · removed: ${removed.join(', ')}`);
  } else {
    say('note: no shim dir found — the run is NOT restricted to the mac commands');
  }

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
  const stole = frontSamples.filter((a) => /textedit/i.test(String(a)));
  say(
    `focus guard: ${frontSamples.length} samples, TextEdit was frontmost ${stole.length} of them`,
  );
  say(`tool calls: ${JSON.stringify(last.tools)}`);
  say(`tool results: ${JSON.stringify(last.results)}`);
  say(`model said: ${JSON.stringify(last.text.slice(0, 220))}`);

  // ── did it actually happen, on the app's own state ───────────────────────
  try {
    const snap = await dbg('snapshot', { app: 'TextEdit' });
    const area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
    const value = String(area?.value ?? '');
    say(`TextEdit document reads: ${JSON.stringify(value.slice(0, 80))}`);
    say(
      `contains ${JSON.stringify(MARKER)}: ${value.toLowerCase().includes(MARKER.toLowerCase())}`,
    );
  } catch (err) {
    say(`could not read TextEdit back: ${String(err).slice(0, 90)}`);
  }
  say(`frontmost at the end: ${(await dbg('frontmost')).app}`);
  await sleep(1500);
} finally {
  shooting = false;
  await sleep(1000 / FPS + 200);
  await app.close().catch(() => {});
  // Leave the user's list as it was found.
  await osa(
    `tell application "Reminders" to delete (every reminder whose name contains "${MARKER}")`,
  );
  await osa('tell application "Reminders" to quit');
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
const video = path.join(OUT, 'bobble-model-drives-textedit.mp4');
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
