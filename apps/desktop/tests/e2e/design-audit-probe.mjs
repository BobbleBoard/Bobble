/**
 * design-audit-probe.mjs — photograph EVERY surface of the app, light and dark,
 * in one hidden run, and dump the computed type/colour/spacing of the elements
 * that carry its hierarchy.
 *
 * the user: "get visuals of all parts of the app ... figure out the aspects that
 * make this feel generic ... my best guess would be a lack of hierarchy."
 *
 * A hierarchy complaint cannot be answered from the stylesheet: the same token
 * lands on a dozen elements through Tailwind classes, calc() scales and flavor
 * overrides, and only the rendered page knows which of them ended up the same
 * size and the same grey. So this probe drives the REAL built app through the
 * same seams the other probes use (`__pi_store`, `__pi_canvas`, `__pi_theme`)
 * into a realistic populated state — a project-folded sidebar, a thread with a
 * thought + tool chain + long markdown + presented file — and reads
 * getComputedStyle off the actual elements next to each screenshot.
 *
 * Run twice with a different TAG (e.g. TAG=before / TAG=after) around a CSS
 * change and the shots pair up name-for-name, same state, same viewport.
 *
 *   OUT=<dir> TAG=before node apps/desktop/tests/e2e/design-audit-probe.mjs
 *
 * Hidden by default (PI_E2E_BACKGROUND=1 + the focus guard); the throwaway HOME
 * and user-data-dir are removed at the end.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { backgroundLaunch, frontmostApp } from './_focus.mjs';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appRoot, '../..');
const mockPi = path.join(repoRoot, 'packages/engine/tools/mock-pi/mock-pi.mjs');
const fixture = path.join(repoRoot, 'packages/engine/tools/mock-pi/fixtures/simple-chat.json');
const TAG = process.env.TAG ?? 'shot';
const OUT = process.env.OUT ?? path.join(repoRoot, 'scratchpad/demos/design-audit', TAG);
mkdirSync(OUT, { recursive: true });

/* ---- a throwaway HOME with five chats, two of them inside a real project dir
 * (real cwds auto-fold into a project folder; sandbox cwds stay loose) ---- */
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'pd-audit-home-')));
const udd = mkdtempSync(path.join(tmpdir(), 'pd-audit-udd-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'audit');
mkdirSync(sessionsDir, { recursive: true });
const projectDir = path.join(home, 'Projects', 'LocalConvert');
mkdirSync(projectDir, { recursive: true });
const l = (o) => JSON.stringify(o);
let stamp = Date.now() - 6 * 3600_000;
const mkSession = (name, text, cwd) => {
  stamp += 900_000;
  writeFileSync(
    path.join(sessionsDir, `${name}.jsonl`),
    [
      l({
        type: 'session',
        version: 3,
        id: `sess-${name}`,
        timestamp: new Date(stamp).toISOString(),
        cwd,
      }),
      l({
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: new Date(stamp).toISOString(),
        message: { role: 'user', content: text, timestamp: stamp },
      }),
      l({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: new Date(stamp + 5000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Sure — here is a first pass on "${text}".` }],
          timestamp: stamp + 5000,
        },
      }),
    ].join('\n'),
  );
};
const sandbox = (n) => path.join(home, '.pi/desktop/sandbox', `conv-${n}`);
mkSession('p1', 'Add a drag-and-drop zone to the converter', projectDir);
mkSession('p2', 'Why does the HEIC path fail on Sonoma?', projectDir);
mkSession('s1', 'Plan a launch checklist for the beta', sandbox(1));
mkSession('s2', 'Summarise the quarterly numbers', sandbox(2));
mkSession('s3', 'Draft a reply to the landlord', sandbox(3));

const focus = backgroundLaunch();
const frontBefore = frontmostApp();
const app = await electron.launch({
  executablePath: electronBinary,
  args: [appRoot, `--user-data-dir=${udd}`],
  env: {
    ...process.env,
    HOME: home,
    PI_BIN: mockPi,
    MOCK_PI_FIXTURE: fixture,
    PI_E2E: '1',
    PI_E2E_NO_SERVER: '1',
    ...focus.env,
  },
});

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 15000 });
await win.waitForTimeout(1500);
focus.restore();

const shot = async (name, opts = {}) => {
  await win.waitForTimeout(opts.settle ?? 400);
  const file = path.join(OUT, `${name}.png`);
  await win.screenshot({ path: file, ...(opts.clip ? { clip: opts.clip } : {}) });
  console.log('shot', path.relative(repoRoot, file));
};

/* One computed-style record per selector, so a finding can quote px/weight/hex
 * rather than "looks the same". `rgb()` is kept verbatim — hex conversion in a
 * report is a place to make transcription mistakes. */
const measure = (label, selectors) =>
  win.evaluate(
    ({ label, selectors }) => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (el === null) return { sel, missing: true };
        const c = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          sel,
          text: (el.textContent ?? '').trim().slice(0, 40),
          font: `${c.fontSize}/${c.lineHeight} ${c.fontWeight}`,
          family: c.fontFamily.split(',')[0],
          color: c.color,
          bg: c.backgroundColor,
          letterSpacing: c.letterSpacing,
          transform: c.textTransform,
          border: c.borderTopWidth === '0px' ? 'none' : `${c.borderTopWidth} ${c.borderTopColor}`,
          shadow: c.boxShadow === 'none' ? 'none' : c.boxShadow.slice(0, 70),
          radius: c.borderRadius,
          padding: c.padding,
          margin: c.margin,
          gap: c.gap,
          opacity: c.opacity,
          rect: `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)}`,
        };
      };
      return { label, rows: selectors.map(pick) };
    },
    { label, selectors },
  );

const measured = [];
const record = async (label, selectors) => {
  const m = await measure(label, selectors);
  measured.push(m);
};

const setTheme = (mode) =>
  win.evaluate((mode) => {
    const t = window.__pi_theme?.();
    t?.setFlavor?.('bobble');
    t?.setMode?.(mode);
    return `${document.documentElement.dataset.flavor}/${document.documentElement.dataset.mode}`;
  }, mode);

/* ---- the populated thread: what a real working turn looks like ---- */
const buildThread = () => {
  const now = Date.now();
  const long = [
    '## Converter drag-and-drop: what I changed',
    '',
    'The drop zone now accepts folders as well as files, and the HEIC path no longer crashes on Sonoma. Three things were wrong, and they compounded:',
    '',
    '1. **The `dragover` handler never called `preventDefault()`**, so the browser handled the drop itself and navigated away.',
    '2. The HEIC decoder was loaded lazily *after* the first drop, so the first file always fell through to the generic path.',
    '3. `convert()` read `file.type`, which Finder leaves empty for HEIC — the extension is the only reliable signal.',
    '',
    '### The fix',
    '',
    '```ts',
    'export async function onDrop(e: DragEvent): Promise<void> {',
    '  e.preventDefault();',
    '  const files = await expandDirectories(e.dataTransfer);',
    '  await Promise.all(files.map((f) => convert(f, sniffKind(f))));',
    '}',
    '```',
    '',
    'I also measured the conversion path before and after on the sample set:',
    '',
    '| Input | Before | After | Notes |',
    '| --- | --- | --- | --- |',
    '| 12 × HEIC (iPhone 15) | crash | 2.1 s | decoder preloaded |',
    '| 40 × JPEG | 3.4 s | 3.3 s | unchanged |',
    '| folder of 200 mixed | n/a | 9.8 s | new |',
    '',
    'Two things I did **not** do, because they need a decision from you:',
    '',
    '- Keep the original files next to the converted ones, or move them to Trash? Right now nothing is deleted.',
    '- The progress bar counts files, not bytes, so one 80 MB video makes it look stuck. Bytes would be more honest but needs a pre-scan.',
    '',
    'Want me to wire the Trash behaviour behind a setting, or leave it as is?',
  ].join('\n');
  return [
    {
      kind: 'user',
      id: 'u-1',
      text: 'Add a drag-and-drop zone to the converter. It should take folders too, and HEIC must not crash on Sonoma.',
      timestamp: now - 600_000,
    },
    {
      kind: 'assistant',
      id: 'a-1',
      timestamp: now - 590_000,
      model: 'qwen3.5-9b',
      blocks: [
        {
          type: 'thinking',
          thinking:
            'The user wants three things: a drop zone, folder support, and a HEIC fix. I should read the existing converter first to see how drops are handled today, then check the HEIC path on Sonoma specifically — the crash is probably the decoder being loaded lazily.\n\nPlan:\n1. Read src/convert/drop.ts\n2. Grep for the HEIC decoder\n3. Run the sample set',
        },
        { type: 'toolCall', id: 'tc-1', name: 'read', arguments: { path: 'src/convert/drop.ts' } },
        {
          type: 'toolCall',
          id: 'tc-2',
          name: 'bash',
          arguments: { command: 'rg -n "heic" src/ --type ts' },
        },
        {
          type: 'toolCall',
          id: 'tc-3',
          name: 'edit',
          arguments: {
            path: 'src/convert/drop.ts',
            oldText: 'function onDrop',
            newText: 'export async function onDrop',
          },
        },
        {
          type: 'toolCall',
          id: 'tc-4',
          name: 'write',
          arguments: {
            path: 'src/convert/sniff.ts',
            content: 'export function sniffKind(f: File) { /* … */ }',
          },
        },
        {
          type: 'toolCall',
          id: 'tc-5',
          name: 'bash',
          arguments: { command: 'npm test -- convert' },
        },
        { type: 'text', text: long },
      ],
    },
    {
      kind: 'toolResult',
      id: 'tr-a-1-tc-1',
      toolCallId: 'tc-1',
      assistantId: 'a-1',
      toolName: 'read',
      text: 'function onDrop(e) {\n  const files = e.dataTransfer.files;\n  for (const f of files) convert(f);\n}',
      isError: false,
      timestamp: now - 585_000,
    },
    {
      kind: 'toolResult',
      id: 'tr-a-1-tc-2',
      toolCallId: 'tc-2',
      assistantId: 'a-1',
      toolName: 'bash',
      text: 'src/convert/heic.ts:12:  const decoder = await import("./heic-decoder");\nsrc/convert/convert.ts:40:  if (file.type === "image/heic")',
      isError: false,
      timestamp: now - 580_000,
    },
    {
      kind: 'toolResult',
      id: 'tr-a-1-tc-3',
      toolCallId: 'tc-3',
      assistantId: 'a-1',
      toolName: 'edit',
      text: 'Edited src/convert/drop.ts (+9 -3)',
      isError: false,
      timestamp: now - 575_000,
    },
    {
      kind: 'toolResult',
      id: 'tr-a-1-tc-4',
      toolCallId: 'tc-4',
      assistantId: 'a-1',
      toolName: 'write',
      text: 'Wrote src/convert/sniff.ts (18 lines)',
      isError: false,
      timestamp: now - 570_000,
    },
    {
      kind: 'toolResult',
      id: 'tr-a-1-tc-5',
      toolCallId: 'tc-5',
      assistantId: 'a-1',
      toolName: 'bash',
      text: 'PASS convert (14 tests)\nRan 14 tests in 2.13s',
      isError: false,
      timestamp: now - 560_000,
    },
    {
      kind: 'user',
      id: 'u-2',
      text: 'Leave the originals. Show me the sniff helper.',
      timestamp: now - 120_000,
    },
    {
      kind: 'assistant',
      id: 'a-2',
      timestamp: now - 110_000,
      model: 'qwen3.5-9b',
      blocks: [
        { type: 'toolCall', id: 'tc-6', name: 'read', arguments: { path: 'src/convert/sniff.ts' } },
        {
          type: 'text',
          text: 'Here it is. It trusts the extension first and only falls back to `file.type` when there is no extension at all:\n\n```ts\nconst BY_EXT: Record<string, Kind> = { heic: "heic", heif: "heic", jpg: "jpeg", jpeg: "jpeg", png: "png" };\n\nexport function sniffKind(f: File): Kind {\n  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";\n  return BY_EXT[ext] ?? fromMime(f.type);\n}\n```\n\nOriginals stay where they are — nothing touches them.',
        },
      ],
    },
    {
      kind: 'toolResult',
      id: 'tr-a-2-tc-6',
      toolCallId: 'tc-6',
      assistantId: 'a-2',
      toolName: 'read',
      text: 'const BY_EXT = { … }',
      isError: false,
      timestamp: now - 105_000,
    },
  ];
};

const injectThread = () =>
  win.evaluate((msgs) => {
    window.__pi_store().getState().setMessagesExternal(msgs, false);
  }, buildThread());

const openChat = async (label) => {
  const row = win.locator(`[data-testid="chat-row-${label}"]`).first();
  if ((await row.count()) > 0) await row.click();
  await win.waitForTimeout(600);
};

const thread = '.pd-thread';
const KEY_SELECTORS = {
  shell: [
    '.pd-sidebar',
    '.pd-sidebar-section-header',
    '.pd-sidebar-row',
    '.pd-sidebar-row[data-selected="true"]',
    '.pd-sidebar-row-label',
    '.pd-sidebar-row-meta',
    '[data-testid="new-chat"]',
    '.pd-topbar',
    '.pd-topbar-title',
    '.pd-chat-title, [data-testid="chat-title"]',
    '.pd-main-surface',
    '[data-testid="footer-model-chip"]',
  ],
  thread: [
    thread,
    '.pd-msg-bubble',
    '.pd-msg--assistant',
    '.pd-prose p',
    '.pd-prose h2',
    '.pd-prose h3',
    '.pd-prose li',
    '.pd-prose strong',
    '.pd-prose th',
    '.pd-prose td',
    '.pd-code-block',
    '.pd-code-block-lang',
    '.pd-code-block code',
    '.pd-chain',
    '.pd-chain-summary',
    '.pd-chain-step-row',
    '.pd-chain-step-label',
    '.pd-chain-step-detail',
    '.pd-chain-step-subline',
    '.pd-chain-thought',
    '.pd-msg-actions',
    '.pd-present-card',
    '.pd-present-title, .pd-present-name',
  ],
  composer: [
    '.pd-composer',
    '.pd-composer-input',
    '[data-testid="composer-send"]',
    '[data-testid="composer-bar"]',
    '[data-testid="composer-effort"]',
    '[data-testid="composer-hints"]',
  ],
  canvas: [
    '.pd-canvas-tabs',
    '.pd-canvas-tabbar',
    '.pd-canvas-tab',
    '.pd-canvas-tab[aria-selected="true"]',
    '.pd-canvas-tab-label',
    '.pd-canvas-tab-subtitle',
    '.pd-canvas-tabpanel',
  ],
};

for (const mode of ['light', 'dark']) {
  console.log('theme →', await setTheme(mode));
  await win.waitForTimeout(500);

  // 1. Empty chat (greeting) with the seeded sidebar.
  await win
    .locator('[data-testid="new-chat"]')
    .first()
    .click()
    .catch(() => {});
  await win.waitForTimeout(600);
  await shot(`01-empty-${mode}`);
  await record(`empty/${mode}`, [
    ...KEY_SELECTORS.shell,
    'h1.text-title',
    'h1.text-title + p',
    ...KEY_SELECTORS.composer,
  ]);

  // 2. Populated thread inside a project chat.
  await openChat('Add a drag-and-drop zone to the converter');
  await injectThread();
  await win.waitForTimeout(900);
  // Expand the tool chain so the step rows are visible in the record.
  const summary = win.locator('.pd-chain-summary').first();
  if ((await summary.count()) > 0) await summary.click();
  await win.waitForTimeout(500);
  // Scroll the thread to the top so the first turn + expanded chain are in frame.
  await win.evaluate(() => {
    const s =
      document.querySelector('.pd-thread')?.closest('[class*="overflow"]') ??
      document.querySelector('.pd-thread')?.parentElement;
    if (s) s.scrollTop = 0;
  });
  await shot(`02-thread-top-${mode}`);
  await record(`thread/${mode}`, [
    ...KEY_SELECTORS.shell,
    ...KEY_SELECTORS.thread,
    ...KEY_SELECTORS.composer,
  ]);
  await win.evaluate(() => {
    const s =
      document.querySelector('.pd-thread')?.closest('[class*="overflow"]') ??
      document.querySelector('.pd-thread')?.parentElement;
    if (s) s.scrollTop = s.scrollHeight;
  });
  await shot(`03-thread-bottom-${mode}`);

  // 3. Composer with text typed.
  const input = win
    .locator(
      '[data-testid="composer-input"], .pd-composer-input [contenteditable="true"], [contenteditable="true"]',
    )
    .first();
  if ((await input.count()) > 0) {
    await input.click();
    await input.type('Wire the Trash behaviour behind a setting, default off.');
    await win.waitForTimeout(300);
    const box = await win
      .locator('.pd-composer')
      .first()
      .boundingBox()
      .catch(() => null);
    await shot(
      `04-composer-typed-${mode}`,
      box
        ? {
            clip: {
              x: Math.max(0, box.x - 24),
              y: Math.max(0, box.y - 60),
              width: Math.min(1440 - Math.max(0, box.x - 24), box.width + 48),
              height: Math.min(900 - Math.max(0, box.y - 60), box.height + 120),
            },
          }
        : {},
    );
    await win.keyboard.press('Meta+A');
    await win.keyboard.press('Backspace');
  }

  // 4. Model quick menu + effort menu.
  const modelChip = win.locator('[data-testid="footer-model-chip"]').first();
  if ((await modelChip.count()) > 0) {
    await modelChip.click();
    await shot(`05-model-menu-${mode}`, { settle: 600 });
    await record(`model-menu/${mode}`, [
      '.pd-menu',
      '.pd-menu-item',
      '.pd-menu-label, .pd-menu-section-label',
      '.pd-menu-item[data-current="true"], .pd-menu-item[aria-checked="true"]',
    ]);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
  }
  const effort = win.locator('[data-testid="composer-effort"]').first();
  if ((await effort.count()) > 0) {
    await effort.click();
    await shot(`06-effort-menu-${mode}`, { settle: 600 });
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);
  }

  // 5. Canvas rail: code / markdown / terminal / image tabs, then the + menu.
  await win.evaluate(() => {
    const c = window.__pi_canvas();
    c.openTab({
      kind: 'file',
      key: 'file:/tmp/audit/drop.ts',
      title: 'drop.ts',
      filePath: '/tmp/audit/drop.ts',
      breadcrumb: ['src', 'convert'],
      artifact: {
        id: 'file:/tmp/audit/drop.ts',
        filename: 'drop.ts',
        content: {
          kind: 'code',
          language: 'typescript',
          text: [
            'import { convert } from "./convert";',
            'import { sniffKind } from "./sniff";',
            '',
            'export async function onDrop(e: DragEvent): Promise<void> {',
            '  e.preventDefault();',
            '  const files = await expandDirectories(e.dataTransfer);',
            '  await Promise.all(files.map((f) => convert(f, sniffKind(f))));',
            '}',
            '',
            'async function expandDirectories(dt: DataTransfer | null): Promise<File[]> {',
            '  if (dt === null) return [];',
            '  const out: File[] = [];',
            '  for (const item of Array.from(dt.items)) {',
            '    const entry = item.webkitGetAsEntry();',
            '    if (entry?.isDirectory) out.push(...(await walk(entry)));',
            '    else if (item.kind === "file") out.push(item.getAsFile()!);',
            '  }',
            '  return out;',
            '}',
          ].join('\n'),
        },
      },
    });
    c.openTab({
      kind: 'markdown',
      key: 'md:notes',
      title: 'NOTES.md',
      artifact: {
        id: 'md:notes',
        filename: 'NOTES.md',
        content: {
          kind: 'markdown',
          text: '# Converter notes\n\nA few things worth remembering about the HEIC path.\n\n## Decoder\n\n- Preload on app start, not on first drop\n- Sonoma ships `libheif` 1.17; older builds crash on 10-bit\n\n## Open questions\n\n1. Trash originals?\n2. Bytes vs files in the progress bar\n',
        },
      },
    });
  });
  await win.waitForTimeout(800);
  await win.evaluate(() => {
    const c = window.__pi_canvas();
    const code = c.getState().tabs.find((t) => t.kind === 'file');
    if (code) c.focusTab(code.id);
  });
  await shot(`07-canvas-code-${mode}`, { settle: 900 });
  await record(`canvas/${mode}`, [
    ...KEY_SELECTORS.canvas,
    '.pd-canvas-code',
    '.cm-content',
    '.pd-canvas-breadcrumb, .pd-canvas-tab-subtitle',
  ]);
  await win.evaluate(() => {
    const c = window.__pi_canvas();
    const md = c.getState().tabs.find((t) => t.kind === 'markdown');
    if (md) c.focusTab(md.id);
  });
  await shot(`08-canvas-markdown-${mode}`, { settle: 700 });

  // Terminal via the + menu (photograph the menu itself on the way).
  const plus = win.locator('.pd-canvas-newtab').first();
  if ((await plus.count()) > 0) {
    await plus.click();
    await shot(`09-canvas-newtab-menu-${mode}`, { settle: 500 });
    await record(`newtab-menu/${mode}`, ['.pd-menu', '.pd-menu-item', '[role="menuitem"]']);
    const termRow = win.locator('[role="menuitem"]', { hasText: /terminal/i }).first();
    if ((await termRow.count()) > 0) await termRow.click();
    else await win.keyboard.press('Escape');
    await win.waitForTimeout(2500);
    await shot(`10-canvas-terminal-${mode}`, { settle: 800 });
  }

  // Image tab from an inline data URL (a 2x2 PNG scaled up shows the frame, not the picture).
  await win.evaluate(() => {
    const c = window.__pi_canvas();
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQIW2NkYPjPwMDAwMDAxMDAAAAKgQEBVn2pjwAAAABJRU5ErkJggg==';
    c.openTab({
      kind: 'image',
      key: 'img:sample',
      title: 'sample.png',
      mediaSrc: png,
      mediaType: 'image/png',
    });
  });
  await shot(`11-canvas-image-${mode}`, { settle: 900 });

  // Close all canvas tabs so the next mode starts clean.
  await win.evaluate(() => window.__pi_canvas().reset());
  await win.waitForTimeout(500);

  // 6. Sidebar hover state + chat row menu (hover the second row).
  const rows = win.locator('.pd-sidebar-row');
  if ((await rows.count()) > 2) {
    await rows.nth(2).hover();
    const sb = await win
      .locator('.pd-sidebar')
      .first()
      .boundingBox()
      .catch(() => null);
    await shot(
      `12-sidebar-hover-${mode}`,
      sb ? { clip: { x: sb.x, y: sb.y, width: sb.width, height: Math.min(sb.height, 900) } } : {},
    );
  }

  // 7. Collapsed sidebar rail.
  const collapse = win.locator('[data-testid="collapse-sidebar"]').first();
  if ((await collapse.count()) > 0) {
    await collapse.click();
    await shot(`13-rail-collapsed-${mode}`, { settle: 900 });
    // Re-expand: the rail's expand control shares the testid or is the first rail button.
    const expand = win
      .locator('[data-testid="collapse-sidebar"], [aria-label*="Expand" i]')
      .first();
    if ((await expand.count()) > 0) await expand.click();
    await win.waitForTimeout(800);
  }

  // 8. Profile menu → Settings (every panel).
  await win.locator('[data-testid="profile-button"]').first().click();
  await shot(`14-profile-menu-${mode}`, { settle: 500 });
  await win.locator('[data-testid="open-settings"]').first().click();
  await win.waitForTimeout(800);
  for (const section of [
    'models',
    'personalization',
    'appearance',
    'interface',
    'agent',
    'search',
    'connectors',
    'capabilities',
  ]) {
    const nav = win.locator(`[data-testid="settings-nav-${section}"]`).first();
    if ((await nav.count()) === 0) continue;
    await nav.click();
    await shot(`15-settings-${section}-${mode}`, { settle: 700 });
    if (section === 'appearance' || section === 'models') {
      await record(`settings-${section}/${mode}`, [
        '[data-testid="settings-nav-appearance"]',
        '[data-testid="settings-nav-appearance"][aria-current="page"], [data-testid="settings-nav-' +
          section +
          '"]',
        '.text-heading',
        '.text-body.font-medium',
        '.text-footnote.text-text-muted',
        '.text-footnote.font-medium.uppercase',
        '.text-caption.text-text-muted',
      ]);
    }
  }
  // Leave settings: back to chat.
  const back = win
    .locator('[data-testid="settings-back"], [aria-label*="Back" i], button:has-text("Back")')
    .first();
  if ((await back.count()) > 0) await back.click();
  else await win.keyboard.press('Escape');
  await win.waitForTimeout(600);

  // 9. Sidebar destinations: Model management / Connectors / Scheduled / Skills.
  for (const label of ['Model management', 'Connectors', 'Scheduled', 'Skills']) {
    const item = win
      .locator(
        `.pd-sidebar [aria-label="${label}"], .pd-sidebar button:has-text("${label}"), .pd-sidebar-row:has-text("${label}")`,
      )
      .first();
    if ((await item.count()) === 0) {
      console.log('no sidebar entry for', label);
      continue;
    }
    await item.click();
    await shot(`16-${label.toLowerCase().replace(/\s+/g, '-')}-${mode}`, { settle: 1200 });
    /* Scheduled and Skills are "coming soon" stubs in this build: an overlay
     * that swallows every later click until its own close button is pressed
     * (the first run died on it — `.pd-stub-overlay intercepts pointer events`). */
    const stubClose = win.locator('[data-testid="stub-panel"] [aria-label="Close"]').first();
    if ((await stubClose.count()) > 0) {
      await stubClose.click();
    } else {
      const backBtn = win
        .locator('[data-testid="connectors-back"], [aria-label*="Back" i], button:has-text("Back")')
        .first();
      if ((await backBtn.count()) > 0) await backBtn.click();
      else
        await win
          .locator('[data-testid="new-chat"]')
          .first()
          .click()
          .catch(() => {});
    }
    await win.waitForTimeout(600);
  }

  // 10. The one studio the sidebar reaches directly (Modalities → 3D Studio).
  const studio = win.locator('.pd-sidebar button:has-text("3D Studio")').first();
  if ((await studio.count()) > 0) {
    await studio.click();
    await shot(`17-studio-3d-${mode}`, { settle: 2500 });
    await record(`studio-3d/${mode}`, [
      '.tp-topbar, .tp-top-bar',
      '.tp-back-btn',
      '.tp-stage, [data-testid="tp-canvas-host"]',
      '[data-testid="tp-stage-empty-copy"]',
    ]);
    const backToChat = win.locator('[data-testid="tp-back"]').first();
    if ((await backToChat.count()) > 0) await backToChat.click();
    await win.waitForTimeout(800);
  }
  // Back to an empty chat for the next mode.
  await win
    .locator('[data-testid="new-chat"]')
    .first()
    .click()
    .catch(() => {});
  await win.waitForTimeout(500);
}

writeFileSync(path.join(OUT, 'computed-styles.json'), JSON.stringify(measured, null, 2));
// A flat, greppable text rendering of the same measurements.
const lines = [];
for (const m of measured) {
  lines.push(`\n=== ${m.label} ===`);
  for (const r of m.rows) {
    if (r.missing) {
      lines.push(`  ${r.sel}  (missing)`);
      continue;
    }
    lines.push(
      `  ${r.sel}\n     "${r.text}"\n     font ${r.font} ${r.family}  color ${r.color}  bg ${r.bg}  ls ${r.letterSpacing} ${r.transform}\n     border ${r.border}  shadow ${r.shadow}  radius ${r.radius}  pad ${r.padding}  margin ${r.margin}  gap ${r.gap}  op ${r.opacity}  ${r.rect}`,
    );
  }
}
writeFileSync(path.join(OUT, 'computed-styles.txt'), lines.join('\n'));
console.log('measurements →', path.relative(repoRoot, path.join(OUT, 'computed-styles.txt')));

const frontAfter = frontmostApp();
if (frontBefore !== null && frontAfter !== null && frontBefore !== frontAfter) {
  console.log(`FOCUS GUARD: frontmost moved "${frontBefore}" → "${frontAfter}"`);
} else {
  console.log('focus guard: frontmost unchanged', frontBefore);
}

await app.close();
for (const dir of [home, udd]) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
console.log('done →', path.relative(repoRoot, OUT));
