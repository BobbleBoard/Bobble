/**
 * CODE APPEARANCE, end to end — invisibly (harness.mjs).
 *
 * the user: "in terminal in the canvas in dark mode there's a dark red color
 * that's a bit unreadable, for the color coding please add a list of text
 * coloring styles as claude does … a little preview in the appearance
 * settings menu … demo screenshot with a line of text in each color on light
 * and dark for the Bobble light and Bobble dark".
 *
 * What this earns, in order:
 *   1. Settings → Appearance shows Code appearance: two pickers, two previews,
 *      the code-font field (screenshots, dark and light).
 *   2. A picker opens with its filter box focused, narrows as you type, and a
 *      pick lands in the document (`<style id="pd-code-theme">`), in the
 *      computed `--pd-syntax-*` variables, and in settings.json.
 *   3. The code font applies as `--pd-font-mono` and persists.
 *   4. A reply's fences are highlighted, and the canvas editor is coloured
 *      from the same variables — in both modes.
 *   5. The canvas terminal paints all sixteen ANSI colours from the code
 *      theme, re-themes when the mode flips, and the red is the readable
 *      one — measured off the rendered cells, not assumed.
 *
 * Run `pnpm build` first.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, launchApp } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures/code-fence.json');

if (!existsSync(path.join(APP_ROOT, 'dist/index.html'))) {
  throw new Error('code-theme-probe: app is not built — run `pnpm build` first');
}

const { page, shot, check, finish, home } = await launchApp('code-theme', { fixture: FIXTURE });
const settingsPath = path.join(home, '.pi', 'desktop', 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'));

/** `#rrggbb` → the `rgb(r, g, b)` a computed style reports. */
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const rootVar = (name) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const codeThemeCss = () =>
  page.evaluate(() => document.getElementById('pd-code-theme')?.textContent ?? null);

async function waitSettings(predicate, label) {
  const start = Date.now();
  while (Date.now() - start < 6000) {
    try {
      if (predicate(readSettings())) return true;
    } catch {
      /* not written yet */
    }
    await page.waitForTimeout(100);
  }
  return check(false, `timed out waiting for settings.json: ${label}`);
}

async function openAppearance() {
  await page.click('[data-testid="profile-button"]');
  await page.waitForSelector('[data-testid="profile-menu"]', { timeout: 8000 });
  await page.click('[data-testid="open-settings"]');
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 8000 });
  await page.click('[data-testid="settings-nav-appearance"]');
  await page.waitForSelector('[data-testid="settings-code-theme"]', { timeout: 8000 });
  await page.waitForTimeout(350);
}

async function closeSettings() {
  await page.click('[data-testid="settings-back"]');
  await page.waitForSelector('[data-testid="settings-view"]', { state: 'detached', timeout: 8000 });
  await page.waitForTimeout(200);
}

async function setMode(label) {
  await page.click(`[data-testid="settings-mode"] >> text=${label}`);
  await page.waitForFunction(
    (m) => document.documentElement.getAttribute('data-mode') === m,
    label.toLowerCase(),
    { timeout: 5000 },
  );
  await page.waitForTimeout(300);
}

/** The colour the terminal paints ANSI colour `n` (0–15) with, off a rendered cell. */
async function ansiCellColor(n) {
  return page.evaluate((i) => {
    const cell = document.querySelector(
      `[data-testid="canvas-tabs-panel"] .xterm-rows .xterm-fg-${i}`,
    );
    return cell === null ? null : getComputedStyle(cell).color;
  }, n);
}

try {
  // ── 1. The Appearance page, dark ─────────────────────────────────────────
  await openAppearance();
  // Pin the mode. A throwaway home has `theme.mode: system`, and the FIRST
  // settings write of any kind applies it — so without this, picking a theme
  // would flip the app to whatever the machine's appearance is mid-probe.
  await setMode('Dark');
  check(
    (await page.$('[data-testid="code-theme-light"]')) !== null &&
      (await page.$('[data-testid="code-theme-dark"]')) !== null,
    'the two code theme pickers are not on the Appearance page',
  );
  check(
    (await page.$('[data-testid="code-theme-preview-light"] .hljs-keyword')) !== null &&
      (await page.$('[data-testid="code-theme-preview-dark"] .hljs-keyword')) !== null,
    'the previews are not rendered with the real highlighter',
  );
  const previews = await page.evaluate(() => {
    const bg = (id) =>
      getComputedStyle(document.querySelector(`[data-testid="${id}"]`)).backgroundColor;
    const ansiCount = (id) =>
      document.querySelectorAll(`[data-testid="${id}"] .pd-code-preview-ansi`).length;
    return {
      light: bg('code-theme-preview-light'),
      dark: bg('code-theme-preview-dark'),
      lightAnsi: ansiCount('code-theme-preview-light'),
      darkAnsi: ansiCount('code-theme-preview-dark'),
    };
  });
  // The LIGHT preview stays light while the app is dark: that is the point.
  check(
    previews.light === rgb('#f6f6f8'),
    `light preview ground is ${previews.light}, wanted #f6f6f8`,
  );
  check(
    previews.dark === rgb('#27272a'),
    `dark preview ground is ${previews.dark}, wanted #27272a`,
  );
  check(
    previews.lightAnsi === 16 && previews.darkAnsi === 16,
    `previews show ${previews.lightAnsi}/${previews.darkAnsi} ANSI colours, wanted 16`,
  );
  await shot('appearance-dark');

  // ── 2. The picker: open, filter, pick ────────────────────────────────────
  await page.click('[data-testid="code-theme-dark"]');
  await page.waitForSelector('[data-testid="code-theme-dark-search"]', { timeout: 5000 });
  check(
    await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') === 'code-theme-dark-search',
    ),
    'the filter box did not take focus when the list opened',
  );
  const total = await page.$$eval('[data-testid^="code-theme-option-"]', (els) => els.length);
  check(total === 17, `dark list shows ${total} themes, wanted 17`);
  const first = await page.$eval('[data-testid^="code-theme-option-"]', (el) => el.textContent);
  check(
    first?.startsWith('Bobble Dark') === true,
    `first dark theme is "${first}", wanted Bobble Dark`,
  );
  await page.keyboard.type('dra');
  await page.waitForTimeout(150);
  const shown = await page.$$eval('[data-testid^="code-theme-option-"]', (els) =>
    els.map((el) => el.getAttribute('data-testid')),
  );
  check(
    shown.join(',') === 'code-theme-option-dracula,code-theme-option-dracula-soft',
    `filter "dra" shows ${shown.join(',')}`,
  );
  await shot('dropdown-filter');
  // Keyboard: down to Dracula Soft, up again, Enter picks Dracula.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="code-theme-dark"]')?.getAttribute('data-value') ===
      'dracula',
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(200);
  const draculaCss = await codeThemeCss();
  check(
    draculaCss?.includes("html:root[data-flavor][data-mode='dark'] {") === true,
    'the override sheet has no dark block after picking Dracula',
  );
  check(
    draculaCss !== null && !draculaCss.includes("[data-mode='light']"),
    'the light slot (Bobble Light) wrote an override block — the house theme must write nothing',
  );
  check(
    (await rootVar('--pd-syntax-keyword')) === '#ff79c6',
    `--pd-syntax-keyword is ${await rootVar('--pd-syntax-keyword')} under Dracula, wanted #ff79c6`,
  );
  check(
    (await rootVar('--pd-ansi-red')) === '#ff5555',
    'Dracula ANSI red did not land in the document',
  );
  await waitSettings((s) => s.codeTheme?.dark === 'dracula', 'codeTheme.dark = dracula');
  check(
    readSettings().codeTheme?.light === 'bobble-light',
    'picking a dark theme disturbed the light slot',
  );
  await shot('appearance-dark-dracula');

  // Back to the house theme through the same picker.
  await page.click('[data-testid="code-theme-dark"]');
  await page.waitForSelector('[data-testid="code-theme-dark-search"]', { timeout: 5000 });
  await page.keyboard.type('bobble');
  await page.click('[data-testid="code-theme-option-bobble-dark"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="code-theme-dark"]')?.getAttribute('data-value') ===
      'bobble-dark',
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(200);
  check((await codeThemeCss()) === '', 'the house pair should leave the override sheet empty');
  check(
    (await rootVar('--pd-syntax-keyword')) === '#ff9ac8',
    'Bobble Dark keyword did not come back',
  );
  await waitSettings((s) => s.codeTheme?.dark === 'bobble-dark', 'codeTheme.dark = bobble-dark');

  // ── 3. The code font ─────────────────────────────────────────────────────
  await page.click('[data-testid="settings-code-font"]');
  await page.keyboard.type('Menlo');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--pd-font-mono').startsWith("'Menlo'"),
    undefined,
    { timeout: 5000 },
  );
  await waitSettings((s) => s.codeFont === 'Menlo', 'codeFont = Menlo');
  const fenceFont = await page.$eval(
    '[data-testid="code-theme-preview-dark"]',
    (el) => getComputedStyle(el).fontFamily,
  );
  check(fenceFont.startsWith('Menlo'), `preview font is ${fenceFont}, wanted Menlo first`);
  await page.click('[data-testid="settings-code-font"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--pd-font-mono') === '',
    undefined,
    { timeout: 5000 },
  );
  await waitSettings((s) => s.codeFont === '', 'codeFont cleared');

  // ── 4. Light mode: the page again, then the surfaces ─────────────────────
  await setMode('Light');
  check(
    (await rootVar('--pd-syntax-keyword')) === '#a3236b',
    'Bobble Light keyword is not in force',
  );
  await shot('appearance-light');
  // The rest of the section: the code-font field sits under the previews.
  await page.evaluate(() =>
    document.querySelector('[data-testid="settings-code-font"]')?.scrollIntoView({ block: 'end' }),
  );
  await page.waitForTimeout(300);
  await shot('appearance-light-code-font');
  await closeSettings();

  // A reply with fences.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type('show me the greeting');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pd-thread .pd-code-block .hljs-keyword', { timeout: 15000 });
  await page.waitForSelector('.pd-thread .pd-code-block--diff .hljs-addition', { timeout: 15000 });
  await page.waitForTimeout(600);
  const fence = await page.evaluate(() => {
    const kw = document.querySelector('.pd-thread .pd-code-block .hljs-keyword');
    const str = document.querySelector('.pd-thread .pd-code-block .hljs-string');
    const add = document.querySelector('.pd-thread .pd-code-block--diff .hljs-addition');
    return {
      keyword: kw && getComputedStyle(kw).color,
      string: str && getComputedStyle(str).color,
      addedBg: add && getComputedStyle(add).backgroundColor,
    };
  });
  check(
    fence.keyword === rgb('#a3236b'),
    `fence keyword is ${fence.keyword}, wanted Bobble Light rose`,
  );
  check(
    fence.string === rgb('#0a6b3d'),
    `fence string is ${fence.string}, wanted Bobble Light green`,
  );
  check(
    fence.addedBg !== null && fence.addedBg !== 'rgba(0, 0, 0, 0)',
    'the diff fence has no added-row tint',
  );

  // The canvas editor, from the same variables.
  await page.evaluate(() => {
    window.__pi_canvas().openTab({
      kind: 'code',
      title: 'greet.ts',
      filePath: '/tmp/greet.ts',
      artifact: {
        id: 'greet',
        filename: 'greet.ts',
        content: {
          kind: 'code',
          language: 'typescript',
          text: [
            '// Greet someone by name.',
            'export function greet(name: string, times = 1): string {',
            '  const lines: string[] = [];',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source
            '  for (let i = 0; i < times; i++) lines.push(`Hello, ${name}!`);',
            '  return lines.join("\\n");',
            '}',
            '',
          ].join('\n'),
        },
      },
    });
  });
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .cm-content', { timeout: 10000 });
  await page.waitForTimeout(500);
  const editor = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-testid="canvas-tabs-panel"] .cm-line span')];
    const colorOf = (text) => {
      const el = spans.find((s) => s.textContent === text);
      return el === undefined ? null : getComputedStyle(el).color;
    };
    return { keyword: colorOf('export'), string: colorOf('"\\n"') };
  });
  check(
    editor.keyword === rgb('#a3236b'),
    `editor keyword is ${editor.keyword}, wanted Bobble Light rose`,
  );
  await shot('surfaces-light');

  // ── 5. The terminal: sixteen colours, measured ───────────────────────────
  await page.evaluate(() => window.__pi_canvas().openTab({ kind: 'terminal', title: 'Terminal' }));
  await page.waitForSelector('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows', {
    timeout: 10000,
  });
  await page.locator('[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-screen').click();
  await page.waitForTimeout(400);
  // Sixteen lines, one per ANSI colour, each naming itself — the demo the user
  // asked for. Short enough for the canvas's ~48 columns, so nothing wraps.
  await page.keyboard.type(
    'clear; i=0; for n in black red green yellow blue magenta cyan white; do printf "\\033[$((30+i))m%-15sThe quick brown fox jumps\\033[0m\\n" "$n"; i=$((i+1)); done; i=0; for n in black red green yellow blue magenta cyan white; do printf "\\033[$((90+i))m%-15sThe quick brown fox jumps\\033[0m\\n" "bright $n"; i=$((i+1)); done',
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const rows = document.querySelector(
        '[data-testid="canvas-tabs-panel"] .pd-terminal .xterm-rows',
      );
      return (rows?.textContent ?? '').includes('bright white');
    },
    undefined,
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);
  // Light: every one of the sixteen is painted from Bobble Light.
  const lightRed = await ansiCellColor(1);
  const lightBrightMagenta = await ansiCellColor(13);
  check(lightRed === rgb('#c0392b'), `terminal red (light) is ${lightRed}, wanted #c0392b`);
  check(
    lightBrightMagenta === rgb('#c2308a'),
    `terminal bright magenta (light) is ${lightBrightMagenta}, wanted #c2308a`,
  );
  await shot('terminal-light');

  // Flip to dark: the terminal must re-theme without being reopened.
  await openAppearance();
  await setMode('Dark');
  await closeSettings();
  await page.waitForTimeout(400);
  const darkRed = await ansiCellColor(1);
  const darkBrightMagenta = await ansiCellColor(13);
  check(
    darkRed === rgb('#ff7a72'),
    `terminal red (dark) is ${darkRed}, wanted #ff7a72 — not xterm's #cd3131`,
  );
  check(
    darkBrightMagenta === rgb('#ffa8d6'),
    `terminal bright magenta (dark) is ${darkBrightMagenta}, wanted #ffa8d6`,
  );
  const allSixteen = [];
  for (let i = 0; i < 16; i++) allSixteen.push(await ansiCellColor(i));
  check(
    allSixteen.every((c) => c !== null) && new Set(allSixteen).size === 16,
    `expected sixteen distinct rendered ANSI colours, got ${JSON.stringify(allSixteen)}`,
  );
  await shot('terminal-dark');

  // And the two code surfaces, dark.
  await page.evaluate(() => {
    const tabs = window.__pi_canvas().getState().tabs;
    const code = tabs.find((t) => t.kind === 'code');
    if (code) window.__pi_canvas().focusTab(code.id);
  });
  await page.waitForTimeout(400);
  const darkFence = await page.evaluate(() => {
    const kw = document.querySelector('.pd-thread .pd-code-block .hljs-keyword');
    return kw && getComputedStyle(kw).color;
  });
  check(
    darkFence === rgb('#ff9ac8'),
    `fence keyword (dark) is ${darkFence}, wanted Bobble Dark rose`,
  );
  await shot('surfaces-dark');

  // ── 6. A third-party theme reaches every surface, terminal included ──────
  await openAppearance();
  await page.click('[data-testid="code-theme-dark"]');
  await page.waitForSelector('[data-testid="code-theme-dark-search"]', { timeout: 5000 });
  await page.keyboard.type('dracula');
  await page.click('[data-testid="code-theme-option-dracula"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="code-theme-dark"]')?.getAttribute('data-value') ===
      'dracula',
    undefined,
    { timeout: 5000 },
  );
  await closeSettings();
  await page.waitForTimeout(400);
  const draculaFence = await page.evaluate(() => {
    const kw = document.querySelector('.pd-thread .pd-code-block .hljs-keyword');
    const block = document.querySelector('.pd-thread .pd-code-block');
    return {
      keyword: kw && getComputedStyle(kw).color,
      ground: block && getComputedStyle(block).backgroundColor,
    };
  });
  check(
    draculaFence.keyword === rgb('#ff79c6'),
    `fence keyword under Dracula is ${draculaFence.keyword}`,
  );
  check(
    draculaFence.ground === rgb('#282a36'),
    `fence ground under Dracula is ${draculaFence.ground}`,
  );
  const draculaEditor = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-testid="canvas-tabs-panel"] .cm-line span')];
    const el = spans.find((s) => s.textContent === 'export');
    return el === undefined ? null : getComputedStyle(el).color;
  });
  check(draculaEditor === rgb('#ff79c6'), `editor keyword under Dracula is ${draculaEditor}`);
  await shot('surfaces-dark-dracula');
  await page.evaluate(() => {
    const term = window
      .__pi_canvas()
      .getState()
      .tabs.find((t) => t.kind === 'terminal');
    if (term) window.__pi_canvas().focusTab(term.id);
  });
  await page.waitForTimeout(500);
  const draculaRed = await ansiCellColor(1);
  const draculaBlue = await ansiCellColor(4);
  check(
    draculaRed === rgb('#ff5555'),
    `terminal red under Dracula is ${draculaRed}, wanted #ff5555`,
  );
  check(
    draculaBlue === rgb('#bd93f9'),
    `terminal blue under Dracula is ${draculaBlue}, wanted #bd93f9`,
  );
  const terminalGround = await page.$eval(
    '[data-testid="canvas-tabs-panel"] .pd-terminal',
    (el) => getComputedStyle(el).backgroundColor,
  );
  check(terminalGround === rgb('#282a36'), `terminal ground under Dracula is ${terminalGround}`);
  await shot('terminal-dark-dracula');
} finally {
  await finish();
}
