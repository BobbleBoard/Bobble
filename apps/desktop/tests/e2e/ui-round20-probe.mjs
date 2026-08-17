/**
 * ROUND-20 UI BATCH: harness tiles, the size slider, the restyled dropup.
 *
 * All three are things a unit test cannot see and the user asked for by looking at a
 * screenshot, so this drives the real app and reads the real DOM:
 *
 *   1. HARNESS TILES — the user: "not rendering properly in this case… especially
 *      the background for the icon is important, for example the free floating
 *      pi looks odd in ours still." Codex and Hermes were EMPTY circles because
 *      the old helper returned null for marks we don't ship. The check is that
 *      every harness row has a tile with a non-transparent background AND
 *      something drawn inside it — an empty tile is the bug we just fixed, so
 *      "the element exists" is not the assertion worth making.
 *
 *   2. THE SIZE SLIDER — must exist for both models and datasets, and moving it
 *      must actually reduce the row count. A control that renders and filters
 *      nothing is the "only show models that fit" bug all over again.
 *
 *   3. THE DROPUP — the user: it "needs to be restyled to be the same as all other
 *      dropdowns/ups in the app". The bespoke bit was a SegmentedControl inside
 *      a menu, so the assertion is that no segmented control remains in there
 *      and the mode rows are ordinary menu items like everything else.
 *
 * Isolated userData: the single-instance lock lives there and a shared one would
 * steal focus from a running Bobble.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.OUT ?? path.join(appRoot, '.probe-shots');

const SIZE_CAP_MAX = 200;
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

if (!existsSync(path.join(appRoot, 'dist/index.html'))) {
  throw new Error('app is not built — run `npm run build` first');
}

mkdirSync(OUT, { recursive: true });
const userDataDir = mkdtempSync(path.join(tmpdir(), 'pi-round20-udd-'));

const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="boot-state"]', { timeout: 20_000 });
  await page.addStyleTag({
    content: '[data-testid="first-run-tips"]{display:none !important}',
  });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 20_000 });

  /* ------------------------------------------- 0. the collapsed top-left corner */
  /*
   * THREE THINGS SHARE THIS CORNER: the macOS traffic lights (~x<78), the
   * sidebar toggle, and the conversation title. The title's inset was written
   * against a 64px collapsed RAIL; the curtain change made that 0px and nothing
   * replaced the gap, so the title landed at x=46 — through the lights and
   * under the toggle. the user: "the left sidebar expand/collapse button doesn't
   * work at all anymore." It was there; clicks were landing on a title drawn on
   * top of it. Geometry, not appearance, is what makes that visible to a test.
   */
  console.log('\ncollapsed corner');
  await page.evaluate(() => document.querySelector('[data-testid="collapse-sidebar"]')?.click());
  await page.waitForTimeout(900);
  const corner = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="expand-sidebar"]');
    const b = btn?.getBoundingClientRect();
    const title = [...document.querySelectorAll('div,span')].find(
      (e) => e.children.length === 0 && /New chat/.test(e.textContent ?? ''),
    );
    const t = title?.getBoundingClientRect();
    const hit =
      b === undefined ? null : document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return {
      slot: Math.round(
        document.querySelector('.pd-sidebar-slot')?.getBoundingClientRect().width ?? -1,
      ),
      titleX: t === undefined ? null : Math.round(t.x),
      btnRight: b === undefined ? null : Math.round(b.right),
      clearsLights: t === undefined ? null : t.x >= 78,
      clearsButton: t === undefined || b === undefined ? null : t.x >= b.right,
      hitIsButton: hit !== null && btn?.contains(hit) === true,
    };
  });
  check(corner.slot === 0, `collapsing closes the sidebar fully (${corner.slot}px)`);
  check(corner.clearsLights === true, `the title clears the traffic lights (x=${corner.titleX})`);
  check(
    corner.clearsButton === true,
    `the title starts after the toggle (x=${corner.titleX} vs button right ${corner.btnRight})`,
  );
  check(corner.hitIsButton === true, 'a click at the toggle reaches the toggle, not the title');
  /*
   * AND NOTHING DRAGGABLE MAY COVER IT. the user, after the first fix: "the left
   * sidebar button is NOT CLICKABLE doesn't have any hover or click." macOS
   * claims mouse events inside a `-webkit-app-region: drag` rect BEFORE the
   * renderer sees them, so a covered button loses hover as well as clicks — and
   * a Playwright click still "passes", because CDP injects below that layer.
   * This is the invariant that governs real input; the hit test above cannot
   * see it.
   */
  const region = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="expand-sidebar"]');
    if (btn === null) return { governing: 'no toggle', stack: [] };
    const r = btn.getBoundingClientRect();
    /*
     * Which region GOVERNS this point. Chromium unions the `drag` rects and
     * subtracts the `no-drag` ones, so an ancestor bar being draggable is fine
     * as long as something nearer the top of the stack opts out — what is fatal
     * is the topmost opt-in winning, which is what `.pd-sidebar-tl` did.
     */
    const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).map((el) => ({
      el: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`,
      region: getComputedStyle(el).webkitAppRegion,
    }));
    const governing = stack.find((e) => e.region === 'drag' || e.region === 'no-drag');
    return { governing: governing?.region ?? 'none', stack: stack.slice(0, 5) };
  });
  check(
    region.governing === 'no-drag',
    `the toggle sits in a no-drag region (governing: ${region.governing})`,
  );
  console.log(`     region stack: ${region.stack.map((e) => `${e.el}:${e.region}`).join(' > ')}`);
  await page.screenshot({ path: path.join(OUT, 'r20-00-collapsed.png') });
  await page.evaluate(() => document.querySelector('[data-testid="expand-sidebar"]')?.click());
  await page.waitForTimeout(900);
  const reopened = await page.evaluate(() =>
    Math.round(document.querySelector('.pd-sidebar-slot')?.getBoundingClientRect().width ?? -1),
  );
  check(reopened > 200, `the toggle round-trips back open (${reopened}px)`);

  /* ------------------------------------------------------- 3. profile dropup */
  console.log('\nprofile dropup');
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'r20-01-dropup.png') });

  const dropup = await page.evaluate(() => {
    const menu = document.querySelector('[data-testid="profile-menu"]');
    if (menu === null) return null;
    const cs = getComputedStyle(menu);
    return {
      // The bespoke block: a segmented control no other menu in the app has.
      segmented: menu.querySelectorAll('[role="radiogroup"], .pd-segmented').length,
      items: menu.querySelectorAll('[role="menuitem"]').length,
      // The User / Power-user toggle was removed outright (the user).
      modeRows: document.querySelectorAll('[data-testid^="usermode-"]').length,
      // Every menu draws from the one recipe: shared class, no open animation.
      isPdMenu: menu.classList.contains('pd-menu'),
      animation: cs.animationName,
      settingsRow: document.querySelector('[data-testid="open-settings"]') !== null,
      radius: cs.borderRadius,
      bg: cs.backgroundColor,
    };
  });
  check(dropup !== null, 'the dropup opens');
  check(
    dropup?.segmented === 0,
    `no segmented control left inside the menu (${dropup?.segmented})`,
  );
  check(dropup?.modeRows === 0, `the User/Power-user toggle is gone (${dropup?.modeRows} rows)`);
  check(dropup?.items >= 2, `menu has its rows (${dropup?.items})`);
  check(dropup?.isPdMenu === true, 'the dropup uses the shared .pd-menu surface');
  check(dropup?.animation === 'none', `the dropup opens instantly (${dropup?.animation})`);
  check(dropup?.settingsRow === true, 'the open-settings row still exists (11 probes click it)');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  /* --------------------------------------------------------- 1. harness tiles */
  console.log('\nharness tiles');
  await page.click('[data-testid="profile-button"]');
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 10_000 });
  const harnessNav = await page.$('[data-testid="settings-nav-harness"]');
  if (harnessNav === null) {
    failures.push('no harness section in the settings nav');
  } else {
    await harnessNav.click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'r20-02-harness.png') });

    const tiles = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid^="harness-row-"]')];
      return rows.map((row) => {
        const id = row.getAttribute('data-testid').replace('harness-row-', '');
        const tile = row.querySelector('[data-testid^="harness-icon-"]');
        if (tile === null) return { id, tile: false };
        const cs = getComputedStyle(tile);
        return {
          id,
          tile: true,
          bg: cs.backgroundColor,
          // Something has to be DRAWN in it: an svg mark or a monogram letter.
          glyph: tile.querySelector('svg') !== null || tile.textContent.trim().length > 0,
          box: tile.getBoundingClientRect().width,
        };
      });
    });
    check(tiles.length >= 3, `harness rows present (${tiles.length})`);
    /* the user: "can you seriously not find any chatgpt / openai logo?" Codex and
       Hermes have real marks now, so a letter in either tile is a regression. */
    const marks = await page.evaluate(() =>
      ['codex', 'hermes'].map((id) => {
        const svg = document.querySelector(`[data-testid="harness-icon-${id}"] svg`);
        return {
          id,
          label: svg?.getAttribute('aria-label') ?? null,
          paths: svg?.querySelectorAll('path').length ?? 0,
        };
      }),
    );
    for (const m of marks) {
      check(m.paths > 0, `${m.id}: draws a real mark, not a monogram (${m.paths} paths)`);
      check(m.label !== null, `${m.id}: the mark names itself ("${m.label}")`);
    }
    for (const t of tiles) {
      check(t.tile === true, `${t.id}: has an icon tile`);
      check(t.glyph === true, `${t.id}: the tile is not empty`);
      const transparent = t.bg === 'rgba(0, 0, 0, 0)' || t.bg === 'transparent';
      check(!transparent, `${t.id}: the tile has a real background (${t.bg})`);
      check(t.box >= 24, `${t.id}: the tile is sized (${Math.round(t.box)}px)`);
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  /* ---------------------------------------------------------- 2. size slider */
  console.log('\nsize slider');
  /* The hub is NOT a settings section any more, so there is no settings-nav row
     for it. The user's way in is the composer's model chip -> "More models",
     which only appears in Power mode (set above). */
  await page.click('[data-testid="footer-model-chip"]');
  await page.waitForSelector('[data-testid="footer-open-manager"]', { timeout: 5000 });
  await page.click('[data-testid="footer-open-manager"]');
  await page.waitForSelector('[data-testid="models-view"]', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'r20-03-models.png') });

  /*
   * THE SIZE COLUMN MUST NOT CONTRADICT THE NAME.
   *
   * HF's `gguf.total` describes one file it indexed, so trusting it over the
   * repo name printed "0.0B" beside a repo called "…-27B-…". Only a screenshot
   * showed it; this check is what keeps it visible without one.
   */
  const contradictions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="model-row-"]')]
      .map((row) => {
        const text = row.textContent ?? '';
        const named = /(\d+(?:\.\d+)?)\s*[bB](?![a-z])/.exec(row.getAttribute('data-testid') ?? '');
        const shown = /(\d+(?:\.\d+)?)B(?!\w)/.exec(text.replace(/^[^]*?—/, ''));
        if (named === null || shown === null) return null;
        const a = Number(named[1]);
        const b = Number(shown[1]);
        // Allow rounding, reject a different order of magnitude.
        return Math.abs(a - b) > Math.max(1, a * 0.25)
          ? `${row.getAttribute('data-testid')}: name says ${a}B, column says ${b}B`
          : null;
      })
      .filter((x) => x !== null),
  );
  check(
    contradictions.length === 0,
    `no row's size contradicts its name (${contradictions.slice(0, 3).join('; ') || 'none'})`,
  );

  for (const kind of ['models', 'datasets']) {
    const tab = await page.$(`[data-testid="hub-kind-${kind}"]`);
    if (tab !== null) {
      await tab.click();
      await page.waitForTimeout(1200);
    }
    const slider = await page.$('[data-testid="filter-size"] input[type="range"]');
    check(slider !== null, `${kind}: the size slider is present`);
    if (slider === null) continue;

    /*
     * SWEEP THE CAP rather than test one value. A filter that returns
     * everything or nothing at every setting looks like it works from a single
     * assertion — this is exactly how "only show models that fit" shipped
     * hiding all 19 rows. A monotonic curve with at least one INTERMEDIATE
     * count is the evidence that the cap is reading real sizes.
     */
    const setCap = async (v) => {
      await page.evaluate((val) => {
        const el = document.querySelector('[data-testid="filter-size"] input[type="range"]');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        setter.call(el, String(val));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, v);
      await page.waitForTimeout(450);
      return page.evaluate(() => document.querySelectorAll('[data-testid^="model-row-"]').length);
    };

    const caps = [200, 60, 30, 12, 6, 2];
    const counts = [];
    for (const c of caps) counts.push(await setCap(c));
    console.log(`     ${kind}: ${caps.map((c, i) => `${c}GB=${counts[i]}`).join('  ')}`);

    const monotonic = counts.every((n, i) => i === 0 || n <= counts[i - 1]);
    check(monotonic, `${kind}: lowering the cap never adds rows`);
    const intermediate = counts.some((n, i) => i > 0 && n > 0 && n < counts[0]);
    check(
      intermediate,
      `${kind}: some cap hides SOME rows, not all-or-nothing (${counts.join('/')})`,
    );

    /* The unit MUST be on the label. Datasets cap real bytes; a Discover repo
       has only a parameter count, so a bare "≤ 2" would be a lie on one of the
       two tabs whichever unit we picked. */
    const label = await page.textContent('[data-testid="filter-size"] span');
    const wantUnit = kind === 'datasets' ? '2 GB' : '2B params';
    check(
      label?.includes(wantUnit) === true,
      `${kind}: the slider names its unit (want "${wantUnit}", got "${label}")`,
    );
    // Back to no cap so the next tab starts clean.
    await setCap(SIZE_CAP_MAX);
    if (kind === 'datasets') {
      /*
       * The hub must not tell someone their PUBLIC dataset is gated. `detail`
       * falls back to rows[0], which sent a dataset id to hf:list-files — a
       * /api/models path that 401s for a dataset — and the 401 branch printed
       * "This repo is gated or private. Paste a Hugging Face token".
       */
      const gatedLie = await page.isVisible('[data-testid="hf-token-row"]').catch(() => false);
      check(!gatedLie, 'datasets: no bogus "this repo is gated" token prompt');
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="model-row-"]')]
          .map((r) => r.textContent)
          .join(' '),
      );
      check(!/\d{4,} GB/.test(sizes), 'datasets: sizes read as TB, not five-digit GB');
      const header = await page.evaluate(
        () =>
          [...document.querySelectorAll('span')].find((e) =>
            ['Model', 'Dataset'].includes(e.textContent.trim()),
          )?.textContent ?? '',
      );
      check(header.trim() === 'Dataset', `datasets: the column is headed "Dataset" (${header})`);
      await page.screenshot({ path: path.join(OUT, 'r20-04-datasets-capped.png') });
    }
  }

  /* --------------------------------------------------- 4. the dataset card */
  console.log('\ndataset card');
  await page.click('[data-testid="hub-kind-datasets"]');
  await page.waitForTimeout(1500);
  // The card lives in the split pane; compact has none, and clicking a row
  // switches to it — the same path a user takes.
  const firstRow = await page.$('[data-testid^="model-row-"]');
  if (firstRow === null) {
    failures.push('no dataset rows to open');
  } else {
    await firstRow.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, 'r20-05-dataset-card.png') });

    const card = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="model-card-body"]');
      return {
        present: body !== null,
        chars: body?.textContent?.trim().length ?? 0,
        headings: body?.querySelectorAll('h1,h2,h3').length ?? 0,
        links: body?.querySelectorAll('a').length ?? 0,
        // The picker's loading state never resolves for a dataset.
        quantSpinner: document.querySelector('[data-testid="quant-picker-loading"]') !== null,
        openBtn: document.querySelector('[data-testid="dataset-open"]') !== null,
        // Frontmatter is metadata; a card that opens with "annotations_creators:"
        // is the raw file, not a document.
        rawFrontmatter: /^(annotations_creators|license|task_categories):/m.test(
          body?.textContent ?? '',
        ),
      };
    });
    check(card.present, 'a dataset renders a card at all');
    check(card.chars > 200, `the dataset card has real content (${card.chars} chars)`);
    check(card.headings > 0, `the dataset card renders headings (${card.headings})`);
    check(!card.quantSpinner, 'no quant picker spinning "Loading files…" on a dataset');
    check(card.openBtn, 'the dataset offers "Open on Hugging Face" instead of a quant ladder');
    check(!card.rawFrontmatter, 'frontmatter is stripped from the dataset card');
    console.log(`     card: ${card.chars} chars, ${card.headings} headings, ${card.links} links`);
  }

  /* ------------------------------------------------------- 5. the quant menu */
  console.log('\nquant menu');
  await page.click('[data-testid="hub-kind-models"]');
  await page.waitForTimeout(1500);
  const firstModel = await page.$('[data-testid^="model-row-"]');
  if (firstModel !== null) {
    await firstModel.click();
    await page.waitForTimeout(2500);
    const trigger = await page.$('[data-testid="quant-current"]');
    if (trigger === null) {
      console.log('     no quant ladder on this model — skipped');
    } else {
      await trigger.click();
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid^="quant-opt-"]')];
        const list = rows.filter((r) => r.dataset.testid.startsWith('quant-opt-list-'));
        /* Read the exact bytes off the size cell rather than scraping row text:
           "BF16" + "37 GB" concatenates to "1637 GB" and a regex believes it. */
        const sizes = list.map((r) =>
          Number(r.querySelector('[data-testid="quant-size"]')?.getAttribute('data-bytes') ?? NaN),
        );
        return {
          pinned: rows.filter((r) => r.dataset.testid.startsWith('quant-opt-pinned-')).length,
          list: list.length,
          sizes,
          selected: rows.filter((r) => r.dataset.selected === 'true').map((r) => r.dataset.testid),
          rowH: Math.round(rows[0]?.getBoundingClientRect().height ?? 0),
          dlH: Math.round(
            document.querySelector('[data-testid="quant-download"]')?.getBoundingClientRect()
              .height ?? 0,
          ),
          overscroll: getComputedStyle(document.querySelector('[data-testid="quant-menu"]'))
            .overscrollBehaviorY,
          // The full-screen close overlay is what stopped the card scrolling.
          overlays: document.querySelectorAll('.fixed.inset-0').length,
          verdictText: rows.some((r) => /Tight|Won't fit|Fits/.test(r.textContent ?? '')),
        };
      });
      check(m.pinned === 1, `exactly one pinned Recommended row (${m.pinned})`);
      const descending = m.sizes.every((n, i) => i === 0 || Number.isNaN(n) || n <= m.sizes[i - 1]);
      check(descending, `the list runs largest to smallest (${m.sizes.slice(0, 5).join(' > ')})`);
      check(
        m.selected.length === 1 && m.selected[0].startsWith('quant-opt-pinned-'),
        `the recommendation is live by default (${m.selected.join(',') || 'none'})`,
      );
      check(
        Math.abs(m.rowH - m.dlH) <= 4,
        `row height matches the Download button (${m.rowH} vs ${m.dlH})`,
      );
      check(m.overscroll === 'contain', `the menu does not chain its scroll (${m.overscroll})`);
      check(m.overlays === 0, `no full-screen overlay blocking the page (${m.overlays})`);
      check(!m.verdictText, 'no "Fits"/"Tight" text in rows — the dot owns the verdict');

      /* The subtle half of the spec: the pinned row and its in-list twin are
         SEPARATE selections even though they download the same file. */
      const twin = await page.$(
        `[data-testid="quant-opt-list-${m.selected[0]?.replace('quant-opt-pinned-', '')}"]`,
      );
      if (twin !== null) {
        await twin.click();
        await page.waitForTimeout(300);
        await trigger.click();
        await page.waitForTimeout(300);
        const after = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="quant-opt-"]')]
            .filter((r) => r.dataset.selected === 'true')
            .map((r) => r.dataset.testid),
        );
        check(
          after.length === 1 && after[0].startsWith('quant-opt-list-'),
          `clicking the in-list twin moves the highlight to it (${after.join(',') || 'none'})`,
        );
      }
      await page.screenshot({ path: path.join(OUT, 'r20-06-quants.png') });
    }
  }

  console.log(
    failures.length === 0
      ? '\nui-round20-probe: all checks passed'
      : `\nui-round20-probe: ${failures.length} FAILURE(S)\n - ${failures.join('\n - ')}`,
  );
  console.log(`shots in ${OUT}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
}
