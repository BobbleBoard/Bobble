/**
 * DICTATION THAT CANNOT RUN — a way in, never red text.
 *
 * The user (2026-10-08): "'the voice model is not installed' … red text that's
 * just a real unknown error or something that doesn't have handling attached
 * to it or can be easily done something about just can't exist anymore."
 *
 * Part A, a fresh Mac (an empty engine cache): pressing the mic shows the
 * Dictation module's Download card in the composer — not an error — and
 * closing it puts the mic back to rest. (The probe does not press Download:
 * that is a 2.5 GB install.)
 *
 * Part B, dictation installed (a cache holding the environment and the model's
 * files): the microphone itself is stubbed in the page, so nothing real is
 * opened. Denied → a plain sentence and "Open Microphone settings", which asks
 * main to open the pane (recorded, not opened, under E2E); missing → "No
 * microphone is connected" and Try again. No red text either way.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/dictation-look.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Red text in the composer: the thing that must not exist. */
const redIn = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid="composer"] *, .pd-composer *')].filter((el) => {
        if (el.children.length > 0 || (el.textContent ?? '').trim() === '') return false;
        const c = getComputedStyle(el).color.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
        return c[0] > 180 && c[1] < 120 && c[2] < 120;
      }).length,
  );

// ── Part A: nothing installed ───────────────────────────────────────────────
if (process.env.ONLY_C !== '1') {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'pd-gen3d-empty-'));
  const { page, check, shot, finish } = await launchApp('dictation-a', {
    env: { GEN3D_CACHE_DIR: empty },
    args: ['--', '--piE2E=1'],
    waitFor: '[data-testid="composer-input"]',
  });
  try {
    await sleep(1500);
    await page.click('[data-testid="composer-mic"]');
    await page.waitForSelector('[data-testid="dictation-needs-module"]', { timeout: 8000 });
    await sleep(400);
    const card = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="module-card-dictation"]');
      return {
        text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        buttons: [...(el?.querySelectorAll('button') ?? [])].map(
          (b) => b.textContent?.trim() || b.getAttribute('aria-label'),
        ),
      };
    });
    console.log('card', JSON.stringify(card));
    check(
      /Dictation not installed/.test(card.text),
      `the mic offers the Dictation module (${card.text.slice(0, 80)})`,
    );
    check(
      card.buttons.some((b) => /Download/i.test(b ?? '')),
      `with a Download button (${card.buttons.join(' | ')})`,
    );
    check((await page.$('[data-testid="dictation-error"]')) === null, 'and no error');
    check((await redIn(page)) === 0, 'no red text in the composer');
    await shot('1-needs-module');
    await page.click('[data-testid="module-card-dictation"] button:has-text("Not now")');
    await sleep(400);
    check(
      (await page.$('[data-testid="dictation-needs-module"]')) === null,
      '"Not now" puts the mic back to rest',
    );
    // Asked again, the card comes back.
    await page.click('[data-testid="composer-mic"]');
    await page.waitForSelector('[data-testid="dictation-needs-module"]', { timeout: 8000 });
    check(true, 'pressing the mic again offers it again');
  } finally {
    await finish();
  }
}

// ── Part B: installed; the microphone denied, then missing ──────────────────
if (process.env.ONLY_C !== '1') {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'pd-gen3d-dict-'));
  const bin = path.join(cache, 'src', 'audio', '.venv', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'python'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const snap = path.join(
    cache,
    'hf',
    'hub',
    'models--mlx-community--parakeet-tdt-0.6b-v3',
    'snapshots',
    'abc',
  );
  mkdirSync(snap, { recursive: true });
  writeFileSync(path.join(snap, 'config.json'), '{}');
  writeFileSync(path.join(snap, 'model.safetensors'), '');
  const { app, page, check, shot, finish } = await launchApp('dictation-b', {
    env: { GEN3D_CACHE_DIR: cache },
    args: ['--', '--piE2E=1'],
    waitFor: '[data-testid="composer-input"]',
  });
  try {
    await sleep(1500);
    const ready = await page.evaluate(
      () =>
        window
          .__gen_modules?.()
          .getState?.()
          .modules?.find((m) => m.id === 'dictation')?.ready ?? null,
    );
    console.log('dictation module ready (store hook, null = no hook):', ready);
    // Denied.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('denied', 'NotAllowedError');
      };
    });
    await page.click('[data-testid="composer-mic"]');
    await page.waitForSelector('[data-testid="dictation-error"]', { timeout: 8000 });
    const denied = await page.textContent('[data-testid="dictation-error"]');
    console.log('denied:', denied);
    check(
      /not allowed to use the microphone/.test(denied ?? ''),
      'a denied microphone says so plainly',
    );
    check(
      (await page.$('[data-testid="dictation-fix-mic-settings"]')) !== null,
      'and offers Open Microphone settings',
    );
    check((await redIn(page)) === 0, 'no red text');
    await shot('2-mic-denied');
    await page.click('[data-testid="dictation-fix-mic-settings"]');
    await sleep(300);
    const opens = await app.evaluate(() => globalThis.__pdOsOpens ?? []);
    check(
      opens.some((o) => o.channel === 'audio:open-mic-settings'),
      'the button asks main to open the Microphone pane (recorded, not opened, under E2E)',
    );
    // Missing.
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('none', 'NotFoundError');
      };
    });
    await page.click('[data-testid="dictation-fix-retry"]');
    await sleep(600);
    const missing = await page.textContent('[data-testid="dictation-error"]');
    console.log('missing:', missing);
    check(
      /No microphone is connected/.test(missing ?? ''),
      'no microphone says so, with Try again',
    );
    await shot('3-no-mic');
    await page.click('[data-testid="dictation-problem-dismiss"]');
    await sleep(300);
    check((await page.$('[data-testid="dictation-error"]')) === null, 'dismiss clears it');
  } finally {
    await finish();
  }
}

// ── Part C (REAL_INSTALL=1): the Download button, for real ─────────────────
// An empty engine cache whose Hugging Face folder links to the speech model
// already on this Mac (so the 2.3 GB is not fetched again): Download builds the
// environment for real, the card goes away, and the mic dictates — fed a
// generated tone through a stubbed getUserMedia, so no real microphone opens.
if (process.env.REAL_INSTALL === '1') {
  const { symlinkSync, existsSync, realpathSync } = await import('node:fs');
  const cache = mkdtempSync(path.join(os.tmpdir(), 'pd-gen3d-real-'));
  const hub = path.join(cache, 'hf', 'hub');
  mkdirSync(hub, { recursive: true });
  const have = path.join(
    os.homedir(),
    '.cache',
    'bobble',
    'gen3d',
    'hf',
    'hub',
    'models--mlx-community--parakeet-tdt-0.6b-v3',
  );
  if (existsSync(have)) {
    symlinkSync(realpathSync(have), path.join(hub, 'models--mlx-community--parakeet-tdt-0.6b-v3'));
  }
  const { app, page, check, shot, finish } = await launchApp('dictation-c', {
    env: { GEN3D_CACHE_DIR: cache },
    args: ['--', '--piE2E=1'],
    waitFor: '[data-testid="composer-input"]',
    timeout: 60_000,
  });
  const mainLines = [];
  for (const stream of [app.process().stdout, app.process().stderr]) {
    stream?.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (/dictation|recogni|audio_worker|transcri/i.test(line))
          mainLines.push(line.slice(0, 300));
      }
    });
  }
  page.on('console', (m) => {
    if (/dictation|recogni/i.test(m.text())) mainLines.push(`[renderer] ${m.text().slice(0, 300)}`);
  });
  try {
    await sleep(1500);
    await page.evaluate(() => {
      // A tone, not a voice: the path runs end to end and nothing real is heard.
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 220;
        osc.connect(dest);
        osc.start();
        return dest.stream;
      };
    });
    await page.click('[data-testid="composer-mic"]');
    await page.waitForSelector('[data-testid="module-card-dictation"]', { timeout: 8000 });
    await page.click('[data-testid="module-card-dictation"] button:has-text("Download")');
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < 600_000) {
      const state = await page.evaluate(() => ({
        card: document.querySelector('[data-testid="module-card-dictation"]')?.textContent ?? null,
        recording: document.querySelector('.pd-dictation') !== null,
      }));
      const line = (state.card ?? '').replace(/\s+/g, ' ').slice(0, 110);
      if (line !== last) {
        console.log(`  ${Math.round((Date.now() - t0) / 1000)}s`, line || '(card gone)');
        last = line;
      }
      if (state.card === null || state.recording) break;
      if (/did not install/.test(state.card ?? '')) break;
      await sleep(1000);
    }
    await shot('4-installed');
    const after = await page.evaluate(() => ({
      card: document.querySelector('[data-testid="module-card-dictation"]')?.textContent ?? null,
      phase: document.querySelector('.pd-dictation')?.getAttribute('data-phase') ?? null,
    }));
    console.log('after install', JSON.stringify(after));
    check(after.card === null, 'the install lands and the card goes away');
    // The dictation the person asked for starts by itself; let it listen, then stop.
    const t1 = Date.now();
    let phase = null;
    while (Date.now() - t1 < 120_000) {
      const now = await page.evaluate(
        () => document.querySelector('.pd-dictation')?.getAttribute('data-phase') ?? null,
      );
      if (now !== phase) {
        console.log(`  +${Math.round((Date.now() - t1) / 1000)}s phase`, now);
        phase = now;
      }
      if (now === 'recording') break;
      if (now === null && (await page.$('[data-testid="dictation-error"]')) !== null) break;
      await sleep(500);
    }
    check(phase === 'recording', `the dictation asked for starts by itself and listens (${phase})`);
    await sleep(3000);
    await shot('5-listening');
    const stopBtn = await page.$(
      '[data-testid="dictation-stop"], .pd-dictation button[aria-label*="Stop"], .pd-dictation button[aria-label*="Done"]',
    );
    if (stopBtn !== null) await stopBtn.click();
    await sleep(8000);
    const end = await page.evaluate(() => ({
      problem: document.querySelector('[data-testid="dictation-error"]')?.textContent ?? null,
      text: document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
    }));
    console.log('after stop', JSON.stringify(end));
    if (/Nothing was heard/.test(end.problem ?? '')) {
      check(
        end.text.trim() === '',
        `with nothing heard, the preview's guess is taken back out (${end.text})`,
      );
    }
    check(
      end.problem === null || /Nothing was heard/.test(end.problem),
      `a tone ends as "nothing heard" or a transcript, never a raw error (${end.problem})`,
    );
    await shot('6-after-stop');
    if (process.env.DIAG === '1') console.log(`MAIN\n  ${mainLines.join('\n  ')}`);
    if (process.env.DIAG === '1') {
      const raw = await page.evaluate(async () => {
        const out = {};
        const s = await window.piDesktop.invoke('audio:dictation-start', {});
        out.start = s;
        const n = 16000;
        const f = new Float32Array(n);
        for (let i = 0; i < n; i++) f[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000);
        const bytes = new Uint8Array(f.buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192)
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await window.piDesktop.invoke('audio:dictation-chunk', {
          sessionId: s.sessionId,
          pcmBase64: btoa(bin),
        });
        const t = Date.now();
        out.stop = await window.piDesktop.invoke('audio:dictation-stop', {
          sessionId: s.sessionId,
        });
        out.stopMs = Date.now() - t;
        return out;
      });
      console.log('DIAG', JSON.stringify(raw));
    }
  } finally {
    await finish();
  }
}
