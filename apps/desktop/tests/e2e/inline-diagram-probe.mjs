/**
 * INLINE DIAGRAMS (VQ-10) — the `diagram` command through pi's own bash, in the
 * real app, HIDDEN (PI_E2E background: never shown, never focused), with a
 * throwaway HOME. The model is only there because a card anchors to a turn (an
 * empty chat shows the greeting, not a thread): one short exchange, then the
 * commands the model would run, typed as it would type them.
 *
 *   1. the research's §2.2.3 flow (LR, two decisions, three failure paths):
 *      one call → the card in the thread, every node and branch, the kit's
 *      colours; the hidden Mermaid window never took the screen;
 *   2. the same card in the dark theme (the dark drawing, the dark paper);
 *   3. the card's corner → the canvas, full size; back;
 *   4. a sequence diagram and a top-down flow, each its own card;
 *   5. a source Mermaid cannot read → the line and the fix, nothing drawn; a
 *      label with brackets is quoted for it.
 *
 * (The guard that sends a hand-typed flow.svg to `diagram` sits on the model's
 * `write` tool call — handwritten-svg.test.ts covers it; a `file write` typed at
 * the shell is dispatched straight to the tool and never meets it.)
 *
 *   SHOT_DIR=/tmp/inline-diagram node scripts/with-lock.mjs heavy -- \
 *     node apps/desktop/tests/e2e/inline-diagram-probe.mjs
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';
import { cropPng } from './png.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/inline-diagram';
mkdirSync(SHOT_DIR, { recursive: true });

const home = probeHome('inline-diagram');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }, null, 2)}\n`,
);
const { app, page, check, finish } = await launchApp('inline-diagram', {
  realCache: true,
  env: { HOME: home, PI_BIN: undefined, HF_HOME: path.join(homedir(), '.cache', 'huggingface') },
  timeout: 120_000,
});
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const findings = [];
const note = (name, pass, detail = '') => {
  findings.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  check(pass, `${name}${detail ? ` — ${detail}` : ''}`);
};
const run = async (cmd) => {
  const t0 = Date.now();
  const r = await page.evaluate((c) => window.piDesktop.invoke('pi:bash', { command: c }), cmd);
  const out = r.result?.output ?? r.error ?? '';
  log(
    `$ ${cmd.split('\n')[0].slice(0, 80)}… (${Date.now() - t0} ms)\n  ${out.split('\n')[0].slice(0, 200)}`,
  );
  return { out, ms: Date.now() - t0 };
};
/** A card cut out of a full-page shot (an element shot re-lays an Electron page out: a flash). */
const cardShot = async (label, index = -1) => {
  const cards = await page.$$('[data-testid="presented-diagram"]');
  const card = cards.at(index);
  if (!card) return log(`no card for ${label}`);
  await card.scrollIntoViewIfNeeded();
  await sleep(300);
  const box = await card.boundingBox();
  const full = await page.screenshot();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  if (box) {
    writeFileSync(
      path.join(SHOT_DIR, `${label}.png`),
      cropPng(full, {
        x: box.x * dpr,
        y: box.y * dpr,
        width: box.width * dpr,
        height: box.height * dpr,
      }),
    );
  }
  writeFileSync(path.join(SHOT_DIR, `${label}-window.png`), full);
  log(`shot ${label}`);
};
const cards = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="presented-diagram"]')].map((c) => {
      const svg = c.querySelector('.pd-inline-widget-box svg');
      const box = svg?.getBoundingClientRect();
      return {
        kind: c.querySelector('.pd-inline-widget-kind')?.textContent ?? null,
        paper: c.style.getPropertyValue('--pd-diagram-paper'),
        texts: [...(svg?.querySelectorAll('text') ?? [])]
          .map((t) => t.textContent.trim())
          .filter(Boolean),
        width: box ? Math.round(box.width) : 0,
        height: box ? Math.round(box.height) : 0,
        fonts: [
          ...new Set(
            [...(svg?.querySelectorAll('text') ?? [])].map((t) => getComputedStyle(t).fontSize),
          ),
        ],
      };
    }),
  );

const FLOW = `flowchart LR
  A([Order placed]) --> B{Payment ok?}
  B -- yes --> C[Pick & pack]
  B -- no --> E[Email customer]
  E -. retry .-> B
  C --> D{Quality ok?}
  D -- no, repack --> C
  D -- yes --> F[Ship] --> G[Delivered] --> H([Review request])`;

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 300_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  await sleep(3000);
  // A card anchors to a turn: one short exchange first.
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.insertText('Reply with just the word ready.');
  await page.keyboard.press('Enter');
  await page
    .waitForFunction(
      () => {
        const s = window.__pi_store().getState();
        const replied = s.messages.some(
          (x) => x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
        );
        return replied && !s.messages.some((x) => x.isStreaming) && s.promptInFlight !== true;
      },
      undefined,
      { timeout: 180_000, polling: 500 },
    )
    .catch(() => {});
  await sleep(1000);
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'light');
    document.documentElement.style.colorScheme = 'light';
  });

  // ── 1. the flow, one call ────────────────────────────────────────────────
  const tools = await run('tools');
  note('`diagram` is a command on PATH', /^\s+diagram\s+/m.test(tools.out), '');
  const help = await run('diagram --help');
  note(
    '`diagram --help` explains the command',
    /Mermaid/.test(help.out) && /diagram edit/.test(help.out),
    help.out.split('\n')[0],
  );
  const first = await run(
    `diagram "Order fulfilment" --subtitle "Checkout to review request" --source '${FLOW}'`,
  );
  note(
    'one call drew every node, edge and branch',
    /Drew a flowchart "Order fulfilment" — 8 steps \(2 decisions\), 9 connections, 5 labelled/.test(
      first.out,
    ),
    first.out.split('\n')[0].slice(0, 200),
  );
  await page
    .waitForSelector('[data-testid="presented-diagram"] svg text', { timeout: 20_000 })
    .catch(() => {});
  await sleep(800);
  let c = await cards();
  const labels = [
    'Order placed',
    'Payment ok?',
    'Pick & pack',
    'Email customer',
    'Quality ok?',
    'Ship',
    'Delivered',
    'Review request',
    'yes',
    'no',
    'retry',
    'no, repack',
  ];
  note(
    'the card in the thread shows every step and every branch label',
    c.length === 1 && labels.every((l) => c[0].texts.includes(l)),
    JSON.stringify({
      cards: c.length,
      missing: labels.filter((l) => !c[0]?.texts.includes(l)),
      kind: c[0]?.kind,
    }),
  );
  note('the card is on the kit’s paper (light)', c[0]?.paper === '#FBFAF7', c[0]?.paper ?? '');
  note(
    'the canvas did not open on its own',
    (await page.evaluate(() => window.__pi_canvas?.()?.getState?.().tabs.length ?? 0)) === 0,
    '',
  );
  await cardShot('01-flow-light');

  // ── 2. dark ──────────────────────────────────────────────────────────────
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  });
  await sleep(600);
  c = await cards();
  note(
    'dark theme: the dark drawing on the dark paper',
    c[0]?.paper === '#191816',
    c[0]?.paper ?? '',
  );
  await cardShot('02-flow-dark');

  // ── 3. the canvas and back ───────────────────────────────────────────────
  await page.evaluate(() =>
    document.querySelector('[data-testid="presented-diagram"] .pd-inline-widget-move')?.click(),
  );
  await sleep(1200);
  const tabs = await page.evaluate(() =>
    (window.__pi_canvas?.()?.getState?.().tabs ?? []).map((t) => ({
      kind: t.kind,
      title: t.title,
      inline: t.inline === true,
    })),
  );
  note(
    'Open in canvas lifts it into an svg tab, and the card steps out',
    tabs.some((t) => t.kind === 'svg' && t.title === 'Order fulfilment' && t.inline) &&
      (await cards()).length === 0,
    JSON.stringify(tabs),
  );
  const inCanvas = await page.evaluate(() => {
    const svg = document.querySelector('.pd-canvas-svg svg.pd-diagram');
    if (!svg) return null;
    return {
      drawn: Math.round(svg.getBoundingClientRect().width),
      own: Number(svg.getAttribute('width')),
      scrolls: svg.parentElement
        ? svg.parentElement.scrollWidth > svg.parentElement.clientWidth
        : false,
    };
  });
  note(
    'the canvas shows the diagram at its own size (it scrolls when wider than the pane)',
    inCanvas !== null && Math.abs(inCanvas.drawn - inCanvas.own) <= 1,
    JSON.stringify(inCanvas),
  );
  await page.screenshot({ path: path.join(SHOT_DIR, '03-canvas-dark.png') });
  await page.evaluate(() => document.querySelector('.pd-canvas-show-inline')?.click());
  await sleep(1000);
  note('Show in chat brings the card back', (await cards()).length === 1, '');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-mode', 'light');
    document.documentElement.style.colorScheme = 'light';
  });
  await sleep(400);

  // ── 4. other kinds, other directions ─────────────────────────────────────
  const seq = await run(`diagram "Checkout" --source 'sequenceDiagram
  participant C as Customer
  participant S as Store
  participant P as Payments
  C->>S: Place order
  S->>P: Charge card
  P-->>S: Approved
  S-->>C: Confirmation email'`);
  note(
    'a sequence diagram draws',
    /Drew a sequence diagram "Checkout"/.test(seq.out),
    seq.out.split('\n')[0].slice(0, 160),
  );
  const td = await run(`diagram "Support ticket" --source 'flowchart TD
  A([Ticket opened]) --> B{Known issue?}
  B -- yes --> C[Send the fix]
  B -- no --> D[Escalate to engineering]
  D --> E[Fix shipped] --> C
  C --> F([Closed])'`);
  note(
    'a top-down flow draws',
    /Drew a flowchart "Support ticket" — 6 steps/.test(td.out),
    td.out.split('\n')[0].slice(0, 160),
  );
  await sleep(1200);
  c = await cards();
  note(
    'each diagram is its own card',
    c.length === 3,
    JSON.stringify(c.map((x) => [x.kind, x.width, x.height])),
  );
  await cardShot('04-sequence-light', 1);
  await cardShot('05-td-light', 2);

  // ── 5. a line Mermaid cannot read ────────────────────────────────────────
  const broken = await run(`diagram "Broken" --source 'flowchart TD
  A[Start] --> B{Paid?}
  B -- no --> end
  end --> C'`);
  note(
    'a parse error names the line and the fix, and draws nothing',
    /Mermaid could not read line \d+/.test(broken.out) &&
      /Fix: /.test(broken.out) &&
      (await cards()).length === 3,
    broken.out.split('\n').slice(0, 2).join(' | '),
  );
  const repaired = await run(`diagram "Packing" --source 'flowchart LR
  A[Pick (and pack)] --> B[Ship (tracked)]'`);
  note(
    'a label with brackets is quoted for it, and it says so',
    /Put quotes round 2 labels/.test(repaired.out),
    repaired.out.split('\n').slice(0, 2).join(' | '),
  );

  // ── 6. the same flow top-down, as the guidance asks for in the chat ──────
  const tdFlow = await run(
    `diagram "Order fulfilment, top-down" --source '${FLOW.replace('flowchart LR', 'flowchart TD')}'`,
  );
  note(
    'the research flow top-down draws',
    /Drew a flowchart "Order fulfilment, top-down" — 8 steps/.test(tdFlow.out),
    tdFlow.out.split('\n')[0].slice(0, 160),
  );
  await sleep(1200);
  const tall = await page.evaluate(() => {
    const cardsNow = [...document.querySelectorAll('[data-testid="presented-diagram"]')];
    const last = cardsNow.at(-1);
    const svg = last?.querySelector('.pd-inline-widget-box svg');
    const box = svg?.getBoundingClientRect();
    // Words only: an empty <text> (an edge with no label) measures 0.
    const labels = [...(svg?.querySelectorAll('text') ?? [])]
      .filter((t) => (t.textContent ?? '').trim() !== '')
      .map((t) => t.getBoundingClientRect().height);
    return {
      overflowing: last?.querySelector('.pd-inline-widget')?.hasAttribute('data-overflowing'),
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      smallestLabelPx: labels.length ? Math.round(Math.min(...labels)) : 0,
    };
  });
  note(
    'a top-down flow shows whole at full size (no fade, labels at their own size)',
    tall.overflowing !== true && tall.smallestLabelPx >= 14,
    JSON.stringify(tall),
  );
  // The card is taller than the 940 px window's thread: grow the (hidden)
  // window for the shot — the crop comes from a viewport screenshot.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      /index\.html|localhost/.test(w.webContents.getURL()),
    );
    win?.setContentSize(1440, 1500);
  });
  await sleep(800);
  await cardShot('06-flow-td-light', -1);

  // The render time, from the app's own log.
  writeFileSync(path.join(SHOT_DIR, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
} finally {
  await finish();
  rmSync(home, { recursive: true, force: true });
}
