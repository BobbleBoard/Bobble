/**
 * Screenshot probe for the CONNECTORS candidates — headless, throwaway home,
 * against the renderer-only dev server on :5312:
 *
 *   npx vite --config src/candidates/connectors/vite.candidates.config.mjs   # from apps/desktop
 *   node src/candidates/connectors/shots.mjs current        # the shipping screen
 *   node src/candidates/connectors/shots.mjs hub            # the model hub — the bar the candidates are held to
 *   node src/candidates/connectors/shots.mjs <candidate-id> # one candidate: 6 themes, details (and their
 *                                                           # ends), the category row mid-scroll and at its
 *                                                           # end, empty, 900 + 640 — and for shelf-plus the
 *                                                           # round-3 states (see shelfPlusStates)
 *   node src/candidates/connectors/shots.mjs fresh          # a fresh install: nothing added
 *   node src/candidates/connectors/shots.mjs reach-tools    # Reach's in-place expansion with a 40-tool server
 *   node src/candidates/connectors/shots.mjs all            # everything, in one run
 *
 * Images land in src/candidates/connectors/shots/. The fixture home carries a
 * registry with installed / disabled / custom servers and one installed skill,
 * plus a mocked /Applications scan (Blender, Xcode, Docker, Chrome), so every
 * state a candidate has to draw is actually on screen.
 *
 * THE SERVERS ARE REAL PROCESSES, AND THEY ANSWER. Round 2's images all showed
 * "Starting the server to list its tools…" because listing means spawning
 * `npx -y @github/github-mcp-server`, which in a fresh home downloads first
 * and without a token fails. The fixture home now puts `npx`, `uvx` and `node`
 * shims first on the app's PATH; each execs fixtures/mcp-fixture.mjs, which
 * speaks MCP over stdio and lists the real server's real tool names. So the
 * app's own `connectors:tools` handler spawns the REAL registry command line,
 * the Command row shows it, and the pane shows what the spinner resolves to.
 *
 * Every mode runs inside {@link withApp}, which closes the app in `finally`.
 * Round 2 found the cost of not doing that: a click timed out mid-run, the
 * retry launched a second Electron and finished the job, and the first one —
 * hidden, with a renderer — stayed alive for twelve minutes holding node open.
 *
 * THE CURSOR IS NEVER IN THE FRAME: a click leaves the pointer where it
 * landed, and one round-2 image carried the I-beam over the text. Every shot
 * parks the mouse in the switcher strip's dead corner first, unless it is a
 * hover shot and says so.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, probeHome } from '../../../tests/e2e/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../../..');
const SHOTS = path.join(HERE, 'shots');
const FIXTURE_SERVER = path.join(HERE, 'fixtures', 'mcp-fixture.mjs');
mkdirSync(SHOTS, { recursive: true });

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5312';
const CANDIDATES = ['shelf-plus', 'shelf', 'ledger', 'reach'];
const THEMES = [
  ['bobble', 'light'],
  ['bobble', 'dark'],
  ['claude', 'light'],
  ['claude', 'dark'],
  ['codex', 'light'],
  ['codex', 'dark'],
];

const mode = process.argv[2] ?? 'all';
const only = process.argv.includes('--only-bobble');

const GOOD_TOKEN = 'ghp_fixture_token_0000000000000000';

/**
 * A home with the states a candidate must render.
 *
 *   fresh        nothing added, no skill installed — what a new user sees first
 *   githubReady  GitHub already set up and on (a token in the registry), so
 *                its 40-tool list is one click away without the setup flow
 */
function fixtureHome(name, { fresh = false, githubReady = false } = {}) {
  const home = probeHome(name);
  const desktop = path.join(home, '.pi', 'desktop');
  mkdirSync(desktop, { recursive: true });
  const servers = fresh
    ? []
    : [
        {
          id: 'memory',
          name: 'Memory',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          enabled: true,
        },
        {
          id: 'filesystem',
          name: 'Filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', `${homedir()}/Projects`],
          enabled: true,
        },
        {
          id: 'github',
          name: 'GitHub',
          command: 'npx',
          args: ['-y', '@github/github-mcp-server'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubReady ? GOOD_TOKEN : '' },
          enabled: githubReady,
        },
        { id: 'blender', name: 'Blender', command: 'uvx', args: ['blender-mcp'], enabled: true },
        {
          id: 'weather',
          name: 'Weather',
          command: 'node',
          args: [`${homedir()}/tools/weather-mcp/index.js`],
          enabled: true,
        },
        // Added and switched OFF, never run: the ledger's "Off" group and the
        // tools section's "Turn it on to list its tools." — two states no
        // frame had shown through round 3 (judgement, §Tool list).
        {
          id: 'sequential-thinking',
          name: 'Sequential Thinking',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
          enabled: false,
        },
      ];
  writeFileSync(
    path.join(desktop, 'mcp-connectors.json'),
    JSON.stringify({ version: 1, mode: 'lite', servers }, null, 2),
  );
  // One installed skill, so the installed state is drawn.
  if (!fresh) {
    const skills = path.join(home, '.pi', 'agent', 'skills');
    mkdirSync(skills, { recursive: true });
    cpSync(
      path.join(APP_ROOT, 'resources', 'skills', 'code-review'),
      path.join(skills, 'code-review'),
      { recursive: true },
    );
  }
  // Mock /Applications: what "Recommended for you" is built from.
  const apps = path.join(home, 'apps-fixture');
  for (const a of ['Blender.app', 'Xcode.app', 'Docker.app', 'Google Chrome.app']) {
    mkdirSync(path.join(apps, a), { recursive: true });
  }
  return { home, apps, bin: writeShims(home) };
}

/**
 * `npx` / `uvx` / `node` that exec the fixture MCP server for the packages the
 * registry names. `node` passes everything else through to the real node, so
 * nothing but the custom Weather server's path is affected by it being first
 * on PATH. The real node is the one running this probe.
 */
function writeShims(home) {
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const node = process.execPath;
  const firstPackage = `pkg=""
for a in "$@"; do
  case "$a" in
    -*) ;;
    *) pkg="$a"; break ;;
  esac
done
exec "${node}" "${FIXTURE_SERVER}" "$pkg"
`;
  writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\n${firstPackage}`);
  writeFileSync(path.join(bin, 'uvx'), `#!/bin/sh\n${firstPackage}`);
  writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh
case "$1" in
  */weather-mcp/index.js) exec "${node}" "${FIXTURE_SERVER}" weather ;;
  *) exec "${node}" "$@" ;;
esac
`,
  );
  for (const f of ['npx', 'uvx', 'node']) chmodSync(path.join(bin, f), 0o755);
  return bin;
}

async function setTheme(page, flavor, modeName) {
  await page.evaluate(
    ([f, m]) => {
      document.documentElement.setAttribute('data-flavor', f);
      document.documentElement.setAttribute('data-mode', m);
    },
    [flavor, modeName],
  );
  await page.waitForTimeout(450);
}

/** PIDs of this process's direct children — the only processes this probe may ever signal. */
function childPids() {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Whatever this probe spawned and is still running after close is a leak.
 * MEASURED: Playwright's `app.process()` reported an exit while an Electron
 * with this node as its parent stayed alive (`ps` state Ss, 230 MB) — so the
 * process handle is not the process that persists, and the only honest check
 * is to ask the OS who our children are.
 */
async function reapChildren(name) {
  const alive = childPids();
  if (alive.length === 0) return;
  console.error(
    `${name}: ${alive.length} child process(es) outlived close (${alive.join(', ')}); terminating`,
  );
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  for (const pid of childPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Launch, run `body`, and ALWAYS close — a thrown step must not leave an app
 * behind. And CHECK that close closed: the harness's `finish()` swallows a
 * rejected `app.close()`, and on one pass all three candidates' Electrons
 * outlived it, hidden, 150–230 MB each, holding node open. Only processes
 * this probe started are ever signalled.
 */
async function withApp(name, extraEnv, waitFor, body, fixtureOpts = {}) {
  const { home, apps, bin } = fixtureHome(name, fixtureOpts);
  activeHome = home;
  const { app, page, finish } = await launchApp(name, {
    waitFor,
    timeout: 45_000,
    env: {
      HOME: home,
      VITE_DEV_SERVER_URL: DEV_URL,
      PI_CONNECTORS_APPS_DIR: apps,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  // Taken BEFORE close: a close that worked disposes `app`, and `app.process()`
  // on a disposed app throws — so a live handle is the only way to ask afterwards.
  const proc = app.process();
  try {
    await body(page);
  } finally {
    // `finish()` can also HANG (seen once on the hub: close never returned), so
    // it gets a deadline; past it, the process is terminated the same way.
    const closed = await Promise.race([
      finish().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!closed) console.error(`${name}: close did not return within 20s`);
    if (proc.exitCode === null && proc.signalCode === null) {
      console.error(`${name}: app did not quit on close; terminating pid ${proc.pid}`);
      proc.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }
    await reapChildren(name);
    activeHome = null;
  }
}

/** The fixture home of the app currently open under {@link withApp}. */
let activeHome = null;

/**
 * The probe's hand on the fixture servers between spawns (fixtures/mcp-fixture.mjs,
 * `control()`): `{ fail: [...] }` makes those packages exit before the handshake,
 * `{ delayMs }` holds every answer. `null` removes the file, so the next spawn
 * answers normally.
 */
function fixtureControl(obj) {
  if (activeHome === null) throw new Error('fixtureControl outside withApp');
  const file = path.join(activeHome, 'mcp-fixture-control.json');
  if (obj === null) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(obj));
}

/** The pointer's parking spot: the switcher strip's left padding, which nothing hovers. */
async function parkMouse(page) {
  await page.mouse.move(2, 2);
}

async function shotAs(page, file, { keepMouse = false, settle = 250 } = {}) {
  if (!keepMouse) await parkMouse(page);
  await page.waitForTimeout(settle);
  const buf = await page.screenshot();
  writeFileSync(path.join(SHOTS, file), buf);
  if (buf.length < 5000) throw new Error(`blank screenshot ${file}`);
  console.log(`  shot ${file}`);
}

/**
 * The end of an open detail, scrolled into view — the Remove row is the last
 * thing in a GitHub detail in every candidate. A 760px viewport shows the top
 * third of an expansion, and what breaks at 640 (a spec list, a command, an
 * About row) is below that.
 */
async function shotDetailEnd(page, file) {
  const end = await page.$('[data-testid="cand-remove"]');
  if (end === null) return false;
  // The ROW, not the button: the row's caption wraps to two lines at 640 and
  // aligning the button's bottom edge cut the caption's second line. Then 40px
  // further: aligned to the container's edge the row sits in the scroller's
  // own 16px bottom fade (it lifts only at the true end, 32px of padding
  // lower), and the last line read as cut in the shot when it is not.
  await end.evaluate((el) => {
    const row = el.parentElement ?? el;
    row.scrollIntoView({ block: 'end' });
    const scroller = row.closest('.pd-scroll');
    if (scroller !== null) scroller.scrollTop += 40;
  });
  await page.waitForTimeout(350);
  await shotAs(page, file);
  return true;
}

/**
 * A horizontal chip row (Ledger's categories) scrolled to the middle and to
 * the end. A fade that is right at rest can still hide the last chip at the
 * end of the row — a static one did, MEASURED — and only a scrolled shot
 * shows it.
 */
async function shotCategoryRow(page, prefix, { mid = true } = {}) {
  const row = await page.$('[data-testid="cand-categories"]');
  if (row === null) return false;
  const overflows = await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  if (!overflows) return false;
  if (mid) {
    await row.evaluate((el) => {
      el.scrollLeft = Math.round((el.scrollWidth - el.clientWidth) / 2);
    });
    await page.waitForTimeout(350);
    await shotAs(page, `${prefix}-categories-mid-bobble-dark.png`);
  }
  await row.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await page.waitForTimeout(350);
  await shotAs(page, `${prefix}-categories-end-bobble-dark.png`);
  await row.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await page.waitForTimeout(250);
  return true;
}

/**
 * The first line of an error plus the call-log lines that say WHY: Playwright
 * reports "intercepts pointer events" / "not visible" / "not stable" on the
 * lines after "Timeout exceeded", and a log that kept only the first line
 * left one Ledger flake unexplained.
 */
function brief(error) {
  const lines = String(error).split('\n');
  return [
    lines[0],
    ...lines.filter((l) => /intercepts|not visible|hidden|not stable|waiting for/.test(l)),
  ]
    .slice(0, 5)
    .map((l) => l.trim())
    .join(' | ');
}

/** Click a selector if it is there; a missing element is not a failure. */
async function clickIf(page, selector) {
  const el = await page.$(selector);
  if (el === null) return false;
  await el.click({ timeout: 5_000 });
  return true;
}

/**
 * Frames of whatever is animating RIGHT NOW: every animation and transition on
 * the page is paused and seeked to each time, shot, then released. A still
 * says nothing about a 250ms entrance; four stills at known times do.
 */
async function shotFrames(page, prefix, times) {
  for (const t of times) {
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        // A scroll-driven animation (the ScrollArea fades) has a progress
        // timeline; setting a time in ms on it throws. Only the clock-driven
        // ones are the entrance being photographed.
        if (a.timeline !== null && !(a.timeline instanceof DocumentTimeline)) continue;
        a.pause();
        a.currentTime = ms;
      }
    }, t);
    await page.waitForTimeout(80);
    await shotAs(page, `${prefix}-${String(t).padStart(3, '0')}ms-bobble-dark.png`, {
      settle: 60,
    });
  }
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.timeline !== null && !(a.timeline instanceof DocumentTimeline)) continue;
      a.play();
    }
  });
  await page.waitForTimeout(500);
}

/** Scroll the first element under `selector` that actually scrolls. */
async function scrollBy(page, selector, px) {
  return page.evaluate(
    ([sel, dy]) => {
      const root = document.querySelector(sel);
      if (root === null) return false;
      const all = [root, ...root.querySelectorAll('*')];
      for (const el of all) {
        if (el.scrollHeight > el.clientHeight + 10) {
          const style = getComputedStyle(el);
          if (/auto|scroll/.test(style.overflowY)) {
            el.scrollTop += dy;
            return true;
          }
        }
      }
      return false;
    },
    [selector, px],
  );
}

function currentScreen() {
  return withApp('cand-connectors-current', {}, '.pd-composer-editor', async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('[data-testid="nav-connectors"]');
    await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="connector-card-blender"]', { timeout: 15_000 });
    for (const [f, m] of THEMES.slice(0, 2)) {
      await setTheme(page, f, m);
      await shotAs(page, `current-plugins-${f}-${m}.png`);
    }
    await page.click('[data-testid="connector-card-github"] >> text=GitHub');
    await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 10_000 });
    await shotAs(page, 'current-detail-bobble-dark.png');
    await page.click('[data-testid="connector-detail-breadcrumb"]');
    await page.click('[data-testid="connectors-tab-skills"]');
    await page.waitForSelector('[data-testid="connectors-skills"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await shotAs(page, 'current-skills-bobble-dark.png');
    await setTheme(page, 'bobble', 'light');
    await shotAs(page, 'current-skills-bobble-light.png');
  });
}

/** The model hub as it renders today — the screen these candidates are measured against. */
function modelHub() {
  return withApp('cand-connectors-hub', {}, '.pd-composer-editor', async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('[data-testid="nav-model-management"]');
    await page.waitForSelector('[data-testid="models-view"]', { timeout: 15_000 });
    await page.waitForSelector('[data-testid^="family-card-"]', { timeout: 15_000 });
    await page.waitForTimeout(600);
    for (const [f, m] of THEMES.slice(0, 2)) {
      await setTheme(page, f, m);
      await shotAs(page, `hub-${f}-${m}.png`);
    }
    // A family opened and a version picked, so the pinned pane is filled.
    try {
      await page.click('[data-testid^="family-card-"] >> nth=0', { timeout: 5_000 });
      await page.waitForTimeout(600);
      await clickIf(page, '[data-testid^="family-variant-"]');
      await page.waitForTimeout(600);
    } catch (error) {
      console.error(`hub: could not open a family: ${String(error).split('\n')[0]}`);
    }
    await shotAs(page, 'hub-detail-bobble-dark.png');
    // The pane scrolled ~400px: does the hub fade its top edge? (Judgement,
    // "could not judge" 7 — beside shelf-plus-pane-scrolled.)
    if (await scrollBy(page, '.pd-detail-panel', 400)) {
      await page.waitForTimeout(350);
      await shotAs(page, 'hub-pane-scrolled-bobble-dark.png');
    }
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(450);
    await shotAs(page, 'hub-w900-bobble-dark.png');
  });
}

async function openCandidate(page, id) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(`[data-testid="cand-${id}"]`, { timeout: 20_000 });
  // Data arrives async; wait for a catalog item to be drawn.
  await page.waitForSelector('[data-testid^="cand-open-"]', { timeout: 20_000 });
  await page.waitForTimeout(500);
}

function candidate(id) {
  return withApp(
    `cand-connectors-${id}`,
    { PI_DESKTOP_CANDIDATES: 'connectors', PI_DESKTOP_CANDIDATE_V: id },
    '[data-testid="candidate-shell"]',
    async (page) => {
      await openCandidate(page, id);
      // The background warm lists every ON server (four, all fixtures) before
      // the first detail opens, so a detail shows the list and not the one
      // cold-path spinner the cache leaves.
      await page.waitForTimeout(1500);
      for (const [f, m] of only ? THEMES.slice(0, 2) : THEMES) {
        await setTheme(page, f, m);
        await shotAs(page, `${id}-${f}-${m}.png`);
      }
      await setTheme(page, 'bobble', 'dark');
      // Detail: a connector that needs a key, an installed one, a skill, one
      // that adds in one click, a built-in with a static tool list, a
      // hand-added server, and a community server. A target a candidate does
      // not draw is skipped.
      const details = [
        ['github', 'detail-github'],
        ['memory', 'detail-memory'],
        ['skill:code-review', 'detail-skill'],
        ['time', 'detail-time'],
        ['video-editing', 'detail-builtin'],
        ['custom:weather', 'detail-custom'],
        ['blender', 'detail-community'],
        // Added, switched off, never run: "Turn it on to list its tools."
        // (judgement 2 — a branch that had never been looked at).
        ['sequential-thinking', 'detail-never-run'],
      ];
      // A detail that cannot be opened or closed within 8s is skipped and
      // said so, not a failed candidate: Reach's in-place rows cost two
      // full retries that way before this.
      page.setDefaultTimeout(8_000);
      for (const [target, label] of details) {
        const sel = `[data-testid="cand-open-${target}"]`;
        if ((await page.$(sel)) === null) continue;
        try {
          await page.click(sel);
          await page.waitForTimeout(500);
          await shotAs(page, `${id}-${label}-bobble-dark.png`);
          if (label === 'detail-github') {
            await setTheme(page, 'bobble', 'light');
            await shotAs(page, `${id}-${label}-bobble-light.png`);
            await setTheme(page, 'bobble', 'dark');
          }
          // The community sentence sits in About, below the tool list.
          if (label === 'detail-community') {
            await shotDetailEnd(page, `${id}-${label}-end-bobble-dark.png`);
          }
          // A sheet / pane closes with cand-back; an in-place row closes by clicking again.
          if (!(await clickIf(page, '[data-testid="cand-back"]'))) await page.click(sel);
          await page.waitForTimeout(250);
        } catch (error) {
          console.error(`${id}: skipped ${label}: ${brief(error)}`);
        }
      }
      // The one horizontal scroller, mid-scroll and at its end.
      await shotCategoryRow(page, id);
      // A filter applied, and a capped section opened.
      if (await clickIf(page, '[data-testid="cand-filter-on"]')) {
        await page.waitForTimeout(350);
        await shotAs(page, `${id}-filter-on-bobble-dark.png`);
        await clickIf(page, '[data-testid="cand-filter-all"]');
        await page.waitForTimeout(250);
      }
      if (await clickIf(page, '[data-testid="cand-show-all"]')) {
        await page.waitForTimeout(350);
        await shotAs(page, `${id}-expanded-bobble-dark.png`);
        await clickIf(page, '[data-testid="cand-show-fewer"]');
        await page.waitForTimeout(250);
      }
      // The empty state: a search nothing matches.
      await page.fill('[data-testid="cand-search"]', 'zzzz');
      await page.waitForTimeout(300);
      await shotAs(page, `${id}-empty-bobble-dark.png`);
      await page.fill('[data-testid="cand-search"]', '');
      await page.waitForTimeout(300);
      // Narrow. The route lives inside the chat shell beside a 288px sidebar,
      // so 900 of content is a ~1190px window and 640 is what a half-screen
      // window leaves. Each is shot with the detail open too: a sheet or a
      // pane is what breaks first, and a candidate that only holds with
      // nothing selected does not hold.
      for (const width of [900, 640]) {
        await page.setViewportSize({ width, height: 760 });
        await page.waitForTimeout(450);
        // At rest means from the top: the detail clicks above scrolled the list
        // to bring their cards into view, and a rest shot 30px down loses the
        // first section's heading.
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('.pd-scroll')) el.scrollTop = 0;
        });
        await page.waitForTimeout(250);
        await shotAs(page, `${id}-w${width}-bobble-dark.png`);
        const sel = '[data-testid="cand-open-github"]';
        try {
          if (await clickIf(page, sel)) {
            await page.waitForTimeout(500);
            await shotAs(page, `${id}-w${width}-detail-bobble-dark.png`);
            await setTheme(page, 'bobble', 'light');
            await shotAs(page, `${id}-w${width}-detail-bobble-light.png`);
            await setTheme(page, 'bobble', 'dark');
            await shotDetailEnd(page, `${id}-w${width}-detail-end-bobble-dark.png`);
            if (!(await clickIf(page, '[data-testid="cand-back"]'))) await page.click(sel);
            await page.waitForTimeout(300);
          }
        } catch (error) {
          console.error(`${id}: skipped w${width} detail: ${brief(error)}`);
        }
      }
      await shotCategoryRow(page, `${id}-w640`, { mid: false });
      await setTheme(page, 'bobble', 'light');
      await shotAs(page, `${id}-w640-bobble-light.png`);
      await setTheme(page, 'bobble', 'dark');
      if (id === 'shelf-plus') await shelfPlusStates(page);
    },
  );
}

/**
 * The states round 3 was asked for and round 2 never drew — in the SAME
 * session as the set above, so the images agree with each other.
 */
async function shelfPlusStates(page) {
  const P = 'shelf-plus';
  const wait = (sel, t = 15_000) => page.waitForSelector(sel, { timeout: t });
  const listTop = () => scrollBy(page, '[data-testid="cand-list"]', -100000);

  // ── hover, focus, tab order — first, while GitHub still needs setup, so the
  // "Set up" pill and a plain "+" are there to land on ──
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await listTop();
  await page.hover('[data-testid="cand-card-git"]');
  await page.waitForTimeout(300);
  await shotAs(page, `${P}-ix-hover-card-bobble-dark.png`, { keepMouse: true });
  await parkMouse(page);
  await page.click('[data-testid="cand-search"]');
  // The first "+" in the Tools grid, whatever it is in this fixture (Sequential
  // Thinking used to be it; it is installed-and-off now, for judgement 2).
  const plusId = await page.$eval(
    '[data-testid="cand-section-tools"] [data-testid^="cand-add-"]',
    (el) => el.getAttribute('data-testid'),
  );
  const wanted = new Map([
    ['cand-open-chrome-devtools', 'chip'],
    ['cand-add-chrome-devtools', 'chip-plus'],
    ['cand-open-github', 'card'],
    ['cand-setup-github', 'setup'],
    ['cand-toggle-filesystem', 'switch'],
    [plusId, 'plus'],
  ]);
  const activeId = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute('data-testid') ?? el?.getAttribute('aria-label') ?? el?.tagName;
    });
  const order = [];
  for (let i = 0; i < 40 && wanted.size > 0; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(60);
    const id = await activeId();
    order.push(id);
    const label = wanted.get(id);
    if (label !== undefined) {
      wanted.delete(id);
      await shotAs(page, `${P}-ix-focus-${label}-bobble-dark.png`, { settle: 120 });
    }
  }
  console.log(`  tab order: ${order.join(' → ')}`);
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 60); // drop keyboard focus: the header's dead space
  await parkMouse(page);
  await listTop();
  // Both rings on one card: Memory selected (its detail in the pane) and then
  // keyboard-focused — selection hugs the card, focus stands 2px off it
  // (judgement 5: the two used to be the same accent at the same pixel).
  await page.click('[data-testid="cand-open-memory"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="cand-search"]');
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(40);
    if ((await activeId()) === 'cand-open-memory') break;
  }
  await shotAs(page, `${P}-ix-focus-selected-card-bobble-dark.png`, { settle: 120 });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 60);
  await parkMouse(page);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);
  await listTop();

  // ── the setup flow, bad key first: pasted, failed, changed, listed ──
  await page.click('[data-testid="cand-open-github"]');
  await wait('[data-testid="cand-setup"]');
  await page.fill('[data-testid="cand-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', 'bad-token');
  await page.waitForTimeout(200);
  await shotAs(page, `${P}-setup-filled-bobble-dark.png`);
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, `${P}-setup-filled-bobble-light.png`);
  await setTheme(page, 'bobble', 'dark');
  await page.click('[data-testid="cand-setup-save"]');
  await wait('[data-testid="cand-tools-error"]');
  await shotAs(page, `${P}-setup-bad-key-bobble-dark.png`);
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, `${P}-setup-bad-key-bobble-light.png`);
  await setTheme(page, 'bobble', 'dark');
  // The ledger after a bad key (judgement 1): GitHub under "Needs setup" with
  // an amber, dated line and the Set up pill; the pill's count still 1; the
  // card's control amber too. Then the row's pill opens the detail with the
  // key card already open, over the saved value.
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);
  await shotAs(page, `${P}-ledger-bad-key-bobble-dark.png`);
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, `${P}-ledger-bad-key-bobble-light.png`);
  await setTheme(page, 'bobble', 'dark');
  await page.click('[data-testid="cand-pane"] [data-testid="cand-setup-github"]');
  await wait('[data-testid="cand-setup-cancel"]');
  await shotAs(page, `${P}-setup-change-key-bobble-dark.png`);
  await page.fill('[data-testid="cand-field-GITHUB_PERSONAL_ACCESS_TOKEN"]', GOOD_TOKEN);
  await page.click('[data-testid="cand-setup-save"]');
  await wait('[data-testid="cand-tools-list"]');
  await page.waitForTimeout(400);
  await shotAs(page, `${P}-detail-github-tools-bobble-dark.png`);
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, `${P}-detail-github-tools-bobble-light.png`);
  await setTheme(page, 'bobble', 'dark');
  // Both groups opened — framed from the Tools title — then the end of the detail.
  const more = await page.$$('[data-testid="cand-tools-more"]');
  for (const m of more) await m.click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector('[data-testid="cand-tools"]')?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(300);
  await shotAs(page, `${P}-detail-github-tools-expanded-bobble-dark.png`);
  await shotDetailEnd(page, `${P}-detail-github-tools-end-bobble-dark.png`);
  // The category link → the search, with the detail still open (pinned).
  await page.click('[data-testid="cand-category-link"]');
  await page.waitForTimeout(400);
  await shotAs(page, `${P}-category-search-bobble-dark.png`);
  await page.fill('[data-testid="cand-search"]', '');
  await page.waitForTimeout(300);
  // The detail re-opened from the cache: no spinner, "listed N ago".
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="cand-open-github"]');
  await page.waitForTimeout(500);
  await shotAs(page, `${P}-detail-github-reopened-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);

  // ── a server that stops answering: the other amber label (judgement 1) ──
  // Blender listed 17 tools at launch; now its package exits before the
  // handshake and Refresh fails. The detail says "Not responding" over the
  // list it still has, the ledger moves it under "Needs setup" with a
  // "Try again" pill, and the pill's count follows.
  fixtureControl({ fail: ['blender-mcp'] });
  await page.click('[data-testid="cand-open-blender"]');
  await wait('[data-testid="cand-tools-refresh"]');
  await page.click('[data-testid="cand-tools-refresh"]');
  await wait('[data-testid="cand-tools-error"]');
  await page.waitForTimeout(300);
  await shotAs(page, `${P}-not-responding-detail-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);
  await shotAs(page, `${P}-not-responding-ledger-bobble-dark.png`);
  fixtureControl(null);
  // "Try again" from the row: the server answers, the failure is cleared, and
  // the detail that opened shows the list under a green "On" again.
  await page.click('[data-testid="cand-pane"] [data-testid="cand-retry-blender"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="cand-tools-error"]') === null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(400);
  await shotAs(page, `${P}-not-responding-recovered-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);

  // ── Refresh in flight: "9 · listing…" and the spinner in the button ──
  fixtureControl({ delayMs: 2500 });
  await page.click('[data-testid="cand-open-memory"]');
  await wait('[data-testid="cand-tools-refresh"]');
  await page.click('[data-testid="cand-tools-refresh"]');
  await page.waitForTimeout(200);
  await shotAs(page, `${P}-ix-refresh-in-flight-bobble-dark.png`, { settle: 100 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="cand-tools-refresh"]')?.disabled === false,
    { timeout: 15_000 },
  );
  fixtureControl(null);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);

  // ── off, with a list from its last run (judgement 2) ──
  // Memory switched off from its card, then opened: "9 · from its last run",
  // no switch-on prompt, no spinner; the ledger lists it under "Off".
  await page.click('[data-testid="cand-card-memory"] [data-testid="cand-toggle-memory"]');
  await page.waitForTimeout(700);
  await shotAs(page, `${P}-ledger-off-bobble-dark.png`);
  await page.click('[data-testid="cand-open-memory"]');
  await page.waitForTimeout(500);
  await shotAs(page, `${P}-detail-memory-off-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="cand-card-memory"] [data-testid="cand-toggle-memory"]');
  await page.waitForTimeout(700);

  // ── the pane at rest: the built-in group opening, frame by frame ──
  await page.click('[data-testid="cand-builtins-toggle"]');
  await shotFrames(page, `${P}-ix-builtins`, [0, 80, 160, 250]);
  // Opened, the group runs past the pane's fold; the pane scrolled to its end
  // shows all seven rows.
  await scrollBy(page, '[data-testid="cand-pane"]', 100000);
  await page.waitForTimeout(350);
  await shotAs(page, `${P}-builtins-open-bobble-dark.png`);
  await scrollBy(page, '[data-testid="cand-pane"]', -100000);
  await page.click('[data-testid="cand-builtins-toggle"]');
  await page.waitForTimeout(400);

  // ── the pane swapping ledger → detail, frame by frame ──
  await page.click('[data-testid="cand-open-memory"]');
  await shotFrames(page, `${P}-ix-swap`, [0, 60, 120, 200]);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);

  // ── the pane scrolled: a playbook 400px down ──
  await page.click('[data-testid="cand-open-skill:code-review"]');
  await wait('[data-testid="cand-skill-body"]');
  await page.waitForTimeout(300);
  await scrollBy(page, '[data-testid="cand-pane"]', 400);
  await page.waitForTimeout(350);
  await shotAs(page, `${P}-pane-scrolled-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);
  await listTop();

  // ── a recommendation added from its chip ──
  await page.click('[data-testid="cand-add-chrome-devtools"]');
  await page.waitForTimeout(1200);
  await shotAs(page, `${P}-ix-chip-added-bobble-dark.png`);
  await page.click('[data-testid="cand-open-chrome-devtools"]');
  await wait('[data-testid="cand-tools-list"]');
  await page.waitForTimeout(300);
  await shotAs(page, `${P}-detail-chrome-devtools-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(300);

  // ── the shell's own width: 1440 minus the 288px sidebar ──
  await page.setViewportSize({ width: 1152, height: 860 });
  await page.waitForTimeout(450);
  await listTop();
  await shotAs(page, `${P}-w1152-bobble-dark.png`);
  await setTheme(page, 'bobble', 'light');
  await shotAs(page, `${P}-w1152-bobble-light.png`);
  await setTheme(page, 'bobble', 'dark');
  await page.click('[data-testid="cand-open-github"]');
  await page.waitForTimeout(500);
  await shotAs(page, `${P}-w1152-detail-bobble-dark.png`);

  // ── across PINNED_MIN (1104px of content) with the detail open: pinned ↔
  // overlay, and the list two columns on BOTH sides (judgement 6) ──
  await page.setViewportSize({ width: 1105, height: 860 });
  await page.waitForTimeout(450);
  await shotAs(page, `${P}-ix-pinned-1105-bobble-dark.png`);
  await page.setViewportSize({ width: 1103, height: 860 });
  await page.waitForTimeout(450);
  await shotAs(page, `${P}-ix-overlay-1103-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);

  // ── 900: the sheet's entrance, its frames; then the tool list in it ──
  await page.setViewportSize({ width: 900, height: 760 });
  await page.waitForTimeout(450);
  await listTop();
  await page.click('[data-testid="cand-open-github"]');
  await shotFrames(page, `${P}-ix-sheet-w900`, [0, 80, 160, 250]);
  await shotAs(page, `${P}-w900-detail-tools-bobble-dark.png`);
  await shotDetailEnd(page, `${P}-w900-detail-tools-end-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);
  // The failing state in the sheet: amber status, the reason above the list,
  // and — with no ledger at this width — the card's "Try again" pill and the
  // pill's count are what the list carries.
  await notResponding(page, 'blender', `${P}-w900-not-responding-bobble-dark.png`);
  // The footer in overlay mode: the list scrolled to its end, nothing open.
  await scrollBy(page, '[data-testid="cand-list"]', 100000);
  await page.waitForTimeout(350);
  await shotAs(page, `${P}-w900-end-bobble-dark.png`);
  await scrollBy(page, '[data-testid="cand-list"]', -100000);

  // ── 640: the detail takes the list's place ──
  await page.setViewportSize({ width: 640, height: 760 });
  await page.waitForTimeout(450);
  await listTop();
  await page.click('[data-testid="cand-open-github"]');
  await page.waitForTimeout(500);
  await shotAs(page, `${P}-w640-detail-tools-bobble-dark.png`);
  await shotDetailEnd(page, `${P}-w640-detail-tools-end-bobble-dark.png`);
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);
  // The failing state in the full-width column.
  await notResponding(page, 'blender', `${P}-w640-not-responding-bobble-dark.png`);
  await scrollBy(page, '[data-testid="cand-list"]', 100000);
  await page.waitForTimeout(350);
  await shotAs(page, `${P}-w640-end-bobble-dark.png`);
  await scrollBy(page, '[data-testid="cand-list"]', -100000);
}

/**
 * Make `id`'s fixture package fail, refresh its detail so the failure is
 * recorded, shoot, then let it answer again and clear the failure with the
 * detail's own "Try again" — so the state after this is the state before it.
 */
async function notResponding(page, id, file) {
  const pkg = { blender: 'blender-mcp', memory: '@modelcontextprotocol/server-memory' }[id];
  fixtureControl({ fail: [pkg] });
  await page.click(`[data-testid="cand-open-${id}"]`);
  await page.waitForSelector('[data-testid="cand-tools-refresh"]', { timeout: 15_000 });
  await page.click('[data-testid="cand-tools-refresh"]');
  await page.waitForSelector('[data-testid="cand-tools-error"]', { timeout: 15_000 });
  await page.waitForTimeout(300);
  await shotAs(page, file);
  fixtureControl(null);
  await page.click('[data-testid="cand-tools-error"] >> text=Try again');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="cand-tools-error"]') === null,
    { timeout: 15_000 },
  );
  await page.click('[data-testid="cand-back"]');
  await page.waitForTimeout(400);
}

/** A fresh install: nothing added, no skill on — the pane a new user sees first. */
function freshInstall() {
  return withApp(
    'cand-connectors-fresh',
    { PI_DESKTOP_CANDIDATES: 'connectors', PI_DESKTOP_CANDIDATE_V: 'shelf-plus' },
    '[data-testid="candidate-shell"]',
    async (page) => {
      await openCandidate(page, 'shelf-plus');
      await page.waitForSelector('[data-testid="cand-pane-empty"]', { timeout: 15_000 });
      for (const [f, m] of THEMES.slice(0, 2)) {
        await setTheme(page, f, m);
        await shotAs(page, `shelf-plus-fresh-${f}-${m}.png`);
      }
      await setTheme(page, 'bobble', 'dark');
      await page.setViewportSize({ width: 900, height: 760 });
      await page.waitForTimeout(450);
      await shotAs(page, 'shelf-plus-fresh-w900-bobble-dark.png');
    },
    { fresh: true },
  );
}

/** Reach's in-place expansion holding the 40-tool list — the judge's item 1, under Reach. */
function reachTools() {
  return withApp(
    'cand-connectors-reach-tools',
    { PI_DESKTOP_CANDIDATES: 'connectors', PI_DESKTOP_CANDIDATE_V: 'reach' },
    '[data-testid="candidate-shell"]',
    async (page) => {
      await openCandidate(page, 'reach');
      await page.waitForTimeout(1500);
      await setTheme(page, 'bobble', 'dark');
      await page.click('[data-testid="cand-open-github"]');
      await page.waitForSelector('[data-testid="cand-tools-list"]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      await shotAs(page, 'reach-detail-github-tools-bobble-dark.png');
      const more = await page.$$('[data-testid="cand-tools-more"]');
      for (const m of more) await m.click();
      await page.waitForTimeout(300);
      await scrollBy(page, '[data-testid="cand-reach"]', 500);
      await page.waitForTimeout(300);
      await shotAs(page, 'reach-detail-github-tools-expanded-bobble-dark.png');
      await shotDetailEnd(page, 'reach-detail-github-tools-end-bobble-dark.png');
    },
    { githubReady: true },
  );
}

/**
 * The dev server is SHARED: another agent saving `electron/*.ts` or any file
 * Vite full-reloads on restarts the page under a probe mid-load, and the
 * launch dies waiting for the candidate shell. That is environmental, not a
 * finding, so a launch gets three tries before it counts as a failure.
 */
async function withRetry(run, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await run();
      console.log(`${label} OK`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`${label}: attempt ${attempt} failed: ${brief(error)}`);
    }
  }
  throw lastError;
}

if (mode === 'current') await withRetry(currentScreen, 'current');
else if (mode === 'hub') await withRetry(modelHub, 'hub');
else if (mode === 'fresh') await withRetry(freshInstall, 'fresh');
else if (mode === 'reach-tools') await withRetry(reachTools, 'reach-tools');
else if (mode === 'all') {
  await withRetry(currentScreen, 'current');
  await withRetry(modelHub, 'hub');
  for (const id of CANDIDATES) await withRetry(() => candidate(id), id);
  await withRetry(freshInstall, 'fresh');
  await withRetry(reachTools, 'reach-tools');
} else await withRetry(() => candidate(mode), mode);
