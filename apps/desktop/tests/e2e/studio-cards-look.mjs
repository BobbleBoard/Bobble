/**
 * LOOK at the user's 2026-09-17 studio list, the UI half (the sound itself is
 * `audio-studio-real-probe.mjs`): runs no longer overlap (the run <section>
 * shared the Generate button's 34px class); the run header is the chat's own
 * message row — hover for Copy/Edit, Edit in place, no model·seed line, no
 * blue "Edit prompt"; the card's top-right is Copy; a waiting picture is
 * borderless with a soft falloff and the cascade runs off its edge; a waiting
 * sound is a pulsing waveform strip with a phrase that fits; the first-party
 * connector marks carry a hue.
 *
 *   SHOT_DIR=/tmp/studio-cards node apps/desktop/tests/e2e/studio-cards-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/studio-cards';
mkdirSync(SHOT_DIR, { recursive: true });
const { page, check, finish, home } = await launchApp('studio-cards', {
  waitFor: '[data-testid="composer-input"]',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const setTheme = async (mode) => {
  await page.evaluate(
    (mode) =>
      window
        .__settings_store()
        .getState()
        .update({ theme: { flavor: 'bobble', mode } }),
    mode,
  );
  await page.waitForFunction((m) => document.documentElement.dataset.mode === m, mode, {
    timeout: 5000,
  });
};
const shot = (label) => page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
const clip = async (label, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box) {
    await page.screenshot({
      path: `${SHOT_DIR}/${label}.png`,
      clip: {
        x: Math.max(0, box.x - 24),
        y: Math.max(0, box.y - 24),
        width: box.width + 48,
        height: box.height + 48,
      },
    });
  } else await shot(label);
};

/* Two real PNGs for the studio's runs (a 1×1 is enough for geometry). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const media = path.join(home, 'Bobble', 'generated');
mkdirSync(media, { recursive: true });
const img1 = path.join(media, 'cat-1.png');
const img2 = path.join(media, 'cat-2.png');
writeFileSync(img1, PNG);
writeFileSync(img2, PNG);

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);
  await setTheme('dark');

  /* ── A. the waiting cards, in the chat (same component as the studios) ── */
  const user = { kind: 'user', id: 'u1', text: 'a cat on a skateboard', timestamp: 1 };
  const running = (name, args) => ({
    kind: 'assistant',
    id: 'a1',
    blocks: [{ type: 'toolCall', id: 'g1', name, arguments: args }],
    timestamp: 2,
    isStreaming: true,
  });
  await set({
    session: { cwd: '/w' },
    agent: { isStreaming: true },
    messages: [
      user,
      running('generate_image', { prompt: 'a cat on a skateboard', size: '512x512' }),
    ],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  await sleep(500);
  /* The soft edge is no longer an element of its own (`.pd-pending-falloff` went
     in 2026-09-23): it is the frame's halo into the chat and the loader's edge
     fading into the card's ground (global.css, the raised card of 2026-09-24). */
  const pendingPic = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="pending-media-card"]');
    const frame = card?.querySelector('.pd-media-frame');
    const loader = card?.querySelector('.pd-bobble-loader-host');
    const mask = loader ? getComputedStyle(loader) : null;
    return {
      kind: card?.getAttribute('data-kind'),
      border: frame ? getComputedStyle(frame).borderTopColor : null,
      halo: frame ? getComputedStyle(frame).boxShadow : null,
      edgeMask: mask ? mask.maskImage || mask.webkitMaskImage : null,
      phase: card?.querySelector('[data-testid="pending-phase"]')?.textContent ?? null,
    };
  });
  await clip('1-pending-image-puzzle', '[data-testid="pending-media-card"]');
  check(
    pendingPic.kind === 'image' && /rgba\(0, 0, 0, 0\)|transparent/.test(pendingPic.border ?? ''),
    `a waiting picture has no border: ${JSON.stringify(pendingPic)}`,
  );
  check(
    /0px 0px 14px/.test(pendingPic.halo ?? '') && /linear-gradient/.test(pendingPic.edgeMask ?? ''),
    `…and its soft edge (halo ${pendingPic.halo}; loader edge ${pendingPic.edgeMask})`,
  );
  // The cascade act: puzzle 12×340ms = 4080ms, split 1500ms → cascade from ~5.6 s.
  await sleep(6200);
  await clip('2-pending-image-cascade', '[data-testid="pending-media-card"]');
  const reach = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="pending-media-card"] canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { width, height } = canvas;
    // Ink within 3% of the left/right edges: the field reaches the card's rim.
    const edge = Math.max(2, Math.round(width * 0.03));
    const left = ctx.getImageData(0, 0, edge, height).data;
    const right = ctx.getImageData(width - edge, 0, edge, height).data;
    const lit = (d) => {
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 3] > 40) n += 1;
      return n;
    };
    return { left: lit(left), right: lit(right), width, height };
  });
  check(
    reach !== null && reach.left + reach.right > 0,
    `the dot field reaches the card's edges during the cascade: ${JSON.stringify(reach)}`,
  );

  await set({
    messages: [user, running('generate_music', { prompt: 'fast paced dubstep song', seconds: 20 })],
    runningToolCalls: ['g1'],
  });
  await sleep(900);
  const pendingAudio = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="pending-media-card"]');
    const strip = card?.querySelector('[data-testid="audio-pending"]');
    const frame = card?.querySelector('.pd-media-frame');
    return {
      kind: card?.getAttribute('data-kind'),
      bars: strip?.querySelectorAll('.pd-audio-pending-bar').length ?? 0,
      phrase: card?.querySelector('[data-testid="pending-phase"]')?.textContent ?? null,
      height: frame ? Math.round(frame.getBoundingClientRect().height) : null,
      loader: card?.querySelector('canvas') !== null,
    };
  });
  await clip('3-pending-audio', '[data-testid="pending-media-card"]');
  check(
    pendingAudio.kind === 'audio' && pendingAudio.bars === 96 && !pendingAudio.loader,
    `a waiting sound is a pulsing waveform, not the mark: ${JSON.stringify(pendingAudio)}`,
  );
  check(
    pendingAudio.phrase !== null &&
      pendingAudio.phrase.length <= 14 &&
      (pendingAudio.height ?? 0) <= 56,
    `…with a phrase that fits the strip (${pendingAudio.phrase}, ${pendingAudio.height}px)`,
  );

  /* ── B. the Image studio: two runs, the header, the card ── */
  await set({ messages: [], runningToolCalls: [], agent: { isStreaming: false } });
  if ((await page.$('[data-testid="modality-image"]')) === null)
    await page.click('text=Modalities');
  await page.click('[data-testid="modality-image"]');
  await page.waitForSelector('.pd-studio', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.__studio_runs === 'function', { timeout: 20000 });
  await page.evaluate(
    ([a, b]) => {
      const st = window.__studio_runs().getState();
      st.clear('image');
      st.add('image', {
        prompt: 'A fluffy tabby cat balancing on a worn wooden skateboard, 35mm photograph.',
        at: Date.now() - 60000,
        seed: 363017526,
        model: 'flux2-klein-4b',
        items: [{ path: a, name: 'cat-1.png', kind: 'image' }],
      });
      st.add('image', {
        prompt: 'make the cat face me',
        at: Date.now(),
        seed: 840706591,
        model: 'flux2-klein-4b',
        items: [{ path: b, name: 'cat-2.png', kind: 'image' }],
      });
    },
    [img1, img2],
  );
  await page.waitForSelector('[data-testid="media-card"]', { timeout: 10000 });
  await sleep(600);
  const runs = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('.pd-studio-run')].map((s) =>
      s.getBoundingClientRect(),
    );
    const overlap =
      sections.length >= 2 &&
      sections.some((a, i) =>
        sections.some((b, j) => i < j && a.top < b.bottom && b.top < a.bottom),
      );
    return {
      sections: sections.map((r) => Math.round(r.height)),
      overlap,
      facts: document.querySelector('.pd-studio-run-facts') !== null,
      editLink: [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Edit prompt',
      ),
      copyBtn: document.querySelectorAll('[data-testid="media-copy"]').length,
      sendChat: document.querySelectorAll('[data-testid="media-send-chat"]').length,
      prompts: document.querySelectorAll('[data-testid="studio-run-prompt"]').length,
    };
  });
  await shot('4-image-studio-two-runs');
  check(
    !runs.overlap && runs.sections.every((h) => h > 60),
    `runs do not overlap (${JSON.stringify(runs.sections)})`,
  );
  check(
    !runs.facts && !runs.editLink,
    'no model·seed line, no "Edit prompt" link under the prompt',
  );
  check(
    runs.copyBtn === 2 && runs.sendChat === 0,
    `every card's top-right is Copy (${runs.copyBtn} copy, ${runs.sendChat} send)`,
  );

  // Hover the prompt → the chat's own actions; Edit → the chat's editor.
  const prompt = page.locator('[data-testid="studio-run-prompt"]').last();
  await prompt.hover();
  await sleep(300);
  const actions = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      '.pd-studio-run-head .pd-msg-actions, .pd-studio-run-head [data-testid="message-actions"]',
    );
    const last = rows[rows.length - 1];
    return {
      rows: rows.length,
      edit: last?.querySelector('[aria-label*="Edit"]') !== null,
      copy: last?.querySelector('[aria-label*="Copy"]') !== null,
    };
  });
  await clip('5-prompt-hover-actions', '.pd-studio-run:last-of-type .pd-studio-run-head');
  check(
    actions.rows >= 1 && actions.edit && actions.copy,
    `hover shows Copy and Edit: ${JSON.stringify(actions)}`,
  );
  await page.locator('.pd-studio-run-head [aria-label*="Edit"]').last().click();
  await page.waitForSelector('[data-testid="studio-editing-prompt"]', { timeout: 5000 });
  await sleep(300);
  await clip('6-prompt-editing', '[data-testid="studio-editing-prompt"]');
  const editor = await page.evaluate(() => {
    const ed = document.querySelector('[data-testid="studio-editing-prompt"]');
    return {
      textarea: ed?.querySelector('textarea') !== null,
      generate: [...(ed?.querySelectorAll('button') ?? [])].some(
        (b) => b.textContent === 'Generate',
      ),
    };
  });
  check(
    editor.textarea && editor.generate,
    `the chat's editor, with Generate: ${JSON.stringify(editor)}`,
  );
  await page.keyboard.press('Escape');

  await setTheme('light');
  await sleep(400);
  await shot('7-image-studio-light');

  /* ── C. the connector marks carry a hue ── */
  await page.click('[data-testid="nav-connectors"]');
  await sleep(1500);
  const marks = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('.pdc-mark .pd-connector-icon svg')];
    const hued = svgs.filter((s) => /^#[0-9a-f]{6}$/i.test(s.getAttribute('stroke') ?? '')).length;
    const strokes = new Set(
      svgs.map((s) => s.getAttribute('stroke')).filter((v) => v && v !== 'currentColor'),
    );
    return { total: svgs.length, hued, hues: [...strokes].length };
  });
  await shot('8-connectors-light');
  check(
    marks.hued >= 3 && marks.hues >= 3,
    `first-party marks carry hues: ${JSON.stringify(marks)}`,
  );
  await setTheme('dark');
  await sleep(400);
  await shot('9-connectors-dark');
  console.log(
    JSON.stringify({ pendingPic, reach, pendingAudio, runs, actions, editor, marks }, null, 1),
  );
} finally {
  await finish();
}
