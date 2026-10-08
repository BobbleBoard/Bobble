/** Screenshot a plain HTML file at 2x: node design/language/tools/snap.mjs <file.html> <out.png> [width] */
import { chromium } from 'playwright';

const [file, out, width = '1200'] = process.argv.slice(2);
const b = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
});
const p = await b.newPage({
  viewport: { width: Number(width), height: 600 },
  deviceScaleFactor: 2,
});
await p.goto(`file://${file}`);
await p.screenshot({ path: out, fullPage: true });
await b.close();
