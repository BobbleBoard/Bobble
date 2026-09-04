/**
 * DOES THE JITTER DETECTOR STILL SEE ANYTHING?
 *
 * The stress probe reports "no jitter findings", and that claim is only worth
 * something if the thing making it can still fail. A detector gets calibrated
 * against real runs — input gating, empty boxes, resize-driven shifts, the
 * transcript exclusion — and every one of those refinements is a chance to have
 * quietly blinded it.
 *
 * So: inject one of each defect it is supposed to catch, deliberately, and
 * require it to catch all three. If this probe goes green while the stress probe
 * reports nothing, the silence means something.
 */
import { launchApp } from './harness.mjs';
import { armJitter, jitterReport, mark, summarizeJitter } from './jitter.mjs';

const { page, check, finish } = await launchApp('jitter-selftest-probe');

try {
  await page.waitForTimeout(800);
  await armJitter(page);
  await page.waitForTimeout(400);

  /* ── FLASH: something visible that lives for under a quarter second ──────── */
  await mark(page, 'flash');
  await page.evaluate(async () => {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'selftest-flash');
    el.style.cssText = 'position:fixed;top:40px;left:40px;width:120px;height:60px;background:#333';
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 120));
    el.remove();
  });
  await page.waitForTimeout(400);

  /* ── BOUNCE: real content pushed down and let back up ────────────────────── */
  await mark(page, 'bounce');
  await page.evaluate(async () => {
    // A spacer ABOVE the composer: inserting it moves everything below, removing
    // it puts everything back — the exact shape of "pushed something up then
    // pushed everything back down again".
    const host = document.querySelector('.pd-composer')?.parentElement ?? document.body;
    const spacer = document.createElement('div');
    spacer.style.cssText = 'height:40px';
    host.insertBefore(spacer, host.firstChild);
    await new Promise((r) => setTimeout(r, 200));
    spacer.remove();
    await new Promise((r) => setTimeout(r, 200));
  });
  await page.waitForTimeout(600);

  /* ── STALL: a frame the main thread never gave back ──────────────────────── */
  await mark(page, 'stall');
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const until = performance.now() + 450;
    while (performance.now() < until) {
      // Busy-wait: this is the point.
    }
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });
  await page.waitForTimeout(600);

  await mark(page, 'idle');
  const report = await jitterReport(page);
  const findings = summarizeJitter(report);
  console.log(`${findings.length} finding(s):`);
  for (const f of findings) console.log(`  • ${f}`);

  check(
    findings.some((f) => f.startsWith('flash:') && f.includes('appeared for')),
    'the detector missed a 120ms visible element (FLASH)',
  );
  check(
    findings.some((f) => f.startsWith('bounce:') && f.includes('came back')),
    'the detector missed content pushed down and let back up (BOUNCE)',
  );
  check(
    findings.some((f) => f.startsWith('stall:') && f.includes('ms frame')),
    'the detector missed a 450ms blocked frame (STALL)',
  );
} finally {
  await finish();
}
