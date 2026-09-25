/**
 * THE TRAY'S DOWNLOADS AND LOADS, LOOKED AT.
 *
 * the user (2026-09-24): "this top left button to show status on running tasks … put
 * downloads/model load progress into aswell, eg. headers for 'Downloads'
 * 'Loading' for these you can use a sort of clean thin blue progressbar w/ % or
 * ngb/rgb red X on the side below some white text that says the running
 * operation".
 *
 * The real app, hidden, on a throwaway home, with nothing downloaded or loaded:
 * the stores are put in the states the downloaders and the server report (a
 * model download three files long, a repo from the store, a module install, a
 * refusal, a model loading with a remembered load time) and the card is read
 * and shot in light and dark. Every button is pressed, and main's handlers for
 * those channels are replaced so the press is caught instead of obeyed.
 *
 * Runs on any build: on one without the groups it records what it finds (the
 * old download icon, no tray) and moves on, so the same steps give BEFORE shots.
 *
 *   SHOT_DIR=<dir> PHASE=after node scripts/with-lock.mjs probe -- node apps/desktop/tests/e2e/tray-transfers-look.mjs
 */
import path from 'node:path';
import { launchApp } from './harness.mjs';

const PHASE = process.env.PHASE ?? 'after';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, page, check, finish, shotDir } = await launchApp('tray-transfers', {
  waitFor: '[data-testid="composer-input"]',
});
const log = (...a) => console.log('  ', ...a);
const GIB = 1024 ** 3;

const setMode = (mode) =>
  page.evaluate((mode) => {
    const t = window.__pi_theme?.();
    t?.setFlavor?.('bobble');
    t?.setMode?.(mode);
  }, mode);
const exists = (sel) => page.evaluate((s) => document.querySelector(s) !== null, sel);

/** The open card with its button and air for the sheet's shadow. */
const cardShot = async (label) => {
  const panel = await page.locator('[data-testid="task-tray-panel"]').boundingBox();
  if (panel === null) {
    await page.screenshot({ path: path.join(shotDir, `${PHASE}-${label}.png`) });
    return;
  }
  const pad = 36;
  await page.screenshot({
    path: path.join(shotDir, `${PHASE}-${label}.png`),
    clip: { x: 0, y: 0, width: panel.x + panel.width + pad, height: panel.y + panel.height + pad },
  });
};

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setMode('dark');
  await page.waitForFunction(
    () =>
      typeof window.__llm_store === 'function' && typeof window.__gen_modules_store === 'function',
    undefined,
    { timeout: 20_000 },
  );

  /* Main's side of every button: caught, not obeyed. */
  await app.evaluate(({ ipcMain }) => {
    globalThis.__trayCalls = [];
    for (const ch of [
      'llm:cancel-download',
      'llm:pause-download',
      'llm:download-model',
      'store:cancel',
      'llm:stop-server',
    ]) {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, (_e, arg) => {
        globalThis.__trayCalls.push({ ch, arg: arg ?? null });
        // A real download's promise settles when the download ends; a resumed
        // one here stays under way until the probe cancels it.
        if (ch === 'llm:download-model') return new Promise(() => {});
        return { ok: true, success: true };
      });
    }
  });
  const calls = () => app.evaluate(() => globalThis.__trayCalls.map((c) => c.ch));

  check(!(await exists('[data-testid="task-tray"]')), 'nothing moving → no tray button');

  /* ── the states the downloaders and the server report ─────────────────── */
  await page.evaluate(
    ({ GIB }) => {
      localStorage.setItem('pd-load-ms:gemma-4-e4b', '10000');
      window
        .__llm_store()
        .getState()
        .applyDownloadProgress({
          modelId: 'qwen3.5-4b-mtp',
          file: 'Qwen3.5-4B-Q8_0.gguf',
          received: 1.2 * GIB,
          total: 4.8 * GIB,
          fraction: 0.25,
          fileIndex: 0,
          fileCount: 3,
          jobReceived: 1.2 * GIB,
          jobTotal: 5.7 * GIB,
        });
      window.__store_models?.().setState({
        progress: {
          'mlx-community/Qwen-Image-2.1-4bit': {
            repo: 'mlx-community/Qwen-Image-2.1-4bit',
            file: 'transformer/model-00002-of-00004.safetensors',
            fileIndex: 1,
            fileCount: 4,
            received: 12.4 * GIB,
            total: 31 * GIB,
            fraction: 0.4,
          },
        },
      });
      window.__gen_modules_store().setState({
        loaded: true,
        modules: [
          {
            id: 'image',
            label: 'Image module',
            blurb: '',
            approxGB: 2.5,
            ready: false,
            installing: true,
            wanted: false,
            detail: 'Installing mflux',
            percent: 0.62,
          },
        ],
      });
      window.__download_tray?.().getState().note({
        key: 'llm:qwen3.5-9b',
        name: 'Qwen3.5 9B',
        kind: 'failed',
        detail: 'Not enough space — 9.4 GB needed, 3.1 GB free.',
      });
      /* PINNED, not set once: the app's own main process reports the (idle)
         server's status a beat after launch and that report has no load in it
         — MEASURED, the Loading section was gone by the time the tray opened
         on 1 run in 2. The cancel check below needs only the IPC call. */
      const llm = window.__llm_store();
      const load = { modelId: 'gemma-4-e4b', displayName: 'Gemma 4 E4B', since: Date.now() - 4000 };
      const pin = () => {
        const status = llm.getState().status;
        if (status.loading?.modelId === load.modelId && status.phase === 'starting') return;
        llm.setState({ status: { ...status, phase: 'starting', loading: load } });
      };
      pin();
      llm.subscribe(pin);
    },
    { GIB },
  );
  /* A second report a second later gives the store a rate — the ETA's source. */
  await sleep(1000);
  await page.evaluate(
    ({ GIB }) =>
      window
        .__llm_store()
        .getState()
        .applyDownloadProgress({
          modelId: 'qwen3.5-4b-mtp',
          file: 'Qwen3.5-4B-Q8_0.gguf',
          received: 1.25 * GIB,
          total: 4.8 * GIB,
          fraction: 0.26,
          fileIndex: 0,
          fileCount: 3,
          jobReceived: 1.25 * GIB,
          jobTotal: 5.7 * GIB,
        }),
    { GIB },
  );
  await sleep(600);

  const oldIcon = await exists('[data-testid="download-tray"]');
  const button = await exists('[data-testid="task-tray"]');
  log('old download icon:', oldIcon, '· tray button:', button);
  if (PHASE === 'after') {
    check(!oldIcon, 'the separate download icon is gone');
    check(button, 'downloads and a load bring the tray button up');
  }
  await page.mouse.move(900, 620);
  await page.screenshot({
    path: path.join(shotDir, `${PHASE}-00-corner-dark.png`),
    clip: { x: 0, y: 0, width: 700, height: 60 },
  });
  if (!button) {
    // A build without the groups: show what it offers instead, and stop.
    if (oldIcon) {
      await page.click('[data-testid="download-tray"]');
      await sleep(500);
    }
    await page.screenshot({ path: path.join(shotDir, `${PHASE}-01-card-dark.png`) });
    log('no tray button on this build — before shots taken');
  } else {
    await page.click('[data-testid="task-tray"]');
    await page.waitForSelector('[data-testid="task-tray-panel"]', { timeout: 3000 });
    await sleep(1400);

    const card = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="task-tray-panel"]');
      const heads = [...(panel?.querySelectorAll('.pd-menu-label') ?? [])].map((h) =>
        h.textContent?.trim(),
      );
      const rows = [...(panel?.querySelectorAll('[data-testid="transfer-row"]') ?? [])].map((r) => {
        const bar = r.querySelector('.pd-transfer-bar');
        const fill = r.querySelector('.pd-transfer-fill');
        const x = r.querySelector('[data-testid="transfer-cancel"]');
        const title = r.querySelector('[data-testid="transfer-title"]');
        const box = bar?.getBoundingClientRect();
        return {
          key: r.getAttribute('data-key'),
          title: title?.textContent,
          titleColor: title === null ? null : getComputedStyle(title).color,
          amount: r.querySelector('[data-testid="transfer-amount"]')?.textContent,
          barH: box?.height ?? null,
          track: bar === null ? null : getComputedStyle(bar).backgroundColor,
          fill: fill === null ? null : getComputedStyle(fill).backgroundColor,
          fillW:
            fill === null || box === undefined
              ? null
              : Math.round((fill.getBoundingClientRect().width / box.width) * 100),
          indeterminate: bar?.getAttribute('data-indeterminate') === 'true',
          x: x === null ? null : getComputedStyle(x).color,
          pause: r.querySelector('[data-testid="transfer-pause"]') !== null,
          note: r.querySelector('[data-testid="transfer-note"]')?.textContent ?? null,
        };
      });
      const probe = document.createElement('span');
      probe.style.color = 'var(--pd-status-danger-fg)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      // The bar is the SOLID status blue, not the text blue (the user: "why such a pale blue").
      probe.style.color = 'var(--pd-status-info-solid)';
      const info = getComputedStyle(probe).color;
      probe.style.color = 'var(--pd-text-primary)';
      const primary = getComputedStyle(probe).color;
      probe.remove();
      const notice = panel?.querySelector('[data-testid="transfer-notice"]')?.textContent ?? '';
      return { heads, rows, danger, info, primary, notice };
    });
    log('card:', JSON.stringify(card, null, 1));
    check(
      card.heads.includes('Downloads') && card.heads.includes('Loading'),
      `headers "Downloads" and "Loading" (${card.heads})`,
    );
    const byKey = Object.fromEntries(card.rows.map((r) => [r.key, r]));
    const llm = byKey['llm:qwen3.5-4b-mtp'];
    const store = byKey['store:mlx-community/Qwen-Image-2.1-4bit'];
    const mod = byKey['module:image'];
    const load = byKey['load:gemma-4-e4b'];
    check(llm?.amount === '1.3 / 5.7 GB', `model download in GB (${llm?.amount})`);
    check(/left$/.test(llm?.note ?? ''), `the model download says how long is left (${llm?.note})`);
    check(store?.amount === '12 / 31 GB', `repo download in GB (${store?.amount})`);
    check(mod?.amount === '62%' && mod?.x === null, `module install: %, no X (${mod?.amount})`);
    check(
      load !== undefined &&
        /^Loading Gemma 4 E4B$/.test(load.title ?? '') &&
        /%$/.test(load.amount ?? ''),
      `the load names the model and says how far (${load?.title} · ${load?.amount})`,
    );
    for (const r of card.rows) {
      check(r.barH !== null && r.barH <= 4, `${r.key}: a thin bar (${r.barH}px)`);
      check(r.titleColor === card.primary, `${r.key}: the operation in the primary ink`);
      if (!r.indeterminate)
        check(r.fill === card.info, `${r.key}: the fill is the blue (${r.fill})`);
      if (r.key !== 'module:image')
        check(r.x === card.danger, `${r.key}: a red X (${r.x} vs ${card.danger})`);
    }
    check(llm?.pause === true, 'the model download keeps Pause');
    check(
      /Not downloaded/.test(card.notice) && /Not enough space/.test(card.notice),
      'the refusal is listed',
    );
    await cardShot('01-card-dark');
    await setMode('light');
    await sleep(500);
    await cardShot('02-card-light');

    /* ── every button, caught in main ─────────────────────────────────────── */
    await page.click('[data-key="llm:qwen3.5-4b-mtp"] [data-testid="transfer-pause"]');
    await sleep(300);
    const paused = await page.evaluate(() => ({
      amount: document.querySelector(
        '[data-key="llm:qwen3.5-4b-mtp"] [data-testid="transfer-amount"]',
      )?.textContent,
      fill: getComputedStyle(
        document.querySelector('[data-key="llm:qwen3.5-4b-mtp"] .pd-transfer-fill'),
      ).backgroundColor,
    }));
    log('paused:', JSON.stringify(paused));
    check(paused.amount === 'Paused', 'Pause says so on the row');
    await cardShot('03-paused-light');
    await page.click('[data-key="llm:qwen3.5-4b-mtp"] [data-testid="transfer-pause"]');
    await sleep(300);
    await page.click('[data-key="llm:qwen3.5-4b-mtp"] [data-testid="transfer-cancel"]');
    await sleep(300);
    await page.click(
      '[data-key="store:mlx-community/Qwen-Image-2.1-4bit"] [data-testid="transfer-cancel"]',
    );
    await sleep(300);
    await page.click('[data-key="load:gemma-4-e4b"] [data-testid="transfer-cancel"]');
    await sleep(300);
    const got = await calls();
    log('main got:', got.join(', '));
    for (const ch of [
      'llm:pause-download',
      'llm:download-model',
      'llm:cancel-download',
      'store:cancel',
      'llm:stop-server',
    ])
      check(got.includes(ch), `${ch} reached main`);
    check(
      !(await exists('[data-key="llm:qwen3.5-4b-mtp"]')),
      'a cancelled model download leaves the list at once',
    );
  }
} catch (err) {
  check(false, `threw: ${err?.stack ?? err}`);
  await page.screenshot({ path: path.join(shotDir, `${PHASE}-zz-error.png`) }).catch(() => {});
} finally {
  await finish();
}
