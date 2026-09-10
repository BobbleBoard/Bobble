/**
 * macmon-parity-probe — the computer-use monitor's states nothing else reaches.
 *
 * `mac-monitor-probe` proves the picture: the tab opens itself, the window is
 * drawn at real point size, the phantom is painted, the capture follows
 * visibility. This one proves the PRODUCT AROUND the picture, and it exists
 * because every item it covers was a measurement in the design-parity review
 * rather than an opinion:
 *
 *   - light mode at the footer (measured: a light scrim fading into a dark
 *     photograph, with muted grey text across the seam);
 *   - reduced motion on the CANVAS (measured: 753 sampled pixels still changing
 *     per 400ms with `prefers-reduced-motion: reduce`), which the CSS rules
 *     never covered because the cursor, the press pop and the
 *     bubble dots are all drawn, not animated;
 *   - the act strip: hover previews, click commits, and what the pinned pill
 *     says while you are scrubbed back;
 *   - take-over, whose load-bearing half is that the CAPTURE CHILD DIES — the
 *     next thing a user does in the app the agent just opened is very often
 *     typing a password into it;
 *   - the scale readout, which replaced "12 fps".
 *
 * Everything runs against the dev frame source (`PI_MAC_MONITOR_MOCK=1`), which
 * stubs the HELPER and not the surface. Nothing ever takes the screen.
 *
 * Artifacts → $TMPDIR/pd-shots/macmon-parity (override with SHOT_DIR).
 */
import { measureDrawnWindow } from './_macmon-measure.mjs';
import { launchApp } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { page, shot, check, finish, shotDir } = await launchApp('macmon-parity', {
  env: { PI_MAC_MONITOR_MOCK: '1' },
  args: ['--', '--piE2E=1'],
});

async function until(fn, arg, timeout = 15_000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 120 });
    return true;
  } catch {
    return false;
  }
}

/** Light and dark are one attribute pair on the root, as every design probe does it. */
async function setTheme(mode) {
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-flavor', 'bobble');
    document.documentElement.setAttribute('data-mode', m);
  }, mode);
  await sleep(400);
}

/**
 * How much of the surface is MOVING, in sampled pixels per 400ms.
 *
 * The same measurement the review used: two full canvas reads 400ms apart,
 * every 8th pixel compared with a tolerance for JPEG noise. Run in the page.
 */
function measureMotion() {
  const canvas = document
    .querySelector('[data-testid="computer-use-surface"]')
    ?.querySelector('canvas');
  if (canvas == null) return Promise.resolve(null);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const read = () => ctx.getImageData(0, 0, W, H).data;
  const a = read();
  return new Promise((resolve) => {
    setTimeout(() => {
      const b = read();
      let changed = 0;
      let sampled = 0;
      for (let i = 0; i < a.length; i += 4 * 8) {
        sampled += 1;
        if (
          Math.abs(a[i] - b[i]) > 6 ||
          Math.abs(a[i + 1] - b[i + 1]) > 6 ||
          Math.abs(a[i + 2] - b[i + 2]) > 6
        ) {
          changed += 1;
        }
      }
      resolve({ changed, sampled });
    }, 400);
  });
}

/**
 * Motion in the 10px band JUST OUTSIDE the drawn window, where the only thing
 * that ever moves is the surface's own breathing "working" outline.
 *
 * A whole-canvas diff cannot answer this question on its own: the stage is a
 * LIVE STREAM of a window whose content genuinely changes, and suppressing that
 * would be suppressing the feature rather than the animation. The band is
 * wallpaper — dead still unless we are animating on it.
 */
function measureGlowBand(box) {
  const canvas = document
    .querySelector('[data-testid="computer-use-surface"]')
    ?.querySelector('canvas');
  if (canvas == null || box == null) return Promise.resolve(null);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pad = Math.round(14 * box.dpr);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(canvas.width - x, box.w + pad * 2);
  const h = Math.min(canvas.height - y, box.h + pad * 2);
  const read = () => ctx.getImageData(x, y, w, h).data;
  const inner = { x: box.x - x + 2, y: box.y - y + 2, w: box.w - 4, h: box.h - 4 };
  const a = read();
  return new Promise((resolve) => {
    setTimeout(() => {
      const b = read();
      let changed = 0;
      let sampled = 0;
      for (let py = 0; py < h; py += 2) {
        for (let px = 0; px < w; px += 2) {
          // Only the band: skip everything inside the window itself.
          if (px >= inner.x && px < inner.x + inner.w && py >= inner.y && py < inner.y + inner.h) {
            continue;
          }
          const i = (py * w + px) * 4;
          sampled += 1;
          if (
            Math.abs(a[i] - b[i]) > 4 ||
            Math.abs(a[i + 1] - b[i + 1]) > 4 ||
            Math.abs(a[i + 2] - b[i + 2]) > 4
          ) {
            changed += 1;
          }
        }
      }
      resolve({ changed, sampled });
    }, 400);
  });
}

/** The footer's real contrast, resolved — not the token, the pixels. */
function readFooter() {
  const root = document.querySelector('[data-testid="computer-use-surface"]');
  const footer = root?.querySelector('.pd-macmon-footer');
  const ident = root?.querySelector('.pd-macmon-ident-text');
  if (footer == null) return null;
  const cs = getComputedStyle(footer);
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m === null) return null;
    const p = m[1].split(',').map((v) => Number.parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = (c) => {
    if (c === null) return null;
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bg = parse(cs.backgroundColor);
  // The band sits on the surface's own ground, so an unset background is that.
  const ground = parse(getComputedStyle(root).backgroundColor);
  const under = bg === null || bg.a === 0 ? ground : bg;
  const fg = parse(getComputedStyle(ident ?? footer).color);
  const l1 = lum(fg);
  const l2 = lum(under);
  const ratio =
    l1 === null || l2 === null ? null : (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return {
    text: (ident?.textContent ?? '').trim(),
    color: cs.color,
    onCanvas: root.querySelector('.pd-macmon-stage')?.contains(footer) === true,
    contrast: ratio === null ? null : Math.round(ratio * 100) / 100,
  };
}

const files = [];
const snap = async (label) => {
  const f = await shot(label);
  files.push(f);
  return f;
};

try {
  await page.setViewportSize({ width: 1500, height: 950 });
  const opened = await until(() => {
    const c = window.__pi_canvas?.();
    return c?.getState().tabs.some((t) => t.key === 'mac-monitor') === true;
  });
  check(opened, 'the computer-use tab did not open itself');
  await page.evaluate(() => window.__pi_canvas?.().setFullscreen(true));
  const live = await until(
    () => document.querySelector('.pd-macmon-live[data-live="true"]') !== null,
  );
  check(live, 'the surface never reported a live stream');
  await sleep(2500); // let the choreography log a few acts

  // ── 1. light mode ───────────────────────────────────────────────────────
  await setTheme('light');
  await snap('A-light-full');
  const lightFooter = await page.evaluate(readFooter);
  check(
    lightFooter?.onCanvas === false,
    'the footer is inside the stage — it will always be a scrim on a photograph',
  );
  check(
    (lightFooter?.contrast ?? 0) >= 4.5,
    `light-mode footer text is ${lightFooter?.contrast}:1 against its own ground`,
  );
  console.log(
    `light footer: "${lightFooter?.text}" ${lightFooter?.color} ${lightFooter?.contrast}:1`,
  );

  await setTheme('dark');
  await snap('B-dark-full');
  const darkFooter = await page.evaluate(readFooter);
  check(
    (darkFooter?.contrast ?? 0) >= 4.5,
    `dark-mode footer text is ${darkFooter?.contrast}:1 against its own ground`,
  );
  console.log(`dark footer:  "${darkFooter?.text}" ${darkFooter?.color} ${darkFooter?.contrast}:1`);

  // ── 2. the docked rail, both modes, both themes ─────────────────────────
  await page.evaluate(() => window.__pi_canvas?.().setFullscreen(false));
  await sleep(700);
  const press = async (id) => {
    await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), id);
    await sleep(700);
  };
  const scale = async () => {
    const t = await page.evaluate(
      () => document.querySelector('.pd-macmon-scale')?.textContent ?? '',
    );
    return t === '' ? 100 : Number.parseInt(t, 10);
  };
  await press('macmon-fit');
  const fitScale = await scale();
  await snap('C-docked-fit-dark');
  await press('macmon-follow');
  const followScale = await scale();
  await snap('D-docked-follow-dark');
  await setTheme('light');
  await snap('E-docked-follow-light');
  await setTheme('dark');
  // Nothing in the actions row may be clipped by a docked rail.
  const clipped = await page.evaluate(() => {
    const row = document.querySelector('.pd-macmon-actions');
    if (row === null) return null;
    const box = row.getBoundingClientRect();
    const over = [...row.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.left < box.left - 0.5;
      })
      .map((b) => (b.textContent ?? '').trim());
    return { width: Math.round(box.width), height: Math.round(box.height), over };
  });
  check(
    (clipped?.over.length ?? 1) === 0,
    `the actions row clips ${clipped?.over.join(', ')} at ${clipped?.width}px`,
  );
  console.log(`actions row: ${clipped?.width}×${clipped?.height}px, nothing clipped`);
  check(fitScale < 60, `fit in the rail read ${fitScale}%`);
  check(followScale >= 85, `follow in the rail read ${followScale}%`);
  console.log(`docked rail: fit ${fitScale}% → follow ${followScale}%`);

  // ── 3. reduced motion, on the CANVAS ────────────────────────────────────
  await page.evaluate(() => window.__pi_canvas?.().setFullscreen(true));
  await sleep(700);
  const box = await page.evaluate(measureDrawnWindow);
  const movingAll = await page.evaluate(measureMotion);
  const movingBand = await page.evaluate(measureGlowBand, box);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sleep(900);
  const stillAll = await page.evaluate(measureMotion);
  const stillBand = await page.evaluate(measureGlowBand, box);
  await snap('F-reduced-motion');
  // The whole-canvas number cannot go to zero and should not: the stage is a
  // live stream of a window whose content genuinely changes. What must stop is
  // everything the SURFACE animates — and all of that, in the band outside the
  // window, is the breathing "working" outline.
  check(
    (movingBand?.changed ?? 0) > 100,
    `nothing was animating outside the window to begin with (${movingBand?.changed})`,
  );
  check(
    (stillBand?.changed ?? 1) <= 20,
    `reduced motion still animates ${stillBand?.changed} of ${stillBand?.sampled} band pixels per 400ms`,
  );
  console.log(
    `motion (whole canvas): normal ${movingAll?.changed}/${movingAll?.sampled} → reduced ${stillAll?.changed}/${stillAll?.sampled}`,
  );
  console.log(
    `motion (surface's own, in the band outside the window): normal ${movingBand?.changed}/${movingBand?.sampled} → reduced ${stillBand?.changed}/${stillBand?.sampled}`,
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await sleep(400);

  // ── 4. the act strip: hover previews, click commits ─────────────────────
  await sleep(2200);
  const strip = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.pd-macmon-chip')];
    return {
      count: chips.length,
      withPictures: chips.filter((c) => c.querySelector('img') !== null).length,
      labels: chips.map((c) => (c.getAttribute('aria-label') ?? '').trim()),
    };
  });
  check(strip.count >= 2, `the act strip has ${strip.count} chips after ~7s of acts`);
  check(
    strip.withPictures >= strip.count - 1,
    `${strip.count - strip.withPictures} of ${strip.count} chips never got a picture`,
  );
  console.log(`acts: ${strip.labels.join(' | ')}`);

  await page.evaluate(() => {
    const chip = document.querySelector('.pd-macmon-chip');
    chip?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  });
  await sleep(500);
  await snap('G-hover-scrub');
  await page.evaluate(() => document.querySelector('.pd-macmon-chip')?.click());
  await sleep(600);
  const pinned = await page.evaluate(
    () => document.querySelector('[data-testid="macmon-pinned"]')?.textContent ?? '',
  );
  check(pinned.includes('Pinned'), `no pinned pill while scrubbed back (got "${pinned}")`);
  check(/\d+ new since/.test(pinned), `the pinned pill does not say what was missed: "${pinned}"`);
  await snap('H-pinned');
  console.log(`pinned pill: ${pinned.replace(/\s+/g, ' ')}`);
  await page.evaluate(() => document.querySelector('.pd-macmon-pinned-resume')?.click());
  await sleep(400);

  // ── 4b. the keyboard path, and the brake ────────────────────────────────
  const order = await page.evaluate(() => {
    const row = document.querySelector('.pd-macmon-actions');
    return [...(row?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim());
  });
  check(
    order[0] === 'Stop',
    `Stop is not the first control in the tab order (got ${order.join(' → ')})`,
  );
  console.log(`tab order: ${order.join(' → ')}`);

  // Cmd-. is the macOS convention for "stop what you are doing" and what Screen
  // Sharing binds. It fires only while focus is inside this surface.
  //
  // The check watches the live region rather than the IPC: `piDesktop` comes
  // over contextBridge and its properties cannot be reassigned, so a spy on
  // `invoke` silently does nothing. The surface announces "Stopped" from the
  // same handler that calls the composer's own abort — and the announcement is
  // collected through a MutationObserver because the next act overwrites it
  // within a beat.
  await page.evaluate(() => {
    window.__macmonSaid = [];
    const node = document.querySelector('.pd-macmon-sr');
    if (node === null) return;
    new MutationObserver(() => window.__macmonSaid.push(node.textContent ?? '')).observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.evaluate(() => document.querySelector('[data-testid="macmon-stop"]')?.focus());
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? '',
  );
  check(focused === 'macmon-stop', `Stop did not take focus (activeElement was "${focused}")`);
  await page.keyboard.press('Meta+.');
  await sleep(600);
  const said = await page.evaluate(() => window.__macmonSaid ?? []);
  check(said.includes('Stopped'), `Cmd-. did not reach the brake (announced ${said.join(' → ')})`);
  console.log(`cmd-. → announced ${said.join(' → ')}`);

  // Copy frame: the tab bar's own Copy is hidden for this surface because there
  // is "no text to copy", which was true and beside the point.
  await page.evaluate(() => document.querySelector('[data-testid="macmon-copy"]')?.click());
  await sleep(700);
  const copyLabel = await page.evaluate(
    () => document.querySelector('[data-testid="macmon-copy"]')?.textContent?.trim() ?? '',
  );
  check(copyLabel !== 'Copy frame', 'the Copy frame button did nothing at all');
  console.log(`copy frame → "${copyLabel}"`);

  // ── 4c. stalled: a live stream with no frames says so, with a number ─────
  // The mock cannot stop delivering frames on request, so the fps window it is
  // read through is stubbed instead — the same seam the surface reads.
  await page.evaluate(() => {
    const tab = window
      .__pi_canvas?.()
      .getState()
      .tabs.find((t) => t.key === 'mac-monitor');
    if (tab?.macMonitor !== undefined) {
      window.__macmonFps = tab.macMonitor.getFps.bind(tab.macMonitor);
      tab.macMonitor.getFps = () => 0;
    }
  });
  await sleep(5200);
  const stalledText = await page.evaluate(
    () => document.querySelector('.pd-macmon-live[data-stalled="true"]')?.textContent ?? '',
  );
  check(
    /Stalled · \d+s/.test(stalledText),
    `no stalled state after 5s of no frames ("${stalledText}")`,
  );
  await snap('J-stalled');
  console.log(`stalled chip: ${stalledText}`);
  await page.evaluate(() => {
    const tab = window
      .__pi_canvas?.()
      .getState()
      .tabs.find((t) => t.key === 'mac-monitor');
    if (tab?.macMonitor !== undefined && window.__macmonFps !== undefined) {
      tab.macMonitor.getFps = window.__macmonFps;
    }
  });
  await until(() => document.querySelector('.pd-macmon-live[data-live="true"]') !== null);
  await sleep(900);

  // ── 5. take over: the capture child must actually die ───────────────────
  const monitorInfo = () =>
    page
      .evaluate(() => window.piDesktop.invoke('mac:debug', { op: 'monitor-info' }))
      .then((r) => r?.result ?? null);
  const before = await monitorInfo();
  check(before?.capturing === true, 'no capture child was running before the take-over');
  await page.evaluate(() => document.querySelector('[data-testid="macmon-takeover"]')?.click());
  await sleep(1400);
  const after = await monitorInfo();
  check(
    after?.capturing === false,
    `the capture kept running after Take over (stream=${String(after?.stream)})`,
  );
  const panel = await page.evaluate(
    () => document.querySelector('.pd-macmon-state[data-kind="taken-over"]')?.textContent ?? '',
  );
  check(panel.includes("You're driving"), 'no stated condition after taking over');
  await snap('I-taken-over');
  console.log(`take over: capturing ${before?.capturing} → ${after?.capturing}`);
  console.log(`  panel: ${panel.replace(/\s+/g, ' ').slice(0, 120)}`);

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.pd-macmon-btn')];
    btns.find((b) => (b.textContent ?? '').includes('carry on'))?.click();
  });
  await sleep(1500);
  const resumed = await monitorInfo();
  check(resumed?.capturing === true, 'handing back did not restart the capture');
  console.log(`hand back: capturing ${resumed?.capturing}`);

  console.log('\nSCREENSHOTS');
  for (const f of files) console.log(`  ${f}`);
  console.log(`  (dir: ${shotDir})`);
} finally {
  const ok = await finish();
  if (!ok) process.exitCode = 1;
}
