/**
 * A PICTURE THE MODEL PRESENTS AND ALSO EMBEDS IN ITS REPLY — once, or twice?
 *
 * STATUS (thread track): "a picture the model also embeds in its reply shows
 * twice". The prompt tells the model to `present` whatever it makes (the full
 * card, beneath the chain), and a model that has just made a picture also
 * writes it into its reply as `![…](path)` (markdown.tsx: "every one of them
 * does") — so the answer showed the same picture twice, one above the other.
 *
 * Staged with no model: a generate_image call, its result, a `present` of the
 * file and a reply embedding it, by its absolute path (A), relative to the
 * working folder (B), and as the app's pd-file:// URL (C). Counted: the
 * pictures of that file on screen OUTSIDE the chain (the chain's own small copy
 * of a draft is the work, and folds away). D: a picture the model did NOT
 * present is still shown once — since 2026-10-02 as its card at the reply's
 * foot (turn-cards.ts: what a call made comes out when its chain is done; the
 * student's "theres no picture in the chat"), the reply's own copy stepping
 * aside as it does for a presented one.
 *
 *   OUT=<dir> node apps/desktop/tests/e2e/reply-embed-look.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';
import { cropPng, eveningPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = probeHome('reply-embed');
const dir = path.join(home, 'Bobble', 'generated', 'evening-fox');
mkdirSync(dir, { recursive: true });
const FOX = path.join(dir, 'fox.png');
writeFileSync(FOX, eveningPng(512, 384));
const OWL = path.join(dir, 'owl.png');
writeFileSync(OWL, eveningPng(384, 384));

const { page, check, finish, shotDir } = await launchApp('reply-embed', {
  env: { HOME: home, PI_E2E_NO_SERVER: '1' },
  waitFor: '[data-testid="composer-input"]',
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);

const user = (text) => ({ kind: 'user', id: 'u1', text, timestamp: 1 });
const gen = (file) => [
  {
    kind: 'assistant',
    id: 'a1',
    blocks: [
      { type: 'thinking', thinking: 'Make the picture.' },
      {
        type: 'toolCall',
        id: 'g1',
        name: 'generate_image',
        arguments: { prompt: 'a fox at dusk' },
      },
    ],
    timestamp: 10,
  },
  {
    kind: 'toolResult',
    id: 'tr-a1-g1',
    toolCallId: 'g1',
    assistantId: 'a1',
    toolName: 'generate_image',
    text: `pd-file://f${file}\nImage saved at ${file}`,
    isError: false,
    timestamp: 20,
  },
];
const present = (file) => [
  {
    kind: 'assistant',
    id: 'a2',
    blocks: [{ type: 'toolCall', id: 'p1', name: 'present', arguments: { path: file } }],
    timestamp: 30,
  },
  {
    kind: 'toolResult',
    id: 'tr-a2-p1',
    toolCallId: 'p1',
    assistantId: 'a2',
    toolName: 'present',
    text: `Presented ${file} to the user. Preview: an image.`,
    isError: false,
    timestamp: 35,
  },
];
const reply = (embed) => ({
  kind: 'assistant',
  id: 'a3',
  blocks: [
    {
      type: 'text',
      text: `Here is your picture:\n\n![A fox at dusk](${embed})\n\nThe light is low and warm.`,
    },
  ],
  timestamp: 40,
});

/** Pictures of `file` on screen: in the chain, and outside it. */
const copies = (file) =>
  page.evaluate((file) => {
    const enc = file
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const imgs = [...document.querySelectorAll('[data-testid="chat-scroll"] img')].filter((img) => {
      const src = decodeURIComponent(img.getAttribute('src') ?? '');
      return src.includes(file) || (img.getAttribute('src') ?? '').includes(enc);
    });
    const outside = imgs.filter((i) => i.closest('.pd-chain') === null);
    return {
      inChain: imgs.length - outside.length,
      outside: outside.length,
      kinds: outside.map((i) => (i.classList.contains('pd-md-image') ? 'reply-embed' : 'card')),
    };
  }, file);
const shot = async (label) => {
  const buf = await page.screenshot();
  writeFileSync(path.join(OUT, `${label}.png`), buf);
  const box = await page.locator('[data-testid="chat-scroll"]').boundingBox();
  if (box === null) return;
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  writeFileSync(
    path.join(OUT, `${label}-column.png`),
    cropPng(buf, {
      x: Math.round(box.x * dpr),
      y: Math.round(box.y * dpr),
      width: Math.round(box.width * dpr),
      height: Math.round(box.height * dpr),
    }),
  );
};

async function stage(label, file, embed, { presented }) {
  await page.evaluate(() => window.__present_store().setState({ byChat: {} }));
  await set({ messages: [], agent: { isStreaming: false } });
  await sleep(300);
  if (presented) {
    await page.evaluate(
      (p) => window.__present_store().getState().add({ path: p, chat: '', afterMessageId: 'a2' }),
      file,
    );
  }
  await set({
    session: { cwd: dir },
    agent: {
      ...(await page.evaluate(() => window.__pi_store().getState().agent)),
      isStreaming: false,
    },
    messages: [
      user('Make me a fox at dusk.'),
      ...gen(file),
      ...(presented ? present(file) : []),
      reply(embed),
    ],
    runningToolCalls: [],
  });
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="chat-scroll"] img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      undefined,
      { timeout: 8000 },
    )
    .catch(() => undefined);
  await sleep(1200);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-scroll"]');
    if (el) el.scrollTop = el.scrollHeight;
  });
  await sleep(400);
  const c = await copies(file);
  await shot(label);
  console.log(`${label}:`, JSON.stringify(c));
  return c;
}

try {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 20000 });
  await page.evaluate(() => {
    window.__pi_theme?.()?.setFlavor?.('bobble');
    window.__pi_theme?.()?.setMode?.('dark');
  });
  await sleep(1000);

  const a = await stage('a-absolute', FOX, FOX, { presented: true });
  check(
    a.outside === 1,
    `A: the presented picture shows once outside the chain (${JSON.stringify(a)})`,
  );
  const b = await stage('b-relative', FOX, 'fox.png', { presented: true });
  check(
    b.outside === 1,
    `B: …also when the reply names it relative to the folder (${JSON.stringify(b)})`,
  );
  const c = await stage('c-pd-file', FOX, `pd-file://f${FOX}`, { presented: true });
  check(c.outside === 1, `C: …and by the app's own URL (${JSON.stringify(c)})`);
  const d = await stage('d-not-presented', OWL, OWL, { presented: false });
  check(
    d.outside === 1 && d.kinds[0] === 'card',
    `D: a picture that was not presented shows once, as its card (${JSON.stringify(d)})`,
  );
} finally {
  await finish();
}
