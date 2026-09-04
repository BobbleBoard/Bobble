/**
 * THE CHAT QUALITY WAVE — the measurements behind the user's numbered chat list.
 *
 * Each block here is one item he reported, checked the only way that settles it:
 * drive the real app and read the real geometry / the real system clipboard.
 *
 *   #9  copy buttons don't actually copy
 *   #6  the sidebar's running spinner is off-centre and too small
 *
 * Run `npm run build` first (the renderer + electron main are loaded from dist).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

// A seeded chat so the sidebar has a row to run, and a message to copy.
const home = mkdtempSync(path.join(tmpdir(), 'pd-chatq-home-'));
const sessionsDir = path.join(home, '.pi', 'agent', 'sessions', 'proj');
mkdirSync(sessionsDir, { recursive: true });
const REPLY = 'Apples are great.';
const l = (o) => JSON.stringify(o);
writeFileSync(
  path.join(sessionsDir, 'alpha.jsonl'),
  [
    l({ type: 'session', version: 3, id: 'sess-alpha', timestamp: 't', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 't',
      message: { role: 'user', content: 'chat about apples', timestamp: 1 },
    }),
    l({
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'text', text: REPLY }], timestamp: 1 },
    }),
  ].join('\n'),
);

const PASTE =
  "we're going to work on the chat, the main product of the app now.\nline two\nline three";
writeFileSync(
  path.join(sessionsDir, 'beta.jsonl'),
  [
    l({ type: 'session', version: 3, id: 'sess-beta', timestamp: 'u', cwd: '/tmp' }),
    l({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: 'u',
      message: {
        role: 'user',
        // Exactly what buildAgentMessage folds in — this is pi's copy, which is
        // what a reopened chat rebuilds its bubbles from.
        content: [
          { type: 'text', text: `Attached file \`pasted content\`:\n\`\`\`\n${PASTE}\n\`\`\`` },
        ],
        timestamp: 1,
      },
    }),
  ].join('\n'),
);

const { app, page, shot, check, finish } = await launchApp('chat-quality-probe', {
  env: { HOME: home },
});

const box = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const b = el.getBoundingClientRect();
    return {
      x: b.x,
      y: b.y,
      w: b.width,
      h: b.height,
      cx: b.x + b.width / 2,
      cy: b.y + b.height / 2,
    };
  }, sel);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 10_000 });
  await page.click('text=chat about apples');
  await page.waitForSelector(`text=${REPLY}`, { timeout: 10_000 });

  /* ---------------------------------------------------------------- #9 copy */
  // MEASURED before the fix: navigator.clipboard.writeText rejected with
  // "NotAllowedError: Write permission denied" (electron/main.ts denied every
  // permission but 'media'), and every call site discarded the promise — so the
  // button flipped to its check and the clipboard was untouched.
  await app.evaluate(({ clipboard }) => clipboard.writeText('CLIPBOARD-UNTOUCHED'));
  const hoverTarget = await page.$(`text=${REPLY}`);
  await hoverTarget.hover();
  await page.waitForTimeout(150);
  const copyBtn = await page.$('.pd-msg--assistant [aria-label="Copy message"]');
  check(copyBtn !== null, 'no copy button appeared on an assistant message');
  if (copyBtn !== null) {
    await copyBtn.click();
    await page.waitForTimeout(300);
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    check(clip.includes(REPLY), `copy button did not reach the clipboard (got "${clip}")`);
  }

  /* --------------------------------------------------- #17 the paste card survives */
  // MEASURED in the user's own sidebar: a chat titled
  //   Attached file `pasted content`: ``` we're going to work on the chat…
  // because pi's copy of the message carries the fold, and both the title and a
  // reopened bubble were built straight from it.
  const pasteTitle = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="chat-row-"]')]
      .map((e) => e.getAttribute('data-testid').replace('chat-row-', ''))
      .find((t) => t.toLowerCase().includes('going to work') || t.includes('Attached file')),
  );
  check(
    pasteTitle !== undefined && !pasteTitle.includes('Attached file'),
    `the sidebar still titles a pasted chat by the folded block: ${pasteTitle}`,
  );
  await page.click(`[data-testid="chat-row-${pasteTitle}"]`);
  await page.waitForSelector('[data-testid="user-attachments"]', { timeout: 8000 });
  const bubbleText = await page.evaluate(
    () => document.querySelector('.pd-msg--user')?.textContent ?? '',
  );
  check(
    !bubbleText.includes('Attached file'),
    `the user bubble still shows the raw fold: ${bubbleText.slice(0, 90)}`,
  );
  // …and the card opens the whole paste, centred, over a blurred room.
  await page.click('[data-testid="user-attachments"] .pd-pasted-open');
  await page.waitForSelector('[data-testid="attached-file-expanded"]', { timeout: 5000 });
  const expandedText = await page.evaluate(
    () => document.querySelector('.pd-pasted-stage-body')?.textContent ?? '',
  );
  check(expandedText.includes('line three'), 'the expanded card does not show the whole paste');
  const blurred = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="attached-file-expanded"]');
    const cs = el === null ? null : getComputedStyle(el);
    return cs === null ? null : `${cs.backdropFilter}${cs.webkitBackdropFilter ?? ''}`;
  });
  check(blurred?.includes('blur'), `the backdrop is not blurred: ${blurred}`);
  await shot('paste-card-expanded');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="attached-file-expanded"]', {
    state: 'detached',
    timeout: 5000,
  });
  await page.click('text=chat about apples');
  await page.waitForSelector(`text=${REPLY}`, { timeout: 8000 });

  /* ------------------------------------------------ #2 the model switch is visible */
  // MEASURED before the fix: `useModelSelectionStore.switching` was set by one of
  // four entry points and rendered by nothing, and the ring is gated on a turn
  // being in flight — so a switch showed NOTHING for the tens of seconds a model
  // takes to load. Both states are asserted with no turn running, which is the
  // case that was broken.
  await page.evaluate(() => {
    window.__model_selection_store?.().setState({
      switching: { toTier: 'balanced', toName: 'Gemma 12B' },
    });
  });
  await page.waitForTimeout(200);
  // The ring lowercases its label by design ("45% processing · 2.3s").
  const switchLabel = (
    await page.evaluate(
      () => document.querySelector('[data-testid="thread-processing"]')?.textContent ?? '(no ring)',
    )
  ).toLowerCase();
  check(
    switchLabel.includes('switching to gemma 12b'),
    `no "Switching to <model>" while switching (saw: ${switchLabel.slice(0, 120)})`,
  );
  await shot('switching-to-model');
  await page.evaluate(() => {
    window.__model_selection_store?.().setState({ switching: null });
    window.__llm_store?.().setState((s) => ({ status: { ...s.status, phase: 'starting' } }));
  });
  await page.waitForTimeout(200);
  const loadLabel = (
    await page.evaluate(
      () => document.querySelector('[data-testid="thread-processing"]')?.textContent ?? '(no ring)',
    )
  ).toLowerCase();
  check(
    loadLabel.includes('loading model'),
    'no "Loading model" while the server is coming up outside a turn',
  );
  await page.evaluate(() => {
    window.__llm_store?.().setState((s) => ({ status: { ...s.status, phase: 'idle' } }));
  });

  /* ------------------------------------------------------- #6 spinner geometry */
  // Put the seeded chat into a running state the way a background run does, so
  // the row draws its spinner without needing a live model.
  const file = await page.evaluate(() => window.__pi_store().getState().sessionFile);
  await page.evaluate((f) => {
    window.__pi_store().setState({
      bgRun: { sessionFile: f, messages: [], streaming: true, title: 'chat about apples' },
    });
  }, file);
  await page.waitForSelector('.pd-chatrow-spinner', { timeout: 5000 });

  const spinner = await box('.pd-chatrow-spinner');
  await shot('sidebar-spinner-resting');
  await page.hover('[data-testid="chat-row-chat about apples"]');
  await page.waitForTimeout(200);
  const dots = await box('.pd-chatrow-dots');
  check(spinner !== null && dots !== null, 'could not measure the spinner and the dots button');
  if (spinner !== null && dots !== null) {
    check(
      Math.abs(spinner.cx - dots.cx) < 0.6 && Math.abs(spinner.cy - dots.cy) < 0.6,
      `spinner is not centred on the 3-dot button: spinner (${spinner.cx}, ${spinner.cy}) vs dots (${dots.cx}, ${dots.cy})`,
    );
    check(
      spinner.w === dots.w && spinner.h === dots.h,
      `spinner box ${spinner.w}x${spinner.h} !== dots box ${dots.w}x${dots.h}`,
    );
  }
  const glyph = await box('.pd-chatrow-spinner .pd-loader');
  check(
    glyph !== null && glyph.w >= 16,
    `spinner glyph should be larger than the old 14px (got ${glyph?.w})`,
  );
  // The loader is a fading ring with a rounded tip, not the old arc-on-a-track.
  const shape = await page.evaluate(() => {
    const ring = document.querySelector('.pd-chatrow-spinner .pd-loader-ring');
    const tip = document.querySelector('.pd-chatrow-spinner .pd-loader-tip');
    if (ring === null || tip === null) return null;
    const cs = getComputedStyle(ring);
    return {
      conic: cs.backgroundImage.includes('conic-gradient'),
      masked: `${cs.maskImage}${cs.webkitMaskImage ?? ''}`.includes('radial-gradient'),
      tipRound: getComputedStyle(tip).borderTopLeftRadius,
    };
  });
  check(shape?.conic, 'the loader tail is not a conic (fading) gradient');
  check(shape?.masked, 'the loader is not masked to a ring');
  await shot('sidebar-spinner-hovered');
} finally {
  await finish();
}
