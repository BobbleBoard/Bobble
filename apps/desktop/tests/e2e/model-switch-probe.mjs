/**
 * PICKING A MODEL BY NAME HAS TO ACTUALLY LOAD IT.
 *
 * the user, with the picker open: "lfm selected, but also qwen3.5-4b still selected
 * in the input bar." Two surfaces disagreeing was the symptom. The cause was
 * that `selectModel` persisted the pin and stopped — where its sibling
 * `selectTier` ends in a real switch (start the server, respawn pi on the same
 * session, re-point the provider). So the choice was recorded, the checkmark
 * moved, the server kept holding the previous model, and the next turn answered
 * "fetch failed" because pi had been pointed at something nobody had loaded.
 *
 * This drives the real menu and asserts all three: the resident model changes,
 * the chip names the model that was picked, and a turn on it does not error.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const fail = (m) => {
  console.error(`model-switch-probe: ${m}`);
  process.exitCode = 1;
  throw new Error(m);
};

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__llm_store === 'function', { timeout: 25000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 25000 });

  // Let the boot model resolve — the switch is only meaningful against a resident one.
  await win.waitForFunction(
    () => (window.__llm_store?.().getState?.().status?.model?.id ?? null) !== null,
    { timeout: 180_000 },
  );
  const resident = () =>
    win.evaluate(() => window.__llm_store?.().getState?.().status?.model?.id ?? null);
  const before = await resident();
  console.log(`resident at start: ${before}`);

  // A DIFFERENT model that is actually on disk — a switch to one that has to be
  // fetched would be measuring the downloader, not the switch.
  const target = await win.evaluate((cur) => {
    const st = window.__llm_store?.().getState?.();
    const hit = (st?.catalog ?? []).find((e) => e.downloaded === true && e.id !== cur);
    return hit === undefined ? null : { id: hit.id, name: hit.displayName };
  }, before);
  if (target === null) fail('no second downloaded model to switch to');
  console.log(`switching to: ${target.id} (${target.name})`);

  await win.click('[data-testid="footer-model-chip"]');
  await win.waitForTimeout(300);
  await win.hover('[data-testid="footer-more-models"]');
  await win.waitForTimeout(600);
  // The row carries the model id on `data-model`; its button is the pick.
  await win.click(
    `[data-testid="quick-menu-row"][data-model="${target.id}"] [data-testid="quick-menu-pick"]`,
  );

  await win
    .waitForFunction(
      (id) => window.__llm_store?.().getState?.().status?.model?.id === id,
      target.id,
      {
        timeout: 240_000,
      },
    )
    .catch(() => undefined);
  const after = await resident();
  console.log(`resident after pick: ${after}`);
  if (after !== target.id) fail(`picked ${target.id} but the server still holds ${after}`);

  const chip = (await win.textContent('[data-testid="footer-model-chip"]'))?.trim() ?? '';
  console.log(`chip reads: ${JSON.stringify(chip)}`);
  if (!chip.includes(target.name.slice(0, 12)))
    fail(`the chip says ${JSON.stringify(chip)}, not ${JSON.stringify(target.name)}`);

  // …and a turn on it must not answer "fetch failed".
  const n = await win.evaluate(() => window.__pi_store?.().getState?.().messages?.length ?? 0);
  await win.click('[data-testid="composer-input"]');
  await win.keyboard.type('Reply with exactly: ok');
  await win.keyboard.press('Enter');
  await win
    .waitForFunction(
      (k) => {
        const ms = window.__pi_store?.().getState?.().messages ?? [];
        return ms.slice(k).some((m) => m.kind === 'assistant' && (m.blocks ?? []).length > 0);
      },
      n,
      { timeout: 180_000 },
    )
    .catch(() => undefined);
  await win.waitForTimeout(4000);
  const text = await win.evaluate((k) => {
    const ms = window.__pi_store?.().getState?.().messages ?? [];
    return ms
      .slice(k)
      .flatMap((m) => (m.blocks ?? []).map((b) => b.text ?? ''))
      .join(' ');
  }, n);
  console.log(`turn text: ${JSON.stringify(text.slice(0, 160))}`);
  if (/fetch failed/i.test(text)) fail('the first turn after the switch answered "fetch failed"');

  console.log('model-switch-probe OK');
} finally {
  await app.close().catch(() => undefined);
}
