/** Print element boxes in a rendered preview, relative to a root: node design/language/tools/measure.mjs <rendered.html> <root> <sel...> */
import { chromium } from 'playwright';

const [file, rootSel, ...sels] = process.argv.slice(2);
const b = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
});
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
// The still frame (Reduce Motion), so a box is measured where it rests, not mid-animation.
await p.emulateMedia({ reducedMotion: 'reduce' });
await p.goto(`file://${file}`);
await p.evaluate(() => document.fonts.ready);
const out = await p.evaluate(
  ([rootSel, sels]) => {
    for (const a of document.getAnimations()) a.pause();
    const r = document.querySelector(rootSel).getBoundingClientRect();
    return sels.map((s) => {
      const e = document.querySelector(s);
      if (!e) return `${s} missing`;
      const q = e.getBoundingClientRect();
      return `${s}: x ${Math.round(q.x - r.x)}..${Math.round(q.right - r.x)} y ${Math.round(q.y - r.y)}..${Math.round(q.bottom - r.y)} (cx ${Math.round(q.x + q.width / 2 - r.x)}, cy ${Math.round(q.y + q.height / 2 - r.y)})`;
    });
  },
  [rootSel, sels],
);
console.log(out.join('\n'));
await b.close();
