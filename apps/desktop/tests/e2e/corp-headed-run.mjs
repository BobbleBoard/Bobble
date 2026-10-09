/**
 * corp-headed-run.mjs — start a corp run the way a USER does, in the real app.
 *
 * The user's ask, and it is the right one: every corp run so far has been driven by
 * `corp-mesh-run.mjs`, which builds the mesh directly in a bare node process. That
 * proves the harness and proves nothing about the product. It skips the app, the
 * IPC, the effort slider, the situation room — the entire surface a person
 * actually touches — so a run can be perfect while the thing the user opens does
 * not start a corp at all.
 *
 * This drives Bobble itself: launch the built app (INVISIBLE by default — see
 * the env block; `PI_E2E_VISIBLE=1` to watch), set the
 * effort the corporation is gated behind, point the chat at a project directory,
 * type the task into the real composer and press Enter. Then it stays out of the
 * way, screenshotting on a timer, so the situation room can be watched live —
 * agents appearing, contracts moving, the roadmap filling in — exactly as a user
 * would watch it.
 *
 *   TASK       what to ask for                  (required, or --task)
 *   PROJECT    the chat's working directory     (default: a fresh /tmp project)
 *   EFFORT     low | medium | high | max        (default: max — the corp is gated
 *              behind the top two levels; below that a single solo agent runs)
 *   MINUTES    how long to watch                (default: 45)
 *   SHOT_MS    ms between screenshots           (default: 60000)
 *   OUT        where screenshots + dumps go     (default .corp-runs/corp-headed)
 *
 * Exit code 0 means the run was DRIVEN, never that the product is good — the
 * verification is the hierarchy, and ultimately a human looking at the artifacts.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

/*
 * DO NOT LEAVE A LOADED MODEL BEHIND.
 *
 * Closing the app from Playwright does not reliably reap the llama-server
 * grandchild — MEASURED 2026-08-16, a bail-out here left a 4B server reparented
 * to init holding 6.6GB. The app reaps orphans when it LAUNCHES
 * (electron/inference/reap-orphans.ts, which owns the real rule and is
 * unit-tested); nothing covers the gap between this script exiting and the next
 * launch, and that gap is exactly when the next benchmark runs and silently
 * measures a machine with a ghost on it. That is not hypothetical: an orphaned
 * 27B took this machine to 10% free and the next probe died with "Compute
 * error", which reads as a model bug and is not one.
 *
 * Narrow on purpose — llama-server only, our cache root only, ppid 1 only. A
 * server owned by a LIVE app always has a live parent, so a running Bobble is
 * never touched. Registered on `exit` so every path (success, bail, throw) is
 * covered rather than just the one someone remembered.
 */
function reapOrphanedServers() {
  const root = path.join(os.homedir(), '.cache/bobble/llamacpp');
  try {
    const rows = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf8' });
    const pids = rows
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((m) => m !== null && m[2] === '1')
      .filter((m) => m[3].includes('llama-server') && m[3].includes(root))
      .map((m) => Number(m[1]));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        console.error(`corp-headed-run: reaped orphaned llama-server ${pid}`);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* tidying up must never be the reason a run fails */
  }
}
process.on('exit', reapOrphanedServers);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const TASK = process.env.TASK ?? arg('task', '');
/** Words that say nothing about what is being built. */
const STOPWORDS = new Set([
  'build',
  'make',
  'create',
  'write',
  'real',
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'into',
  'from',
  'like',
  'any',
  'all',
  'can',
  'has',
  'have',
  'them',
  'they',
  'you',
  'your',
  'able',
  'must',
  'need',
  'want',
  'please',
  'app',
  'application',
]);
const EFFORT = process.env.EFFORT ?? arg('effort', 'max');
const MINUTES = Number(process.env.MINUTES ?? arg('minutes', '45'));
const SHOT_MS = Number(process.env.SHOT_MS ?? 60_000);
/** Pin a catalog model id for the run (empty = whatever the profile has). */
const MODEL = process.env.MODEL ?? arg('model', '');
const OUT = process.env.OUT ?? path.join(repoRoot, '.corp-runs', 'corp-headed');
/*
 * A REAL, NAMED FOLDER — never a temp path with a random suffix.
 *
 * The default used to be `mkdtemp('/tmp/corp-project-')`, which produces
 * `/tmp/corp-project-Xk9fL2`. The user, watching a run go into one: "that's just not
 * going to work." The user is right, and not only aesthetically. That directory means
 * nothing to the person who has to open it afterwards, it is swept away by the
 * OS, and the TEAM is keyed to its path — so a project whose folder is a random
 * string is a team that can never be returned to, which is the one thing the
 * hierarchy exists to provide.
 */
const requested = process.env.PROJECT ?? arg('project', '');
const PROJECT = path.resolve(requested !== '' ? requested : defaultProjectDir());

function defaultProjectDir() {
  const slug =
    TASK.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .slice(0, 3)
      .join('-') || 'corp-project';
  return path.join(process.env.HOME ?? '/tmp', 'Desktop', slug);
}

if (TASK.trim() === '') {
  console.error('corp-headed-run: set TASK="..." (or --task "...")');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(PROJECT, { recursive: true });

if (
  !existsSync(path.join(appRoot, 'dist/index.html')) ||
  !existsSync(path.join(appRoot, 'dist-electron/main.js'))
) {
  console.error('corp-headed-run: app is not built — run `npm run build` in apps/desktop first');
  process.exit(2);
}

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const log = (...a) => console.error(`[${since()}] ${a.join(' ')}`);

// A dedicated profile, so this never disturbs the real app's state — but NOT a
// throwaway one: the hierarchy lives in userData, and the whole point of a team
// is that it is still there next time.
const userDataDir = path.join(repoRoot, '.corp-runs', 'corp-headed-profile');
mkdirSync(userDataDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronBinary,
  /*
   * THE REAL PROFILE, by default.
   *
   * This used to always launch with its own `--user-data-dir`, which sounds tidy
   * and is why every headed run I did answered "fetch failed": a fresh profile
   * has no model selected, so the app never starts a llama-server. The user, seeing
   * it: "on your test build you're getting fetch failed … this never happens on
   * the real app seemingly, make sure this doesn't happen for you."
   *
   * A test that cannot reproduce the user's setup is not a test of the product.
   * So the default is now the SAME profile the installed app uses — same model,
   * same server, same everything. ISOLATED_PROFILE=1 restores the sandbox for a
   * probe that genuinely must not touch real state.
   */
  args:
    process.env.ISOLATED_PROFILE === '1' ? [appRoot, `--user-data-dir=${userDataDir}`] : [appRoot],
  // PI_E2E exposes the store for observation. There is no mock here: this is the
  // real local model, because a corp run against a fixture proves nothing.
  env: {
    ...process.env,
    PI_E2E: '1',
    PI_DESKTOP_CORP: '1',
    /*
     * FORCE IS OPT-IN NOW. It used to default ON, and the app this probe leaves
     * open is one the user then types into — so every message the user sent, "hi" included,
     * was forced into a corporation and answered with "Reading the request and
     * deciding how to approach it." The user reported it as a product bug. It was this
     * flag: a testing-only switch that made the app I handed them behave unlike
     * the app the user ships.
     *
     * Set FORCE=1 when a probe genuinely needs a corp on the first message.
     * Otherwise the model decides, exactly as it does for a real user.
     */
    ...(process.env.FORCE === '1' ? { PI_DESKTOP_CORP_FORCE: '1' } : {}),
    /*
     * INVISIBLE BY DEFAULT, like every other probe.
     *
     * This one was written to be WATCHED — that is what "headed" meant — and
     * the standing rule is that a run never takes the user's screen: they are
     * usually at the machine, and a corp run is hours long. `PI_E2E_VISIBLE=1`
     * is the one way to watch it, and it flows through `...process.env` above,
     * so the intent of this file is preserved and its default is no longer to
     * seize the display for the rest of the afternoon.
     */
    ...(process.env.PI_E2E_VISIBLE === '1' ? {} : { PI_E2E_BACKGROUND: '1' }),
  },
});

try {
  let page = await app.firstWindow();
  await page.waitForFunction(
    () => typeof window.__pi_store === 'function' && typeof window.__pi_project === 'function',
    { timeout: 30_000 },
  );
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  log('app up · project:', PROJECT);

  /*
   * EFFORT FIRST, AND VERIFIED. The corporation is gated behind the top levels;
   * below them the same prompt runs as ONE solo agent with no hierarchy at all.
   * The first version of this set it through a store call wrapped in a try/catch,
   * which silently did nothing — and the run that followed was a lone agent
   * flailing in a directory that did not exist, with `Effort · Low` sitting in the
   * corner of the screenshot. Set it through the real IPC, then READ IT BACK.
   */
  /*
   * THROUGH THE RENDERER'S STORE, AND CONFIRMED ON SCREEN.
   *
   * The previous version called the `settings:set` IPC and believed the value
   * main handed back. Main is not who decides: the RENDERER stamps `effort` on
   * the corp request, and `settings:set` does not push into its store. So the
   * probe reported "effort: max", the request went out at whatever the renderer
   * still held, and two runs I told the user were the corporation were a single solo
   * agent — with `Effort · Low` sitting in the corner of the screenshot the whole
   * time. This is the SAME mistake the project chip had, in the same file, fixed
   * the same way: drive the store a user drives, then read the screen.
   */
  const effortNow = await page.evaluate(async (level) => {
    const store = window.__settings_store?.();
    if (store === undefined) return 'no-store';
    await store.getState().update({ effort: level, effortMode: 'level' });
    return store.getState().settings.effort;
  }, EFFORT);
  await page.waitForTimeout(1500);
  const effortChip =
    (await page.textContent('[data-testid="composer-effort"]').catch(() => null)) ??
    (await page.evaluate(() => {
      const el = [...document.querySelectorAll('button, span')].find((n) =>
        /Effort\s*·/.test(n.textContent ?? ''),
      );
      return el?.textContent ?? '';
    }));
  const wantLabel = { low: 'Low', medium: 'Balanced', high: 'High', max: 'Max' }[EFFORT] ?? EFFORT;
  if (effortNow !== EFFORT || !new RegExp(wantLabel, 'i').test(effortChip ?? '')) {
    console.error(`corp-headed-run: effort is "${effortNow}" and the chip reads`);
    console.error(`"${(effortChip ?? '').trim()}" — wanted "${EFFORT}" / "${wantLabel}".`);
    console.error('Refusing to start: below the top levels there is no corporation to observe,');
    console.error('and a run reported as the corp that was a solo agent is worse than no run.');
    await app.close().catch(() => {});
    process.exit(3);
  }
  log('effort:', effortNow, '· chip:', (effortChip ?? '').trim());
  /*
   * AND SET IT IN SETTINGS. The chip is the UI's view; `settings.effort` is what
   * reaches the harness and what `corpToolEnabled` reads when it decides whether
   * `talk_to_manager` enters the active tool set. Reading the chip and calling
   * that "effort: max" is the same mistake as reading the folder chip and
   * calling that the working directory.
   */
  await page
    .evaluate(async (level) => {
      await window.piDesktop.invoke('settings:set', { patch: { effort: level } });
    }, EFFORT)
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  /*
   * THE PROJECT — set it, then CONFIRM IT ON SCREEN.
   *
   * The previous attempt called `project:set` and believed the value it got
   * back. The app kept the project from the last session, the run went to that
   * old folder, and I reported it as landing in the new one. The composer's
   * folder chip is the same thing a user reads, so read that: if it does not say
   * this project, nothing downstream is trustworthy.
   */
  await page.evaluate(async (dir) => {
    // Through the STORE, not the IPC. Calling `project:set` directly switches the
    // project in the main process and leaves the renderer none the wiser — and the
    // renderer's store is what corp-connect reads when it starts a run, so the
    // work went to the previous session's folder while the log said otherwise.
    await window.__pi_project?.().getState().selectPath(dir);
  }, PROJECT);
  await page.waitForTimeout(2500);
  const chip = (await page.textContent('.pd-project-chip').catch(() => null)) ?? '';
  const want = path.basename(PROJECT);
  if (process.env.NO_PROJECT === '1') {
    log('project check skipped (NO_PROJECT=1)');
  } else if (!chip.includes(want)) {
    console.error(`corp-headed-run: the folder chip reads "${chip.trim()}", not "${want}".`);
    console.error('Refusing to start — the run would go somewhere other than the project you');
    console.error('asked for, and the team is keyed to that path.');
    await app.close().catch(() => {});
    process.exit(4);
  }
  log('project confirmed on screen:', chip.trim());

  /*
   * PIN THE MODEL when asked.
   *
   * The user: "rerun the corp harness with the 4b qwen model, NOT the 9b model."
   * With Qwen3.5-9B now the `balanced` tier pick, a run that inherits whatever
   * the profile last used could silently be a 9B run — and a trace attributing
   * 4B behaviour to a 9B is worse than no trace. `mode: 'model'` also disables
   * the auto-router, so the tier cannot drift mid-run.
   */
  if (MODEL !== '') {
    // settings:set takes a PATCH and merges it — passing a whole document (my
    // first attempt) threw "Cannot read properties of undefined (reading
    // 'theme')" from inside the merge.
    await page.evaluate(async (modelId) => {
      await window.piDesktop.invoke('settings:set', {
        patch: { modelSelection: { mode: 'model', modelId } },
      });
      /*
       * AND SWITCH THE RUNNING SERVER. modelSelection is the user's DEFAULT,
       * "re-applied on each fresh pi session" — it does not retarget a server
       * that is already up. MEASURED: the pin was accepted and the previous
       * model stayed loaded, which the assertion below caught. Setting the
       * preference and starting the server are two different things and the
       * probe has to do both.
       */
      await window.piDesktop.invoke('llm:start-server', { modelId, launchMode: 'fast-text' });
    }, MODEL);
    await page.waitForTimeout(5000);
    log('model pinned:', MODEL);
  }

  /*
   * WAIT FOR THE MODEL. Every headed run I did answered "fetch failed", and the
   * reason was mine: the probe typed the moment the window appeared, while a 4B
   * Q8 model was still loading. The user: "this never happens on the real app
   * seemingly" — because a human waits for it. A test that races the model is
   * testing the race.
   */
  /*
   * ASK THE APP, NOT A TEST-ONLY HOOK.
   *
   * This used to read `window.__llm_store?.().getState?.().status`, and it could
   * never once have returned true. `__llm_store` is installed ONLY when the app
   * is loaded with `?piE2E=1` (state/llm-store.ts), and this launcher
   * deliberately does not use that flag — the whole point is to drive the app as
   * a user does. So `window.__llm_store?.()` was always undefined, `.getState?.()`
   * on undefined THREW, the throw landed in `.catch(() => false)`, and every run
   * bailed with "the model never reached ready" in a couple of seconds — the
   * 180s budget never even started. MEASURED 2026-08-16: the 4B was in fact fine,
   * loaded and resident at 6.6GB, while the launcher declared it never ready.
   *
   * A gate that reads a hook the app does not install is not a gate, it is an
   * unconditional refusal. `llm:get-status` is the real IPC the UI itself renders
   * from, it is on the always-present preload bridge, and it needs no test flag.
   */
  const readyDeadline = Date.now() + 180_000;
  let modelReady = false;
  let lastPhase = 'unknown';
  let lastError;
  /*
   * A SINGLE `error` READING IS NOT A DEAD MODEL.
   *
   * This used to `break` on the first one, and MEASURED that killed three runs
   * in a row: pinning the model writes settings, the settings write restarts
   * the server, and a poll landing in that window reads `error` for a second or
   * two before `starting` and then `ready`. The exact same profile, model and
   * env reached ready in 3s when nothing bailed early.
   *
   * The 180s budget was already allocated for exactly this. So an error is
   * remembered, not obeyed — it only ends the wait if it is still the answer
   * several reads later, which is what a genuinely failed load looks like.
   */
  let errorStreak = 0;
  const ERROR_STREAK_LIMIT = 8; // ~16s of nothing but `error`
  while (Date.now() < readyDeadline) {
    const st = await page
      .evaluate(() => window.piDesktop.invoke('llm:get-status', undefined))
      .catch(() => null);
    if (st !== null && st !== undefined) {
      lastPhase = String(st.phase);
      if (st.phase === 'ready') {
        modelReady = true;
        break;
      }
      if (st.phase === 'error') {
        errorStreak += 1;
        lastError = st.error ?? st.lastError;
        if (errorStreak >= ERROR_STREAK_LIMIT) break;
      } else {
        errorStreak = 0;
      }
    }
    await page.waitForTimeout(2000);
  }
  if (!modelReady) {
    console.error(`corp-headed-run: the model never reached "ready" (phase: ${lastPhase}) —`);
    if (lastError !== undefined) console.error(`  the engine said: ${lastError}`);
    console.error('refusing to send, because a prompt into a loading model just yields');
    console.error('"fetch failed" and proves nothing.');
    await app.close().catch(() => {});
    process.exit(5);
  }
  log('model ready');
  /*
   * RE-PUSH THE EFFORT, NOW THAT PI IS THE ONE THAT WILL ANSWER.
   *
   * MEASURED: the harness held `effort=medium` while the renderer, the store and
   * the chip all said max — so `corpToolEnabled` was false and `talk_to_manager`
   * never entered the advertised set. The push at the top of this run goes out
   * before the model is ready; selecting/loading a model respawns pi, and the
   * fresh child does not carry it. The effort that matters is the one the child
   * answering the prompt holds.
   */
  await page
    .evaluate(async (level) => {
      const store = window.__settings_store?.();
      if (store === undefined) return;
      await store.getState().update({ effort: level, effortMode: 'level' });
    }, EFFORT)
    .catch(() => undefined);
  await page.waitForTimeout(2000);

  /* Say WHICH model came up. The pin above is an instruction; this is the
     observation, and a trace is only attributable if they agree. */
  const loaded = await page
    .evaluate(() => {
      const st = window.__llm_store?.().getState?.().status;
      return st?.model ? `${st.model.id} ${st.model.quant}` : null;
    })
    .catch(() => null);
  log('model ready:', loaded ?? '(unreported)');
  /*
   * AND ASSERT THE HARNESS ACTUALLY HAS THE EFFORT. The chip is the UI's view;
   * `corpToolEnabled` reads the effort the pi CHILD holds, and those came apart:
   * a run reported "effort: max · chip: Effort · Max" while the harness held
   * medium, so `talk_to_manager` was never advertised and the CEO built a whole
   * product alone because it had no other option. Set PI_ADV_DEBUG_TOOLS to see
   * the gate's own verdict per request.
   */
  if (MODEL !== '' && loaded !== null && !String(loaded).includes(MODEL)) {
    console.error(`corp-headed-run: asked for "${MODEL}" but "${loaded}" is loaded. Refusing:`);
    console.error('a run traced against the wrong model is worse than no run.');
    await app.close().catch(() => {});
    process.exit(6);
  }

  /*
   * "READY" IS NOT "ANSWERING", AND ON A BIG MODEL THE GAP IS WHOLE SECONDS.
   *
   * MEASURED, run 16 (Qwen3.8-27B, 13.4 GB): the supervisor reported `model
   * ready` at t+25s, this typed the prompt immediately, and pi's first four
   * requests all came back `fetch failed`. The CEO gave up and sat idle for the
   * rest of the run — five messages, zero tool calls, zero files. The server was
   * fine; by the time anyone looked, `/health` answered `{"status":"ok"}` on the
   * port models.json named. The race is between the health flip and pi actually
   * holding a usable connection, and it never showed on a 641 MB 4B because the
   * window is too small to hit.
   *
   * So: ask the server the question the run is about to ask it — one token
   * through the real endpoint, at the URL pi was given — and only type when that
   * comes back. Reading models.json is the point: it verifies the address pi
   * will use, not one this script picked.
   */
  const served = await (async () => {
    const modelsJson = path.join(process.env.HOME ?? '', '.pi/agent/models.json');
    const deadline = Date.now() + 180_000;
    let lastErr = 'never resolved a baseUrl';
    while (Date.now() < deadline) {
      try {
        const doc = JSON.parse(readFileSync(modelsJson, 'utf8'));
        const base = doc?.providers?.llamacpp?.baseUrl;
        if (typeof base === 'string' && base !== '') {
          const res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'hi' }],
              max_tokens: 1,
              stream: false,
            }),
          });
          if (res.ok) return base;
          lastErr = `HTTP ${res.status}`;
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await page.waitForTimeout(2000);
    }
    log(`WARNING: the server never answered a test completion (${lastErr}) — sending anyway`);
    return null;
  })();
  if (served !== null) log('server answered a real completion:', served);

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(TASK);
  await page.keyboard.press('Enter');
  log('task sent — watch the situation room');

  /*
   * A TOUR, not a fixed camera. The user: "periodically take and review a screenshot
   * and do some automation to click around, maybe on a tool call, screenshot
   * again, then click a different subagent/engineer chat, screenshot again… that'll
   * give you ability to build a good UI/UX checklist issue list as well as read
   * thoughts and such and see what's actually failing in more real time and
   * concretely than your logs provide."
   *
   * One camera pointed at the situation room shows a tidy list of rows. The
   * failures live one click in — inside a collapsed tool call, or in an
   * engineer's own chat — which is exactly where a log never looks. Each round
   * walks a DIFFERENT subagent so the set covers the team rather than the first
   * name in the list.
   */
  const tour = async (round) => {
    const tag = String(round).padStart(2, '0');
    const shoot = async (name) =>
      page.screenshot({ path: path.join(OUT, `r${tag}-${name}.png`) }).catch(() => {});
    await shoot('a-overview');

    // Expand a collapsed tool call — the row whose contents the logs cannot show.
    const chains = await page.$$(
      '.pd-chain-summary, .pd-chain-header, [data-testid="chain-summary"]',
    );
    const chain = chains[Math.min(round, chains.length - 1)] ?? chains[0];
    if (chain !== undefined) {
      await chain.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(900);
      await shoot('b-toolcall');
    }

    // A DIFFERENT role each round, so the set spans the team.
    const rows = await page.$$('[data-testid^="child-row-"]');
    if (rows.length > 0) {
      const row = rows[round % rows.length];
      await row?.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1600);
      await shoot('c-role-chat');
      // Scroll its transcript so the shot is the LIVE tail, not the opening brief.
      await page.mouse.wheel(0, 4000).catch(() => {});
      await page.waitForTimeout(600);
      await shoot('d-role-tail');
    }
  };

  /*
   * WHY THE RENDERER DIED, captured at the moment it dies.
   *
   * Run 4 ended at t+2 with Playwright's bare `Page crashed` and nothing else —
   * no .ips report, no stack, no numbers. A repeat would have been just as
   * opaque, so take the two measurements that are only available while the page
   * is alive: how much the renderer was holding, and how much was on screen. A
   * corp run's DOM grows with every worker-activity block, so the block count is
   * the first number worth having.
   */
  let crashNote = null;
  page.on('crash', () => {
    crashNote = 'renderer crashed (no further detail available after the fact)';
    log('RENDERER CRASHED');
  });
  page.on('console', (m) => {
    if (m.type() === 'error') log(`console.error: ${m.text().slice(0, 300)}`);
  });
  const vitals = async () => {
    try {
      return await page.evaluate(() => ({
        nodes: document.getElementsByTagName('*').length,
        msgs: document.querySelectorAll('.pd-msg').length,
        heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6),
      }));
    } catch {
      return null;
    }
  };

  /*
   * IS ANY SEAT ACTUALLY WORKING? Read from the corp store rather than the chat
   * transcript, because the two disagree exactly when it matters: a blocking
   * `talk_to_manager` pins the main thread at two messages for the whole run
   * while the team builds. `working` (and `waiting`, which is a seat queued
   * behind the single llama-server slot) both count as alive.
   */
  const corpBusy = async () => {
    try {
      return await page.evaluate(() => {
        const nodes = window.__corpStore?.getState().situation?.chart.nodes ?? [];
        return nodes.some((node) => node.state === 'working' || node.state === 'waiting');
      });
    } catch {
      /* Can't tell → assume alive. A stall report has to be earned. */
      return true;
    }
  };

  const deadline = Date.now() + MINUTES * 60_000;
  /** Consecutive ticks with a frozen transcript, nothing streaming, no seat busy. */
  const STALL_MIN = Number(process.env.STALL_MIN ?? 10);
  const STALL_TICKS = Math.max(3, Math.ceil((STALL_MIN * 60_000) / SHOT_MS));
  let idleTicks = 0;
  let lastCount = -1;
  let stalled = false;
  let n = 0;
  while (Date.now() < deadline) {
    /*
     * A CRASH MUST NOT KILL THE WATCHER BEFORE THE REASON IS PRINTED.
     *
     * The main process DOES log why a renderer died — `render-process-gone`
     * carries a reason and an exit code, and renderer-recovery logs both. It
     * has never appeared in a run log because `page.waitForTimeout` REJECTS the
     * instant the page goes, this script threw, and node exited before
     * Electron's own line was flushed to stdout. So every crash for months has
     * read "RENDERER CRASHED" and nothing else — the report existed and the
     * harness killed itself before reading it.
     *
     * Swallow the rejection, give the main process a moment to say why, and let
     * the loop's own crash check end the run in order.
     */
    try {
      await page.waitForTimeout(SHOT_MS);
    } catch (err) {
      log('watch interrupted:', err instanceof Error ? err.message : String(err));
      // Give the main process a beat to print WHY, then say it.
      await new Promise((r) => setTimeout(r, 3000));
      if (crashNote !== null) log(crashNote);
      /*
       * THE APP SURVIVES A RENDERER CRASH; THE WATCHER SHOULD TOO.
       *
       * renderer-recovery reloads the window (up to MAX_CONSECUTIVE_RECOVERIES),
       * so the corp run in the MAIN process is untouched — engineers keep
       * working. Only this script's `page` handle is dead. It used to exit
       * anyway, which is how a crash at 30 minutes ended a 5-hour run and threw
       * away everything the team was still doing.
       */
      const recovered = await app.firstWindow({ timeout: 30_000 }).catch(() => null);
      if (recovered === null) {
        log('renderer did not come back — stopping');
        break;
      }
      page = recovered;
      crashNote = null;
      /* The listeners were bound to the DEAD page; rebind or the next crash is
         silent and the console stops being mirrored. */
      page.on('crash', () => {
        crashNote = 'renderer crashed (no further detail available after the fact)';
        log('RENDERER CRASHED');
      });
      log('renderer recovered — re-attached, still watching');
      continue;
    }
    const v = await vitals();
    if (v !== null) log(`vitals · dom ${v.nodes} nodes · ${v.msgs} msgs · heap ${v.heap}MB`);
    if (crashNote !== null) {
      log(crashNote);
      break;
    }
    n += 1;
    const shot = path.join(OUT, `t${String(n).padStart(3, '0')}.png`);
    try {
      await page.screenshot({ path: shot });
      await tour(n);
    } catch {
      log('window went away — stopping');
      break;
    }
    const state = await page.evaluate(() => {
      const st = window.__pi_store?.().getState?.() ?? {};
      const msgs = st.messages ?? [];
      const last = msgs[msgs.length - 1];
      return {
        messages: msgs.length,
        streaming: msgs.some((m) => m.isStreaming === true),
        tail:
          last?.kind === 'assistant'
            ? (last.blocks ?? [])
                .map((b) => b.text ?? b.thinking ?? '')
                .join('')
                .slice(-160)
            : (last?.text ?? '').slice(-160),
      };
    });
    log(
      `t+${n} · ${state.messages} msgs · ${state.streaming ? 'working' : 'idle'} · ${state.tail}`,
    );
    writeFileSync(path.join(OUT, 'last-state.json'), JSON.stringify(state, null, 2));

    /*
     * A DEAD RUN IS NOT A QUIET RUN.
     *
     * MEASURED, run 14: the CEO's turn was aborted externally at 4m06s with a
     * healthy 20k context, and this loop went on logging `118 msgs · idle`
     * every 60 seconds for FOUR HOURS FIFTY-SIX MINUTES. Nothing was wrong with
     * the watcher — it reported exactly what it saw, once a minute, 290 times,
     * and never drew the obvious conclusion. I then read the five hours of
     * screenshots as five hours of work and wrote that into a commit message.
     *
     * A corp run is legitimately silent for long stretches — a blocking
     * `talk_to_manager` freezes the main thread at two messages while five
     * roles work, which is the signature of healthy delegation, not a stall.
     * So this cannot key on the main thread alone: it stalls only when the
     * transcript is FROZEN, nothing is streaming, and no corp node is running.
     */
    const quiet = state.messages === lastCount && !state.streaming && !(await corpBusy());
    lastCount = state.messages;
    idleTicks = quiet ? idleTicks + 1 : 0;
    if (idleTicks >= STALL_TICKS) {
      log(
        `STALLED — ${state.messages} messages, nothing streaming and no corp seat working ` +
          `for ${Math.round((STALL_TICKS * SHOT_MS) / 60_000)} minutes. The run is over; ` +
          `watching longer only produces identical screenshots. Stopping.`,
      );
      stalled = true;
      break;
    }
  }

  /*
   * A SUBAGENT'S OWN CHAT. The point of the display unification is that opening a
   * subagent gives you a chat like any other, so the run has to be observed that
   * way and not only as a room full of rows.
   */
  await page
    .evaluate(() => {
      const corp = window.__corpStore;
      const nodes = corp?.getState().situation?.chart.nodes ?? [];
      const worker = nodes.find((n) => n.parentId !== undefined);
      if (worker !== undefined) corp.getState().selectNode(worker);
    })
    .catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, 'subagent-chat.png') });

  /* The PLAN, read straight from the store — so "the panel is empty" can be told
     apart from "nothing was handed out", which are very different bugs. */
  const plan = await page
    .evaluate(() => {
      const st = window.__corpStore?.getState?.().situation;
      return {
        rows: (st?.checklist ?? []).map((c) => `${c.state} · ${c.group ?? ''} · ${c.label}`),
        nodes: st?.chart.nodes.length ?? 0,
      };
    })
    .catch(() => ({ rows: [], nodes: 0 }));
  log(`plan rows: ${plan.rows.length} of ${plan.nodes} nodes`);
  for (const r of plan.rows) log('  ·', r);

  await page.screenshot({ path: path.join(OUT, 'final.png') }).catch(() => {});
  /* Say WHY it ended. "done watching" reads the same whether the run finished
     or died in the first five minutes — which is how run 14 got written up as
     five hours of work. */
  log(
    stalled
      ? `done watching (STALLED — the run stopped producing anything and was not going to resume) · screenshots:`
      : 'done watching (watch window elapsed) · screenshots:',
    OUT,
  );
  console.log(`\nProject (go and look): ${PROJECT}`);
  console.log(`Screenshots:           ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
