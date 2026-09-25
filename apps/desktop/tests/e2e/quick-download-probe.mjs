/**
 * QUICK DOWNLOAD FETCHES WHAT TOP RECOMMENDED WOULD — read off the real hub.
 *
 * Every family card's Quick Download is the recommender's judgement scoped to
 * that family, and it only agrees with Top Recommended when both decide against
 * the same machine. FamilyCard used to hand the recommender total RAM (24 GB on
 * a 24 GB Mac) while Top Recommended used `hostFor(hardware)` (18 GB), so on
 * this Mac Mage Flow's Quick Download fetched Turbo · bf16 — marked Tight on
 * its own row — beside Top Recommended's Turbo · int8.
 *
 * This drives the hub on THIS machine's detected hardware, in a throwaway HOME,
 * and for every family:
 *   · reads the Quick Download's data-repo and data-variant (the repo alone is
 *     not the variant: Mage Flow's recipes are one repo) and checks them against
 *     `quickPickFor(family, hostFor(hardware))`, the recommender's own call,
 *     imported from source;
 *   · checks every Top Recommended card against its family's Quick Download;
 *   · checks a recipe's Quick Download never lands on a row marked Tight or Too
 *     large (on unified memory, where the rows are judged on the same RAM);
 *   · clicks every Quick Download and Top Recommended Download with the
 *     channels that start a download refused in main (harness.mjs `refuseIpc`),
 *     and checks the request names that variant's files: a recipe's own (its
 *     `allow`, a GGUF recipe's named file included), else a file of its repo.
 *     Nothing downloads.
 * Printed alongside: what total RAM, the old budget, would have fetched.
 *
 *   node scripts/with-lock.mjs probe -- node apps/desktop/tests/e2e/quick-download-probe.mjs
 *
 * Build first. A text family's click reads its repo's listing from Hugging
 * Face, so this needs the network. Screenshots land in $SHOT_DIR, else
 * $TMPDIR/pd-shots/quick-download; each changed family's card is shot open,
 * with the row its Quick Download fetches outlined by the probe.
 */
import './_ts-source.mjs';
import path from 'node:path';
import { launchApp, refuseIpc } from './harness.mjs';

const { hostFor, quickPickFor, recommendAll } = await import(
  '../../src/models/model-recommender.ts'
);
const { installKindOf, RECOMMENDED_FAMILIES } = await import(
  '../../src/models/recommended-catalog.ts'
);

const {
  app,
  page,
  check: record,
  finish,
  shotDir,
} = await launchApp('quick-download', {
  waitFor: null,
});

page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error:', m.text().slice(0, 200));
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

/** The channels that start a download: refused and recorded in main. */
const STARTS_A_DOWNLOAD = ['hf:register', 'llm:download-model', 'store:download'];
let refused = { calls: async () => [] };

/** "repo · label" — how a variant is named here, since a repo can hold several. */
const named = (v) =>
  v === undefined || v === null || v.repo === null ? '—' : `${v.repo} · ${v.label ?? v.variant}`;
const pickNamed = (p) => (p === undefined ? '—' : named(p.variant));
const said = (p) =>
  p === undefined
    ? '—'
    : `${p.variant.label}${p.quant === undefined ? '' : ` ${p.quant.rung.quant}`} · ${p.needsGB} GB`;

/**
 * Everything the hub offers, as the DOM has it: each family card's Quick
 * Download (and the verdict its variant's own row shows), and each Top
 * Recommended card.
 */
const readHub = () =>
  page.evaluate(() => {
    const families = [...document.querySelectorAll('[data-testid^="family-card-"]')].map((el) => {
      const id = (el.getAttribute('data-testid') ?? '').slice('family-card-'.length);
      const q = el.querySelector(
        `[data-testid="family-quick-${id}"], [data-testid="family-quick-use-${id}"]`,
      );
      if (q === null) return { id, quick: null };
      const repo = q.getAttribute('data-repo');
      const variant = q.getAttribute('data-variant');
      const row = [...el.querySelectorAll('[data-testid^="family-variant-"]')].find(
        (r) => r.getAttribute('data-testid') === `family-variant-${repo}:${variant}`,
      );
      const pill = row?.querySelector('[data-testid^="fit-"]');
      return {
        id,
        quick: {
          repo,
          variant,
          title: q.getAttribute('title'),
          text: q.textContent?.trim() ?? '',
          row: row !== undefined,
          verdict: pill === null || pill === undefined ? 'fits' : pill.getAttribute('data-testid'),
        },
      };
    });
    const best = [...document.querySelectorAll('[data-testid^="best-"]')]
      .filter((el) =>
        /^best-(text|image|video|audio|3d)$/.test(el.getAttribute('data-testid') ?? ''),
      )
      .map((el) => ({
        modality: (el.getAttribute('data-testid') ?? '').slice('best-'.length),
        repo: el.getAttribute('data-repo'),
        variant: el.getAttribute('data-variant'),
        text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      }));
    return { families, best };
  });

/**
 * Click, then wait for the request that click sends to `channel` — or say why
 * none came. A refused request comes back within milliseconds; a text family
 * first reads its repo's listing from Hugging Face, hence the long wait.
 */
async function requestAfter(click, what, channel) {
  const before = (await refused.calls()).length;
  await click();
  const until = Date.now() + 30_000;
  let heard = [];
  while (Date.now() < until) {
    heard = (await refused.calls()).slice(before);
    if (heard.some((c) => c.channel === channel)) break;
    await page.waitForTimeout(100);
  }
  // Let the click unwind (a text download clears its busy state after a
  // catalog refresh) before the next one.
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="quant-download"]')?.textContent?.trim() !==
        'Downloading…',
      undefined,
      { timeout: 8000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(250);
  const call = heard.find((c) => c.channel === channel);
  const banner =
    (await page
      .locator('[data-testid="models-error"]')
      .textContent({ timeout: 300 })
      .catch(() => null)) ?? null;
  return { what, request: call?.request, heard: heard.map((c) => c.channel), banner };
}

/** Does a repo path match one of a recipe's `*` globs (`UD-IQ3_XXS/*`, a file name)? */
const globbed = (allow, p) =>
  allow.some((g) =>
    new RegExp(
      `^${g
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')}$`,
    ).test(p),
  );

/** What a request asks for, in one line — the recipe's files, or the GGUF file. */
function asked(channel, request) {
  if (request === undefined) return undefined;
  if (channel === 'store:download') {
    return `${request.repo} [${(request.allow ?? ['(whole repo)']).join(', ')}]`;
  }
  const f = request.file;
  return `${request.hit?.id} → ${f?.path} (${((f?.sizeBytes ?? 0) / 1e9).toFixed(2)} GB)`;
}

try {
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 });
  /*
   * The refusal goes in before anything on the page can be clicked, and proves
   * itself: a page-side invoke must come back refused, and be heard in main.
   */
  refused = await refuseIpc(app, STARTS_A_DOWNLOAD);
  const selfTest = await page.evaluate(() =>
    window.piDesktop.invoke('llm:download-model', { modelId: '__probe_self_test__' }).then(
      () => 'it went through',
      (e) => String(e?.message ?? e),
    ),
  );
  need(
    /refused by the probe/.test(selfTest) &&
      (await refused.calls()).some((c) => c.request?.modelId === '__probe_self_test__'),
    `downloads are refused in main, and a page-side invoke is heard there ("${selfTest}")`,
  );

  // ── The hub, on this machine's hardware ──────────────────────────────────
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
  const strip = (await page.textContent('[data-testid="hardware-strip"]')) ?? '';
  const ramGB = Number(/(\d+)\s*GB RAM/.exec(strip)?.[1]);
  need(hardware !== null && ramGB > 0, `the hub knows this machine (${ramGB} GB RAM)`);
  const host = hostFor(hardware);
  console.log(`hardware: ${JSON.stringify(hardware)}`);
  console.log(
    `host (Top Recommended's budget): ${host.usableMemoryGB} GB of ${host.totalRamGB} GB; the hardware strip says ${ramGB} GB`,
  );

  // Recommended waits out the hub's first Hugging Face search before it shows.
  await page.waitForSelector('[data-testid="curated-families"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="best-for-your-machine"]', { timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot('1-hub');
  // Each Top Recommended card on its own: the row scrolls sideways, and only
  // two of five are in view at this width.
  for (const m of ['text', 'image', 'video', 'audio', '3d']) {
    const card = page.locator(`[data-testid="best-${m}"]`);
    if ((await card.count()) > 0) await shot(`1b-best-${m}`, card);
  }

  // ── Every family's Quick Download, against the recommender on the host ───
  const hub = await readHub();
  const byId = new Map(RECOMMENDED_FAMILIES.map((f) => [f.id, f]));
  const onScreen = hub.families.filter((f) => byId.has(f.id));
  check(
    onScreen.length === RECOMMENDED_FAMILIES.length,
    `every curated family is on screen (${onScreen.length} of ${RECOMMENDED_FAMILIES.length})`,
  );
  check(
    host.totalRamGB === ramGB,
    `the host's RAM is the hardware strip's (${host.totalRamGB} vs ${ramGB} GB)`,
  );
  const oldBudget = { usableMemoryGB: ramGB, totalRamGB: ramGB };
  const changed = [];
  console.log(
    `\nevery family's Quick Download (★ = Top Recommended picks from it) — on screen, then the recommender at ${host.usableMemoryGB} GB:`,
  );
  for (const { id, quick } of onScreen) {
    const family = byId.get(id);
    const want = quickPickFor(family, host);
    const atTotal = quickPickFor(family, oldBudget);
    if (pickNamed(atTotal) !== pickNamed(want)) changed.push(id);
    const top = Object.values(recommendAll(host)).some((r) => r.family.id === id);
    const got =
      quick === null
        ? '—'
        : `${quick.variant}${quick.verdict === 'fits' ? '' : ` [${quick.verdict}]`}`;
    console.log(
      `  ${top ? '★' : ' '} ${family.name.padEnd(22)} ${got.padEnd(30)} want ${said(want).padEnd(32)}${pickNamed(atTotal) === pickNamed(want) ? '' : `  (${ramGB} GB would take ${said(atTotal)})`}`,
    );
  }
  for (const { id, quick } of onScreen) {
    const family = byId.get(id);
    const want = quickPickFor(family, host);
    check(
      named(quick) === pickNamed(want),
      `${family.name}: Quick Download is ${named(quick)}, the recommender's pick on ${host.usableMemoryGB} GB is ${pickNamed(want)}`,
    );
  }
  // A recipe's row is judged on the same RAM the host is three quarters of.
  if (hardware.unifiedMemory !== false) {
    for (const { id, quick } of onScreen) {
      const family = byId.get(id);
      if (quick === null || installKindOf(family) === 'gguf') continue;
      check(
        quick.row && quick.verdict === 'fits',
        `${family.name}: the recipe Quick Download fetches (${quick.variant}) is not marked Tight or Too large on its own row (${quick.row ? quick.verdict : 'no such row'})`,
      );
    }
  }

  // ── Top Recommended against each family's Quick Download ─────────────────
  const top = recommendAll(host);
  const modalities = Object.keys(top);
  need(
    hub.best.map((b) => b.modality).join(',') === modalities.join(','),
    `Top Recommended shows a card for ${modalities.join(', ')} (${hub.best.map((b) => b.modality).join(', ')})`,
  );
  for (const best of hub.best) {
    const rec = top[best.modality];
    const quick = onScreen.find((f) => f.id === rec.family.id)?.quick ?? null;
    console.log(`  Top Recommended ${best.modality.padEnd(5)} "${best.text}"`);
    check(
      named(best) === named(rec.variant),
      `Top Recommended's ${best.modality} card is the recommender's pick, ${named(rec.variant)}`,
    );
    check(
      named(quick) === named(best),
      `${rec.family.name}'s Quick Download is Top Recommended's ${best.modality} pick: ${named(quick)} vs ${named(best)}`,
    );
  }

  // ── LOOK: each family this budget changes, opened, its pick outlined ─────
  console.log(
    `\nfamilies whose pick differs between ${ramGB} GB and ${host.usableMemoryGB} GB here: ${changed.join(', ') || 'none'}`,
  );
  for (const id of changed) {
    const card = page.locator(`[data-testid="family-card-${id}"]`);
    await card.scrollIntoViewIfNeeded();
    if ((await card.getAttribute('data-open')) !== 'true') {
      await page.click(`[data-testid="family-toggle-${id}"]`);
      // The card grows over 200 ms, then releases to auto.
      await page.waitForTimeout(450);
    }
    /*
     * The probe's own marking: an outline on the row Quick Download fetches and
     * a caption strip under the card saying which — below the rows rather than
     * on them, so it covers none of the pills it is there to show.
     */
    const marked = await card.evaluate((el, familyId) => {
      const q = el.querySelector(`[data-testid="family-quick-${familyId}"]`);
      const row =
        q === null
          ? undefined
          : [...el.querySelectorAll('[data-testid^="family-variant-"]')].find(
              (r) =>
                r.getAttribute('data-testid') ===
                `family-variant-${q.getAttribute('data-repo')}:${q.getAttribute('data-variant')}`,
            );
      if (row !== undefined) {
        row.style.outline = '2px solid #ff2d55';
        row.style.outlineOffset = '-2px';
      }
      const caption = document.createElement('div');
      caption.dataset.probeMark = '';
      caption.textContent =
        q === null
          ? 'Probe: this card has no Quick Download'
          : `Probe: Quick Download fetches “${q.getAttribute('data-variant')}” (outlined)`;
      caption.style.cssText =
        'background:#ff2d55;color:#fff;font:600 12px/1.4 -apple-system,system-ui;padding:6px 12px';
      el.appendChild(caption);
      return q === null ? 'no Quick Download' : (q.getAttribute('data-variant') ?? '?');
    }, id);
    console.log(`  shot ${id}: ${marked}`);
    await shot(`2-${id}`, card);
    await card.evaluate((el) => {
      for (const m of el.querySelectorAll('[data-probe-mark]')) m.remove();
      for (const r of el.querySelectorAll('[data-testid^="family-variant-"]')) {
        r.style.outline = '';
        r.style.outlineOffset = '';
      }
    });
    await page.click(`[data-testid="family-toggle-${id}"]`);
    await page.waitForTimeout(350);
  }

  // ── What each click asks for ─────────────────────────────────────────────
  /*
   * The attributes say what the button holds; the click is what it does. Each
   * one ends at a refused request in main whose body names the files: a recipe's
   * repo and globs, or the GGUF file the repo's listing resolved to.
   */
  refused = await refuseIpc(app, STARTS_A_DOWNLOAD);
  const quickAsked = new Map();
  for (const { id, quick } of onScreen) {
    if (quick === null || quick.text !== 'Quick Download') continue;
    const family = byId.get(id);
    const want = quickPickFor(family, host)?.variant;
    const channel = installKindOf(family) === 'gguf' ? 'hf:register' : 'store:download';
    const r = await requestAfter(
      () => page.click(`[data-testid="family-quick-${id}"]`, { timeout: 5000 }),
      `${family.name} Quick Download`,
      channel,
    );
    quickAsked.set(id, r);
    console.log(
      `  ${r.what.padEnd(34)} → ${asked(channel, r.request) ?? `nothing (${r.heard.join(', ') || 'no request'}; the page says: ${r.banner})`}`,
    );
    if (channel === 'store:download') {
      check(
        want !== undefined &&
          r.request?.repo === want.repo &&
          JSON.stringify(r.request?.allow ?? null) === JSON.stringify(want.allow ?? null) &&
          r.request?.name === `${family.name} ${want.label}`,
        `${family.name}'s Quick Download asks for ${named(want)}'s files`,
      );
    } else {
      /*
       * A GGUF file is the listing's pick within the repo — unless the variant
       * is a RECIPE that names its file (Ling 3.0's "tiny · Q4" is
       * Ling-3.0-tiny-UD-Q4_K_XL.gguf), and then it must be that file.
       */
      const path = r.request?.file?.path;
      check(
        want !== undefined &&
          r.request?.hit?.id === want.repo &&
          path !== undefined &&
          (want.allow === undefined || globbed(want.allow, path)),
        `${family.name}'s Quick Download asks for ${want?.allow === undefined ? `a file of ${want?.repo}` : `the file its recipe names, ${want.allow.join(', ')}`}: ${path ?? 'nothing'}`,
      );
    }
  }
  for (const best of hub.best) {
    const rec = top[best.modality];
    const channel = installKindOf(rec.family) === 'gguf' ? 'hf:register' : 'store:download';
    const r = await requestAfter(
      () => page.click(`[data-testid="best-download-${best.modality}"]`, { timeout: 5000 }),
      `Top Recommended ${best.modality}`,
      channel,
    );
    console.log(
      `  ${r.what.padEnd(34)} → ${asked(channel, r.request) ?? `nothing (${r.heard.join(', ') || 'no request'}; the page says: ${r.banner})`}`,
    );
    const fromQuick = quickAsked.get(rec.family.id);
    check(
      r.request !== undefined && asked(channel, r.request) === asked(channel, fromQuick?.request),
      `Top Recommended's ${best.modality} Download and ${rec.family.name}'s Quick Download ask for the same files`,
    );
  }
  await shot('3-after-clicks');

  // Nothing moved: every request was refused, so no bar is left running.
  const live = await page.evaluate(() => ({
    gguf: window.__llm_store?.().getState().download ?? null,
    bars: [
      ...document.querySelectorAll(
        '[data-testid^="family-quick-progress-"], [data-testid^="best-progress-"]',
      ),
    ].map((el) => el.getAttribute('data-testid')),
  }));
  check(
    live.gguf === null && live.bars.length === 0,
    `no download is in flight (${JSON.stringify(live)}; ${(await refused.calls()).length} requests refused in main)`,
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
