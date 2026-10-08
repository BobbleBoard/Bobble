/**
 * THE PICTURES A CHAIN WORKED WITH — beside it, bigger on hover, in a lightbox.
 *
 * the user (2026-10-08): "if there's an image/visuals of some sort worked with in
 * the thought/tool chain put on the right side of the chat area but vertically
 * in line with the tool chain a little preview of the image hovering it shows
 * it a bit bigger and clicking on it shows it, if there's multiple, clicking on
 * it shows it with the others on the left and right" and "in expanded tools
 * nothing should render at full size right there".
 *
 * A turn seeded into the store (no model): a chain that generates a picture,
 * edits it into a second, and reads a third, then a reply. Checks: the chain's
 * previews sit at the right end of its summary row, level with it; hovering one
 * opens the picture large in a card under it (the user's second note: "hover should
 * show a larger version like shown in the image"); a click opens the lightbox on
 * that picture with its neighbours peeking in at the edges, greyed and cut off —
 * a sliver lifts under the pointer and, clicked, slides to the middle; ‹ › and
 * the arrow keys step, Esc closes; expanded, no picture in the chain is taller
 * than a row preview.
 *
 * Usage (build first): SHOT_DIR=… node apps/desktop/tests/e2e/chain-visuals-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { launchApp, probeHome } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A W×H RGB PNG painted by `paint(x, y) → [r, g, b]`. */
function png(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const home = probeHome('chain-visuals');
const dir = path.join(home, 'Bobble', 'generated', 'a-lighthouse');
mkdirSync(dir, { recursive: true });
const pics = {
  a: path.join(dir, 'lighthouse.png'),
  b: path.join(dir, 'lighthouse-dusk.png'),
  c: path.join(dir, 'reference.png'),
};
// Wide, at a generation's size: the lightbox's neighbours then only peek in.
const W = 1280;
const H = 800;
writeFileSync(
  pics.a,
  png(W, H, (x, y) =>
    y > H * 0.7
      ? [40, 110, 160]
      : x > W * 0.47 && x < W * 0.53 && y > H * 0.25
        ? [235, 235, 230]
        : [150, 200, 235],
  ),
);
writeFileSync(
  pics.b,
  png(W, H, (x, y) =>
    y > H * 0.7
      ? [30, 40, 90]
      : x > W * 0.47 && x < W * 0.53 && y > H * 0.25
        ? [250, 210, 120]
        : [230, 120, 90],
  ),
);
writeFileSync(
  pics.c,
  png(1024, 680, (x) => [200 - (x % 40), 190, 170]),
);

const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
const result = (callId, assistantId, text, t) => ({
  kind: 'toolResult',
  id: `tr-${assistantId}-${callId}`,
  toolCallId: callId,
  assistantId,
  toolName: 'bash',
  text,
  isError: false,
  timestamp: t,
});
const messages = [
  {
    kind: 'user',
    id: 'u1',
    text: 'make me a lighthouse picture, then a dusk version',
    timestamp: 1,
  },
  {
    kind: 'assistant',
    id: 'a1',
    timestamp: 10,
    blocks: [
      { type: 'thinking', thinking: 'A lighthouse first, then the same at dusk.' },
      { type: 'toolCall', id: 'c0', name: 'read', arguments: { path: pics.c } },
      bash('c1', 'media generate image "a lighthouse on a cliff"'),
      bash('c2', `media edit image "${pics.a}" "the same at dusk"`),
    ],
  },
  {
    kind: 'toolResult',
    id: 'tr-a1-c0',
    toolCallId: 'c0',
    assistantId: 'a1',
    toolName: 'read',
    text: 'Read image file [image/png]',
    isError: false,
    timestamp: 11,
  },
  result(
    'c1',
    'a1',
    `Generated 1 image on the canvas:\n  1. ${pics.a} (seed 7)\nModel: Qwen-Image 2.1`,
    12,
  ),
  result('c2', 'a1', `Edited the image:\n  1. ${pics.b} (seed 8)\nModel: Qwen-Image Edit`, 14),
  {
    kind: 'assistant',
    id: 'a2',
    timestamp: 20,
    blocks: [{ type: 'text', text: 'Here is the lighthouse, and the same scene at dusk.' }],
  },
];

const { page, check, shot, finish } = await launchApp('chain-visuals', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  args: ['--', '--piE2E=1'],
  waitFor: '[data-testid="composer-input"]',
});
try {
  await page.evaluate((m) => window.__pi_store().setState({ messages: m }), messages);
  await page.waitForSelector('[data-testid="chain-thumbs"]', { timeout: 10_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="chain-thumb"] img')].every(
        (i) => i.complete && i.naturalWidth > 0,
      ),
    undefined,
    { timeout: 8000 },
  );
  await sleep(500);
  const row = await page.evaluate(() => {
    const thumbs = document.querySelector('[data-testid="chain-thumbs"]')?.getBoundingClientRect();
    const summary = document.querySelector('.pd-chain-summary')?.getBoundingClientRect();
    const chain = document.querySelector('.pd-chain')?.getBoundingClientRect();
    return {
      count: document.querySelectorAll('[data-testid="chain-thumb"]').length,
      thumbsRight: thumbs ? Math.round(thumbs.right) : null,
      chainRight: chain ? Math.round(chain.right) : null,
      thumbsMid: thumbs ? Math.round(thumbs.top + thumbs.height / 2) : null,
      summaryMid: summary ? Math.round(summary.top + summary.height / 2) : null,
    };
  });
  console.log('row', JSON.stringify(row));
  check(row.count === 3, `the chain shows its three pictures (${row.count})`);
  check(
    row.thumbsRight !== null && row.chainRight !== null && row.chainRight - row.thumbsRight <= 2,
    `they sit at the right end of the chain's row (${row.thumbsRight} vs ${row.chainRight})`,
  );
  check(
    row.thumbsMid !== null && Math.abs(row.thumbsMid - row.summaryMid) <= 3,
    `level with its summary (${row.thumbsMid} vs ${row.summaryMid})`,
  );
  await shot('1-collapsed');

  // Hover: the picture large in a card under its thumbnail, right edges lined up.
  const first = page.locator('[data-testid="chain-thumb"]').first();
  await first.hover();
  await page.waitForSelector('[data-testid="chain-hover-preview"]', { timeout: 2000 });
  await sleep(300);
  const hover = await page.evaluate(() => {
    const thumb = document.querySelector('[data-testid="chain-thumb"]')?.getBoundingClientRect();
    const card = document.querySelector('[data-testid="chain-hover-preview"]');
    const r = card?.getBoundingClientRect();
    const img = card?.querySelector('img');
    return {
      thumb: thumb ? { w: thumb.width, right: thumb.right, bottom: thumb.bottom } : null,
      card: r ? { w: r.width, h: r.height, right: r.right, top: r.top } : null,
      side: card?.getAttribute('data-side') ?? null,
      loaded: img ? img.complete && img.naturalWidth > 0 : false,
    };
  });
  console.log('hover', JSON.stringify(hover));
  check(
    hover.card !== null && hover.thumb !== null && hover.card.w >= 8 * hover.thumb.w,
    `hovering opens the picture large (${hover.card?.w}px wide against a ${hover.thumb?.w}px thumbnail)`,
  );
  check(
    hover.card !== null &&
      hover.thumb !== null &&
      Math.abs(hover.card.right - hover.thumb.right) <= 2 &&
      hover.side === 'below' &&
      hover.card.top >= hover.thumb.bottom,
    `under the thumbnail, right edges lined up (${hover.card?.right} vs ${hover.thumb?.right}, ${hover.side})`,
  );
  check(hover.loaded, 'the card shows the picture');
  // Moving to the next thumbnail swaps the card at once.
  await page.locator('[data-testid="chain-thumb"]').nth(1).hover();
  await sleep(60);
  const swapped = await page.evaluate(() => ({
    card: document.querySelector('[data-testid="chain-hover-preview"] img')?.getAttribute('src'),
    thumb: document.querySelectorAll('[data-testid="chain-thumb"] img')[1]?.getAttribute('src'),
  }));
  check(
    swapped.card !== undefined && swapped.card === swapped.thumb,
    `the next thumbnail swaps the card without a second wait (${swapped.card?.split('/').pop()})`,
  );
  await first.hover();
  await sleep(300);
  await shot('2-hover');
  await page.mouse.move(5, 5);
  await sleep(200);
  check(
    (await page.$('[data-testid="chain-hover-preview"]')) === null,
    'leaving the thumbnail closes the card',
  );

  // Click: the lightbox, its neighbours peeking in at the edges.
  await page.locator('[data-testid="chain-thumb"]').nth(1).click();
  await page.waitForSelector('[data-testid="lightbox"]', { timeout: 3000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.pd-lightbox-slide img')].every(
        (i) => i.complete && i.naturalWidth > 0,
      ),
    undefined,
    { timeout: 5000 },
  );
  await sleep(700);
  const count1 = await page.textContent('[data-testid="lightbox-count"]');
  check(count1?.trim() === '2 of 3', `the lightbox opens on the picture clicked (${count1})`);
  const peeks = () =>
    page.evaluate(() => {
      const vw = window.innerWidth;
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const slide = el.closest('.pd-lightbox-slide') ?? el;
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          onScreen: Math.round(Math.min(r.right, vw) - Math.max(r.left, 0)),
          opacity: Number(getComputedStyle(slide).opacity),
        };
      };
      return {
        prev: box('[data-testid="lightbox-peek-prev"]'),
        next: box('[data-testid="lightbox-peek-next"]'),
        current: box('[data-testid="lightbox-current"]'),
        nextDisabled: document.querySelector('[data-testid="lightbox-next"]')?.disabled ?? null,
      };
    });
  const p1 = await peeks();
  console.log('peeks', JSON.stringify(p1));
  check(
    p1.prev !== null && p1.next !== null && p1.prev.left < 0 && p1.next.right > 1440,
    'the neighbours are cut off by the window edges',
  );
  check(
    p1.prev !== null &&
      p1.next !== null &&
      Math.abs(p1.prev.onScreen - 64) <= 2 &&
      Math.abs(p1.next.onScreen - 64) <= 2,
    `only a sliver of each shows (${p1.prev?.onScreen}px, ${p1.next?.onScreen}px)`,
  );
  check(
    p1.prev !== null && p1.prev.opacity < 0.5 && p1.current?.opacity === 1,
    `the slivers are greyed, the picture is not (${p1.prev?.opacity} / ${p1.current?.opacity})`,
  );
  await shot('3-lightbox');
  // Hover a sliver: it lifts.
  await page.hover('[data-testid="lightbox-peek-next"]', { position: { x: 20, y: 100 } });
  await sleep(450);
  const lifted = (await peeks()).next?.opacity ?? 0;
  check(
    lifted > p1.next.opacity + 0.1,
    `a sliver lifts under the pointer (${p1.next.opacity} → ${lifted})`,
  );
  await shot('3b-lightbox-hover');
  // Click it: it slides to the middle, as › would.
  const nextLeft0 = p1.next.left;
  await page.click('[data-testid="lightbox-peek-next"]', { position: { x: 20, y: 100 } });
  await sleep(120);
  const mid = await page.evaluate(() => {
    const cur = document.querySelector('[data-testid="lightbox-current"]')?.getBoundingClientRect();
    return cur ? Math.round(cur.left) : null;
  });
  await shot('3c-lightbox-sliding');
  await sleep(600);
  const p2 = await peeks();
  const count2 = await page.textContent('[data-testid="lightbox-count"]');
  console.log('after the sliver', JSON.stringify({ mid, p2, count2 }));
  check(count2?.trim() === '3 of 3', `clicking the sliver steps to it (${count2})`);
  check(
    mid !== null && p2.current !== null && mid < nextLeft0 && mid > p2.current.left,
    `it slides in rather than jumping (left ${nextLeft0} → ${mid} mid-way → ${p2.current?.left})`,
  );
  check(
    p2.next === null && p2.nextDisabled === true && p2.prev !== null,
    'at the last picture there is nothing to the right and › is off',
  );
  await shot('3d-lightbox-last');
  await page.keyboard.press('ArrowLeft');
  await sleep(500);
  check(
    (await page.textContent('[data-testid="lightbox-count"]'))?.trim() === '2 of 3',
    'the arrow key steps back',
  );
  await page.click('[data-testid="lightbox-prev"]');
  await sleep(500);
  check(
    (await page.textContent('[data-testid="lightbox-count"]'))?.trim() === '1 of 3',
    '‹ steps back again',
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  check((await page.$('[data-testid="lightbox"]')) === null, 'Esc closes the lightbox');

  // Expanded: nothing full size.
  await page.click('.pd-chain-summary');
  await sleep(600);
  const tallest = await page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll('.pd-chain img')].map(
        (i) => i.getBoundingClientRect().height,
      ),
    ),
  );
  console.log('tallest picture in the expanded chain', tallest);
  check(
    tallest > 0 && tallest <= 80,
    `no picture in the expanded chain is taller than a preview (${tallest}px)`,
  );
  await shot('4-expanded');
} finally {
  await finish();
}
