/**
 * A PICTURE THE MODEL MADE AND NEVER PRESENTED — IS IT IN THE CHAT?
 *
 * The visual-learner student (2026-10-01, Gemma 4 12B, bash-CLI): "how do the
 * slices actually make a rectangle?? … can you show it with an actual picture".
 * The model ran `media generate image "…"`, read back "Generated 1 image on the
 * canvas: …/cand0_seed259687452.png", wrote its reply about "the image of the
 * thin slices", and ended the turn. The canvas never hears about generation
 * (gen-stream.ts), the picture was filed in the chain row that made it
 * (turn-cards.ts: un-presented work stays in the work), and the chain folded
 * when the reply began. The student's next message: "theres no picture in the
 * chat".
 *
 * Stages that turn — no model, no GPU — and reads where the picture is, and
 * whether a person could SEE it: not merely mounted (a folded chain keeps its
 * rows mounted in a zero-height reveal, so "one media card in the DOM" passes
 * while nothing is on screen), but outside any folded reveal, with a box, and
 * on top at its own centre.
 *
 *   a-chain-working     the chain is live — the picture is in its row (the user,
 *                       2026-09-24: generated work goes inside the thought
 *                       process first)
 *   b-reply-streaming   the model is writing its reply — the chain has folded
 *   c-turn-ended        the turn is over
 *   d-overview          the whole turn in one frame
 *
 * Checks assert the fix (the picture is visible once its chain is done), so the
 * unfixed app FAILS b and c — that run is the "before" picture.
 *
 *   OUT=/tmp/unpresented PICTURE=/path/to/cand0.png \
 *     node apps/desktop/tests/e2e/unpresented-image-look.mjs
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { launchApp, probeHome } from './harness.mjs';

const OUT = process.env.OUT ?? '/tmp/unpresented-image';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A W×H RGB PNG painted by `paint(x, y) → [r, g, b]`. No dependencies. */
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

/* The picture: the run's own (PICTURE=…, the woven disc the 12B was given), or
   a stand-in — a pale disc of thin radial spokes on white, the same idea. */
const home = probeHome('unpresented-image');
const dir = path.join(
  home,
  'Bobble',
  'generated',
  'a-high-quality-educational-3d-illustration-showi',
);
mkdirSync(dir, { recursive: true });
const PIC = path.join(dir, 'cand0_seed259687452.png');
if (process.env.PICTURE !== undefined && existsSync(process.env.PICTURE)) {
  copyFileSync(process.env.PICTURE, PIC);
} else {
  const S = 512;
  writeFileSync(
    PIC,
    png(S, S, (x, y) => {
      const dx = x - S / 2;
      const dy = y - S / 2;
      const r = Math.hypot(dx, dy);
      if (r > S * 0.44) return [250, 250, 248];
      const spoke = Math.abs(Math.sin(Math.atan2(dy, dx) * 90)) < 0.35;
      return spoke ? [196, 188, 170] : [236, 232, 222];
    }),
  );
}

/* ── the turn, as the run had it (bash-CLI: every call is `bash`) ──────── */

const PROMPT =
  'A high-quality, educational 3D illustration showing a circle being sliced into hundreds of extremely thin, needle-like wedges';
const user = {
  kind: 'user',
  id: 'u2',
  text: 'ok i watched the page on the side. i kind of get cutting it like a pizza but the slices never actually move into the rectangle, its just a box next to the circle. how do the slices actually make a rectangle?? the edges are all curvy. can you show it with an actual picture',
  timestamp: 1,
};
const thought = (text) => ({ type: 'thinking', thinking: text });
const bash = (id, command) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
const assistant = (id, blocks, t, streaming = false) => ({
  kind: 'assistant',
  id,
  blocks,
  timestamp: t,
  ...(streaming ? { isStreaming: true } : {}),
});
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
const a1 = assistant(
  'a1',
  [
    thought(
      'The user watched the math visualization but found it lacking because the slices do not physically move into the rectangle. A picture of thin slices should help.',
    ),
    bash('c1', `media generate image "${PROMPT}"`),
  ],
  10,
);
/* The run's own result text, word for word — the old wording, which a saved
   chat still carries. */
const r1 = result(
  'c1',
  'a1',
  `Generated 1 image on the canvas:\n  1. ${PIC} (seed 259687452)\nModel: Qwen-Image 2.1 (qwen-image-2.1, apache-2.0)`,
  20,
);
const REPLY =
  'That is a great question. The "curvy" part is actually the most important part of the math! The thinner the slices, the straighter those curvy edges get — with hundreds of slices, the top and bottom of the shape are almost perfectly flat, and it becomes a rectangle with height $r$ and width $\\pi r$.';
/* The chain goes on after the picture (the run drew a flowchart next). */
const a2 = assistant(
  'a2',
  [thought('I have the image of the thin slices.'), bash('c2', 'ls visualizations')],
  25,
);
const r2 = result('c2', 'a2', 'circle_area.math.json\ncircle_area.html', 28);
const reply = (text, streaming) => assistant('a3', [{ type: 'text', text }], 32, streaming);

const { page, check, finish } = await launchApp('unpresented-image', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});

const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const agentStreaming = async (on) => ({
  ...(await page.evaluate(() => window.__pi_store().getState().agent)),
  isStreaming: on,
});
const shot = (label) => page.screenshot({ path: path.join(OUT, `${label}.png`) });
const toBottom = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el) el.scrollTop = el.scrollHeight;
  });
/** Every image decoded — a shot of empty frames proves nothing. */
const decoded = () =>
  page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="media-card"] img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      undefined,
      { timeout: 8000 },
    )
    .catch(() => undefined);

/**
 * Where the picture is, and whether a person could see it. Each card is
 * brought into view first, then hit-tested at its own centre.
 */
const seen = () =>
  page.evaluate(
    (replyStart) => {
      const reply = [...document.querySelectorAll('p')].find((p) =>
        (p.textContent ?? '').startsWith(replyStart),
      );
      return [...document.querySelectorAll('[data-testid="media-card"]')].map((card) => {
        card.scrollIntoView({ block: 'center' });
        const b = card.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        const folded = card.closest('.pd-chain-reveal[data-open="false"]') !== null;
        return {
          name: card.querySelector('img')?.getAttribute('alt') ?? '?',
          inChain: card.closest('.pd-chain') !== null,
          inFoot: card.closest('[data-testid="turn-foot"]') !== null,
          folded,
          box: [Math.round(b.width), Math.round(b.height)],
          visible: !folded && b.width > 40 && b.height > 40 && hit !== null && card.contains(hit),
          afterReply:
            reply === undefined
              ? null
              : (reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        };
      });
    },
    REPLY.slice(0, 30),
  );

const cdp = await page.context().newCDPSession(page);
const overview = async (label) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1500,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(700);
  await toBottom();
  await sleep(400);
  await shot(label);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await sleep(1200);

  /* ── a. the picture is made; the chain works on ── */
  await set({
    session: { cwd: home },
    agent: await agentStreaming(true),
    messages: [user, a1, r1, { ...a2, isStreaming: true }],
    runningToolCalls: ['c2'],
  });
  await decoded();
  await sleep(1500);
  await toBottom();
  await sleep(300);
  const a = await seen();
  console.log('chain working:', JSON.stringify(a));
  await shot('a-chain-working');
  check(a.length === 1, `one card for the one picture while the chain works (${a.length})`);
  check(
    a[0]?.inChain === true && a[0]?.visible === true,
    `while its chain works, the picture is in the chain row, and visible there (${JSON.stringify(a[0])})`,
  );

  /* ── b. the reply begins: the chain folds ── */
  await set({
    messages: [user, a1, r1, a2, r2, reply(REPLY.slice(0, 120), true)],
    runningToolCalls: [],
  });
  await sleep(1500);
  await decoded();
  await toBottom();
  await sleep(300);
  const b = await seen();
  console.log('reply streaming:', JSON.stringify(b));
  await shot('b-reply-streaming');
  check(
    b.length === 1 && b[0]?.visible === true && b[0]?.inChain === false,
    `once its chain is done, the picture is out of the folded chain and visible (${JSON.stringify(b)})`,
  );

  /* ── c. the turn ends ── */
  await set({
    agent: await agentStreaming(false),
    messages: [user, a1, r1, a2, r2, reply(REPLY, false)],
    runningToolCalls: [],
  });
  await sleep(1500);
  await decoded();
  await toBottom();
  await sleep(300);
  const c = await seen();
  console.log('turn ended:', JSON.stringify(c));
  await shot('c-turn-ended');
  check(c.length === 1, `one card for the one picture (${c.length})`);
  check(
    c[0]?.visible === true && c[0]?.inFoot === true && c[0]?.afterReply === true,
    `the finished picture stands at the reply's foot, after its words, visible (${JSON.stringify(c[0])})`,
  );
  check(
    (await page.getAttribute('.pd-chain', 'data-expanded')) === 'false',
    'the chain folds when the turn is done',
  );
  await overview('d-overview');
} finally {
  const ok = await finish();
  console.log(`unpresented-image: shots in ${OUT}`);
  if (!ok) process.exitCode = 1;
}
