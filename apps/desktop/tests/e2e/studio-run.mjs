/**
 * A STUDIO ACTUALLY GENERATING — the `gen:generate` path end to end.
 *
 * Independent of the chat/capability question: this drives the Audio Studio's
 * own button, which goes renderer → gen:generate → JobQueue → the uv worker, and
 * checks that a real file lands and mounts in the results with a waveform.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
const OUT = process.env.OUT ?? '/tmp/studio-run';
mkdirSync(OUT, { recursive: true });
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(), env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_GEN: '1' },
});
const mainLog = [];
for (const st of [app.process().stdout, app.process().stderr]) {
  st?.on('data', (d) => mainLog.push(String(d)));
}
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 25000 });
  await win.waitForTimeout(2500);
  await win.evaluate(() => window.__modality_store?.().getState().setView('audio'));
  await win.waitForTimeout(1200);
  await win.click('[data-testid="audio-mode-speech"]');
  // Pin Kokoro: it is the one already proved to synthesise standalone, so a
  // failure here is the WORKER PLUMBING rather than a model-specific problem.
  await win.selectOption('[data-testid="audio-model"]', process.env.AUDIO_MODEL ?? 'kokoro-82m').catch(() => {});
  await win.click('[data-testid="studio-prompt"]');
  await win.keyboard.type('The studio can speak.');
  await win.waitForTimeout(300);
  await win.click('[data-testid="studio-run"]');
  console.log('[studio] pressed run');
  const t0 = Date.now();
  let state = {};
  while (Date.now() - t0 < 600000) {
    state = await win.evaluate(() => ({
      busy: document.querySelector('[data-testid="studio-run"]')?.textContent?.includes('Working') ?? false,
      players: document.querySelectorAll('[data-testid="thread-audio"]').length,
      bars: document.querySelectorAll('.pd-thread-audio-bar').length,
      cards: document.querySelectorAll('[data-testid="thread-file-card"]').length,
      err: document.querySelector('[data-testid="studio-error"]')?.textContent ?? null,
    })).catch(() => ({}));
    if (state.players === undefined) break; // window gone
    if (!state.busy && (state.players > 0 || state.err)) break;
    await win.waitForTimeout(4000).catch(() => undefined);
  }
  console.log('[studio] RESULT:', JSON.stringify(state));
  await win.screenshot({ path: path.join(OUT, 'result.png'), fullPage: true });
  const all = mainLog.join('');
  const lines = all.split('\n').filter((l) => /gen|audio|worker|Traceback|Error|uv |mlx/i.test(l));
  console.log('[studio] MAIN LOG TAIL:\n' + lines.slice(-25).join('\n').slice(0, 3000));
} finally {
  await app.close().catch(() => undefined);
  console.log('[studio] shots in', OUT);
}
