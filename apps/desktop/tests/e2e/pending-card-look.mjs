/**
 * LOOK at the generating card: its ground, its number, its size.
 *
 * the user (2026-09-24), with ChatGPT's generating card beside ours: "a distinct
 * black background card that makes it feel raised, not lowered, but without a
 * border, just quick but noticeable falloff around the edge into the background
 * color"; "that terminal logging style text below it needs to go … show a little
 * bordered pill at the bottom right of the image card that says n% and smoothly
 * goes up"; and "it's significantly smaller than the images generated, make sure
 * those are the same sizes".
 *
 * No GPU: the running tool call is put in the thread and the live job is driven
 * through `__gen_live` (the same store the engine's events feed), so the steps
 * arrive on a schedule this probe controls — including a step that is late.
 * Then the Image Studio's finished card for a 640x480 picture is measured
 * against the waiting card for the same 4:3 shape.
 *
 *   SHOT_DIR=<dir> node apps/desktop/tests/e2e/pending-card-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const home = probeHome('pending-card');
const { page, check, finish, shotDir } = await launchApp('pending-card', {
  env: { HOME: home },
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
const clip = async (label) => {
  const box = await page.locator('[data-testid="pending-media-card"]').first().boundingBox();
  if (box === null) return page.screenshot({ path: path.join(shotDir, `${label}.png`) });
  return page.screenshot({
    path: path.join(shotDir, `${label}.png`),
    clip: {
      x: Math.max(0, box.x - 48),
      y: Math.max(0, box.y - 48),
      width: box.width + 96,
      height: box.height + 96,
    },
  });
};
const frameFacts = () =>
  page.evaluate(() => {
    const card = document.querySelector('[data-testid="pending-media-card"]');
    const frame = card?.querySelector('.pd-media-frame');
    const cs = frame ? getComputedStyle(frame) : null;
    const pill = card?.querySelector('[data-testid="pending-pct"]');
    const b = frame?.getBoundingClientRect();
    return {
      ground: cs?.backgroundColor ?? null,
      border: cs?.borderTopColor ?? null,
      shadow: cs?.boxShadow ?? null,
      width: b ? Math.round(b.width) : null,
      height: b ? Math.round(b.height) : null,
      pill: pill ? { text: pill.textContent, visible: getComputedStyle(pill).opacity } : null,
      bars: document.querySelectorAll('.pd-pending-bar, .pd-pending-fill').length,
      underText: card
        ? [...card.children]
            .filter((c) => !c.classList.contains('pd-media-frame'))
            .map((c) => c.textContent)
            .join('|')
        : null,
    };
  });
const pillNow = () =>
  page.evaluate(() => document.querySelector('[data-testid="pending-pct"]')?.textContent ?? null);

const user = { kind: 'user', id: 'u1', text: 'make the fur a deeper red', timestamp: 1 };
const running = {
  kind: 'assistant',
  id: 'a1',
  blocks: [
    {
      type: 'toolCall',
      id: 'g1',
      name: 'generate_image',
      arguments: { prompt: 'a fox, deeper red fur' },
    },
  ],
  timestamp: 2,
  isStreaming: true,
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);
  await setTheme('dark');
  await set({
    session: { cwd: '/w' },
    agent: { isStreaming: true },
    messages: [user, running],
    runningToolCalls: ['g1'],
  });
  await page.waitForSelector('[data-testid="pending-media-card"]', { timeout: 8000 });
  // An edit of a 4:3 photo: the job knows its shape, not a width.
  await page.evaluate(() =>
    window
      .__gen_live()
      .getState()
      .open({
        id: 'pi:gen-probe',
        jobId: 'probe',
        modality: 'image',
        aspect: 4 / 3,
        note: '46%|████▋     | 11/24 [01:01<01:06,  5.08s/it]',
        outputs: [],
        status: 'generating',
        startedAt: Date.now(),
      }),
  );
  await sleep(1200);
  const warm = await frameFacts();
  await clip('1-warmup-dark');
  check(warm.bars === 0, 'no progress bar under the card');
  check(
    !/s\/it|\d+\/\d+/.test(warm.underText ?? ''),
    `no engine line under the card (${warm.underText})`,
  );
  check(
    warm.pill !== null && warm.pill.visible === '0',
    'no number before the first step (the phase says warming up)',
  );
  check(/rgb\(0, 0, 0\)/.test(warm.ground ?? ''), `the waiting card is black (${warm.ground})`);
  check(
    /rgba\(0, 0, 0, 0\)|transparent/.test(warm.border ?? ''),
    `…with no border (${warm.border})`,
  );
  check(
    /0px 0px 14px 4px/.test(warm.shadow ?? ''),
    `…and a short falloff around its edge (${warm.shadow})`,
  );

  // Steps every 700 ms (compressed time), sampling the pill every 50 ms.
  const samples = [];
  const sampleFor = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = await pillNow();
      if (t !== null) samples.push(Number.parseInt(t, 10));
      await sleep(50);
    }
  };
  for (let s = 1; s <= 10; s += 1) {
    await page.evaluate(
      (s) => window.__gen_live().getState().update('pi:gen-probe', { step: s, total: 24 }),
      s,
    );
    await sampleFor(700);
  }
  await clip('2-steps-dark');
  const mid = await frameFacts();
  console.log('mid', JSON.stringify(mid));
  // A late step: nothing for 4 s — the number may slow, never pass step 11.
  const lateStart = samples.length;
  await sampleFor(4000);
  const late = samples.slice(lateStart);
  const cap = Math.floor((11 / 24) * 0.94 * 100);
  check(
    late.every((v) => v < cap + 1),
    `a late step never claims step 11 (${Math.max(...late)} vs ${cap})`,
  );
  let backwards = 0;
  let bigJumps = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] < samples[i - 1]) backwards += 1;
    if (samples[i] - samples[i - 1] > 3) bigJumps += 1;
  }
  check(backwards === 0, `the number never goes backwards (${backwards})`);
  check(bigJumps === 0, `…and never jumps more than 3 points in 50 ms (${bigJumps})`);
  writeFileSync(path.join(shotDir, 'pill-samples.json'), JSON.stringify(samples));
  console.log(
    'pill samples',
    samples.length,
    'first',
    samples.slice(0, 12).join(','),
    'last',
    samples.slice(-8).join(','),
  );

  await setTheme('light');
  await sleep(700);
  await clip('3-steps-light');
  const light = await frameFacts();
  console.log(
    'light',
    JSON.stringify({ ground: light.ground, shadow: light.shadow, pill: light.pill }),
  );

  // SIZE: a finished 640x480 picture in the THREAD, above the same 4:3 job still
  // waiting — the case the user saw ("significantly smaller than the images
  // generated"). The file lives in the conversation sandbox, a pd-file:// root.
  await setTheme('dark');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const g = c.getContext('2d');
    g.fillStyle = '#8a4b2b';
    g.fillRect(0, 0, 640, 480);
    g.fillStyle = '#f0c27a';
    g.beginPath();
    g.arc(320, 240, 110, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  const conv = path.join(home, '.pi', 'desktop', 'sandbox', 'conv-probe');
  mkdirSync(conv, { recursive: true });
  const file = path.join(conv, 'fox.png');
  writeFileSync(file, Buffer.from(png, 'base64'));
  const done0 = {
    kind: 'assistant',
    id: 'a0',
    blocks: [
      { type: 'toolCall', id: 'g0', name: 'generate_image', arguments: { prompt: 'a fox' } },
    ],
    timestamp: 2,
  };
  const result0 = {
    kind: 'toolResult',
    id: 'tr-a0-g0',
    toolCallId: 'g0',
    assistantId: 'a0',
    toolName: 'generate_image',
    text: `Generated image: ${file}`,
    isError: false,
    timestamp: 3,
  };
  const user2 = { kind: 'user', id: 'u2', text: 'now a deeper red', timestamp: 4 };
  await set({
    messages: [user, done0, result0, user2, { ...running, timestamp: 5 }],
    runningToolCalls: ['g1'],
    agent: { isStreaming: true },
  });
  await page.waitForSelector('[data-testid="media-card"]', { timeout: 8000 });
  await sleep(1200);
  const sizes = await page.evaluate(() => {
    const chain = (el) => {
      const out = [];
      for (let e = el; e && out.length < 6; e = e.parentElement) {
        out.push(
          `${String(e.className).split(' ')[0].slice(0, 26)}:${Math.round(e.getBoundingClientRect().width)}`,
        );
      }
      return out.join(' < ');
    };
    const fin = document.querySelector('[data-testid="media-card"] .pd-media-frame');
    const wait = document.querySelector('[data-testid="pending-media-card"] .pd-media-frame');
    return {
      finished: fin ? Math.round(fin.getBoundingClientRect().width) : null,
      waiting: wait ? Math.round(wait.getBoundingClientRect().width) : null,
      finChain: fin ? chain(fin) : null,
      waitChain: wait ? chain(wait) : null,
    };
  });
  console.log('size', JSON.stringify(sizes));
  await page.screenshot({ path: path.join(shotDir, '4-sizes-dark.png') });
  check(
    sizes.finished !== null &&
      sizes.waiting !== null &&
      Math.abs(sizes.finished - sizes.waiting) <= 2,
    `the waiting card is the finished card's size (${sizes.waiting} vs ${sizes.finished})`,
  );

  // HANDOVER: finish the waiting job with a real 4:3 result and watch it land —
  // the number reaches 100, the halo goes, and the box does not change size.
  await page.evaluate(() =>
    window.__gen_live().getState().update('pi:gen-probe', { step: 24, total: 24 }),
  );
  await sleep(600);
  const file2 = path.join(conv, 'fox-red.png');
  writeFileSync(file2, Buffer.from(png, 'base64'));
  const result1 = {
    kind: 'toolResult',
    id: 'tr-a1-g1',
    toolCallId: 'g1',
    assistantId: 'a1',
    toolName: 'generate_image',
    text: `Generated image: ${file2}`,
    isError: false,
    timestamp: 6,
  };
  const watch = page.evaluate(
    () =>
      new Promise((resolve) => {
        const seen = [];
        const t0 = performance.now();
        const tick = () => {
          const pill = document.querySelector('[data-testid="pending-pct"]');
          const frame =
            document.querySelector('[data-testid="pending-media-card"] .pd-media-frame') ??
            document.querySelectorAll('[data-testid="media-card"] .pd-media-frame')[1];
          seen.push({
            t: Math.round(performance.now() - t0),
            pill: pill ? pill.textContent : null,
            w: frame ? Math.round(frame.getBoundingClientRect().width) : null,
            pending: document.querySelector('[data-testid="pending-media-card"]') !== null,
          });
          if (performance.now() - t0 < 3200) requestAnimationFrame(tick);
          else resolve(seen);
        };
        requestAnimationFrame(tick);
      }),
  );
  await set({
    messages: [user, done0, result0, user2, { ...running, timestamp: 5 }, result1],
    runningToolCalls: [],
    agent: { isStreaming: false },
  });
  await page.evaluate(() =>
    window.__gen_live().getState().update('pi:gen-probe', { status: 'done', outputs: [] }),
  );
  await sleep(700);
  await page.screenshot({ path: path.join(shotDir, '5-handover-dark.png') });
  const seen = await watch;
  writeFileSync(path.join(shotDir, 'handover.json'), JSON.stringify(seen));
  const pills = seen.map((x) => x.pill).filter((x) => x !== null);
  const widths = [...new Set(seen.map((x) => x.w).filter((x) => x !== null))];
  console.log('handover pills', [...new Set(pills)].join(','), 'widths', widths.join(','));
  check(pills.includes('100%'), 'the number reaches 100 when the result lands');
  check(
    widths.every((w) => Math.abs(w - 482) <= 2),
    `the box does not jump at the handover (${widths.join(',')})`,
  );
} finally {
  await finish();
}
