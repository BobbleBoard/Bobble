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
 * makes it bigger; a click opens the lightbox on that picture, ‹ › step through
 * all three ("2 of 3"), Esc closes; expanded, no picture in the chain is taller
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
const S = 384;
writeFileSync(
  pics.a,
  png(S, S, (x, y) =>
    y > S * 0.7
      ? [40, 110, 160]
      : x > S * 0.45 && x < S * 0.55 && y > S * 0.25
        ? [235, 235, 230]
        : [150, 200, 235],
  ),
);
writeFileSync(
  pics.b,
  png(S, S, (x, y) =>
    y > S * 0.7
      ? [30, 40, 90]
      : x > S * 0.45 && x < S * 0.55 && y > S * 0.25
        ? [250, 210, 120]
        : [230, 120, 90],
  ),
);
writeFileSync(
  pics.c,
  png(S, Math.round(S * 0.66), (x) => [200 - (x % 40), 190, 170]),
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

  // Hover: a bit bigger.
  const first = page.locator('[data-testid="chain-thumb"]').first();
  const before = await first.boundingBox();
  await first.hover();
  await sleep(400);
  const after = await first.boundingBox();
  console.log('hover', JSON.stringify({ before, after }));
  check(
    after !== null && before !== null && after.width > before.width * 2,
    'hovering a preview makes it bigger',
  );
  await shot('2-hover');
  await page.mouse.move(5, 5);
  await sleep(300);

  // Click: the lightbox, then step through.
  await page.locator('[data-testid="chain-thumb"]').nth(1).click();
  await page.waitForSelector('[data-testid="lightbox"]', { timeout: 3000 });
  await sleep(500);
  const count1 = await page.textContent('[data-testid="lightbox-count"]');
  check(count1?.trim() === '2 of 3', `the lightbox opens on the picture clicked (${count1})`);
  await shot('3-lightbox');
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  const count2 = await page.textContent('[data-testid="lightbox-count"]');
  check(count2?.trim() === '3 of 3', `the arrow key steps to the next (${count2})`);
  await page.click('[data-testid="lightbox-prev"]');
  await sleep(300);
  check(
    (await page.textContent('[data-testid="lightbox-count"]'))?.trim() === '2 of 3',
    '‹ steps back',
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
