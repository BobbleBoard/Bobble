/**
 * ONE COMPUTER-USE DEMO RUN — the shared harness behind the app matrix.
 *
 * WHY IT DOES NOT SPAWN THE APP. Every other probe here uses
 * `_electron.launch`, which starts Contents/MacOS/Bobble directly. TCC
 * attributes a request to the RESPONSIBLE process, and a directly-spawned binary
 * inherits the launching shell's grants rather than the app's own. MEASURED on
 * this machine, same bundle, both ways:
 *
 *   spawned by playwright : accessibility ✓  screenRecording ✗   (the shell's)
 *   open -a Bobble.app    : accessibility ✗  screenRecording ✓   (Bobble's)
 *
 * A demo that needs PIXELS therefore has to be launched by LaunchServices, which
 * means driving it over CDP instead. `open --env` carries the E2E flags through,
 * so the debug channel, background mode and the phantom-cursor overlay all
 * behave exactly as they do under the spawned probes.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => run('osascript', ['-e', s]).catch(() => undefined);

/**
 * Drive one demo end to end and write an MP4.
 *
 * @param {object} o
 * @param {string} o.name        Slug for the output directory.
 * @param {string} o.app         The Mac app under test (quit before and after).
 * @param {string} o.prompt      Typed into the composer, verbatim.
 * @param {string} o.model       Model id.
 * @param {'bash-cli'|'schemas'} o.mode
 * @param {boolean} [o.attach] Use the app as it already is, rather than quitting
 *        it first — see the note at the quit below.
 * @param {(dbg: Function) => Promise<Record<string, unknown>>} [o.verify]
 *        Asked of the APP once the turn ends — the run's own evidence.
 */
export async function demoRun(o) {
  const OUT = path.join('/Users/user/Desktop/OSS-harness/scratchpad/demos', o.name);
  const FPS = Number(process.env.FPS ?? 6);
  const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 300_000);
  const PORT = Number(process.env.CDP_PORT ?? 9350);
  const log = [];
  const started = Date.now();
  const say = (m) => {
    log.push(`${((Date.now() - started) / 1000).toFixed(1)}s  ${m}`);
    console.log(m);
  };

  rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
  mkdirSync(path.join(OUT, 'frames'), { recursive: true });

  /*
   * ATTACH TO WHAT IS OPEN, when the app has state worth attaching to.
   *
   * Quitting the target first makes a run repeatable, and for Maps or Blender
   * that is free. For Chrome it manufactured a bug: a cold start with five
   * profiles opens the profile chooser, so three runs measured a model's ability
   * to get past a screen the user would never have been on. the user: "this allows
   * attaching to an already open chrome session though too right we wouldn't
   * need it then right?" — right, and attaching is also the case the tools are
   * built for, with the user's logins and their session.
   */
  if (o.attach !== true) await osa(`tell application "${o.app}" to quit`);
  await osa('tell application "Bobble" to quit');
  await sleep(2500);
  if (o.attach === true) {
    // Make sure there IS something to attach to, without stealing the screen.
    await run('open', ['-g', '-a', o.app]).catch(() => undefined);
    await sleep(4000);
  }

  /* A throwaway HOME keeps settings and conversations out of the user's; the model
     cache is linked in, or the run dies on "model not downloaded". */
  const HOME = probeHome(`demo-${o.name}`);
  mkdirSync(path.join(HOME, '.cache'), { recursive: true });
  const realCache = path.join(homedir(), '.cache/pi-desktop');
  if (existsSync(realCache) && !existsSync(path.join(HOME, '.cache/pi-desktop'))) {
    symlinkSync(realCache, path.join(HOME, '.cache/pi-desktop'));
  }

  /*
   * TWO WAYS IN, because TCC gives them different answers (see the header).
   * `open` is the one that can record; `spawn` is the one that works on a
   * machine whose Accessibility row is bound to the shell rather than the app,
   * and is how a task is dry-run before it is worth twelve long recordings.
   */
  const LAUNCH = process.env.LAUNCH ?? 'open';
  const env = {
    HOME,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_MAC_PRECONSENT: '1',
    PI_MAC_OVERLAY: '1',
  };
  let browser = null;
  let electronApp = null;
  let page;
  if (LAUNCH === 'spawn') {
    electronApp = await electron.launch({
      executablePath: '/Applications/Bobble.app/Contents/MacOS/Bobble',
      env: { ...process.env, ...env },
      args: [`--user-data-dir=${path.join(HOME, 'udd')}`],
    });
    page = await electronApp.firstWindow();
  } else {
    await run('open', [
      '-g',
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      '-a',
      '/Applications/Bobble.app',
      '--args',
      `--remote-debugging-port=${PORT}`,
    ]);
    await sleep(7000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    page = (browser.contexts()[0]?.pages() ?? []).find((p) => !p.url().startsWith('devtools://'));
  }

  let shooting = true;
  let shot = 0;
  try {
    if (page === undefined) throw new Error('no renderer page');
    await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
      timeout: 40_000,
    });
    const dbg = async (op, params) => {
      const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), {
        op,
        params,
      });
      if (res.ok !== true) throw new Error(`${op}: ${res.error}`);
      return res.result;
    };
    const grants = await dbg('check');
    say(`grants: ${JSON.stringify(grants)}`);
    if (grants.screenRecording !== true) {
      say('WARNING: no Screen Recording — the monitor will show the permission panel, not pixels');
    }
    if (grants.accessibility !== true) {
      throw new Error('accessibility is not granted for the LaunchServices identity — see README');
    }

    const camera = (async () => {
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

    await page.evaluate(
      (m) => window.piDesktop.invoke('settings:set', { patch: { toolInterface: m } }),
      o.mode,
    );
    say(`tool interface: ${o.mode}`);

    const up = await page.evaluate(
      (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
      o.model,
    );
    if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
    await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
    const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
    const target = models.models.find((m) => m.provider === 'llamacpp');
    if (target === undefined) throw new Error('no llamacpp model registered');
    await page.evaluate(
      (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
      target,
    );
    say(`model: ${target.id}`);
    await sleep(2500);

    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.type(o.prompt, { delay: 18 });
    await sleep(600);
    await page.keyboard.press('Enter');
    say(`sent: ${JSON.stringify(o.prompt)}`);

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
                .map(
                  (b) => `${b.name} ${JSON.stringify(b.args ?? b.arguments ?? {}).slice(0, 120)}`,
                ),
            ),
          text: ps.messages
            .filter((m) => m.kind === 'assistant')
            .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
            .join(' '),
        };
      });

    /* THE FOCUS GUARD. Driving an app must never take the user's screen; sample
       continuously and report every moment it did rather than claiming it never. */
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
        for (const n of last.tools.slice(seen)) say(`model called ${n}`);
        seen = last.tools.length;
      }
      if (!last.streaming && last.tools.length > 0 && last.text.trim().length > 0) break;
      await sleep(800);
    }
    clearInterval(watcher);

    const stole = frontSamples.filter((a) => new RegExp(o.app, 'i').test(String(a)));
    say(`focus guard: ${frontSamples.length} samples, ${o.app} was frontmost ${stole.length}`);
    say(`tool calls (${last.tools.length}): ${JSON.stringify(last.tools)}`);
    say(`model said: ${JSON.stringify(last.text.slice(0, 400))}`);

    if (o.verify !== undefined) {
      try {
        const evidence = await o.verify(dbg, last);
        say(`VERIFY: ${JSON.stringify(evidence)}`);
      } catch (err) {
        say(`verify failed: ${String(err).slice(0, 140)}`);
      }
    }
    say(`frontmost at the end: ${(await dbg('frontmost')).app}`);
    await sleep(1200);
  } finally {
    shooting = false;
    await sleep(1000 / FPS + 250);
    await browser?.close().catch(() => {});
    await electronApp?.close().catch(() => {});
    await osa('tell application "Bobble" to quit');
    if (o.attach !== true) await osa(`tell application "${o.app}" to quit`);
  }

  const dir = path.join(OUT, 'frames');
  const frames = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => ({
      file: path.join(dir, f),
      t: Number(f.split('-')[2]?.replace('.png', '') ?? 0),
    }));
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
  const video = path.join(OUT, `${o.name}.mp4`);
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
  return { video, log };
}
