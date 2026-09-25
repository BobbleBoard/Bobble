/**
 * LOOK at the model hub's fit, sort and ordering work in the real app.
 *
 * the user's standing rule on UI work: drive the real thing and look, because tests
 * pass while the screen is wrong. This asserts what the unit tests cannot — that
 * the verdict is on screen, that it carries its arithmetic, that the dropdown
 * really is in the order the user asked for, and that the verdict CHANGES when the
 * quant does. It prints every row too, because printing the real data is what
 * found the bugs this probe exists for.
 *
 * WHERE THAT LIVES NOW. Model management left Settings for a page of its own —
 * the sidebar's "Model management" row opens the hub in the chat area — so the
 * `settings-nav-models` this used to click is gone, and so is the card's text
 * badge. The quant picker sits in the hub's detail pane, and two things about it
 * changed on the user's word (QuantPicker.tsx has the quotes):
 *   · the verdict is the fit DOT's tooltip, not a word on the card;
 *   · the list is plain size order, largest first, under ONE pinned
 *     "Recommended" row — the fit-first ranking now only chooses that row.
 * The checks follow those shapes and keep what they were for.
 *
 * A Recommended pick is a Hugging Face repo, so its ladder is a live file
 * listing: this needs the network. The catalog, the hardware detect and every
 * fit computation are the app's own, and the numbers on screen are checked
 * against the launcher's estimator (context-cap.ts), not against a copy of it.
 *
 * ON DISK, WITHOUT A DOWNLOAD. The on-disk half — the picker's action following
 * the selected file, "Only show models that fit", the delete confirmation — used
 * to need REAL_HOME=1 and the real cache. A probe never gets the real home now
 * (harness.mjs), so this STAGES a library in its throwaway one: sparse files at
 * the catalog's own paths, found by the app's ordinary disk-truth code and
 * taking no disk. They appear only after the boot-time model check has found
 * nothing to start, and nothing is ever sent, so nothing starts for them — the
 * last check proves it.
 *
 *   node scripts/with-lock.mjs probe -- node apps/desktop/tests/e2e/model-fit-ui-probe.mjs
 *
 * Build first. MODEL_ID picks another catalog model (default: the 27B).
 * Screenshots land in $SHOT_DIR, else $TMPDIR/pd-shots/model-fit-ui.
 */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { launchApp, REPO_ROOT } from './harness.mjs';

const SRC = path.join(REPO_ROOT, 'packages/inference/src');
const { CATALOG } = await import(`${SRC}/catalog.ts`);
const { DEFAULT_MEMORY_FRACTION, estimateLaunchRamGB } = await import(`${SRC}/context-cap.ts`);

const MODEL_ID = process.env.MODEL_ID ?? 'qwen3.8-27b-mtp';
const model = CATALOG.find((m) => m.id === MODEL_ID);
if (model?.hfRepo === undefined || model.files.length === 0) {
  console.error(`model-fit-ui-probe: ${MODEL_ID} is not a catalog model with a Hugging Face repo`);
  process.exit(1);
}
if (process.env.REAL_HOME === '1') {
  console.log(
    '  --   REAL_HOME=1 is ignored: a probe never runs in the real home; a staged library stands in',
  );
}

const {
  page,
  check: record,
  finish,
  home,
  shotDir,
} = await launchApp('model-fit-ui', {
  waitFor: null,
});

/*
 * THE BOOT-TIME MODEL CHECK, heard from the first frame. App.tsx starts the
 * first downloaded model it finds (ensureChatServerReady), so the staged
 * library below may only appear once that check has decided there is nothing
 * to start. Listening before the page has even loaded is what makes its
 * verdict impossible to miss.
 */
const bootCheck = [];
page.on('console', (m) => {
  const text = m.text();
  if (m.type() === 'error') console.log('console.error:', text.slice(0, 200));
  if (text.includes('[pi-diag] ensureChatServerReady:')) bootCheck.push(text);
});

function check(ok, message) {
  if (ok) console.log(`  ok   ${message}`);
  return record(ok, message);
}
/** A check the rest of the run stands on: recorded like any other, then stop. */
class Stop extends Error {}
function need(ok, message) {
  if (!check(ok, message)) throw new Stop(message);
}

const shot = (name, target = page) =>
  target.screenshot({ path: path.join(shotDir, `${name}.png`) });

/** The three words the tone stands for; the user keeps them off the card itself. */
const LABEL = { success: 'Fits', warning: 'Tight, will swap', danger: "Won't fit" };
const SEVERITY = { success: 0, warning: 1, danger: 2 };

/**
 * Hover a fit dot and read ITS tooltip — the verdict lives there now.
 *
 * MEASURED, row by row: every other row's tooltip never opened. Leaving a dot
 * gives the pointer a grace area to travel to its tooltip, and only a LATER
 * move outside that area closes it and clears Radix's "pointer in transit" —
 * so one jump away left the flag up, and the next dot's hover was swallowed.
 * Hence two moves away, the old tooltip waited out, and the text read through
 * the dot's own `aria-describedby` rather than whatever tooltip is on screen.
 */
async function tooltipOf(dot) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(50);
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]') === null, undefined, {
    timeout: 3000,
  });
  await dot.hover();
  await page.waitForFunction(
    (el) => {
      const id = el.getAttribute('aria-describedby');
      return id !== null && document.getElementById(id) !== null;
    },
    await dot.elementHandle(),
    { timeout: 3000 },
  );
  return dot.evaluate(
    (el) =>
      document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? '',
  );
}

/*
 * DOES A VERDICT ADD UP? Its terms must sum to its total, the total must be the
 * launcher's own estimate for THIS file at the window it names, the RAM must be
 * this machine's, and the colour must be the one those numbers earn. The last
 * is the composition the old dropdown got wrong while every unit test passed:
 * the sort and the labels were each right and fed different inputs.
 */
const WORKING =
  /^([\d.]+) weights \+ ([\d.]+) context \+ ([\d.]+) runtime ≈ ([\d.]+) GB of (\d+) GB, at a (\d+)k window/;
function judge(text, bytes, tone, ramGB) {
  const m = WORKING.exec(text ?? '');
  if (m === null) return `no arithmetic in "${text}"`;
  const [weights, context, runtime, total, of, windowK] = m.slice(1).map(Number);
  const estimate = estimateLaunchRamGB(bytes, windowK * 1024);
  const earned =
    estimate <= ramGB * DEFAULT_MEMORY_FRACTION
      ? 'success'
      : estimate <= ramGB
        ? 'warning'
        : 'danger';
  if (Math.abs(weights - bytes / 1024 ** 3) > 0.051)
    return `${weights} GB of weights is not this file`;
  if (Math.abs(weights + context + runtime - total) > 0.151)
    return `its terms do not sum to ${total}`;
  if (Math.abs(total - estimate) > 0.051)
    return `${total} is not the launcher's ${estimate.toFixed(2)}`;
  if (of !== ramGB) return `"of ${of} GB" is not this machine's ${ramGB} GB`;
  if (tone !== earned) return `coloured ${tone}, but its numbers earn ${earned}`;
  return null;
}

/** Every row of the open quant menu, top to bottom, as the screen has it. */
const MENU_ROW = '[data-testid="quant-menu"] [data-testid^="quant-opt-"]';
const readMenu = () =>
  page.$$eval(MENU_ROW, (els) =>
    els.map((el) => {
      const id = el.getAttribute('data-testid') ?? '';
      const from = id.startsWith('quant-opt-pinned-') ? 'pinned' : 'list';
      const dot = el.querySelector('span.rounded-full.h-2');
      const box = dot?.getBoundingClientRect();
      const tint = dot?.getAttribute('class') ?? '';
      const size = el.querySelector('[data-testid="quant-size"]');
      return {
        from,
        quant: id.slice(`quant-opt-${from}-`.length),
        bytes: Number(size?.getAttribute('data-bytes')),
        size: size?.textContent?.trim() ?? '',
        tone: /status-success/.test(tint)
          ? 'success'
          : /status-warning/.test(tint)
            ? 'warning'
            : /status-danger/.test(tint)
              ? 'danger'
              : 'default',
        dot:
          dot !== null &&
          box !== undefined &&
          box.width >= 6 &&
          box.height >= 6 &&
          getComputedStyle(dot).backgroundColor !== 'rgba(0, 0, 0, 0)',
        badge: /Recommended/.test(el.textContent ?? ''),
        onDisk: /on disk/.test(el.textContent ?? ''),
        selected: el.getAttribute('data-selected') === 'true',
        dividedBelow: el.nextElementSibling?.classList.contains('pd-menu-separator') ?? false,
      };
    }),
  );

function printRows(rows) {
  console.log('the menu, top to bottom:');
  for (const r of rows) {
    const marks = [r.badge ? 'Recommended' : '', r.onDisk ? 'on disk' : '', r.selected ? '✓' : '']
      .filter(Boolean)
      .join(' ');
    console.log(
      `  ${r.from === 'pinned' ? '★' : ' '} ${r.quant.padEnd(16)} ${r.size.padStart(7)}  ${(LABEL[r.tone] ?? r.tone).padEnd(16)} ${marks.padEnd(22)} ${r.tip ?? ''}`,
    );
  }
}

try {
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  // Every phase the inference status passes through, for the last check.
  await page.waitForFunction(() => window.__llm_store !== undefined, undefined, {
    timeout: 10_000,
  });
  await page.evaluate(() => {
    const store = window.__llm_store();
    window.__phases = [store.getState().status.phase];
    store.subscribe((s) => {
      if (window.__phases.at(-1) !== s.status.phase) window.__phases.push(s.status.phase);
    });
  });

  // ── The hub, from the sidebar ────────────────────────────────────────────
  await page.click('[data-testid="nav-model-management"]');
  await page.waitForSelector('[data-testid="models-view"]', { timeout: 10_000 });
  await page.waitForFunction(
    () =>
      /\d+\s*GB RAM/.test(
        document.querySelector('[data-testid="hardware-strip"]')?.textContent ?? '',
      ) && window.__llm_store?.().getState().hardware != null,
    undefined,
    { timeout: 15_000 },
  );
  const hardware = await page.evaluate(() => window.__llm_store?.().getState().hardware ?? null);
  console.log('hardware:', JSON.stringify(hardware));
  check(hardware !== null && hardware.totalRamGB > 0, 'hardware was detected (real RAM)');
  const strip = (await page.textContent('[data-testid="hardware-strip"]')) ?? '';
  const ramGB = Number(/(\d+)\s*GB RAM/.exec(strip)?.[1]);
  need(ramGB > 0, `the hub states this machine's memory (${ramGB} GB)`);

  // ── The model, where a person finds it: Recommended → its family ─────────
  check(
    await page.evaluate(
      (id) =>
        window
          .__llm_store?.()
          .getState()
          .catalog.some((e) => e.id === id) ?? false,
      MODEL_ID,
    ),
    `${MODEL_ID} is in the app's catalog`,
  );
  // Recommended waits out the hub's first Hugging Face search before it shows.
  await page.waitForSelector('[data-testid="curated-families"]', { timeout: 30_000 });
  await shot('1-hub');
  const variant = page.locator(`[data-testid^="family-variant-${model.hfRepo}:"]`).first();
  need((await variant.count()) > 0, `Recommended offers ${model.hfRepo}`);
  const family = await variant.evaluate(
    (el) =>
      el
        .closest('[data-testid^="family-card-"]')
        ?.getAttribute('data-testid')
        ?.slice('family-card-'.length) ?? '',
  );
  await page.click(`[data-testid="family-toggle-${family}"]`);
  // A one-version family opens its card on that click; a larger one unfolds.
  await page.waitForTimeout(400);
  if ((await variant.getAttribute('data-selected')) !== 'true') {
    await variant.locator('button').first().click();
  }
  await page.waitForSelector('[data-testid="model-detail"]', { timeout: 10_000 });
  check(
    (await variant.getAttribute('data-selected')) === 'true',
    `its card is the one open (${family} → ${model.hfRepo})`,
  );
  // The ladder is a live Hugging Face listing; give the network its time.
  const listed = await page
    .waitForSelector('[data-testid="quant-picker"]', { timeout: 45_000 })
    .then(
      () => true,
      () => false,
    );
  if (!listed) {
    const why = await page.evaluate(() => ({
      loading: document.querySelector('[data-testid="quant-picker-loading"]') !== null,
      error: document.querySelector('[data-testid="models-hf-error"]')?.textContent ?? null,
      gated: document.querySelector('[data-testid="hf-token-row"]') !== null,
    }));
    need(
      false,
      `${model.hfRepo}'s files came back from Hugging Face (needs the network): ${JSON.stringify(why)}`,
    );
  }
  await shot('2-card', page.locator('[data-testid="model-detail"]'));

  // ── The verdict: the dot's colour, with its working in the tooltip ───────
  const dot = page.locator('[data-testid="quant-fit-dot"]');
  const current = page.locator('[data-testid="quant-current"]');
  /** The quant the closed picker names — its first span; the rest is size. */
  const currentQuant = async () =>
    ((await current.locator('span').first().textContent()) ?? '').trim();
  const preselected = await currentQuant();
  const tone = (await dot.getAttribute('data-tone')) ?? '';
  const detail = await tooltipOf(dot);
  console.log(`verdict on ${preselected}: ${LABEL[tone] ?? tone}  "${detail}"`);
  check(tone in LABEL, `the dot carries a fit verdict (${tone})`);
  check(
    /GB of \d+ GB, at a \d+k window/.test(detail),
    `the verdict shows its arithmetic ("${detail}")`,
  );
  await shot('2b-verdict-tooltip');

  // ── The dropdown: the pinned pick, then every file largest → smallest ────
  await page.mouse.move(1, 1);
  await current.click();
  await page.waitForSelector('[data-testid="quant-menu"]', { timeout: 3000 });
  await page.waitForTimeout(300);
  await shot('3-quant-dropdown');
  const rows = await readMenu();
  // Each row's verdict is on its own dot, so read every one of them.
  for (let i = 0; i < rows.length; i++) {
    const rowDot = page.locator(MENU_ROW).nth(i).locator('span.rounded-full.h-2');
    rows[i].tip = await tooltipOf(rowDot).catch(() => '');
  }
  await page.mouse.move(1, 1);
  printRows(rows);

  /*
   * The invariants, not a hand-written expected list:
   *   · one pinned "Recommended" row, a divider, then the list by size, largest
   *     first — the user's spec for this menu;
   *   · every file once, the pick's twin included (and without the badge);
   *   · down the list the verdict only improves — size and colour agree;
   *   · the pick is in the best fit class on offer, and it is the preselection;
   *   · inside that class a dynamic quant beats a marginally larger plain one
   *     (UD_QUALITY_BONUS), so where one fits, the pick is one.
   */
  const [pick, ...list] = rows;
  need(
    rows.length >= 3 && pick.from === 'pinned',
    `the menu opens on a pinned pick (${rows.length} rows)`,
  );
  check(
    rows.filter((r) => r.from === 'pinned').length === 1 && pick.badge,
    `one pinned row, and it says "Recommended" (${pick.quant})`,
  );
  check(pick.dividedBelow, 'a divider separates the pick from the list');
  check(
    list.every((r, i) => i === 0 || r.bytes <= list[i - 1].bytes),
    `the list runs largest → smallest (${list.map((r) => r.size).join(', ')})`,
  );
  const names = list.map((r) => r.quant);
  const twice = [...new Set(names.filter((q, i) => names.indexOf(q) !== i))];
  check(
    twice.length === 0,
    `no quant is listed twice${twice.length > 0 ? ` (${twice.join(', ')})` : ''}`,
  );
  const twins = list.filter((r) => r.quant === pick.quant);
  check(
    twins.length === 1 && !twins[0].badge,
    `the pick is in the list too, once, without the badge (${pick.quant})`,
  );
  const severity = list.map((r) => SEVERITY[r.tone] ?? 3);
  check(
    severity.every((s, i) => i === 0 || s <= severity[i - 1]),
    `down the list the verdict only improves (${list.map((r) => r.tone).join(', ')})`,
  );
  const best = Math.min(...severity);
  check(
    (SEVERITY[pick.tone] ?? 3) === best,
    `the pick is in the best fit class on offer (${pick.quant}: ${LABEL[pick.tone] ?? pick.tone})`,
  );
  const dynamic = (q) => /(^|[^A-Z])UD-/i.test(q);
  check(
    !list.some((r) => SEVERITY[r.tone] === best && dynamic(r.quant)) || dynamic(pick.quant),
    `a dynamic quant wins the pick where one fits (${pick.quant})`,
  );
  check(
    pick.selected && preselected === pick.quant && detail === pick.tip,
    `the closed picker was already showing the pick, verdict and all — it is the preselection (${preselected})`,
  );
  check(
    rows.every((r) => r.dot),
    `every row carries a fit dot (${rows.filter((r) => r.dot).length} of ${rows.length})`,
  );
  const wrong = rows
    .map((r) => ({ quant: r.quant, why: judge(r.tip, r.bytes, r.tone, ramGB) }))
    .filter((w) => w.why !== null);
  check(
    wrong.length === 0,
    `every row's verdict adds up and earns its colour${wrong.length > 0 ? `: ${wrong.map((w) => `${w.quant} — ${w.why}`).join('; ')}` : ` (${rows.length} rows)`}`,
  );

  // ── The verdict MOVES with the selection ─────────────────────────────────
  const other = list[0].quant !== pick.quant ? list[0] : list[list.length - 1];
  await page.locator(`[data-testid="quant-opt-list-${other.quant}"]`).first().click();
  await page.waitForSelector('[data-testid="quant-menu"]', { state: 'detached', timeout: 3000 });
  const tone2 = (await dot.getAttribute('data-tone')) ?? '';
  const detail2 = await tooltipOf(dot);
  console.log(`after picking ${other.quant}: ${LABEL[tone2] ?? tone2}  "${detail2}"`);
  check((await currentQuant()) === other.quant, `the picker now names ${other.quant}`);
  check(detail2 !== detail, `the verdict moved with the quant ("${detail}" → "${detail2}")`);
  const moved = judge(detail2, other.bytes, tone2, ramGB);
  check(
    moved === null,
    `and it is ${other.quant}'s own verdict${moved === null ? ` (${LABEL[tone2]})` : `: ${moved}`}`,
  );
  await shot('4-card-other-quant');
  await page.mouse.move(1, 1);

  // ── A staged library: the on-disk half, without a download ───────────────
  const until = Date.now() + 20_000;
  while (!bootCheck.some((l) => l.includes('NO model to start')) && Date.now() < until) {
    await page.waitForTimeout(250);
  }
  need(
    bootCheck.some((l) => l.includes('NO model to start')),
    `the boot-time model check found nothing to start before anything was staged (${bootCheck.at(-1) ?? 'no verdict heard'})`,
  );
  const { libraryRoot } = await page.evaluate(() =>
    window.piDesktop.invoke('storage:overview', { fresh: false }),
  );
  const inHome = (p) =>
    [home, realpathSync(home)].some(
      (h) => typeof p === 'string' && p.startsWith(`${h}${path.sep}`),
    );
  need(inHome(libraryRoot), `the library is inside the throwaway home (${libraryRoot})`);
  // Sparse, or not at all: a disk that cannot make a hole would really write 13 GB.
  const canary = path.join(home, 'sparse-canary');
  writeFileSync(canary, '');
  truncateSync(canary, 64 * 1024 ** 2);
  const sparse = statSync(canary).blocks * 512 < 1024 ** 2;
  rmSync(canary);
  need(sparse, 'this disk makes sparse files, so a staged model costs nothing');
  /** A model's first file at the catalog's own path and size — a hole, not data. */
  const stage = (m) => {
    const file = m.files[0];
    const at = path.join(libraryRoot, 'LLM', m.id, file.name);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, '');
    truncateSync(at, file.bytes);
    console.log(
      `staged ${path.relative(libraryRoot, at)}: ${(file.bytes / 1e9).toFixed(2)} GB, ${statSync(at).blocks * 512} bytes on disk`,
    );
    return { at, bytes: file.bytes, quant: file.quant };
  };
  /* The near miss: the smallest catalog model this machine cannot hold, so the
     fit filter has something real to hide. */
  const tooBig = CATALOG.filter(
    (m) =>
      m.id !== MODEL_ID &&
      m.minRamGB > ramGB &&
      m.files.length > 0 &&
      (m.engine ?? 'llamacpp') === 'llamacpp',
  ).sort((a, b) => a.minRamGB - b.minRamGB)[0];
  const staged = stage(model);
  if (tooBig !== undefined) stage(tooBig);

  // ── On Device, and "Only show models that fit" ──────────────────────────
  await page.click('[data-testid="models-tab-device"]');
  await page.click('[data-testid="models-refresh"]');
  await page.waitForSelector(`[data-testid="model-row-${MODEL_ID}"]`, { timeout: 10_000 });
  if (tooBig !== undefined) {
    await page.waitForSelector(`[data-testid="model-row-${tooBig.id}"]`, { timeout: 10_000 });
  }
  const onDevice = () =>
    page.$$eval('[data-testid^="model-row-"]', (els) =>
      els.map((el) => el.getAttribute('data-testid')?.slice('model-row-'.length) ?? ''),
    );
  const before = await onDevice();
  await page.click('[data-testid="filter-sort"]');
  await page.click('[data-testid="filter-only-fits"]');
  await page.waitForTimeout(500);
  const after = await onDevice();
  console.log(`fit filter: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  // The hub's own rule (ramVerdict): a model fits when the machine meets its minimum.
  const fitsHere = (m) => ramGB >= m.minRamGB;
  check(after.length > 0 || !fitsHere(model), 'the fit filter leaves something on screen');
  check(
    after.includes(MODEL_ID) === fitsHere(model),
    `it keeps ${MODEL_ID} exactly when it fits (${model.minRamGB} GB minimum, ${ramGB} GB here)`,
  );
  if (tooBig !== undefined) {
    check(
      !after.includes(tooBig.id) && after.length < before.length,
      `it hid the model that cannot load (${tooBig.id}, ${tooBig.minRamGB} GB minimum)`,
    );
  } else {
    console.log('  --   nothing in the catalog is too big for this machine; nothing to hide');
  }
  await shot('5-fits-only');
  await page.click('[data-testid="filter-only-fits"]');
  await page.keyboard.press('Escape');

  /*
   * ── The picker's action follows the SELECTED file ────────────────────────
   * With one quant on disk, picking another used to keep offering Verify /
   * Delete / Set active — and Set active would have loaded a file that is not
   * there. The picker's own button is that action now: "On disk" for the file
   * that is here, "Download" for one that is not.
   */
  await page.click(`[data-testid="model-row-${MODEL_ID}"]`);
  await page.waitForSelector('[data-testid="quant-picker"]', { timeout: 10_000 });
  const action = page.locator('[data-testid="quant-download"]');
  const actionState = async () => ({
    selected: await currentQuant(),
    action: ((await action.textContent()) ?? '').trim(),
    enabled: await action.isEnabled(),
  });
  let state = await actionState();
  check(
    state.selected === staged.quant && state.action === 'On disk' && !state.enabled,
    `the file on disk is the preselection, and its action says so (${JSON.stringify(state)})`,
  );
  await current.click();
  await page.waitForSelector('[data-testid="quant-menu"]', { timeout: 3000 });
  const local = await readMenu();
  printRows(local);
  check(
    local.every((r) => r.onDisk === (r.quant === staged.quant)),
    `"on disk" marks the ${staged.quant} rows and nothing else`,
  );
  const elsewhere = local.find((r) => r.from === 'list' && r.quant !== staged.quant);
  if (elsewhere !== undefined) {
    await page.locator(`[data-testid="quant-opt-list-${elsewhere.quant}"]`).first().click();
    state = await actionState();
    check(
      state.selected === elsewhere.quant && state.action === 'Download' && state.enabled,
      `picking ${elsewhere.quant}, which is not on disk, offers Download (${JSON.stringify(state)})`,
    );
    await shot('6-on-device-card');
    await current.click();
    await page.locator(`[data-testid="quant-opt-list-${staged.quant}"]`).first().click();
    state = await actionState();
    check(
      state.selected === staged.quant && state.action === 'On disk' && !state.enabled,
      `picking ${staged.quant} again turns it back to On disk (${JSON.stringify(state)})`,
    );
  } else {
    console.log(`  --   ${MODEL_ID} has one quant in the catalog; nothing to switch between`);
    await page.keyboard.press('Escape');
  }

  /*
   * ── The delete confirmation ──────────────────────────────────────────────
   * Deleting the 27B was one click on a ghost button: 14.4 GB and a 3m30s
   * re-download, with no dialog and no undo. Delete lives in Manage Storage now.
   * This opens it, reads it, and presses CANCEL — a probe must never destroy
   * what it is inspecting, staged or not.
   */
  await page.click('[data-testid="models-tab-storage"]');
  await page.waitForSelector('[data-testid="storage-library"]', { timeout: 15_000 });
  // The library names a model the way the catalog does, so search for that.
  await page.fill('[data-testid="storage-search"]', model.displayName);
  const node = page.locator(`[data-testid^="storage-row-"][data-path$="/LLM/${MODEL_ID}"]`).first();
  if ((await node.count()) === 0) {
    // An overview measured before the staging: measure again, as a person would.
    await page.click('[data-testid="storage-view"] button[aria-label="Measure again"]');
    await node.waitFor({ timeout: 15_000 });
  }
  await node.locator('[data-testid="storage-name"]').click();
  await page.click('[data-testid="inspector-delete"]');
  const dialog = page.locator('[data-testid="delete-model-dialog"]');
  await dialog.waitFor({ timeout: 5000 });
  // Photographed once it has faded in, not halfway.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );
  const said = ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  console.log(`delete dialog: "${said}"`);
  const frees = /([\d.]+) (KB|MB|GB|TB) goes to the Trash/.exec(said);
  check(frees !== null, `the delete dialog says what it frees ("${frees?.[0] ?? said}")`);
  const statedGB =
    Number(frees?.[1]) * ({ KB: 1e-6, MB: 1e-3, GB: 1, TB: 1e3 }[frees?.[2]] ?? Number.NaN);
  const heldGB = staged.bytes / 1e9;
  check(
    Math.abs(statedGB - heldGB) <= (heldGB >= 10 ? 0.51 : 0.051),
    `and that is what this model holds on disk (${frees?.[0]}, for ${heldGB.toFixed(2)} GB)`,
  );
  await shot('7-delete-confirm');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 3000 });
  check(existsSync(staged.at), 'Cancel closes the dialog without deleting');

  /*
   * ── The chat-screen download indicator, LOOKED AT ────────────────────────
   * The real 13 GB download proved the TEXT was right ("43%1m 48s left") but I
   * never saw it rendered. Injected through the store hook so the pixels can be
   * checked without another multi-gigabyte transfer — the numbers below are the
   * real ones observed mid-download.
   */
  await page.click('[data-testid="new-chat"]');
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 10_000 });
  await page.evaluate(() => {
    window.__llm_store?.().getState().applyDownloadProgress({
      modelId: 'qwen3.8-27b-mtp',
      file: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
      received: 5_800_000_000,
      total: 13_441_059_904,
      fraction: 0.43,
      fileIndex: 0,
      fileCount: 2,
      jobReceived: 5_800_000_000,
      jobTotal: 14_368_667_392,
    });
  });
  await page.waitForTimeout(400);
  // A second sample so a rate (and therefore an ETA) can be derived.
  await page.evaluate(() => {
    window.__llm_store?.().getState().applyDownloadProgress({
      modelId: 'qwen3.8-27b-mtp',
      file: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
      received: 6_200_000_000,
      total: 13_441_059_904,
      fraction: 0.46,
      fileIndex: 0,
      fileCount: 2,
      jobReceived: 6_200_000_000,
      jobTotal: 14_368_667_392,
    });
  });
  await page.waitForTimeout(600);
  // The indicator is the task tray's Downloads group now (the user: nothing in the
  // input area); a model download reads in bytes, received / total.
  const footer = page.locator('[data-testid="task-tray"]');
  check((await footer.count()) > 0, 'the chat screen shows a download indicator (the tray button)');
  if ((await footer.count()) > 0) {
    await footer.click();
    await page.waitForSelector('[data-testid="task-tray-panel"]', { timeout: 3000 });
    const text = (await page.locator('[data-testid="tray-downloads"]').textContent())?.trim() ?? '';
    console.log(`tray panel: "${text}"`);
    check(/\d+(\.\d)? \/ \d+(\.\d)? GB|\d+%/.test(text), `the indicator says how far ("${text}")`);
    await shot('8-footer-download');
    const box = await footer.boundingBox();
    check(
      box !== null && box.width > 16 && box.height > 16,
      `the indicator has real size on screen (${JSON.stringify(box)})`,
    );
    await page.keyboard.press('Escape');
  }

  // ── Nothing was started for the staged files ─────────────────────────────
  const phases = await page.evaluate(() => window.__phases ?? []);
  check(
    phases.length > 0 && !phases.some((p) => p === 'starting' || p === 'ready'),
    `no model server started during the run (status: ${phases.join(' → ')})`,
  );
} catch (error) {
  if (!(error instanceof Stop)) {
    console.error(error);
    record(false, `the probe threw: ${String(error?.message ?? error).split('\n')[0]}`);
  }
} finally {
  await finish();
}
console.log(`\nscreenshots: ${shotDir}`);
