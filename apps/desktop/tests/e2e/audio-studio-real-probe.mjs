/**
 * THE SOUND ITSELF, through the app. the user (2026-09-17): "sfx and music work
 * 0, nada, nothing random noise random amount of output."
 *
 * MEASURED before the fix: every Stable Audio 3 clip was broadband noise with a
 * click train — ComfyUI decoded the audio VAE in bfloat16 on MPS (garbage),
 * the graph sampled a distilled checkpoint with euler/cfg 6 (the template says
 * lcm/8/cfg 1), a ConditioningStableAudio node pinned every clip to "8 s", and
 * a sound-effect request ran on the MUSIC checkpoint (the sfx pick named a
 * model no longer in the catalogue and fell to "the first ComfyUI audio row").
 *
 * This drives the Audio studio with the REAL engine (hidden, throwaway HOME on
 * the real model cache): one music prompt, one effect, and judges each file by
 * its spectrum — a piano has harmonics (spectral flatness well under 0.05 and
 * a strong low band), noise does not — and by which checkpoint the job named.
 *
 *   SHOT_DIR=/tmp/audio-real node apps/desktop/tests/e2e/audio-studio-real-probe.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/audio-real';
mkdirSync(SHOT_DIR, { recursive: true });
const home = probeHome('audio-real');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power' }, null, 2)}\n`,
);
const { page, check, finish } = await launchApp('audio-real', {
  realCache: true,
  waitFor: '[data-testid="composer-input"]',
  env: { HOME: home, HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 120_000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY = path.join(homedir(), '.cache', 'bobble', 'engines', 'comfyui', '.venv', 'bin', 'python');
const STATS = `
import sys, numpy as np, av
def read(f):
    c = av.open(f); st = c.streams.audio[0]; ch = st.channels; frames = []
    for fr in c.decode(st):
        a = fr.to_ndarray()
        frames.append(a.T if a.ndim == 2 and a.shape[0] == ch else a.reshape(-1, ch))
    return np.concatenate(frames, axis=0).astype(np.float64), st.rate
x, sr = read(sys.argv[1])
if x.ndim > 1: x = x.mean(axis=1)
x = x / (np.max(np.abs(x)) + 1e-9)
n = 2048
frames = [x[i:i+n] for i in range(0, len(x)-n, n)]
spec = np.mean([np.abs(np.fft.rfft(fr*np.hanning(n)))**2 for fr in frames[:600]], axis=0) + 1e-12
flat = float(np.exp(np.mean(np.log(spec))) / np.mean(spec))
freqs = np.fft.rfftfreq(n, 1/sr)
lf = float(spec[freqs < 500].sum() / spec.sum())
# harmonic peakiness: how much of the energy sits in the top 5% of bins
top = np.sort(spec)[::-1]
peak = float(top[: max(1, len(top)//20)].sum() / spec.sum())
print(f"{len(x)/sr:.2f} {flat:.4f} {lf:.3f} {peak:.3f}")
`;
const measure = (file) => {
  const out = execFileSync(PY, ['-c', STATS, file], { encoding: 'utf8' }).trim().split(' ');
  return {
    seconds: Number(out[0]),
    flat: Number(out[1]),
    lf: Number(out[2]),
    peak: Number(out[3]),
  };
};

const pick = async (testid, value) => {
  await page.click(`[data-testid="${testid}"]`);
  await page.click(`[data-testid="${testid}-${value}"]`);
  await sleep(300);
};
const generate = async (prompt, kind) => {
  await page.fill('[data-testid="studio-prompt"]', prompt);
  const before = await page.evaluate(
    () => document.querySelectorAll('[data-testid="media-card"]').length,
  );
  await page.click('[data-testid="studio-run"]');
  const t0 = Date.now();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="media-card"]').length > n,
    before,
    { timeout: 600_000, polling: 1000 },
  );
  const wall = Math.round((Date.now() - t0) / 1000);
  await sleep(800);
  const run = await page.evaluate(() => {
    const st = window.__studio_runs().getState();
    const r = st.runs.audio[0]; // newest first
    return r ? { prompt: r.prompt, model: r.model, items: r.items.map((i) => i.path) } : null;
  });
  await page.screenshot({ path: `${SHOT_DIR}/${kind}.png` });
  return { wall, run };
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  if ((await page.$('[data-testid="modality-audio"]')) === null)
    await page.click('text=Modalities');
  await page.click('[data-testid="modality-audio"]');
  await page.waitForSelector('[data-testid="audio-studio"]', { timeout: 15_000 });
  await sleep(800);

  await pick('audio-mode', 'music');
  const music = await generate('fast paced dubstep song', 'music');
  console.log('music', JSON.stringify(music));
  const musicFile = music.run?.items?.[0];
  check(
    musicFile !== undefined && existsSync(musicFile),
    `music produced a file in ${music.wall}s: ${musicFile}`,
  );
  check(
    /stable-audio-3-music/.test(music.run?.model ?? ''),
    `music ran on the music checkpoint (${music.run?.model})`,
  );
  if (musicFile) {
    const m = measure(musicFile);
    console.log('music stats', JSON.stringify(m));
    check(m.seconds >= 18 && m.seconds <= 22, `20 s asked, ${m.seconds}s made`);
    check(
      m.flat < 0.15 && m.peak > 0.25,
      `music, not noise: flatness ${m.flat}, top-5% bins carry ${m.peak}`,
    );
  }

  await pick('audio-mode', 'sfx');
  const sfx = await generate('a wooden door creaking open slowly', 'sfx');
  console.log('sfx', JSON.stringify(sfx));
  const sfxFile = sfx.run?.items?.[0];
  check(
    sfxFile !== undefined && existsSync(sfxFile),
    `sfx produced a file in ${sfx.wall}s: ${sfxFile}`,
  );
  check((sfx.run?.items?.length ?? 0) === 1, `one take by default (${sfx.run?.items?.length})`);
  check(
    /stable-audio-3-sfx/.test(sfx.run?.model ?? ''),
    `the effect ran on the SFX checkpoint (${sfx.run?.model})`,
  );
  if (sfxFile) {
    const m = measure(sfxFile);
    console.log('sfx stats', JSON.stringify(m));
    check(m.seconds >= 4 && m.seconds <= 6, `5 s asked, ${m.seconds}s made`);
    check(m.flat < 0.2, `a sound, not white noise: flatness ${m.flat}`);
  }
} finally {
  await finish();
  rmSync(home, { recursive: true, force: true });
}
