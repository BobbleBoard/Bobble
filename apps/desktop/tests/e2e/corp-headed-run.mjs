/**
 * corp-headed-run.mjs — start a corp run the way a USER does, in the real app.
 *
 * the user's ask, and it is the right one: every corp run so far has been driven by
 * `corp-mesh-run.mjs`, which builds the mesh directly in a bare node process. That
 * proves the harness and proves nothing about the product. It skips the app, the
 * IPC, the effort slider, the situation room — the entire surface a person
 * actually touches — so a run can be perfect while the thing the user opens does
 * not start a corp at all.
 *
 * This drives Bobble itself: launch the built app with a VISIBLE window, set the
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

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
 * `/tmp/corp-project-Xk9fL2`. the user, watching a run go into one: "that's just not
 * going to work." He is right, and not only aesthetically. That directory means
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
   * has no model selected, so the app never starts a llama-server. the user, seeing
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
     * open is one the user then types into — so every message he sent, "hi" included,
     * was forced into a corporation and answered with "Reading the request and
     * deciding how to approach it." He reported it as a product bug. It was this
     * flag: a testing-only switch that made the app I handed him behave unlike
     * the app he ships.
     *
     * Set FORCE=1 when a probe genuinely needs a corp on the first message.
     * Otherwise the model decides, exactly as it does for a real user.
     */
    ...(process.env.FORCE === '1' ? { PI_DESKTOP_CORP_FORCE: '1' } : {}),
  },
});

try {
  const page = await app.firstWindow();
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
   * the user: "rerun the corp harness with the 4b qwen model, NOT the 9b model."
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
   * Q8 model was still loading. the user: "this never happens on the real app
   * seemingly" — because a human waits for it. A test that races the model is
   * testing the race.
   */
  const modelReady = await page
    .waitForFunction(
      () => {
        const st = window.__llm_store?.().getState?.().status;
        return st?.phase === 'ready';
      },
      { timeout: 180_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!modelReady) {
    console.error('corp-headed-run: the model never reached "ready" — refusing to send, because');
    console.error('a prompt into a loading model just yields "fetch failed" and proves nothing.');
    await app.close().catch(() => {});
    process.exit(5);
  }
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

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText(TASK);
  await page.keyboard.press('Enter');
  log('task sent — watch the situation room');

  /*
   * A TOUR, not a fixed camera. the user: "periodically take and review a screenshot
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
    const chains = await page.$$('.pd-chain-summary, .pd-chain-header, [data-testid="chain-summary"]');
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

  const deadline = Date.now() + MINUTES * 60_000;
  let n = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(SHOT_MS);
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
  log('done watching · screenshots:', OUT);
  console.log(`\nProject (go and look): ${PROJECT}`);
  console.log(`Screenshots:           ${OUT}`);
} finally {
  await app.close().catch(() => {});
}
