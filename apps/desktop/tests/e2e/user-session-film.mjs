/**
 * DRIVE THE APP LIKE A PERSON, AND FILM IT AT 2fps.
 *
 * A generalisation of cold-start-film-probe, for handing to someone (or some
 * agent) whose job is to judge the EXPERIENCE rather than to write Playwright.
 * It takes a script of things a user does, performs them against the real app
 * with the real engine, photographs every 500ms throughout, and writes a
 * timeline that can be read without opening a single frame.
 *
 * The point of filming rather than screenshotting at the end: almost everything
 * wrong with a chat app is temporal. A control that is enabled a second too
 * early, a label that lies for ten seconds, a spinner that stops while work
 * continues, an answer that appears in two jumps — none of it survives into a
 * final screenshot, and all of it is what makes an app feel unfinished.
 *
 *   SCRIPT=<file.json>   the steps (see below); default: one hello
 *   OUT=<dir>            frames + timeline
 *   MODEL=<id>           pin a model instead of letting Auto choose
 *   COLD=1               do not wait for the model — type immediately (default)
 *
 * A step is one of:
 *   { "say": "text" }                  type it and press enter
 *   { "waitForReply": 180000 }         until the turn stops streaming
 *   { "click": "css-or-testid" }       click something
 *   { "wait": 3000 }                   just watch
 *   { "note": "..." }                  a marker in the timeline
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp } from './harness.mjs';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'user-session-film');
const FRAMES = path.join(OUT, 'frames');
mkdirSync(FRAMES, { recursive: true });
const script = process.env.SCRIPT
  ? JSON.parse(readFileSync(process.env.SCRIPT, 'utf8'))
  : [{ say: 'hello, what can you do?' }, { waitForReply: 180_000 }];

const { page, finish } = await launchApp('user-session-film', {
  env: { PI_BIN: undefined },
  realCache: true,
  timeout: 120_000,
});

const started = Date.now();
const film = [];
let frame = 0;
let filming = true;

const state = () =>
  page.evaluate(() => {
    const pi = window.__pi_store().getState();
    const llm = window.__llm_store?.().getState?.();
    const txt = (s) => {
      const el = document.querySelector(s);
      return el === null ? null : (el.textContent ?? '').trim().slice(0, 90);
    };
    const last = pi.messages[pi.messages.length - 1];
    return {
      phase: llm?.status?.phase ?? null,
      model: llm?.status?.model?.id ?? null,
      streaming: pi.agent?.isStreaming === true,
      messages: pi.messages.length,
      kinds: pi.messages.slice(-4).map((m) => m.kind),
      chars:
        last?.kind === 'assistant'
          ? (last.blocks ?? []).reduce((n, b) => n + ((b.text ?? b.thinking ?? '') || '').length, 0)
          : 0,
      status: txt('.pd-working-label'),
      activity: txt('.pd-chain-step'),
      toast: txt('.pd-toast'),
      dialog: document.querySelector('[role="dialog"]')?.getAttribute('data-testid') ?? null,
      placeholder:
        document
          .querySelector('[data-testid="composer-input"]')
          ?.getAttribute('data-placeholder') ?? null,
      composerTop: Math.round(
        document.querySelector('.pd-composer')?.getBoundingClientRect().top ?? -1,
      ),
    };
  });

/** Film in the background so the steps and the camera do not block each other. */
const camera = (async () => {
  while (filming) {
    const at = Date.now() - started;
    try {
      const s = await state();
      const file = path.join(
        FRAMES,
        `${String(frame).padStart(4, '0')}-${String(at).padStart(7, '0')}ms.png`,
      );
      await page.screenshot({ path: file });
      film.push({ frame, at, file: path.basename(file), ...s });
      frame += 1;
    } catch {
      /* a frame we could not take is not worth ending the session over */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
})();

const mark = (note) => film.push({ frame: -1, at: Date.now() - started, note });

for (const step of script) {
  if (typeof step.note === 'string') {
    mark(`— ${step.note}`);
    continue;
  }
  if (typeof step.say === 'string') {
    mark(`USER SAYS: ${step.say}`);
    await page.click('[data-testid="composer-input"]');
    await page.keyboard.type(step.say);
    await page.keyboard.press('Enter');
    continue;
  }
  if (typeof step.click === 'string') {
    mark(`USER CLICKS: ${step.click}`);
    await page.click(step.click).catch(() => mark(`  (could not click ${step.click})`));
    continue;
  }
  if (typeof step.wait === 'number') {
    await page.waitForTimeout(step.wait);
    continue;
  }
  if (typeof step.waitForReply === 'number') {
    const before = Date.now();
    await page
      .waitForFunction(() => window.__pi_store().getState().agent?.isStreaming === true, null, {
        timeout: 60_000,
      })
      .catch(() => mark('  (the turn never started streaming)'));
    await page
      .waitForFunction(() => window.__pi_store().getState().agent?.isStreaming !== true, null, {
        timeout: step.waitForReply,
      })
      .catch(() => mark(`  (still going after ${step.waitForReply}ms)`));
    mark(`  reply took ${((Date.now() - before) / 1000).toFixed(1)}s`);
  }
}

filming = false;
await camera;

/*
 * THE TIMELINE, which is the artefact. Only rows where something CHANGED, so a
 * ten-minute session reads as a page rather than as 1,200 identical lines.
 */
const key = (f) =>
  JSON.stringify([
    f.phase,
    f.model,
    f.streaming,
    f.messages,
    f.status,
    f.activity,
    f.toast,
    f.dialog,
    f.placeholder,
    f.composerTop,
    f.chars > 0,
  ]);
const lines = [`# what the user saw — ${new Date().toISOString()}`, ''];
let prev = null;
for (const f of film) {
  if (f.note !== undefined) {
    lines.push(`\n**${String(f.at / 1000).padStart(6)}s  ${f.note}**`);
    prev = null;
    continue;
  }
  const k = key(f);
  if (k === prev) continue;
  prev = k;
  lines.push(
    `${String(f.at / 1000).padStart(7)}s  ${f.file}  msgs=${f.messages} chars=${f.chars} streaming=${f.streaming}` +
      `${f.status ? ` | status: "${f.status}"` : ''}` +
      `${f.activity ? ` | activity: "${f.activity}"` : ''}` +
      `${f.toast ? ` | TOAST: "${f.toast}"` : ''}` +
      `${f.dialog ? ` | DIALOG: ${f.dialog}` : ''}` +
      `${f.placeholder ? ` | box: "${f.placeholder}"` : ''}`,
  );
}
const total = film.filter((f) => f.frame >= 0).length;
lines.push(
  '',
  `${total} frames at 2fps over ${((Date.now() - started) / 1000).toFixed(1)}s`,
  `frames: ${FRAMES}`,
);
writeFileSync(path.join(OUT, 'timeline.md'), `${lines.join('\n')}\n`);
writeFileSync(path.join(OUT, 'film.json'), `${JSON.stringify(film, null, 2)}\n`);
console.log(lines.join('\n'));
await finish();
