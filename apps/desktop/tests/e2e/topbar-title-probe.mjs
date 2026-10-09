/**
 * THE TOP-BAR TITLE RIDES THE SIDEBAR — it does not jump ahead of it.
 *
 * The user: "when clicking the open/collapse sidebar buttons the top left text eg.
 * 'image studio' snaps to the left briefly fix this flicker."
 *
 * The title's left edge is `sidebar slot width + the section's padding`, and the
 * two used to be driven differently: the slot animates its width, the padding
 * flipped on a class. MEASURED per frame, that put a 124px jump the wrong way at
 * the start of every toggle — 132 → 8 → 280 opening, 280 → 404 → 132 closing.
 *
 * This is the shape of bug a screenshot cannot show and a human catches instantly,
 * so it is worth a probe: sample the title every frame across a toggle and fail
 * on any meaningful step AGAINST the direction of travel. That rule generalises —
 * it will catch the next pair of quantities someone animates on different curves.
 */
import { launchApp } from './harness.mjs';

const { page, check, finish } = await launchApp('topbar-title-probe');

/** The biggest step backwards against the overall direction of travel. */
function worstReversal(xs) {
  const forward = Math.sign(xs.at(-1) - xs[0]);
  if (forward === 0) return 0;
  let worst = 0;
  for (let i = 1; i < xs.length; i++) {
    const step = (xs[i] - xs[i - 1]) * forward;
    if (step < 0) worst = Math.min(worst, step);
  }
  return -worst;
}

/** Click `selector`, then sample `title`'s left edge every frame for ~45 frames. */
const track = (selector, title) =>
  page.evaluate(
    async ([sel, titleSel]) => {
      const el = document.querySelector(titleSel);
      const xs = [];
      document.querySelector(sel).click();
      for (let i = 0; i < 45; i++) {
        xs.push(Math.round(el.getBoundingClientRect().x));
        await new Promise((r) => requestAnimationFrame(r));
      }
      await new Promise((r) => setTimeout(r, 400));
      xs.push(Math.round(el.getBoundingClientRect().x));
      return xs;
    },
    [selector, title],
  );

async function toggleIsSmooth(title, label) {
  // Always start from a known state: sidebar open.
  const open = await page.evaluate(
    () => document.querySelector('.pd-sidebar-slot')?.getBoundingClientRect().width ?? 0,
  );
  if (open === 0) {
    await page.click('[data-testid="expand-sidebar"]');
    await page.waitForTimeout(700);
  }

  const closing = await track('[data-testid="collapse-sidebar"]', title);
  await page.waitForTimeout(400);
  const opening = await track('[data-testid="expand-sidebar"]', title);
  await page.waitForTimeout(400);

  // A couple of pixels is sub-pixel rounding; 124 is the bug.
  for (const [name, xs] of [
    ['closing', closing],
    ['opening', opening],
  ]) {
    const worst = worstReversal(xs);
    console.log(`${label} ${name}: ${xs[0]} → ${xs.at(-1)}, worst reversal ${worst}px`);
    check(worst <= 4, `[${label}] the title snaps ${worst}px backwards while ${name}`);
    check(
      Math.abs(xs.at(-1) - xs[0]) > 40,
      `[${label}] the title did not move at all while ${name} — the probe proved nothing`,
    );
  }
}

// The studio title, which is what the user was looking at…
await page.click('[data-testid="modality-image"]');
await page.waitForSelector('[data-testid="studio-title"]');
await page.waitForTimeout(900);
await toggleIsSmooth('[data-testid="studio-title"]', 'studio');

// …and the chat title, which sits in the same slot and shares the same inset.
await page.click('[data-testid="expand-sidebar"]').catch(() => undefined);
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await toggleIsSmooth('.pd-chat-title', 'chat');

await finish();
