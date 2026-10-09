/**
 * LEAVING THE MODEL HUB.
 *
 * The user: "from the model management tab clicking on to new chat or an existing
 * chat causes weird behavior that's very not expected." So: open the hub, then
 * take each exit a user actually has and photograph what lands.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';

const OUT = process.env.OUT ?? '/tmp/hub-exit';
mkdirSync(OUT, { recursive: true });

const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-e2e-udd-'))}`],
  cwd: process.cwd(),
  env: { ...process.env, PI_E2E: '1', PI_E2E_BACKGROUND: '1' },
});
const win = await app.firstWindow();
await win.waitForTimeout(4000).catch(() => undefined);

const shot = async (name) => {
  await win.screenshot({ path: path.join(OUT, `${name}.png`) });
  return win.evaluate(() => ({
    hub: document.querySelector('[data-testid="hardware-strip"]') !== null,
    composer: document.querySelector('[data-testid="composer"]') !== null,
    modelHubTitle: document.querySelector('h1')?.textContent?.trim() ?? null,
    navSelected: [...document.querySelectorAll('[data-selected="true"]')]
      .map((e) => e.getAttribute('data-testid') ?? e.textContent?.trim()?.slice(0, 30))
      .filter(Boolean),
    scrollTop: document.scrollingElement?.scrollTop ?? null,
  }));
};

console.log('start            ', JSON.stringify(await shot('0-start')));
await win.click('[data-testid="nav-model-management"]');
await win.waitForTimeout(1500).catch(() => undefined);
console.log('in hub           ', JSON.stringify(await shot('1-hub')));

// Exit 1: New chat.
await win.click('[data-testid="new-chat"]');
await win.waitForTimeout(1500).catch(() => undefined);
const afterNew = await shot('2-new-chat');
console.log('after New chat   ', JSON.stringify(afterNew));
/* THE BUG: the hub renders as a `contentOverride` inside the chat shell, so
   the sidebar stayed live while it was up and picking a chat switched the
   session UNDERNEATH it. You clicked New chat and kept looking at the hub. */
if (afterNew.hub) throw new Error('the model hub survived New chat');

// Back to the hub, then exit 2: an existing chat row.
await win.click('[data-testid="nav-model-management"]');
await win.waitForTimeout(1200).catch(() => undefined);
const row = await win.evaluate(
  () =>
    [...document.querySelectorAll('[data-testid^="chat-row-"]')]
      .map((e) => e.getAttribute('data-testid'))
      .filter((t) => t !== null && t !== 'chat-row-New chat')[0] ?? null,
);
console.log('existing row     ', row);
if (row === null) throw new Error('no existing chat to click');
/*
 * BY HANDLE, NOT BY SELECTOR STRING. A chat is titled from its first message,
 * so any conversation containing a quote mark produces a testid that cannot be
 * expressed in a CSS attribute selector — and the probe died on its own test
 * data rather than on anything the app did.
 */
await win.evaluate((id) => {
  const el = [...document.querySelectorAll('[data-testid^="chat-row-"]')].find(
    (n) => n.getAttribute('data-testid') === id,
  );
  el?.click();
}, row);
await win.waitForTimeout(1800).catch(() => undefined);
const after = await shot('3-existing-chat');
console.log('after chat click ', JSON.stringify(after));
if (after.hub) throw new Error('the model hub survived opening a chat');

/*
 * AND THE SHORTCUT THE ROW ADVERTISES. The sidebar has always drawn a "⌘N"
 * chip beside New chat; nothing was bound to it, so pressing it did nothing at
 * all. A hint that lies costs more than a missing one.
 */
const selected = () =>
  win.evaluate(
    () =>
      document
        .querySelector('[data-testid^="chat-row-"][data-selected="true"]')
        ?.getAttribute('data-testid') ?? null,
  );
const beforeKey = await selected();
await win.keyboard.press('Meta+n');
await win.waitForTimeout(1500).catch(() => undefined);
const afterKey = await selected();
console.log('cmd-n            ', JSON.stringify({ beforeKey, afterKey }));
if (beforeKey === afterKey) throw new Error('⌘N is advertised but bound to nothing');

await app.close();
console.log('captures in', OUT);
console.log('hub-exit-probe OK');
