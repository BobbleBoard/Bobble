/**
 * ⌘Z INTO A TURN THAT IS ALREADY ANSWERING — against the REAL pi.
 *
 * unsend-probe.mjs drives mock-pi, whose abort is a scripted three-event exit
 * and which keeps no session of its own. Two things it could not see (STATUS,
 * from the thread track):
 *
 *   C3  ⌘Z into a turn that is already producing output aborts it but keeps
 *       the partial reply;
 *   C4  a message that is only a picture cannot be rewound out of pi's session
 *       (pi's fork list skips a user message with no text).
 *
 * So this runs the real pi, the real harness and provider and real session
 * files, with only the model scripted (_mock-openai): every reply streams for
 * seconds, so the ⌘Z lands while text is arriving. What pi still holds is read
 * off the NEXT request it sends the model — its actual context — not guessed
 * from the thread: the user messages in it, and any trace of the partial reply.
 *
 *   C3a  the chat's first message
 *   C3b  a later message, after a finished exchange
 *   C4a  a later message that is only a pasted picture (saved, so it is named)
 *   C4b  the same, with the picture's save refused in main — the one way a
 *        picture still reaches pi with no text at all
 *
 * `API=mlx-stream` routes the same turns through the MLX provider (rapid-mlx,
 * the 4B's default engine) instead of llama.cpp's; `CASES=c3a,c3b` runs a subset.
 *
 *   OUT=<dir> node apps/desktop/tests/e2e/unsend-real-pi-probe.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { contentText, startMockOpenAI, writeModelsJson } from './_mock-openai.mjs';
import { launchApp, probeHome, refuseIpc } from './harness.mjs';
import { eveningPng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'mock-4b';
const API = process.env.API ?? 'llamacpp-stream';
/* The MLX provider attaches to the provider named `mlx` (provider-mlx). */
const PROVIDER = API === 'mlx-stream' ? 'mlx' : 'mock';
const CASES = new Set((process.env.CASES ?? 'c3a,c3b,c4a,c4b').split(','));
/** Every reply streams for ~9 s: text arrives within a second of the send. */
const streamed = (text) => ({ content: text.repeat(40), chunkDelayMs: 90, chunkSize: 6 });
const REPLY = {
  fox: 'Here is a careful sketch of the fox. ',
  otter: 'Otters hold hands while they sleep. ',
  badger: 'Badgers dig long tunnels called setts. ',
  picture: 'The picture shows an evening sky over hills. ',
};

const lastUserMessage = (messages) => [...messages].reverse().find((m) => m?.role === 'user');
/*
 * What the user asked, in pi's copy: its user messages minus the harness's own
 * note that a chat's folder now exists ("Working folder: … is your current
 * directory now"), which rides as a user message of its own the first time.
 */
const asksOf = (messages) =>
  messages
    .filter((m) => m?.role === 'user')
    .map((m) => contentText(m.content))
    .filter((t) => !t.startsWith('Working folder:'));
const lastAsk = (needle) => ({
  when: (ctx) => (asksOf(ctx.messages).at(-1) ?? '').includes(needle),
});

const mock = await startMockOpenAI({
  model: MODEL,
  rules: [
    { name: 'fox', match: lastAsk('tiny hat'), reply: streamed(REPLY.fox) },
    { name: 'owl', match: lastAsk('the owl'), reply: { content: 'Owls hunt at night.' } },
    { name: 'heron', match: lastAsk('the heron'), reply: { content: 'Herons wade.' } },
    { name: 'otter', match: lastAsk('the otter'), reply: streamed(REPLY.otter) },
    { name: 'wren', match: lastAsk('the wren'), reply: { content: 'Wrens are loud.' } },
    { name: 'badger', match: lastAsk('the badger'), reply: streamed(REPLY.badger) },
    { name: 'ask', match: lastAsk('colour'), reply: { content: 'Orange, near the sun.' } },
  ],
  // A picture with nothing typed has no words to match on: it is the one
  // request no rule above names.
  defaultReply: streamed(REPLY.picture),
});

const home = probeHome('unsend-real');
// Vision switched off: a picture goes to pi as it is (no model relaunch).
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ modelSelection: { mode: 'tier', tier: 'balanced' }, loadVision: false }, null, 2)}\n`,
);
writeModelsJson(home, {
  provider: PROVIDER,
  api: API,
  baseUrl: mock.baseUrl,
  model: MODEL,
  name: 'Mock 4B',
  input: ['text', 'image'],
});

const { app, page, check, finish, shotDir } = await launchApp('unsend-real', {
  env: { HOME: home, PI_BIN: undefined, PI_E2E_NO_SERVER: '1' },
  timeout: 60_000,
});
const OUT = process.env.OUT ?? shotDir;
mkdirSync(OUT, { recursive: true });
const shot = (label) => page.screenshot({ path: path.join(OUT, `${label}.png`) });

/** The thread as the store holds it: who said what, and pictures. */
const thread = () =>
  page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.map((m) => ({
        kind: m.kind,
        text:
          m.kind === 'user'
            ? m.text
            : m.kind === 'assistant'
              ? m.blocks
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('')
                  .slice(0, 60)
              : '',
        images: m.kind === 'user' ? (m.images?.length ?? 0) : 0,
      })),
  );
const idle = () =>
  page.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return !s.agent.isStreaming && !s.promptInFlight;
    },
    undefined,
    { timeout: 60_000 },
  );
const typeAndSend = async (text) => {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  return Date.now();
};
/** A picture pasted into the composer (in the page — never the system pasteboard). */
const pastePicture = async () => {
  await page.click('[data-testid="composer-input"]');
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    (
      document.activeElement ?? document.querySelector('[data-testid="composer-input"]')
    ).dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, eveningPng().toString('base64'));
  await page.waitForSelector('[data-testid="composer-attachments"]', { timeout: 8000 });
  await sleep(600);
};
/** The reply is on screen: an assistant row with this in its text. */
const answering = (needle) =>
  page.waitForFunction(
    (n) =>
      window
        .__pi_store()
        .getState()
        .messages.some(
          (m) =>
            m.kind === 'assistant' &&
            m.blocks.some((b) => b.type === 'text' && b.text.includes(n) && b.text.length > 12),
        ),
    needle,
    { timeout: 20_000, polling: 30 },
  );
/** The newest request the mock has seen, so a wait can ask for a later one. */
const lastSeq = () => mock.log.reduce((n, e) => Math.max(n, e.seq ?? 0), 0);
/** What pi sent the model for the next request rule `name` answers after `since`. */
const context = async (name, since = 0) => {
  const req = await mock.waitFor((e) => e.rule === name && e.seq > since, { timeoutMs: 60_000 });
  const msgs = req.body?.messages ?? [];
  return {
    users: asksOf(msgs).map((t) => t.slice(0, 70)),
    text: msgs.map((m) => contentText(m.content)).join('\n'),
  };
};
/** ⌘Z puts the message back in the box, pictures included: empty it. Returns
 * the chips left (0), so a follow-up never carries the picture again. */
const clearComposer = async () => {
  const x = page.locator('[data-testid="composer-attachments"] [aria-label^="Remove "]');
  for (let i = 0; i < 6 && (await x.count()) > 0; i++) {
    await x.first().click({ force: true });
    await sleep(200);
  }
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await sleep(200);
  return page.locator('[data-testid="composer-attachments"] .pd-attach').count();
};
const newChat = async () => {
  await page.click('text=New chat');
  await page.waitForFunction(
    () => window.__pi_store().getState().messages.length === 0,
    undefined,
    {
      timeout: 15_000,
    },
  );
  await sleep(800);
};

/**
 * One case: `send` starts the turn, the reply begins (`needle`), ⌘Z, and then
 * `next` is sent — whose request shows what pi still holds.
 */
async function unsendCase(label, { send, needle, next, nextRule, expectUsers }) {
  const at = await send();
  await answering(needle);
  const partialMs = Date.now() - at;
  await shot(`${label}-1-answering`);
  await page.keyboard.press('Meta+z');
  const undoMs = Date.now() - at;
  await sleep(4500);
  await shot(`${label}-2-after-undo`);
  const after = await thread();
  const restored = await page.evaluate(
    () => document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
  );
  const restoredChips = await page
    .locator('[data-testid="composer-attachments"] .pd-attach')
    .count();
  await idle();
  check(
    (await clearComposer()) === 0,
    `${label}: the composer was emptied before the next message`,
  );
  const since = lastSeq();
  await typeAndSend(next);
  const ctx = await context(nextRule, since);
  await idle();
  await sleep(600);
  await shot(`${label}-3-next-message`);
  const result = {
    partialMs,
    undoMs,
    restored,
    restoredChips,
    thread: after,
    nextUsers: ctx.users,
  };
  console.log(`${label}:`, JSON.stringify(result));
  check(undoMs < 3000, `${label}: ⌘Z landed inside the window (${undoMs} ms after sending)`);
  check(
    !after.some((m) => m.kind === 'assistant' && m.text.includes(needle)),
    `${label}: nothing of the partial reply stays in the thread (${JSON.stringify(after)})`,
  );
  check(
    ctx.users.length === expectUsers,
    `${label}: pi no longer holds the message (${ctx.users.length} user messages in its next request, want ${expectUsers}: ${JSON.stringify(ctx.users)})`,
  );
  check(!ctx.text.includes(needle), `${label}: pi no longer holds the partial reply`);
  return result;
}

const summary = {};
try {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 30_000 });
  const started = await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  check(started.pid > 0, `pi did not start: ${JSON.stringify(started)}`);
  const set = await page.evaluate(
    ([provider, m]) => window.piDesktop.invoke('pi:set-model', { provider, modelId: m }),
    [PROVIDER, MODEL],
  );
  check(set.success === true, `pi:set-model failed: ${JSON.stringify(set)}`);
  await page.waitForFunction((m) => window.__pi_store().getState().agent.model?.id === m, MODEL, {
    timeout: 20_000,
  });
  await sleep(1500);

  let since = 0;
  /* ── C3a: the chat's first message (C3b continues its chat) ────────── */
  if (CASES.has('c3a') || CASES.has('c3b')) {
    summary.c3a = await unsendCase('c3a', {
      send: () => typeAndSend('Draw a fox wearing a tiny hat'),
      needle: 'sketch of the fox',
      next: 'Tell me about the owl',
      nextRule: 'owl',
      expectUsers: 1,
    });
  }

  /* ── C3b: a later message ──────────────────────────────────────────── */
  if (CASES.has('c3b')) {
    since = lastSeq();
    await typeAndSend('And the heron?');
    await context('heron', since);
    await idle();
    summary.c3b = await unsendCase('c3b', {
      send: () => typeAndSend('Now tell me about the otter'),
      needle: 'hold hands',
      next: 'What about the wren?',
      nextRule: 'wren',
      expectUsers: 3,
    });
  }

  /* ── C4a: a later message that is only a picture, saved and named ───── */
  if (CASES.has('c4a')) {
    await newChat();
    since = lastSeq();
    await typeAndSend('Tell me about the badger');
    await answering('long tunnels');
    await context('badger', since);
    await idle();
    summary.c4a = await unsendCase('c4a', {
      send: async () => {
        await pastePicture();
        await page.keyboard.press('Enter');
        return Date.now();
      },
      needle: 'evening sky over hills',
      next: 'What colour is the sky there?',
      nextRule: 'ask',
      expectUsers: 2,
    });
  }

  /* ── C4b: the same, with the picture's save refused ────────────────── */
  if (CASES.has('c4b')) {
    await newChat();
    since = lastSeq();
    await typeAndSend('Tell me about the badger');
    await context('badger', since);
    await idle();
    const refused = await refuseIpc(app, ['attachments:save-image']);
    summary.c4b = await unsendCase('c4b', {
      send: async () => {
        await pastePicture();
        await page.keyboard.press('Enter');
        return Date.now();
      },
      needle: 'evening sky over hills',
      next: 'What colour is the sky there?',
      nextRule: 'ask',
      expectUsers: 2,
    });
    summary.c4bSaveRefused = (await refused.calls()).length;
    check(summary.c4bSaveRefused >= 1, 'C4b: the picture really had no saved file behind it');
  }
  summary.api = API;
} catch (e) {
  check(false, `probe threw: ${e instanceof Error ? e.stack : String(e)}`);
  await shot('failure').catch(() => undefined);
} finally {
  writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    path.join(OUT, 'requests.json'),
    `${JSON.stringify(
      mock.log.map((e) => ({
        seq: e.seq,
        rule: e.rule,
        lastUser: contentText(lastUserMessage(e.body?.messages ?? [])?.content).slice(0, 80),
        users: (e.body?.messages ?? []).filter((m) => m.role === 'user').length,
      })),
      null,
      2,
    )}\n`,
  );
  await mock.close();
}
await finish();
