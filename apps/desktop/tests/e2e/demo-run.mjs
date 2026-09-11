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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (s) => run('osascript', ['-e', s]).catch(() => undefined);

/**
 * Quit the app under test WITHOUT it asking to save.
 *
 * the user: "blender came back because of a 'save or not' popup when it got quit."
 * A plain `quit` on an app with unsaved changes puts a modal on screen and
 * brings that app to the front — so the teardown itself takes the user's screen,
 * and the run reports a focus violation it caused on the way out.
 *
 * `quit saving no` is the standard-suite form and says exactly that. The plain
 * quit stays as the fallback for an app that does not implement it.
 */
async function quitTarget(app) {
  if (typeof app !== 'string' || app === '') return;
  const r = await osa(`tell application "${app}" to quit saving no`);
  if (r === undefined) await osa(`tell application "${app}" to quit`);
}

/**
 * Wait for Bobble's process to actually be gone.
 *
 * The AppleScript quit RETURNS as soon as the app accepts it, not when it has
 * finished quitting — and the whole point of quitting rather than closing is to
 * give the quit-hold time to reap the inference process and its llama-server
 * grandchild. Returning early and then calling `electronApp.close()` would put
 * the bug straight back.
 */
async function waitForBobbleToExit(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).catch(() => null);
    if (out === null || out.stdout.trim() === '') return true;
    await sleep(250);
  }
  return false;
}

/**
 * Kill llama-servers that no longer have a parent, and say so.
 *
 * A benchmark is only worth reading if the machine it ran on was the same each
 * time. An orphaned server holds a model and a port, and the power policy reads
 * the resulting pressure as "memory is tight" and quietly drops the whole run to
 * `gentle` — smaller context, one slot. That is a silent, run-to-run-varying
 * change to what is being measured, so it is swept before AND after every run
 * rather than trusted not to happen.
 *
 * ppid === 1 is the whole test: a live run's server is a child of the app, so
 * this can never touch one. Nothing is killed by name alone.
 */
async function reapOrphanServers(when) {
  const found = await run('pgrep', ['-f', 'llama-server']).catch(() => null);
  const pids = (found?.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const killed = [];
  for (const pid of pids) {
    const ps = await run('ps', ['-o', 'ppid=', '-p', pid]).catch(() => null);
    if (ps === null || ps.stdout.trim() !== '1') continue;
    try {
      process.kill(Number(pid), 'SIGTERM');
      killed.push(pid);
    } catch {
      /* already gone between the listing and the kill — nothing to do */
    }
  }
  if (killed.length > 0) {
    console.log(
      `[demo] reaped ${killed.length} orphaned llama-server(s) ${when}: ${killed.join(', ')}`,
    );
    await sleep(1500);
  }
  return killed.length;
}

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
  /*
   * A NEWLINE IN THE PROMPT IS AN ENTER.
   *
   * The prompt is typed into the composer with `keyboard.type`, so a multi-line
   * prompt sends itself halfway through and the run dies further down with "the
   * prompt never entered the conversation" — which says nothing about the cause.
   * MEASURED once, on a demo whose passage was separated by blank lines.
   */
  if (typeof o.prompt === 'string' && /[\r\n]/.test(o.prompt)) {
    throw new Error(
      'demoRun: the prompt contains a newline, and prompts are TYPED — that Enter ' +
        'sends the message early. Put it on one line.',
    );
  }
  const OUT = path.join('/Users/user/Desktop/OSS-harness/scratchpad/demos', o.name);
  /* the user: "please video at 30+ if possible ... earlier ones were low framerate".
     They were: capture ran at 5-6/s and ffmpeg then held each frame for ~5 output
     frames. The cost is the screenshot, so the frames are JPEG at CSS scale
     (1440x867, not the 2880x1734 backing store) — a quarter of the pixels and no
     PNG deflate, which is what makes 30/s reachable at all. */
  const FPS = Number(process.env.FPS ?? 30);
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
  if (o.attach !== true) await quitTarget(o.app);
  await osa('tell application "Bobble" to quit');
  /*
   * AND WAIT FOR IT TO ACTUALLY BE GONE.
   *
   * A fixed sleep after the quit is a hope, not a gate, and MEASURED it lost
   * four runs of an overnight batch in a row: a Bobble killed mid-run (its
   * `finally` never reached) was still tearing down when the next run launched,
   * so Playwright found a window whose composer never became visible and every
   * run after it failed identically with the same TimeoutError. Nothing about
   * that is diagnosable from the run it breaks, which is what makes it worth a
   * real check rather than a longer sleep.
   */
  for (let i = 0; i < 40; i += 1) {
    // execFile is promisified, so this resolves to {stdout}; pgrep exits 1 when
    // nothing matches, which rejects — and "no match" is exactly "not alive".
    const alive = await run('pgrep', ['-f', 'Bobble.app/Contents/MacOS/Bobble']).then(
      (r) => String(r.stdout ?? '').trim() !== '',
      () => false,
    );
    if (!alive) break;
    if (i === 20) await osa('tell application "Bobble" to quit');
    await sleep(500);
  }
  await sleep(1500);
  /* Nothing from a previous run may still be holding a model — see
     reapOrphanServers. Swept here, with Bobble confirmed gone, so any survivor
     is unambiguously an orphan. */
  await reapOrphanServers('before');
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
  /*
   * LIVE=1 — run it where the user can watch.
   *
   * Everything here is normally invisible by default, which is the standing rule
   * and stays the default. But a run nobody can see is also a run nobody can
   * sanity-check, and the user asked to observe these: "why don't you open these
   * live actually rather than headlessly i'd like to observe (still do the
   * screen recording)".
   *
   * So LIVE drops background mode and brings the window forward. The recording
   * is unchanged — it is the same page screenshots and the same capture stream —
   * and the target app still opens in the background, because that is the
   * product's behaviour and the monitor tab is the better view of it anyway.
   */
  const LIVE = process.env.LIVE === '1';
  const env = {
    HOME,
    PI_E2E: '1',
    PI_MAC_PRECONSENT: '1',
    PI_MAC_OVERLAY: '1',
    ...(LIVE ? {} : { PI_E2E_BACKGROUND: '1' }),
    /* Diagnostic passthrough: with PI_ADV_DEBUG_TOOLS set to a file path the
       provider appends the EXACT tool list sent to llama-server each request.
       It is the only ground truth for "which tools does the model actually
       know about", and a run is the only place to observe it. */
    ...(process.env.PI_ADV_DEBUG_TOOLS === undefined
      ? {}
      : { PI_ADV_DEBUG_TOOLS: process.env.PI_ADV_DEBUG_TOOLS }),
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
    /*
     * AND KEEP THE MAIN PROCESS'S OUTPUT.
     *
     * LaunchServices sends a launched app's stdout to the system log, where this
     * run cannot see it — so when a message enters the conversation and pi never
     * runs a turn (MEASURED five times tonight, with the renderer console
     * silent), the one place that could say why is thrown away. `open` will
     * redirect it if asked.
     */
    await run('open', [
      ...(LIVE ? [] : ['-g']),
      '--stdout',
      path.join(OUT, 'main-stdout.log'),
      '--stderr',
      path.join(OUT, 'main-stderr.log'),
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
  /** The camera loop, hoisted so `finally` can wait for it to stop. */
  let camera = Promise.resolve();
  let shot = 0;
  /** Stops the CDP screencast, if one was started. */
  let screencastStop = null;
  try {
    if (page === undefined) throw new Error('no renderer page');

    /*
     * WHATEVER THE APP ITSELF COMPLAINED ABOUT.
     *
     * MEASURED three times across this matrix: the prompt goes in, prefill
     * finishes, and the turn ends having produced NOTHING — no text, no tool
     * call, no error the run can see. A frame from the middle shows the composer
     * back at "Ask anything...", so the turn really did end; the run has no way
     * to say why, and that is exactly the failure the user asked me to make sure
     * never just hangs quietly. The renderer's own errors are the one channel
     * that might say, and nothing was reading it.
     */
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        log.push(`  [app ${m.type()}] ${m.text().slice(0, 300)}`);
      }
    });
    page.on('pageerror', (e) => log.push(`  [app pageerror] ${String(e).slice(0, 300)}`));

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

    /*
     * PREFILL, PER TURN, WHILE IT HAPPENS.
     *
     * the user: "check that prefill makes sense on each turn ... when there's a >2
     * second prefill in a turn check it out". The provider reports real
     * processed/total over the `harness-prefill` status channel, so the run can
     * time every ingest episode rather than inferring one from wall clock.
     * Recorded next to the tool count, because the usual reason an ingest gets
     * long is that the prompt's prefix moved — and the tool schemas ARE that
     * prefix.
     */
    const prefills = [];
    let prefillStart = null;
    let prefillPeak = 0;
    const prefillWatch = setInterval(async () => {
      try {
        const raw = await page.evaluate(
          () => window.__pi_store().getState().extensionStatus['harness-prefill'],
        );
        /* The channel carries a bare percentage string ("0".."99"), not JSON —
           `parsePrefillPercent` is the reader, and 100/absent means done. */
        const pct = raw === undefined || raw === '' ? Number.NaN : Number(raw);
        const active = Number.isFinite(pct) && pct >= 0 && pct < 100;
        if (active && prefillStart === null) {
          prefillStart = Date.now();
          prefillPeak = 0;
        }
        if (active) prefillPeak = Math.max(prefillPeak, pct);
        if (!active && prefillStart !== null) {
          prefills.push({ ms: Date.now() - prefillStart, peak: Math.round(prefillPeak) });
          prefillStart = null;
        }
      } catch {
        /* between turns */
      }
    }, 250);

    /*
     * THIRTY FRAMES A SECOND NEEDS A PUSH, NOT A PULL.
     *
     * the user: "please video at 30+ if possible ... it seems earlier ones were low
     * framerate". Asking for a screenshot per frame is a full CDP round trip
     * each time, and MEASURED it tops out between 15/s (while Blender is busy
     * on the GPU) and 27/s. Page.startScreencast has the browser PUSH frames
     * instead, already JPEG-encoded at the size we ask for, so the rate stops
     * depending on our round trip.
     *
     * Frames are written with the same name shape as the pulled ones, so the
     * assembler cannot tell the difference. If the session fails to start we
     * fall back rather than lose the video — a lower framerate is worth more
     * than no recording.
     */
    /* When the last pushed frame arrived — the pull loop skips a shot if the
       push is keeping up, and takes over the moment it stops. */
    let lastPush = 0;
    let screencast = null;
    if (process.env.SCREENCAST !== '0') {
      try {
        screencast = await page.context().newCDPSession(page);
        screencast.on('Page.screencastFrame', async (f) => {
          if (!shooting) return;
          const at = Date.now();
          lastPush = at;
          writeFileSync(
            path.join(OUT, 'frames', `f-${String(++shot).padStart(5, '0')}-${at}.jpg`),
            Buffer.from(f.data, 'base64'),
          );
          await screencast
            .send('Page.screencastFrameAck', { sessionId: f.sessionId })
            .catch(() => {});
        });
        /* No size caps: uncapped, the screencast emits the page's own CSS size,
           which is exactly what `scale: 'css'` gives the pulled frames. Capping
           it made pushed frames 1600x963 against the pull's 1440x868, and a
           concat of two sizes makes ffmpeg reconfigure its filter graph on every
           single frame. */
        await screencast.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 72,
          everyNthFrame: 1,
        });
        screencastStop = async () => {
          await screencast?.send('Page.stopScreencast').catch(() => {});
          await screencast?.detach().catch(() => {});
        };
        say('camera: CDP screencast');
      } catch (e) {
        screencast = null;
        say(`camera: screenshots (screencast unavailable: ${String(e).slice(0, 80)})`);
      }
    }

    camera = (async () => {
      while (shooting) {
        const at = Date.now();
        /*
         * PUSH WHEN IT CAN, PULL WHEN IT CANNOT.
         *
         * Page.startScreencast reaches 79/s — and MEASURED it stopped after 40
         * seconds of a 125-second run, because Chromium suspends the screencast
         * when the window is not visibly updating, which is exactly this case:
         * the app being driven is in front and Bobble is behind it. A video that
         * covers a third of the run at 79/s is worth less than one that covers
         * all of it at 25/s.
         *
         * So the pull loop stays, and simply stands down while the push is
         * keeping up. Together they hold 30+ through the busy parts without ever
         * leaving a gap.
         */
        if (screencast !== null && at - lastPush < 1000 / FPS) {
          await sleep(Math.max(5, 1000 / FPS / 2));
          continue;
        }
        try {
          await page.screenshot({
            path: path.join(OUT, 'frames', `f-${String(++shot).padStart(5, '0')}-${at}.jpg`),
            animations: 'allow',
            type: 'jpeg',
            quality: 72,
            scale: 'css',
          });
        } catch {
          /* mid-layout; skip */
        }
        await sleep(Math.max(0, 1000 / FPS - (Date.now() - at)));
      }
    })();

    /*
     * POWER=low runs the whole thing on the app's gentle profile.
     *
     * the user: "run these on 'low power mode' that we have in the app and see if it
     * works also keeping things speedy and mem pressure low". It has to be set
     * BEFORE llm:start-server, because it decides how the server is launched —
     * setting it afterwards would describe a run that had already started.
     */
    const power = process.env.POWER ?? 'auto';
    await page.evaluate(
      ({ m, p }) =>
        window.piDesktop.invoke('settings:set', { patch: { toolInterface: m, powerMode: p } }),
      { m: o.mode, p: power },
    );
    say(`tool interface: ${o.mode}, power: ${power}`);

    const up = await page.evaluate(
      (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
      o.model,
    );
    if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
    /* llama-server's own throughput counters, so "speed" is a measurement
       rather than a stopwatch guess. Prometheus text at /metrics on the same
       origin as the OpenAI endpoint. */
    const metricsUrl =
      typeof up.baseUrl === 'string' ? `${up.baseUrl.replace(/\/v1\/?$/, '')}/metrics` : null;
    await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
    const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
    const target = models.models.find((m) => m.provider === 'llamacpp');
    if (target === undefined) throw new Error('no llamacpp model registered');
    await page.evaluate(
      (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
      target,
    );

    /*
     * AND MAKE THE SELECTOR SAY IT.
     *
     * the user: "ensure model is selected via the UI and model selector accurately
     * at the start of each video is used and reflects the model being used."
     * Every video so far showed "Balanced" in the composer's model chip while a
     * named model was doing the work — because the run set the model through the
     * engine (llm:start-server + pi:set-model) and never touched the SELECTION,
     * which is a separate setting and was still on a tier. Anyone watching had
     * no way to tell which of the three models they were looking at.
     *
     * So the run writes the same selection the picker writes, and then READS THE
     * CHIP BACK. The write alone would be the same class of mistake as before —
     * a thing that was set but never seen.
     */
    /* `window.__settings_store()` is the renderer store itself — the thing the
       picker writes and the chip reads. Writing the setting through main
       instead left the chip on "Balanced", which the read-back below caught. */
    await page.evaluate(
      (id) =>
        window
          .__settings_store?.()
          .getState?.()
          .update?.({
            modelSelection: { mode: 'model', modelId: id },
          }) ??
        window.piDesktop.invoke('settings:set', {
          patch: { modelSelection: { mode: 'model', modelId: id } },
        }),
      o.model,
    );
    await sleep(700);
    const chip = await page
      .evaluate(
        () => document.querySelector('[data-testid="footer-model-chip"]')?.textContent ?? '',
      )
      .catch(() => '');
    const shortId = o.model.split('/').pop() ?? o.model;
    /*
     * COMPARE THE LETTERS, NOT THE PUNCTUATION.
     *
     * This split the id on "-" and looked for the first piece in the chip, which
     * works only when the display name punctuates exactly like the id. MEASURED:
     * `nanbeige4.2-3b` renders as "Nanbeige 4.2 3B", so the check looked for
     * "nanbeige4.2" in "nanbeige 4.2 3b", missed on one space, and warned that
     * the chip did not name the model — while the chip named it perfectly.
     *
     * A verification that cries wolf is worse than none: it would have gone into
     * a report as a UI defect that does not exist. Strip everything that is not
     * a letter or digit from BOTH sides and compare that.
     */
    const bare = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const chipNames = bare(chip).includes(bare(shortId));
    say(
      `model: ${target.id} · selector shows ${JSON.stringify(chip.trim())}` +
        (chipNames ? '' : ' — WARNING: the chip does not name this model'),
    );
    await sleep(2500);

    /*
     * AND CHECK THE MESSAGE ACTUALLY LANDED.
     *
     * Typing and pressing Enter was fire-and-forget, and MEASURED four times in
     * this matrix the message simply did not arrive: `prefill: 0 ingests`, no
     * text, no tool call, and the run then spent its entire deadline polling an
     * idle app. `pi:restart` above is asynchronous, so a send that races it is
     * dropped with nothing raised — the failure looks exactly like a model that
     * chose to say nothing, which is what made it so slow to spot.
     *
     * A user message in the store is the only proof the send took. If it is not
     * there, press Enter again, and retype if the composer was cleared without
     * the message landing.
     */
    /*
     * WAIT FOR CAPACITY BEFORE TYPING, AND NAME THE GATE IF THERE IS NONE.
     *
     * A message sent while the app believes a turn is running does not fail — it
     * is QUEUED (pi-slice's canDrainQueue: not streaming, no prompt in flight,
     * no background run, not resuming) and drains later. MEASURED: after
     * `pi:restart` one of those flags can still be set, so the prompt lands in
     * the store as a user message, the queue never drains, and the run sits for
     * its whole deadline with `prefill: 0 ingests` and nothing to show. It looks
     * identical to a model that said nothing.
     */
    const capacity = async () =>
      page.evaluate(() => {
        const s = window.__pi_store().getState();
        return {
          ok:
            !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming,
          streaming: s.agent.isStreaming === true,
          promptInFlight: s.promptInFlight === true,
          bgRun: s.bgRun?.streaming === true,
          resuming: s.resuming === true,
          queued: (s.queuedSends ?? []).length,
        };
      });
    let cap = await capacity();
    for (let i = 0; i < 40 && !cap.ok; i += 1) {
      await sleep(500);
      cap = await capacity();
    }
    if (!cap.ok) {
      say(`WARNING sending anyway, the app reports no capacity: ${JSON.stringify(cap)}`);
    }

    const editor = page.locator('[contenteditable="true"]').first();
    const landed = () =>
      page.evaluate(
        (want) =>
          window
            .__pi_store()
            .getState()
            .messages.some((m) => m.kind === 'user' && m.text === want),
        o.prompt,
      );

    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
      if (attempt > 0) say(`the send did not land; retrying (${attempt})`);
      await editor.click();
      const empty = await page.evaluate(
        (el) => el.textContent.trim() === '',
        await editor.elementHandle(),
      );
      if (empty) await page.keyboard.type(o.prompt, { delay: 18 });
      await sleep(600);
      await page.keyboard.press('Enter');
      for (let i = 0; i < 30 && !sent; i += 1) {
        sent = await landed().catch(() => false);
        if (!sent) await sleep(400);
      }
    }
    if (!sent) throw new Error('the prompt never entered the conversation');
    const focusBefore = (await dbg('frontmost')).app;
    say(`frontmost before the run: ${focusBefore}`);
    say(`sent: ${JSON.stringify(o.prompt)}`);
    /* A message can be IN the conversation and still be waiting: report the
       queue rather than letting the run look like a silent model. */
    const after = await capacity();
    if (after.queued > 0 || !after.ok) say(`after send: ${JSON.stringify(after)}`);

    const readState = () =>
      page.evaluate(() => {
        const ps = window.__pi_store().getState();
        return {
          streaming: ps.agent.isStreaming,
          /* The call AND what came back. A name-only log says a run made forty
             calls and not which of them failed, so every diagnosis needed the
             session JSONL afterwards — too late to act on during an overnight
             batch. Results are their own messages, joined back by toolCallId;
             truncated hard, because this is a trace and not a copy of the
             conversation. */
          tools: (() => {
            const resultFor = new Map();
            for (const m of ps.messages) {
              if (m.kind === 'toolResult') resultFor.set(m.toolCallId, m);
            }
            return ps.messages
              .filter((m) => m.kind === 'assistant')
              .flatMap((m) =>
                m.blocks
                  .filter((b) => b.type === 'toolCall')
                  .map((b) => {
                    const args = JSON.stringify(b.args ?? b.arguments ?? {}).slice(0, 140);
                    const r = resultFor.get(b.id);
                    const parts = Array.isArray(r?.content) ? r.content : [];
                    const text = [
                      r?.text ?? '',
                      ...parts.filter((x) => x?.type === 'text').map((x) => x.text ?? ''),
                    ].join(' ');
                    const imgs = parts.filter((x) => x?.type === 'image').length;
                    const back =
                      `${imgs > 0 ? `[+${imgs} image] ` : ''}` +
                      `${r?.isError ? 'ERROR ' : ''}${text.replace(/\s+/g, ' ').slice(0, 240)}`;
                    return `${b.name} ${args}${back.trim() === '' ? '' : `\n      -> ${back}`}`;
                  }),
              );
          })(),
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
    /* The app going away mid-run is not a result. MEASURED twice while the user's
       machine locked and slept under a running suite: `readState` threw "Target
       page, context or browser has been closed" and the run died with a stack
       trace, which in a ledger is indistinguishable from a model that failed.
       Recorded as INVALID instead, the same as a session that came up with no
       tools. */
    let vanished = null;
    while (Date.now() < deadline) {
      try {
        /*
         * THE DEADLINE HAS TO BOUND THE CALL, NOT JUST THE LOOP.
         *
         * `while (Date.now() < deadline)` is only checked BETWEEN iterations, so
         * one `page.evaluate` that never comes back overruns it by however long
         * it hangs. MEASURED: a Maps run recorded 1173s against a 300s deadline —
         * 42,374 frames at 42.8/s, sixteen minutes of capture — because a single
         * read stalled inside the loop. Every run after it in a suite pays that
         * time too.
         */
        const left = Math.max(1000, deadline - Date.now());
        last = await Promise.race([
          readState(),
          new Promise((_r, reject) =>
            setTimeout(() => reject(new Error('readState stalled')), left),
          ),
        ]);
      } catch (err) {
        vanished = `the app stopped answering mid-run (${String(err).slice(0, 70)})`;
        break;
      }
      if (last.tools.length > seen) {
        for (const n of last.tools.slice(seen)) say(`model called ${n}`);
        seen = last.tools.length;
      }
      /*
       * A TASK THAT NEEDS NO TOOLS CAN STILL BE FINISHED.
       *
       * This waited for `tools.length > 0`, so a question answered in prose —
       * which is a whole category of task — could never break early and always
       * burned the entire deadline. MEASURED: two recall runs that were done in
       * seconds were recorded at 355s and 361s, i.e. the 300s cap plus setup,
       * which makes a fast model look slow for a reason that has nothing to do
       * with it. `!streaming` with text already means the turn is over.
       */
      if (!last.streaming && last.text.trim().length > 0) break;
      await sleep(800);
    }
    if (vanished !== null) say(`INVALID: ${vanished}`);
    clearInterval(watcher);
    clearInterval(prefillWatch);

    /*
     * WHAT THE MODEL ACTUALLY LOOKED AT (the user) — read off `harness-modality`,
     * which the harness accumulates per tool result. Reported as three numbers
     * that mean different things: what came back, what the acts were aimed by,
     * and how many snapshots had no tree to aim at. The third is what separates
     * "the model chose pixels" from "the app left it nothing else".
     */
    let modality = null;
    try {
      const raw = await page.evaluate(
        () => window.__pi_store().getState().extensionStatus['harness-modality'],
      );
      modality = raw ? JSON.parse(raw) : null;
    } catch {
      /* the app may already be closing */
    }
    if (modality !== null) {
      const aimed = modality.byIndex + modality.byCoord;
      const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
      const trees = modality.axSnapshots + modality.domSnapshots;
      say(
        `modality: images ${modality.images} (${(modality.imageBytes / 1024).toFixed(0)}KB) · ` +
          `ax ${modality.axSnapshots} (${(modality.axChars / 1024).toFixed(0)}KB) · ` +
          `dom ${modality.domSnapshots} (${(modality.domChars / 1024).toFixed(0)}KB) · ` +
          `aimed by index ${modality.byIndex}/${aimed} (${pct(modality.byIndex, aimed)}), ` +
          `by pixel ${modality.byCoord}/${aimed} (${pct(modality.byCoord, aimed)}) · ` +
          `snapshots with no tree ${modality.visualOnly}/${trees}`,
      );
      say(`MODALITY: ${JSON.stringify(modality)}`);
    }
    if (prefillStart !== null) prefills.push({ ms: Date.now() - prefillStart, peak: prefillPeak });
    const slow = prefills.filter((p) => p.ms >= 2000);
    say(
      `prefill: ${prefills.length} ingests, ${slow.length} over 2s` +
        (prefills.length === 0
          ? ''
          : ` — ${prefills.map((p) => `${(p.ms / 1000).toFixed(1)}s`).join(', ')}`),
    );

    const stole = frontSamples.filter((a) => new RegExp(o.app, 'i').test(String(a)));
    say(
      `focus guard: ${frontSamples.length} samples, ${o.app} was frontmost ${stole.length}` +
        (LIVE ? ' (LIVE run — Bobble is deliberately visible; the app should still not be)' : ''),
    );
    say(`tool calls (${last.tools.length}): ${JSON.stringify(last.tools)}`);
    say(`model said: ${JSON.stringify(last.text.slice(0, 400))}`);

    /*
     * A SESSION WITH NO TOOLS IS NOT A RESULT, AND MUST NOT BE SCORED LIKE ONE.
     *
     * pi can die at startup, and when it does the app deliberately degrades —
     * it respawns with every extension disabled so a broken extension cannot
     * crash-loop the whole app. That is right for a person sitting in front of
     * it. For a benchmark it is poison: the model then has no tools and cannot
     * generate at all, so the run produces zero tool calls and an empty reply,
     * and `verify` faithfully reports that nothing on screen changed.
     *
     * MEASURED, matrix run 2 (9B): `pi exited at startup; retrying WITHOUT ANY
     * EXTENSIONS … this session has NO TOOLS — no browser, no files, no
     * generation`, then 392 seconds of nothing, recorded in the ledger as
     * `verdict: fail`. Read cold, that is a model that tried and failed. It
     * never ran. A benchmark that cannot tell those apart is worse than no
     * benchmark, so this is checked BEFORE the verdict and overrides it.
     */
    let invalid = null;
    try {
      const mainErr = readFileSync(path.join(OUT, 'main-stderr.log'), 'utf8');
      if (/pi exited at startup|NO TOOLS — no browser/.test(mainErr)) {
        invalid =
          'pi exited at startup — the session had NO TOOLS, so nothing about the model was measured';
      }
    } catch {
      /* no stderr captured (LIVE/attached runs) — nothing to check */
    }
    if (invalid !== null) say(`INVALID: ${invalid}`);

    /*
     * HOW FAST WAS IT, in the server's own numbers.
     *
     * Wall time answers "did the run finish" and nothing about the model: on a
     * computer-use task most of it is the app, the screenshots and the waiting.
     * llama.cpp counts what it actually did — tokens generated per second and
     * prompt tokens processed per second — so a small model's speed can be
     * compared across task types that spend wildly different amounts of time
     * outside the model.
     */
    if (metricsUrl !== null) {
      /*
       * A FIXED, TINY COMPLETION, timed by llama.cpp itself.
       *
       * /metrics needs the server launched with --metrics and ours is not, so
       * the counters came back empty. llama.cpp's own /completion always
       * reports `timings`, so the speed number is measured rather than
       * estimated — and because every model gets the SAME short prompt, the
       * generation rate is comparable across them in a way wall-clock never is
       * (a computer-use run spends most of its time in the app, not the model).
       */
      try {
        const origin = metricsUrl.replace(/\/metrics$/, '');
        const res = await fetch(`${origin}/completion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: 'Count from one to twenty in words, comma separated.',
            n_predict: 96,
            temperature: 0,
            cache_prompt: false,
          }),
        });
        const j = res.ok ? await res.json() : null;
        const t = j?.timings ?? null;
        say(
          t === null
            ? 'speed: unavailable (no timings from /completion)'
            : `speed: ${Number(t.predicted_per_second ?? 0).toFixed(1)} tok/s generated, ` +
                `${Number(t.prompt_per_second ?? 0).toFixed(0)} tok/s prompt ` +
                `(${t.predicted_n ?? '?'} tokens in ${Math.round(t.predicted_ms ?? 0)}ms)`,
        );
      } catch (err) {
        say(`speed: unavailable (${String(err).slice(0, 90)})`);
      }
    }

    if (o.verify !== undefined) {
      try {
        const evidence = await o.verify(dbg, last, { home: HOME });
        if (invalid !== null) evidence.verdict = 'invalid';
        say(`VERIFY: ${JSON.stringify(evidence)}`);
      } catch (err) {
        say(`verify failed: ${String(err).slice(0, 140)}`);
      }
    }
    /*
     * DID THE RUN TAKE THE USER'S SCREEN? Say so, rather than leaving it to be
     * noticed. the user, watching one: "it took focus again, that whole issue
     * should be solved by now" — and I could not answer him, because the only
     * thing recorded was who was in front at the END, which is the same line
     * whether the run stole focus or simply found the app already there.
     */
    /* Best-effort: this is the run's own report card, and a window that has
       already gone (the app quit, the machine slept) must not turn a finished
       run into a failed one. MEASURED: a completed recall run — verdict printed,
       speed printed — exited 1 here because the page had closed. */
    let focusAfter = null;
    try {
      focusAfter = (await dbg('frontmost')).app;
    } catch {
      /* fall through to the unknown case below */
    }
    /*
     * THE QUESTION IS WHETHER THE RUN TOOK THE SCREEN, not whether the frontmost
     * app is the same one as before.
     *
     * MEASURED: a Blender run reported `FOCUS MOVED: "loginwindow" -> "Safari"`
     * while the same line said `Blender was frontmost 0` of 601 samples. The
     * machine had been LOCKED when the run began and the user unlocked it partway
     * through — so the guard was comparing "nobody, the screen is locked" with
     * "the user's own browser" and calling that a theft. The run never came
     * near the screen.
     *
     * `stole` is the authoritative signal and was already being counted: did the
     * controlled app EVER become frontmost. It cannot be confused by the user
     * doing their own thing, which is the entire point of a guard that runs while
     * somebody is using their computer. The before/after pair is kept as context
     * because it is genuinely useful when the answer is yes.
     */
    /*
     * …AND IT ONLY COUNTS IF IT WASN'T ALREADY THERE.
     *
     * My first cut at this said "the controlled app was ever frontmost", which
     * immediately mis-reported the Chrome demo: it ATTACHES to the browser the
     * user already has in front, so Chrome is frontmost 599/599 samples and none
     * of them are a theft. Taking the screen means BECOMING frontmost when you
     * were not — that is the thing the user would notice.
     */
    const alreadyThere = new RegExp(o.app, 'i').test(String(focusBefore ?? ''));
    const tookScreen = stole.length > 0 && !alreadyThere;
    say(
      tookScreen
        ? `FOCUS MOVED: ${o.app} was frontmost ${stole.length}/${frontSamples.length} samples ` +
            `— the run took the user's screen ("${focusBefore}" -> "${focusAfter ?? '?'}").`
        : alreadyThere
          ? `FOCUS HELD: ${o.app} was already in front before the run (attached), and the run ` +
            'did not move it.'
          : focusAfter === null
            ? `FOCUS HELD: ${o.app} was never frontmost (the app was gone before the final read).`
            : focusBefore === focusAfter
              ? `FOCUS HELD: "${focusAfter}" was in front before the run and still is.`
              : `FOCUS HELD: ${o.app} was never frontmost; the user moved from ` +
                `"${focusBefore}" to "${focusAfter}" themselves.`,
    );
    await sleep(1200);
  } finally {
    shooting = false;
    await screencastStop?.().catch(() => {});
    /* Wait for the camera itself, not for a guess at its period: a screenshot in
       flight when the app closes writes a truncated frame that ffmpeg then trips
       over, and at 30/s there is almost always one in flight. */
    await camera.catch(() => {});
    await browser?.close().catch(() => {});
    /*
     * QUIT FIRST, THEN CLOSE THE HANDLE. The order here was the other way round
     * and it orphaned a llama-server on every single run.
     *
     * Playwright's `electronApp.close()` terminates Electron abruptly, so the
     * quit-hold never opens — and the quit-hold is where main.ts runs
     * `reapChildProcesses()` (its `extraTeardown`), which is the only thing that
     * stops the inference utilityProcess and its llama-server GRANDCHILD. Kill
     * the app first and that grandchild is reparented to launchd and lives
     * forever.
     *
     * MEASURED: `llama-server … Qwen3.5-4B-Q8_0.gguf`, ppid=1, still resident
     * 17 minutes after its run ended, from a demo two runs earlier. The next
     * runs then booted into `[pi-power] gentle: memory is tight`, and on the 9B
     * pi itself died at startup — "this session has NO TOOLS" — so the model
     * never emitted a token and the matrix recorded `verdict: fail` as though it
     * had tried. One orphan, four symptoms, all of them ours.
     *
     * So: AppleScript quit, WAIT for the process to actually go (that is the
     * reap happening), and keep `close()` only as the fallback for an app that
     * would not quit.
     */
    await osa('tell application "Bobble" to quit');
    await waitForBobbleToExit();
    await electronApp?.close().catch(() => {});
    if (o.attach !== true) await quitTarget(o.app);
    await reapOrphanServers('after');
  }

  const dir = path.join(OUT, 'frames');
  const frames = readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => ({
      file: path.join(dir, f),
      t: Number(f.split('-')[2]?.replace('.jpg', '') ?? 0),
    }));
  if (frames.length === 0) throw new Error('no frames were captured');
  /* What the camera ACHIEVED, not what it was asked for — a target FPS that the
     screenshot cost cannot meet would otherwise be reported as if it had. */
  const span = (frames[frames.length - 1].t - frames[0].t) / 1000;
  const achieved = span > 0 ? frames.length / span : 0;
  const lines = [];
  for (let i = 0; i < frames.length; i += 1) {
    const next = frames[i + 1]?.t ?? frames[i].t + 1000 / FPS;
    lines.push(
      `file '${frames[i].file}'`,
      /*
       * REAL TIME, WHATEVER THE CAPTURE RATE.
       *
       * The floor used to be 0.03s, which is invisible at 25/s and ruinous at
       * 70: the screencast pushes a frame every ~14ms, each one was then held
       * for 30ms, and MEASURED the video ran 2.28x slow — 376 seconds of run
       * stretched into 856 seconds of video. the user, watching one: "a prefill
       * timer ticking up in very much slower than real time so over a minute or
       * so it reports 14 seconds". That was this.
       *
       * The floor now only guards against a zero-length frame; the cap still
       * compresses dead air.
       */
      `duration ${Math.min(3, Math.max(0.004, (next - frames[i].t) / 1000)).toFixed(3)}`,
    );
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = path.join(OUT, 'frames.txt');
  writeFileSync(list, lines.join('\n'));
  const video = path.join(OUT, `${o.name}.mp4`);
  /*
   * ONE SIZE FOR THE WHOLE CONCAT.
   *
   * The window is resized by a pixel here and there over a long run, so the
   * frames are not all identical even from one camera — MEASURED 1440x868 and
   * 1440x867 in the same run, plus 1600x963 from the screencast before its caps
   * came off. ffmpeg handles that by reconfiguring its filter graph and saying
   * so, once per frame, and MEASURED that killed a finished run outright:
   * execFile's 1MB stderr buffer overflowed and threw
   * ERR_CHILD_PROCESS_STDIO_MAXBUFFER after every frame had been captured.
   *
   * So: pin the output to the first frame's size, and make ffmpeg quiet and
   * unable to overflow anything regardless.
   */
  const first = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    frames[0].file,
  ]).then(
    (r) => r.stdout.trim().split(',').map(Number),
    () => [1440, 868],
  );
  const evenW = Math.max(2, Math.floor((first[0] ?? 1440) / 2) * 2);
  const evenH = Math.max(2, Math.floor((first[1] ?? 868) / 2) * 2);
  await run(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `scale=${evenW}:${evenH},fps=30`,
      /* CFR, explicitly. MEASURED: the frames go in at 66/s and the video comes
         out the right LENGTH (321.8s captured, 323.7s of video), but ffmpeg's
         default frame-rate mode drops the slots where nothing changed, so the
         file reports 7,977 frames over 323.7s — 24.6/s — and reads as under
         the user's "video at 30+" even though every moving second of it was 30.
         Nothing is added by leaving that ambiguous. */
      '-fps_mode',
      'cfr',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      video,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(path.join(OUT, 'run-log.txt'), log.join('\n'));
  /*
   * THE VIDEO IS THE DELIVERABLE. THE FRAMES WERE THE MEANS.
   *
   * Every run left its raw JPEGs behind: 781 MB of frames beside a 2.4 MB MP4
   * for a two-minute run, and 16-18 GB for each of the two runs that stalled.
   * MEASURED: 183 GB of `frames/` across the demos directory, 2.6 GB free on
   * the user's disk, and a 15 GB model download dying with "No space left on
   * device". The frames exist to be encoded; once the MP4 is on disk they are
   * kept only when someone asks to keep them (KEEP_FRAMES=1), for the case of
   * reading individual frames off a run.
   */
  if (process.env.KEEP_FRAMES !== '1' && existsSync(video)) {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${frames.length} frames, captured at ${achieved.toFixed(1)}/s → ${video}`);
  return { video, log };
}
