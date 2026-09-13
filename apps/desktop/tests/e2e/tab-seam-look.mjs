/**
 * THE SELECTED TAB'S BORDER, UP CLOSE — light and dark.
 *
 * the user: "there's a bit of a seam on that selected tab border, the curve up is
 * nice but the border needs to seamlessly flow up its edges and back down
 * rather than being a straight line under the tab as well as a different one
 * around it." Two file tabs, the second selected, the strip zoomed 4× in both
 * themes. Shots in $TMPDIR/pd-shots/tab-seam-look/.
 *
 *   node tests/e2e/tab-seam-look.mjs
 */
import { launchApp } from './harness.mjs';

const { page, shot, finish } = await launchApp('tab-seam-look');
await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
await page.waitForTimeout(400);
await page.evaluate(() => {
  const ctl = window.__pi_canvas();
  ctl.openTab({
    kind: 'file',
    title: 'notes.md',
    artifact: { filename: 'notes.md', content: { kind: 'text', text: '# notes' } },
  });
  ctl.openTab({
    kind: 'file',
    title: 'q3-review.pptx',
    subtitle: 'a 6-slide deck',
    artifact: { filename: 'q3-review.pptx', content: { kind: 'text', text: 'x' } },
  });
  ctl.openTab({
    kind: 'file',
    title: 'after.md',
    artifact: { filename: 'after.md', content: { kind: 'text', text: 'y' } },
  });
  const tabs = ctl.getState().tabs;
  ctl.focusTab(tabs[1].id);
});
await page.waitForTimeout(800);
for (const mode of ['dark', 'light']) {
  await page.evaluate(
    (m) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({ theme: { mode: m } }),
    mode,
  );
  await page.waitForTimeout(700);
  const strip = await page.$('.pd-canvas-tabbar');
  const box = await strip.boundingBox();
  const tab = await page.$('.pd-canvas-tab[data-active]');
  const tb = await tab.boundingBox();
  await page.screenshot({
    path: `${process.env.TMPDIR}/pd-shots/tab-seam-look/${mode}-strip.png`,
    clip: { x: tb.x - 40, y: box.y, width: tb.width + 120, height: box.height + 24 },
  });
  await shot(`${mode}-full`);
}
await finish();
