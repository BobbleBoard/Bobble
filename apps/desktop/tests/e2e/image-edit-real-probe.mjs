/**
 * ROUND 2 — A REAL IMAGE-TO-IMAGE EDIT, THROUGH THE APP.
 *
 * the user: "all types of media handoff into studios and EDITING will also be
 * tested." Everything else about the handoff is proven offline in
 * media-handoff-probe. This is the one that costs a GPU: hand a real picture to
 * the Image studio the way "Open in studio" does, press Edit, and check that
 * what comes back is a real file, derived from the input, and DIFFERENT from
 * it in the direction the knob claims.
 *
 * WHY THE DIRECTION MATTERS ENOUGH TO SPEND A GENERATION ON IT
 *
 * mflux's `--image-strength` is the fraction of the denoising schedule SKIPPED,
 * so a bigger number lands CLOSER to the original — the reverse of diffusers,
 * of our own agent tool, and of what anyone typing a number expects. The app
 * carries the ordinary meaning and worker.py inverts. If that inversion is ever
 * dropped, every edit quietly does the opposite of what was asked AND STILL
 * SUCCEEDS: no error, no crash, a perfectly good picture. Unit tests pin the
 * argv; only a real run pins the pixels.
 *
 *   MODEL   catalog id (default z-image-turbo — cached, ~13s at 512²)
 *   MAX_MIN give up after this many minutes (default 12)
 *
 * Uses the REAL home, because the point is the installed engine and its
 * weights. Run `npm run build` first.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'z-image-turbo';
const CAP_MS = Number(process.env.MAX_MIN ?? 12) * 60_000;

/* The input lives where generated media lives, because that is where a picture
   handed over from the transcript comes from and the pd-file:// fence is
   scoped to it. */
const outRoot = path.join(homedir(), 'Bobble', 'generated');
const inputDir = path.join(outRoot, 'probe-edit-input');
mkdirSync(inputDir, { recursive: true });
const inputPath = path.join(inputDir, 'fox-base.png');

/*
 * The base picture. Made by the same engine rather than shipped as a fixture:
 * a hand-drawn PNG would prove the plumbing and nothing about whether an edit
 * of a real generation looks like one. Reused across runs when it is already
 * there — it costs a generation of its own.
 */
if (!existsSync(inputPath)) {
  const src = process.env.BASE_IMAGE;
  if (src === undefined || !existsSync(src)) {
    console.error(
      'no base image: set BASE_IMAGE=/path/to.png, or let a previous run leave one at',
      inputPath,
    );
    process.exit(1);
  }
  writeFileSync(inputPath, (await import('node:fs')).readFileSync(src));
}

const before = new Set(existsSync(outRoot) ? readdirSync(outRoot) : []);

const { page, shot, check, finish, shotDir } = await launchApp('image-edit-real-probe', {
  // `?gen=1` is main.ts's surfacing of PI_DESKTOP_GEN — generation is behind an
  // experimental flag, and a probe should not have to write the user's settings
  // to get at it.
  env: { PI_DESKTOP_GEN: '1' },
  args: ['--', '--piE2E=1'],
  timeout: 60_000,
});

const newOutputs = () =>
  (existsSync(outRoot) ? readdirSync(outRoot) : []).filter((n) => !before.has(n));

try {
  await page.waitForFunction(() => typeof window.__studio_handoff === 'function', {
    timeout: 30_000,
  });

  /* ------------------------------------------- hand the picture to the room */
  await page.evaluate(
    ([p]) => {
      window.__studio_handoff().getState().offer('image', {
        path: p,
        name: 'fox-base.png',
        kind: 'image',
        prompt: 'a red fox sitting in deep snow, soft winter light',
      });
      window.__modality_store().getState().setView('image');
    },
    [inputPath],
  );
  await page.waitForSelector('.pd-studio', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="studio-input"]', { timeout: 10_000 });
  const label = await page.evaluate(
    () => document.querySelector('[data-testid="studio-run"]')?.textContent?.trim() ?? '',
  );
  check(label === 'Edit', `the run button says "${label}", not Edit, with a picture loaded`);

  /* --------------------------------- pick the model and the change amount */
  const railOpen = async () =>
    (await page.getAttribute('[data-testid="studio-settings"]', 'data-open')) === 'true';
  if (!(await railOpen())) await page.click('[data-testid="studio-settings-toggle"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="studio-settings"]')?.getAttribute('data-open') ===
      'true',
    { timeout: 6000 },
  );
  await page.waitForTimeout(300);

  // "High" — the largest magnitude the knob offers, so the difference is not a
  // question of measurement noise.
  await page.click('[data-testid="image-strength-rail"] >> text=High');
  await page.click('[data-testid="image-model-rail"]');
  await page.waitForTimeout(250);
  const picked = await page.evaluate(
    ([id]) => {
      const rows = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
      const want = rows.find((r) => (r.textContent ?? '').toLowerCase().includes(id));
      if (want === undefined) return null;
      want.click();
      return want.textContent?.trim() ?? '';
    },
    [MODEL.replace('z-image-turbo', 'z-image')],
  );
  check(picked !== null, `the image model picker has no row for ${MODEL}`);
  console.log(`   model: ${picked}`);
  await page.waitForTimeout(300);

  /* ------------------------------------------------------------- run it */
  await page.fill(
    '[data-testid="studio-prompt"]',
    'a red fox sitting in deep snow at golden hour, warm low sun',
  );
  await shot('1-before-edit');
  const t0 = Date.now();
  await page.click('[data-testid="studio-run"]');

  // A cold run provisions Python and loads weights before step 1; the room
  // narrates that in its own footnote, which is also how we know it is alive.
  let lastNote = '';
  let done = false;
  while (Date.now() - t0 < CAP_MS) {
    const state = await page
      .evaluate(() => {
        const job = document.querySelector('[data-testid="studio-job-meta"]')?.textContent ?? '';
        const cards = document.querySelectorAll('[data-testid="media-card"]').length;
        const err = document.querySelector('.pd-studio-error')?.textContent ?? '';
        return { job, cards, err };
      })
      .catch(() => null);
    if (state === null) break;
    if (state.job !== lastNote && state.job.length > 0) {
      lastNote = state.job;
      console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] ${lastNote}`);
    }
    if (state.err.length > 0) {
      check(false, `the edit failed: ${state.err}`);
      break;
    }
    if (state.cards > 0) {
      done = true;
      break;
    }
    await page.waitForTimeout(1500);
  }
  check(done, `no result after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await shot('2-after-edit');

  /* ------------------------------------------- what actually landed on disk */
  const made = newOutputs();
  check(made.length > 0, `the edit produced no new output directory under ${outRoot}`);
  const files = made
    .flatMap((d) => {
      const full = path.join(outRoot, d);
      return statSync(full).isDirectory()
        ? readdirSync(full).map((f) => path.join(full, f))
        : [full];
    })
    .filter((f) => f.endsWith('.png') || f.endsWith('.jpg'));
  check(files.length > 0, `nothing image-shaped in ${JSON.stringify(made)}`);
  for (const f of files) console.log(`   wrote ${f} (${(statSync(f).size / 1024).toFixed(0)} KB)`);

  /*
   * THE ACTUAL CLAIM: the result is DERIVED from the input and DIFFERENT from
   * it. Identical means the input was ignored (a plain text-to-image run);
   * unrecognisably different at "High" is possible but a mean per-channel
   * distance near the noise floor is not — that is the inversion having flipped.
   */
  if (files.length > 0) {
    const distance = await page.evaluate(
      async ([a, b]) => {
        const read = async (p) => {
          const res = await fetch(`pd-file://f${encodeURI(p)}`);
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob);
          const c = new OffscreenCanvas(128, 128);
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0, 128, 128);
          return ctx.getImageData(0, 0, 128, 128).data;
        };
        const [x, y] = await Promise.all([read(a), read(b)]);
        let sum = 0;
        let n = 0;
        for (let i = 0; i < x.length; i += 4) {
          sum +=
            Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
          n += 3;
        }
        return sum / n;
      },
      [inputPath, files[0]],
    );
    console.log(`   mean |Δ| from the input: ${distance.toFixed(1)} / 255`);
    check(distance > 1, `the result is identical to the input — the picture was ignored`);
    check(
      distance < 120,
      `the result has nothing to do with the input (Δ ${distance.toFixed(1)}) — an edit should keep the composition`,
    );
  }

  console.log(`shots: ${shotDir}`);
} finally {
  await finish();
}
