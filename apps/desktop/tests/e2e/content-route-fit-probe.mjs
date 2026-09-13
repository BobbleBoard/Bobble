/**
 * EVERY CONTENT ROUTE FITS THE WINDOW.
 *
 * The model hub's root was `h-full` — 100% of the main surface — under a 48px
 * top bar, so it ran 48px past the bottom of the window with the body's
 * overflow hiding the evidence: the last row of every list was cut off, and
 * the symptom had been treated with padding. This walks the sidebar's content
 * routes and asserts each root ends at the window's bottom edge and that the
 * document has nothing hidden below it.
 *
 *   node apps/desktop/tests/e2e/content-route-fit-probe.mjs
 */
import { launchApp } from './harness.mjs';

const {
  page: win,
  check,
  finish,
} = await launchApp('content-route-fit', {
  waitFor: '[data-testid="composer-input"]',
});
try {
  await win.waitForTimeout(1000);
  const read = (label) =>
    win.evaluate((label) => {
      const H = window.innerHeight;
      const main = document.querySelector('main.pd-main-surface');
      const kids = [...(main?.children ?? [])].map((el) => ({
        testid: el.getAttribute('data-testid'),
        cls: el.className?.toString().slice(0, 70),
        top: Math.round(el.getBoundingClientRect().top),
        bottom: Math.round(el.getBoundingClientRect().bottom),
      }));
      return { label, H, docSH: document.scrollingElement.scrollHeight, kids };
    }, label);
  const routes = [
    ['nav-model-management', 'models'],
    ['nav-scheduled', 'scheduled'],
    ['nav-connectors', 'connectors'],
    ['modality-3d', '3d'],
    ['modality-image', 'image'],
    ['modality-video', 'video'],
    ['modality-audio', 'audio'],
  ];
  const judge = (r) => {
    const root = r.kids.at(-1);
    console.log(JSON.stringify(r));
    check(
      root !== undefined && Math.abs(root.bottom - r.H) <= 1 && r.docSH <= r.H,
      `${r.label}: the route ends at the window's edge (root bottom ${root?.bottom}, window ${r.H}, document ${r.docSH})`,
    );
  };
  judge(await read('chat'));
  for (const [tid, label] of routes) {
    const el = await win.$(`[data-testid="${tid}"]`);
    if (el === null) {
      console.log('no nav', tid);
      continue;
    }
    await el.click();
    await win.waitForTimeout(1200);
    judge(await read(label));
  }
} finally {
  await finish();
}
