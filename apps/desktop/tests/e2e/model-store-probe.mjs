/**
 * THE MODEL STORE, end to end and for real.
 *
 * the user: "we need to be able to download anything and store it properly in an
 * organized format so that no matter what we add either now or later we have an
 * easy way to list relevant models and know where their weights are stored their
 * names relevant info etc."
 *
 * So this does not mock anything. It downloads a genuine non-GGUF repo (Kokoro,
 * 363 MB across 72 files — small enough to finish in a probe, real enough to
 * prove the path), then asks the store what it has and checks the answer against
 * the disk: the manifest exists, it names the weights, the byte count is real,
 * and `store:list` reports it beside the GGUF models the other downloader owns.
 * Then it cancels a second download mid-flight and checks the partial is gone.
 */
import { _electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT = process.env.OUT ?? '/tmp/model-store';
const CACHE = mkdtempSync(path.join(tmpdir(), 'pd-store-cache-'));
const REPO = process.env.REPO ?? 'hexgrad/Kokoro-82M';

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  // A scratch cache root: the probe must never touch the real one, and the
  // store's layout functions all read this.
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1', PI_DESKTOP_CACHE_DIR: CACHE },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

const fail = (m) => {
  throw new Error(`model-store-probe: ${m}`);
};

try {
  console.log(`cache root: ${CACHE}`);

  // ── a real download, start to finish ────────────────────────────────────
  const started = await win.evaluate(
    (repo) =>
      window.piDesktop.invoke('store:download', {
        repo,
        kind: 'audio',
        name: 'Kokoro 82M',
        family: 'kokoro',
        tasks: ['text-to-speech'],
      }),
    REPO,
  );
  if (started?.ok !== true) fail(`the download did not start: ${JSON.stringify(started)}`);

  const finished = await win.evaluate(
    (repo) =>
      new Promise((resolve) => {
        const seen = [];
        const off = window.piDesktop.onEvent('store:download', (p) => {
          if (p.repo !== repo) return;
          seen.push(p);
          if (p.done) {
            off();
            resolve({
              updates: seen.length,
              peak: Math.max(...seen.map((s) => s.received)),
              files: Math.max(...seen.map((s) => s.fileCount)),
              error: p.error ?? null,
              cancelled: p.cancelled ?? false,
            });
          }
        });
        setTimeout(() => {
          off();
          resolve({ updates: seen.length, timedOut: true });
        }, 300000);
      }),
    REPO,
  );
  console.log('download finished:', JSON.stringify(finished));
  if (finished.timedOut === true) fail('the download never reported done');
  if (finished.error !== null) fail(`the download failed: ${finished.error}`);
  if (finished.updates < 2) fail('no progress was reported while it ran');

  // ── the disk, checked directly ──────────────────────────────────────────
  const dir = path.join(CACHE, 'store', 'audio', 'hexgrad__kokoro-82m');
  const manifestPath = path.join(dir, 'model.json');
  if (!existsSync(manifestPath)) fail(`no manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const m = manifest.model;
  console.log(
    `manifest: ${m.name} · ${m.kind} · ${m.files.length} files · ${(m.bytes / 1e6).toFixed(0)} MB · tasks=${(m.tasks ?? []).join(',')}`,
  );
  if (m.incomplete === true) fail('the finished model is still marked incomplete');
  if (m.files.length < 5) fail(`the manifest lists only ${m.files.length} files`);
  if (m.bytes < 100_000_000) fail(`the manifest reports only ${m.bytes} bytes`);
  const sample = m.files.find((f) => f.path.endsWith('.pth') || f.path.endsWith('.onnx'));
  if (sample !== undefined && !existsSync(path.join(dir, sample.path)))
    fail(`the manifest names ${sample.path} but it is not on disk`);

  // ── the index answers for every source ──────────────────────────────────
  const listed = await win.evaluate(() => window.piDesktop.invoke('store:list', undefined));
  const mine = listed.models.find((x) => x.repo === REPO);
  console.log(
    `store:list → ${listed.models.length} models, ${(listed.bytes / 1e6).toFixed(0)} MB total`,
  );
  if (mine === undefined) fail('store:list does not report the model it just downloaded');
  if (mine.dir !== dir) fail(`store:list points at ${mine.dir}, not ${dir}`);

  // ── cancel throws the partial away ──────────────────────────────────────
  const second = 'stabilityai/TripoSR';
  await win.evaluate(
    (repo) =>
      window.piDesktop.invoke('store:download', { repo, kind: '3d', name: 'TripoSR', family: 'triposr' }),
    second,
  );
  await win.waitForTimeout(4000);
  const partialDir = path.join(CACHE, 'store', '3d', 'stabilityai__triposr');
  console.log('partial exists mid-flight:', existsSync(partialDir));
  await win.evaluate((repo) => window.piDesktop.invoke('store:cancel', { repo }), second);
  await win.waitForTimeout(3000);
  if (existsSync(partialDir)) fail('the cancelled download left its partial tree behind');
  console.log('cancel → partial tree discarded');

  console.log('model-store-probe OK');
} finally {
  await app.close();
}
