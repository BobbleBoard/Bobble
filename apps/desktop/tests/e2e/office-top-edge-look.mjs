/** The office editor's top edge, as the user sees it under the tab strip. */
import { writeFileSync } from 'node:fs';
import { launchApp } from './harness.mjs';

const FILE = process.env.FILE ?? `${process.env.TMPDIR}/office-live/project-schemas/docs/q3-review.pptx`;
const { page, shot, finish } = await launchApp('office-top-edge-look');
await page.waitForFunction(() => typeof window.__pi_canvas === 'function', { timeout: 30000 });
await page.evaluate((m) => window.__settings_store?.().getState?.().update?.({ theme: { mode: m } }), 'light');
await page.waitForTimeout(500);
const id = await page.evaluate((f) => window.__pi_canvas().openTab({ kind: 'office', title: 'q3-review.pptx', filePath: f, mediaType: 'PPTX' }), FILE);
await page.waitForTimeout(6000);
const cap = await page.evaluate((tid) => window.piDesktop.invoke('office:capture', { tabId: tid }), id);
if (cap?.dataUrl) writeFileSync(`${process.env.TMPDIR}/pd-shots/office-top-edge-look/office.png`, Buffer.from(cap.dataUrl.split(',')[1], 'base64'));
console.log(JSON.stringify({ captured: Boolean(cap?.dataUrl), error: cap?.error ?? null }));
await shot('window');
await finish();
