/**
 * QWEN-IMAGE 2.1 THROUGH THE APP — the DEFAULT picture model since 2026-09-20,
 * on MLX (the mflux port, bundled as a wheel beside worker.py) and the model
 * this Mac converted for itself, in the Image studio the way a person uses it:
 * open the room, leave the model and the size the machine picked, type a line
 * with text in it, press Generate, wait, LOOK.
 *
 * What is checked: the catalog lists it FIRST (the default), on mflux with
 * the bundled build and the research licence; klein second; the machine's
 * default size on 24 GB is 1024 (the model garbles text at 512); the guardian
 * admits it on a 24 GB Mac (MEASURED ~7.4 GB of the machine, ~6 GB MLX peak);
 * no download card appears when the conversion is on the shelf; the note
 * counts steps; a real PNG lands in the run's folder; the wall time is
 * printed against the measured 97 s (24 steps at 1024², a chat model
 * resident) so a regression shows as a number.
 *
 * Under 16 GB the honest outcome is the guardian holding it with the numbers.
 *
 *   MAX_MIN=10 SHOT_DIR=/tmp/qwen21 node apps/desktop/tests/e2e/qwen-image-21-real-probe.mjs
 *
 * Real cache + real library (the converted model on its shelf), throwaway
 * home (the output lands in the probe's own Bobble/generated, never the
 * user's). Run `npm run build` first.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const CAP_MS = Number(process.env.MAX_MIN ?? 10) * 60_000;
const PROMPT =
  process.env.PROMPT ??
  'A neon shop sign that reads "BOBBLE", rainy night, reflections on wet pavement, cinematic';

const home = probeHome('qwen-image-21-real');
const outRoot = path.join(home, 'Bobble', 'generated');
const { page, shot, check, finish } = await launchApp('qwen-image-21-real', {
  env: { HOME: home, PI_DESKTOP_GEN: '1' },
  realCache: true,
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});

try {
  await page.waitForFunction(() => typeof window.__modality_store === 'function', {
    timeout: 30_000,
  });
  await page.evaluate(() => window.__modality_store().getState().setView('image'));
  await page.waitForSelector('[data-testid="studio-prompt"]', { timeout: 20_000 });
  await page.waitForFunction(() => (window.__gen_store?.().getState().catalog ?? []).length > 0, {
    timeout: 20_000,
  });

  // THE DEFAULT. "Recommended" in the picker is the catalog's first image
  // entry; the DTO carries it in catalog order.
  const facts = await page.evaluate(() => {
    const cat = window.__gen_store().getState().catalog;
    const images = cat.filter((m) => m.modality === 'image');
    const q = images.find((m) => m.id === 'qwen-image-2.1');
    return {
      first: images[0]?.id,
      second: images[1]?.id,
      license: q?.license,
      commercial: q?.commercialUse,
      backend: q?.backend,
      recommended: images.filter((m) => m.recommended).map((m) => m.id),
    };
  });
  console.log('catalog:', JSON.stringify(facts));
  check(facts.first === 'qwen-image-2.1', `Qwen-Image 2.1 is the default (${facts.first})`);
  check(facts.second === 'flux2-klein-4b', `klein is the fast pick after it (${facts.second})`);
  check(facts.backend === 'mflux', `it runs on MLX (${facts.backend})`);
  check(
    facts.commercial === false && facts.license === 'research-nc',
    'its card says research licence',
  );
  check(facts.recommended.includes('qwen-image-2.1'), 'it is recommended');

  // The machine's default size: 1024 on 24 GB (the rail reads it back).
  const railOpen = async () =>
    (await page.getAttribute('[data-testid="studio-settings"]', 'data-open')) === 'true';
  if (!(await railOpen())) await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(400);
  const sizeText = await page.evaluate(
    () => document.querySelector('[data-testid="image-pixels-rail"]')?.textContent ?? '',
  );
  console.log('size rail:', sizeText.replace(/\s+/g, ' ').slice(0, 120));
  check(
    /1024\s*×\s*1024/.test(sizeText.replace(/\s+/g, ' ')),
    'the default size on this 24 GB Mac is 1024²',
  );
  // Pick Qwen-Image 2.1 in the rail's model picker.
  await page.click('[data-testid="image-model-rail"]');
  await page.waitForTimeout(250);
  const picked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
    const want = rows.find((r) => (r.textContent ?? '').includes('Qwen-Image 2.1'));
    if (want === undefined) return null;
    want.click();
    return want.textContent?.trim() ?? '';
  });
  check(picked !== null, `the model picker has a Qwen-Image 2.1 row (${picked})`);
  await page.waitForTimeout(300);
  await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForTimeout(300);

  await page.fill('[data-testid="studio-prompt"]', PROMPT);
  await shot('1-before');
  // What this Mac is: the catalog says 16 GB for the MLX path (~7.4 GB of
  // the machine at 1024²); on less the guardian must say so — hold with the
  // numbers — rather than run it into a swap storm.
  const totalGB = await page.evaluate(() =>
    window.piDesktop.invoke('app:get-info', undefined).then((i) => i.totalMemoryBytes / 1024 ** 3),
  );
  const fits = totalGB >= 16;
  console.log(
    `machine: ${totalGB.toFixed(0)} GB — ${fits ? 'expect a picture' : 'expect the guardian to hold it, with the numbers'}`,
  );
  const before = new Set(existsSync(outRoot) ? readdirSync(outRoot) : []);
  const t0 = Date.now();
  await page.click('[data-testid="studio-run"]');

  let lastNote = '';
  let done = false;
  let held = '';
  let firstStepAt = null;
  let stepsSeen = 0;
  while (Date.now() - t0 < (fits ? CAP_MS : 45_000)) {
    const state = await page
      .evaluate(() => {
        const job = document.querySelector('[data-testid="studio-job"]');
        const note =
          job?.querySelector('.pd-studio-job-meta, .pd-loader-note, [data-testid="studio-note"]')
            ?.textContent ?? '';
        const text = job?.textContent ?? '';
        const cards = document.querySelectorAll('[data-testid="media-card"]').length;
        const err = document.querySelector('.pd-studio-error')?.textContent ?? '';
        const module = document.querySelector('[data-testid="module-card"]')?.textContent ?? '';
        return { note: note || text.slice(0, 160), cards, err, module };
      })
      .catch(() => null);
    if (state === null) break;
    if (state.module.length > 0) {
      check(false, `the run is gated on a download card: ${state.module.slice(0, 160)}`);
      break;
    }
    if (state.note !== lastNote && state.note.length > 0) {
      lastNote = state.note;
      console.log(
        `   [${((Date.now() - t0) / 1000).toFixed(0)}s] ${lastNote.replace(/\s+/g, ' ').slice(0, 140)}`,
      );
      if (/step|\d+\s*\/\s*\d+/i.test(lastNote)) {
        stepsSeen += 1;
        if (firstStepAt === null) firstStepAt = Date.now();
      }
      const m = /needs about [\s\S]*?(?=Try again|$)/.exec(lastNote.replace(/\s+/g, ' '));
      if (m !== null) held = m[0].trim();
    }
    if (state.err.length > 0) {
      check(false, `the generation failed: ${state.err}`);
      break;
    }
    if (state.cards > 0) {
      done = true;
      break;
    }
    await page.waitForTimeout(1500);
  }
  const secs = (Date.now() - t0) / 1000;
  await page.waitForTimeout(1500);
  await shot('2-after');
  if (!fits) {
    // The honest outcome on a 24 GB Mac: held on the numbers, no swap storm.
    check(
      held !== '',
      `the guardian holds Qwen-Image 2.1 with its numbers on a ${totalGB.toFixed(0)} GB Mac (${held || lastNote.slice(0, 120)})`,
    );
    check(!done, 'and did not run it into a swap storm');
    console.log(`held: ${held}`);
  } else {
    check(done, `no picture after ${secs.toFixed(0)}s`);
    check(stepsSeen > 0, `the card counted steps as it went (${stepsSeen} notes)`);
    console.log(
      `wall: ${secs.toFixed(0)} s (measured by hand: 97 s at 24 steps with a chat model resident; the first run of a fresh uv env adds its resolve)`,
    );
  }

  const made = fits
    ? (existsSync(outRoot) ? readdirSync(outRoot) : []).filter((n) => !before.has(n))
    : [];
  const files = made
    .flatMap((d) => {
      const full = path.join(outRoot, d);
      return statSync(full).isDirectory()
        ? readdirSync(full).map((f) => path.join(full, f))
        : [full];
    })
    .filter((f) => /\.(png|jpg)$/i.test(f));
  if (fits) check(files.length > 0, `a PNG landed under ${outRoot} (${JSON.stringify(made)})`);
  for (const f of files) {
    const kb = statSync(f).size / 1024;
    console.log(`   wrote ${f} (${kb.toFixed(0)} KB)`);
    check(
      kb > 200,
      `${path.basename(f)} is a real 1024² picture, not a stub (${kb.toFixed(0)} KB)`,
    );
  }
  if (files[0] !== undefined) console.log(`RESULT ${files[0]}`);
} finally {
  await finish();
}
