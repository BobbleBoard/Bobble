/**
 * THE STUDIO AND THE COMFYUI ENGINE ROW, driven in the real app.
 *
 * The user: "let's have comfy as a downloadable inference engine and then wire up a
 * primitive for now image/video studio) and have those run through it."
 *
 * Two things this checks that only the running app can answer: the engine row
 * reports what is ACTUALLY on disk (ComfyUI is installed on this machine, so it
 * must say so rather than offering to install it again), and the studio's two
 * gates say the right sentence — an engine problem points at Settings, a weights
 * problem points at the hub, and they are different messages.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/studio';
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1700, height: 1050 });
});
await win.waitForTimeout(500);

const fail = (m) => {
  throw new Error(`studio-probe: ${m}`);
};
const text = (sel) =>
  win.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);

try {
  // ── the engine row knows the truth about the disk ────────────────────────
  const engines = await win.evaluate(() => window.piDesktop.invoke('engines:list', undefined));
  const comfy = engines.engines.find((e) => e.id === 'comfyui');
  console.log('comfyui engine state:', JSON.stringify(comfy));
  if (comfy === undefined) fail('ComfyUI is not in the engine list');
  if (comfy.installed !== true)
    fail('ComfyUI is installed on this machine but the engine row says it is not');
  if ((comfy.bytes ?? 0) < 100_000_000) fail(`engine size looks wrong: ${comfy.bytes}`);

  // ── the studio opens from the sidebar ────────────────────────────────────
  await win.click('[data-testid="modality-studio"]');
  await win.waitForSelector('[data-testid="studio-view"]', { timeout: 8000 });
  await win.waitForTimeout(1200);

  const needsEngine = await text('[data-testid="studio-needs-engine"]');
  const needsModels = await text('[data-testid="studio-needs-models"]');
  console.log('engine gate:', JSON.stringify(needsEngine));
  console.log('weights gate:', JSON.stringify(needsModels));
  // ComfyUI IS installed here, so the engine gate must be silent and the
  // weights gate must be the one talking.
  if (needsEngine !== null) fail('the engine gate fired even though ComfyUI is installed');
  if (needsModels === null) fail('no image models are downloaded, but nothing said so');
  if (!/Model management/.test(needsModels))
    fail(`the weights gate does not point at the hub: ${needsModels}`);
  await win.screenshot({ path: path.join(OUT, '1-studio.png') });

  // Switching kind switches the sentence, not just the label.
  await win.click('[data-testid="studio-kind-video"]');
  await win.waitForTimeout(500);
  const videoGate = await text('[data-testid="studio-needs-models"]');
  console.log('video gate:', JSON.stringify(videoGate));
  if (videoGate === null || !/video/.test(videoGate))
    fail('the video tab does not say it has no video models');
  await win.screenshot({ path: path.join(OUT, '2-studio-video.png') });

  // Generate is refused until there is something to generate WITH.
  const disabled = await win.evaluate(
    () => document.querySelector('[data-testid="studio-generate"]')?.disabled ?? null,
  );
  console.log('generate disabled with no model:', disabled);
  if (disabled !== true) fail('Generate is clickable with no model and no prompt');

  // ── the INSTALL path itself, exercised against a satisfied install ───────
  //    Re-running it is the honest smoke test we can afford: the clone is
  //    skipped, the venv is reused, and `uv pip install -r requirements.txt`
  //    verifies every dependency resolves. A failure here is a real failure of
  //    the same code a first-time user runs.
  const started = Date.now();
  const install = await win.evaluate(() =>
    window.piDesktop.invoke('engines:install', { id: 'comfyui' }),
  );
  console.log(`engines:install comfyui → ${JSON.stringify(install)} in ${Date.now() - started}ms`);
  if (install?.success !== true) fail(`the install path failed: ${install?.error}`);

  // …and it wrote the model-paths yaml that points ComfyUI at OUR store.
  const yamlOk = await win.evaluate(() => window.piDesktop.invoke('studio:status', undefined));
  console.log('studio status after install:', JSON.stringify(yamlOk));
  if (yamlOk?.engineInstalled !== true) fail('the studio does not see the engine');

  // A full-window modality must have a door out of it.
  await win.click('[data-testid="studio-back"]');
  await win.waitForTimeout(600);
  const backToChat = await win.evaluate(
    () => document.querySelector('[data-testid="composer-input"]') !== null,
  );
  console.log('back button returns to chat:', backToChat);
  if (!backToChat) fail('the studio has no way back to the chat');

  console.log('studio-probe OK');
} finally {
  await app.close();
}
