/**
 * LOOK at the Bobble 3D connector. the user (2026-09-17): "3d should be a
 * connector that gets recommended for install upon installing the 3d studio
 * module".
 *
 * Two Macs, two throwaway HOMEs:
 *   A. the 3D engine is installed (its install stamps under GEN3D_CACHE_DIR)
 *      and the connector is off — the card sits under "Recommended for you"
 *      with the reason, its add is the plain +, adding it turns it on (the
 *      settings flag, no download), the detail says so, Remove turns it off.
 *   B. no engine — the card is in its category (Media & creative) with a download glyph and the
 *      detail names the engine install and its size.
 *
 *   SHOT_DIR=/tmp/bobble-3d node apps/desktop/tests/e2e/bobble-3d-connector-look.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/bobble-3d';
mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An engine cache that says the core set is installed — four stamps and the
 * remesher binary path; nothing runs, nothing is downloaded. */
function fakeEngineCache() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pd-gen3d-cache-'));
  mkdirSync(path.join(dir, 'installed'), { recursive: true });
  for (const id of ['mageflow', 'trellis2', 'humanoid-rig']) {
    writeFileSync(path.join(dir, 'installed', `${id}.json`), '{"ok":true}\n');
  }
  const bin = path.join(dir, 'bin', 'autoremesher.app', 'Contents', 'MacOS');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'autoremesher'), '#!/bin/sh\n');
  return dir;
}

async function run(label, { engine }) {
  const cache = engine ? fakeEngineCache() : mkdtempSync(path.join(tmpdir(), 'pd-gen3d-empty-'));
  const apps = mkdtempSync(path.join(tmpdir(), 'pd-apps-'));
  const piLog = path.join(apps, 'mock-pi.log');
  const { page, check, finish, home } = await launchApp(`bobble-3d-${label}`, {
    waitFor: '[data-testid="nav-connectors"]',
    env: {
      GEN3D_CACHE_DIR: cache,
      // An empty /Applications: the only recommendation can be ours.
      PI_CONNECTORS_APPS_DIR: apps,
      // Every pi spawn records the tool gates the app handed it.
      MOCK_PI_LOG: piLog,
    },
  });
  /** The gate the LAST pi spawn was given — what the chat's tools are decided by. */
  const lastGate = () => {
    try {
      const lines = readFileSync(piLog, 'utf8').trim().split('\n');
      const spawns = lines.map((l) => JSON.parse(l)).filter((r) => r.kind === 'spawn');
      return spawns.at(-1)?.gates?.PI_BOBBLE_3D_READY ?? null;
    } catch {
      return null;
    }
  };
  const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${label}-${name}.png` });
  const setTheme = async (mode) => {
    await page.evaluate(
      (mode) =>
        window
          .__settings_store()
          .getState()
          .update({ theme: { flavor: 'bobble', mode } }),
      mode,
    );
    await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
      timeout: 5000,
    });
  };
  const cardState = () =>
    page.evaluate(() => {
      const card = document.querySelector('[data-testid="connector-card-bobble-3d"]');
      const section = card?.closest('[data-testid^="connectors-section-"]');
      return card
        ? {
            section: section?.getAttribute('data-testid') ?? null,
            line: card.querySelector('.pdc-row-line, .pdc-line')?.textContent ?? null,
            text: card.textContent,
            add: card.querySelector('[data-testid="connector-add-bobble-3d"]') !== null,
            download: card.querySelector('[data-testid="connector-download-bobble-3d"]') !== null,
            hasSvgMark: card.querySelector('svg') !== null,
          }
        : null;
    });
  try {
    await page.waitForFunction(() => typeof window.__settings_store === 'function', {
      timeout: 20000,
    });
    await setTheme('light');
    await page.click('[data-testid="nav-connectors"]');
    await page.waitForSelector('[data-testid="connectors-screen"]', { timeout: 15_000 });
    await sleep(1200);
    let card = await cardState();
    console.log(label, 'card', JSON.stringify(card));
    await shot('1-gallery');
    check(card?.hasSvgMark === true, `${label}: the Bobble 3D card is in the gallery`);
    if (engine) {
      check(
        card?.section === 'connectors-section-recommended' &&
          (card.text ?? '').includes('3D studio is installed'),
        `${label}: recommended, with the reason (${card?.section}: ${card?.text})`,
      );
      check(card?.add === true && card.download === false, `${label}: the add is a plain +`);
    } else {
      check(
        card?.section === 'connectors-section-media' && card.download === true,
        `${label}: in the media section (creative) with a download glyph (${card?.section})`,
      );
    }

    // The detail.
    await page.click('[data-testid="connector-open-bobble-3d"]');
    await page.waitForSelector('[data-testid="connector-detail"]', { timeout: 8000 });
    await sleep(600);
    let detail = await page.evaluate(() => ({
      status: document.querySelector('[data-testid="connector-detail-status"]')?.textContent ?? '',
      tools: [
        ...document.querySelectorAll(
          '[data-testid="connector-tools"] code, [data-testid="connector-tools"] .pdc-tool-name',
        ),
      ]
        .map((t) => t.textContent)
        .slice(0, 4),
      text: document.querySelector('[data-testid="connector-detail"]')?.textContent ?? '',
      switch: document.querySelector('[data-testid="connector-toggle-bobble-3d"]') !== null,
      cost: document.querySelector('[data-testid="connector-tool-cost"]') !== null,
    }));
    console.log(label, 'detail', JSON.stringify({ ...detail, text: detail.text.slice(0, 200) }));
    await shot('2-detail');
    check(
      detail.text.includes('generate_3d') && detail.text.includes('refine_3d'),
      `${label}: the detail lists both tools`,
    );
    check(!detail.switch && !detail.cost, `${label}: no switch, no token-cost line for an engine`);
    if (engine) {
      check(
        detail.status.includes('Not added') && detail.status.includes('engine is installed'),
        `${label}: status says the engine is here and the tools are not added (${detail.status})`,
      );
      // Add it: a flag in settings, then pi respawns — no download.
      const addBtn = page.locator('[data-testid="connector-detail"] button', {
        hasText: 'Add to Bobble',
      });
      check((await addBtn.count()) === 1, `${label}: the detail offers "Add to Bobble"`);
      await addBtn.first().click();
      await page.waitForFunction(
        () =>
          (
            document.querySelector('[data-testid="connector-detail-status"]')?.textContent ?? ''
          ).startsWith('On'),
        undefined,
        { timeout: 20_000 },
      );
      await sleep(400);
      detail = await page.evaluate(() => ({
        status:
          document.querySelector('[data-testid="connector-detail-status"]')?.textContent ?? '',
      }));
      await shot('3-detail-on');
      check(
        detail.status.startsWith('On'),
        `${label}: after Add the connector is on (${detail.status})`,
      );
      const settings = JSON.parse(
        readFileSync(path.join(home, '.pi', 'desktop', 'settings.json'), 'utf8'),
      );
      check(
        settings.moduleConnectors?.['3d'] === true,
        `${label}: the flag is in settings (${JSON.stringify(settings.moduleConnectors)})`,
      );
      /* THE TRUTH FOR THE CHAT: the respawned pi was told the tools may register. */
      await sleep(1500);
      check(lastGate() === '1', `${label}: pi respawned with PI_BOBBLE_3D_READY=1 (${lastGate()})`);
      // Back to the gallery: no longer recommended, now in Installed.
      await page.click('[data-testid="connectors-back"]');
      await sleep(800);
      card = await cardState();
      const tile = await page.$('[data-testid="connector-tile-bobble-3d"]');
      await shot('4-gallery-on');
      check(
        card?.section !== 'connectors-section-recommended' && tile !== null,
        `${label}: once on it leaves Recommended and joins Installed (${card?.section}, tile ${tile !== null})`,
      );
      // Remove: the tools leave the chat, the engine stays.
      await page.click('[data-testid="connector-open-bobble-3d"]');
      await page.waitForSelector('[data-testid="connector-remove"]', { timeout: 8000 });
      await page.click('[data-testid="connector-remove"]');
      await sleep(300);
      const armed = await page.evaluate(
        () => document.querySelector('[data-testid="connector-remove-row"]')?.textContent ?? '',
      );
      await shot('5-remove-armed');
      check(
        armed.includes('3D studio and its engine stay'),
        `${label}: the remove confirm says the engine stays (${armed})`,
      );
      await page.click('[data-testid="connector-remove-confirm"]');
      await sleep(1500);
      const after = JSON.parse(
        readFileSync(path.join(home, '.pi', 'desktop', 'settings.json'), 'utf8'),
      );
      check(
        after.moduleConnectors?.['3d'] === false,
        `${label}: removed = the flag is off (${JSON.stringify(after.moduleConnectors)})`,
      );
      await sleep(1500);
      check(
        lastGate() === '0',
        `${label}: …and pi respawned with PI_BOBBLE_3D_READY=0 (${lastGate()})`,
      );
      await sleep(600);
      card = await cardState();
      check(
        card?.section === 'connectors-section-recommended',
        `${label}: …and it is recommended again (${card?.section})`,
      );
      await setTheme('dark');
      await sleep(400);
      await shot('6-gallery-dark');
    } else {
      check(lastGate() === '0', `${label}: with no engine pi is told 0 (${lastGate()})`);
      check(
        detail.status.includes('installs the 3D engine') &&
          /about \d+(\.\d+)? GB/.test(detail.status),
        `${label}: status names the engine install and its size (${detail.status})`,
      );
      const addBtn = page.locator('[data-testid="connector-detail"] button', {
        hasText: 'Install the 3D engine and add',
      });
      check(
        (await addBtn.count()) === 1,
        `${label}: the detail's button says it installs the engine`,
      );
    }
  } finally {
    await finish();
    rmSync(cache, { recursive: true, force: true });
    rmSync(apps, { recursive: true, force: true });
  }
}

await run('engine', { engine: true });
await run('bare', { engine: false });
