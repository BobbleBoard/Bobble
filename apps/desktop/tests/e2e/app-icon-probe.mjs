/**
 * REAL APP ICONS IN THE CHAT — with the test-only channel taken away.
 *
 * The chat's computer-use rows ("Used <icon> TextEdit snapshotted") used to ask
 * for the app's icon over `mac:debug`, which has a handler only in a test run
 * (PI_E2E=1). Every probe therefore saw icons, and the shipped app never did.
 * This probe refuses `mac:debug` in main (refuseIpc) — the shipped app's
 * situation — and checks the icons still arrive, over `mac:app-icon`:
 *
 *   - the channel itself: a running app by name (Finder), an app by bundle id,
 *     an installed app that is probably not running (Chess), the model's
 *     shorthand ("textedit"), and a name that is no app (null, no error);
 *   - a repeated ask is answered from main's per-app cache;
 *   - seeded computer-use rows draw each app's real icon, decoded and non-empty;
 *   - nothing asked `mac:debug`, no window was ever shown, and the harness's
 *     focus guard holds. The icons come from NSWorkspace through the `pi-mac`
 *     helper, which asks macOS for no permission.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/app-icon-probe.mjs
 */
import path from 'node:path';
import { launchApp, refuseIpc } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What a PNG data URL holds: its pixel size and byte count, or null. */
function pngInfo(url) {
  const m = /^data:image\/png;base64,(.+)$/.exec(url ?? '');
  if (m === null) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}

const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
const result = (callId, text, t) => ({
  kind: 'toolResult',
  id: `tr-a1-${callId}`,
  toolCallId: callId,
  assistantId: 'a1',
  toolName: 'bash',
  text,
  isError: false,
  timestamp: t,
});
/** A finished turn that drove three apps, as the chat stores one. */
const messages = [
  { kind: 'user', id: 'u1', text: 'tidy the note in TextEdit, then show me Chess', timestamp: 1 },
  {
    kind: 'assistant',
    id: 'a1',
    timestamp: 10,
    blocks: [
      { type: 'thinking', thinking: 'Look at TextEdit first, then open Chess.' },
      bash('c1', 'mac snapshot textedit'),
      bash('c2', 'mac launch Chess'),
      bash('c3', 'mac screenshot Finder'),
    ],
  },
  result('c1', 'TextEdit — 1 window, 14 elements', 11),
  result('c2', 'Launched Chess in the background', 12),
  result('c3', 'Captured the Finder window', 13),
  {
    kind: 'assistant',
    id: 'a2',
    timestamp: 20,
    blocks: [{ type: 'text', text: 'The note is tidied, and Chess is open behind your work.' }],
  },
];

const { app, page, check, shot, finish, shotDir } = await launchApp('app-icon', {
  env: { PI_E2E_NO_SERVER: '1' },
  args: ['--', '--piE2E=1'],
  waitFor: '[data-testid="composer-input"]',
});
try {
  // The shipped app has no `mac:debug` handler; neither does this run now.
  const refused = await refuseIpc(app, ['mac:debug']);

  /* An ask that fails is reported, not thrown — so a build without the channel
     still reaches the rows and leaves a screenshot of what it draws. */
  const ask = (name) =>
    page.evaluate(async (a) => {
      const t0 = performance.now();
      try {
        const res = await window.piDesktop.invoke('mac:app-icon', { app: a });
        return { icon: res.icon, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        return { icon: undefined, error: String(err), ms: Math.round(performance.now() - t0) };
      }
    }, name);

  // 1. The channel, one kind of name at a time.
  for (const name of ['Finder', 'com.apple.Notes', 'Chess', 'textedit']) {
    const r = await ask(name);
    const png = pngInfo(r.icon);
    console.log(
      `mac:app-icon ${JSON.stringify(name)} → ${png === null ? (r.error ?? r.icon) : `${png.w}×${png.h} PNG, ${png.bytes} B`} in ${r.ms} ms`,
    );
    check(
      png !== null && png.w >= 64 && png.w === png.h && png.bytes > 1000,
      `${name}: a real square PNG icon (${JSON.stringify(png)})`,
    );
  }
  const none = await ask('No Such App Qzx');
  check(none.icon === null, `a name that is no app answers null (${String(none.icon)})`);

  // 2. Main's cache: the same app again, under another spelling, costs no lookup.
  const first = await ask('textedit');
  const again = await ask('TextEdit');
  console.log(`repeat ask: ${first.ms} ms, other case ${again.ms} ms`);
  check(
    typeof first.icon === 'string' && again.icon === first.icon,
    'the same app under another case is the same cached icon',
  );
  check(again.ms < 50, `a repeated ask is answered from the cache (${again.ms} ms)`);

  // 3. The rows: a seeded turn that drove three apps.
  await page.evaluate((m) => window.__pi_store().setState({ messages: m }), messages);
  await page.waitForSelector('.pd-chain-summary', { timeout: 10_000 });
  await page.click('.pd-chain-summary');
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('.pd-chain img.pd-chain-app-icon')];
        return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => console.log('the rows never got three icons — the checks below say which'));
  await sleep(400);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-chain img.pd-chain-app-icon')].map((img) => {
      const r = img.getBoundingClientRect();
      const row = img.closest('.pd-chain-step, li, [class*="pd-chain-row"]');
      return {
        row: (row?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        src: img.getAttribute('src')?.slice(0, 30),
        natural: `${img.naturalWidth}×${img.naturalHeight}`,
        shown: `${Math.round(r.width)}×${Math.round(r.height)}`,
        visible: r.width > 0 && r.height > 0,
      };
    }),
  );
  for (const r of rows) console.log('row', JSON.stringify(r));
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.pd-chain .pd-chain-step')].map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    ),
  );
  console.log('chain rows', JSON.stringify(labels));
  for (const want of ['textedit', 'Chess', 'Finder']) {
    check(
      rows.some((r) => r.row.includes(want) && r.visible && r.src.startsWith('data:image/png')),
      `the ${want} row shows its real icon`,
    );
  }
  await shot('chain-with-app-icons');
  const chain = await page.$('.pd-chain');
  if (chain !== null) await chain.screenshot({ path: path.join(shotDir, 'chain.png') });

  // 4. Nothing went through the test-only channel, and nothing was shown.
  const debugCalls = await refused.calls();
  check(debugCalls.length === 0, `nothing asked mac:debug (${JSON.stringify(debugCalls)})`);
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      url: w.webContents.getURL().slice(0, 60),
      visible: w.isVisible(),
    })),
  );
  console.log('windows', JSON.stringify(windows));
  check(
    windows.every((w) => !w.visible),
    `no window was shown (${JSON.stringify(windows)})`,
  );
} finally {
  await finish();
}
