/**
 * WHAT THE MODEL CAN MAKE, LOOKED AT — one fresh chat per request, real model.
 *
 * the user (2026-09-24): "start working on the visuals (high priority) the model can
 * produce, websites, pptx, docx, slides, all sorts types of data visuals, images
 * (… observe+ improve loop ensurance), svg icons and artwork, UI, really clean,
 * intuitive interactive widgets inline/+canvas, eg. for math explanation NN
 * inner working visualizaitons. source citing … along with mixes and matches of
 * all of these … verify each of these with a generation of it's type you are
 * proud of … don't overfit to tasks though, this is still a general purpouse
 * tool, if the user asks to draft a quick email it should obviously never be
 * generating a powerpoint … measure prefill and look at the ui via headless
 * testing screenshots at evals".
 *
 * So each task is a request a person would type — no tool names, no hints — and
 * the probe records what a person would see and what it cost:
 *   - the chat at the end of the turn (and the canvas, when something opened),
 *     screenshotted hidden, light;
 *   - every tool call and whether it failed, the files that landed, the cards
 *     presented, the reply;
 *   - per request, the engine's own prompt accounting: tokens, how many it had
 *     to compute, the time to the first token (the rapid-mlx / llama-server
 *     lines in the app's log).
 * The artefacts are copied beside the shots so they can be rendered and judged.
 * The `email` task is the control: plain text, no artefact.
 *
 *   MODEL=qwen3.5-9b-mtp TASKS=website,email SHOT_DIR=<dir> \
 *     node scripts/with-lock.mjs heavy -- node apps/desktop/tests/e2e/visual-suite-probe.mjs
 *
 * Results: <SHOT_DIR>/results.md, <SHOT_DIR>/<task>/{chat.png,canvas.png,task.json,files/}.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-9b-mtp';
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/visual-suite';
const TURN_CAP_MS = Number(process.env.TURN_CAP_S ?? 480) * 1000;
mkdirSync(SHOT_DIR, { recursive: true });
const LOG = path.join(SHOT_DIR, 'app.log');

/** The requests, as a person would type them. `kind` groups them in the report. */
const TASKS = [
  {
    id: 'website',
    kind: 'website',
    prompt:
      'Design a landing page for Kiln & Co, a small ceramics studio in Portland: a big hero photo, a gallery of their work, a weekly class schedule and a contact section. Make it feel premium and show it to me.',
  },
  {
    id: 'nn-widget',
    kind: 'widget',
    prompt:
      "Build me an interactive widget that shows how a small neural network's forward pass works — a 2-3-1 network where I can drag the two input values and watch the activations flow through the layers.",
  },
  {
    id: 'fourier',
    kind: 'math',
    prompt:
      'Explain intuitively how a Fourier series builds a square wave, with an interactive visual where I add terms with a slider and watch the approximation improve.',
  },
  {
    id: 'dataviz',
    kind: 'dataviz',
    prompt:
      'Here is our website traffic by channel for the last six months (thousands of visits, April to September). Organic: 12, 14, 15, 17, 21, 24. Paid: 8, 9, 7, 10, 12, 11. Social: 3, 4, 6, 5, 7, 9. Show me the trend and how the channel mix changed.',
  },
  {
    id: 'icons',
    kind: 'svg',
    prompt:
      'Make me a set of six matching line icons for a recipe app: timer, servings, difficulty, vegetarian, favourite and shopping list.',
  },
  {
    id: 'svg-art',
    kind: 'svg',
    prompt: 'Create an SVG illustration of a lighthouse at sunset for my blog header.',
  },
  {
    id: 'image',
    kind: 'image',
    prompt:
      'Generate a photo of a cozy reading nook: a window seat with rain on the glass, a knitted blanket, a stack of books and warm lamp light.',
  },
  {
    id: 'deck',
    kind: 'pptx',
    prompt:
      'Make an 8-slide deck pitching a community solar co-op to our city council. We have 312 member households, want to put 1.4 MW on the old landfill, and expect bills to drop 18% in year one. Include a chart, a diagram of how the co-op works and a strong ask at the end.',
  },
  {
    id: 'report',
    kind: 'docx',
    prompt:
      'Write a two-page brief as a Word document on where solid-state batteries stand in 2026 — who is closest to production and what is still hard — with sources.',
  },
  {
    id: 'budget',
    kind: 'xlsx',
    prompt:
      'Set up a spreadsheet for my monthly budget: income, fixed costs, variable costs by category, totals, what is left over, and a chart of where the money goes.',
  },
  {
    id: 'research',
    kind: 'sources',
    prompt:
      "What's the latest on the fruit fly brain connectome? Give me a short summary with sources.",
  },
  {
    id: 'intro-anim',
    kind: 'animation',
    prompt:
      "Make a 6-second animated intro for my YouTube channel 'Byte Sized' — playful, with the title bouncing in.",
  },
  {
    id: 'math-anim',
    kind: 'math-animation',
    prompt:
      'Make a short animation that shows why the Pythagorean theorem is true by rearranging four triangles inside a square.',
  },
  {
    id: 'game-asset',
    kind: '3d',
    prompt:
      'Make a stylized low-poly treasure chest 3D model for my game, with clean game-ready topology.',
  },
  {
    id: 'email',
    kind: 'control',
    prompt: 'Draft a quick email to my landlord asking when the heating repair is scheduled.',
  },
  /*
   * STEM PRACTICE PROBLEMS (the user, 2026-09-25): "test some math/physics/
   * chemistry... practice problem requests, this falls into visual aswell …
   * having diagrams/visuals and animating them cleanly to go along with an
   * explanation when informative". The figure is a stand-in drawn after the
   * kinetic-theory "Fig. 3.1" he sent (fixtures/stem/fig31.png), attached the
   * way a paste attaches it.
   */
  {
    id: 'physics-fig',
    kind: 'stem',
    attach: 'fixtures/stem/fig31.png',
    prompt:
      'This is from my A-level physics practice paper (Fig. 3.1). A molecule of mass m moves with speed u inside a cube of side L, at right angles to the shaded face. Show that the average force it exerts on the shaded face is mu²/L, then help me understand how that leads to pV = ⅓Nm<c²>.',
  },
  {
    id: 'chem-stoich',
    kind: 'stem',
    prompt:
      "I'm revising for chemistry: 2.4 g of magnesium reacts with excess hydrochloric acid. Calculate the volume of hydrogen gas produced at room temperature and pressure, and explain each step.",
  },
  {
    id: 'math-practice',
    kind: 'stem',
    prompt:
      'Give me 3 practice problems on completing the square, with worked solutions I can check after I have tried them.',
  },
  {
    id: 'shm-anim',
    kind: 'stem',
    prompt:
      'Explain simple harmonic motion to me, with an animation of a mass on a spring next to its displacement–time graph.',
  },
  {
    id: 'calc-visual',
    kind: 'stem',
    prompt: 'Why is the derivative of sin x equal to cos x? Explain it visually.',
  },
];
const WANT = new Set((process.env.TASKS ?? TASKS.map((t) => t.id).join(',')).split(','));

const home = probeHome('visual-suite');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    {
      userMode: 'power',
      modelSelection: { mode: 'model', modelId: MODEL },
      ...(process.env.EXTRA_SETTINGS ? JSON.parse(process.env.EXTRA_SETTINGS) : {}),
    },
    null,
    2,
  )}\n`,
);
const { app, page, check, finish } = await launchApp('visual-suite', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_DESKTOP_GEN: '1',
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
for (const s of [app.process().stderr, app.process().stdout])
  s?.on('data', (c) => appendFileSync(LOG, c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Everything under a folder, relative, newest last. */
function filesUnder(root, rel = '', out = []) {
  let names = [];
  try {
    names = readdirSync(path.join(root, rel));
  } catch {
    return out;
  }
  for (const n of names) {
    if (n.startsWith('.') || n === 'node_modules') continue;
    const r = path.join(rel, n);
    const st = statSync(path.join(root, r));
    if (st.isDirectory()) filesUnder(root, r, out);
    else out.push({ rel: r, bytes: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** The engine's own accounting for every request since `from` bytes into the log. */
function prefillSince(from) {
  let text = '';
  try {
    text = readFileSync(LOG, 'utf8').slice(from);
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    // rapid-mlx: [mllm_apc] request=… HIT prompt_tokens=3495 cached=3377 remaining=118
    const a = /prompt_tokens=(\d+) cached=(\d+) remaining=(\d+)/.exec(line);
    if (a) rows.push({ prompt: Number(a[1]), cached: Number(a[2]), computed: Number(a[3]) });
    // llama-server: prompt eval time = 812.3 ms / 1203 tokens … and the slot's n_past
    const b = /prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens/.exec(line);
    if (b) rows.push({ computed: Number(b[2]), ms: Number(b[1]) });
  }
  return rows;
}

const rows = [];
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  log(`waiting for ${MODEL}…`);
  await page.waitForFunction(
    (m) =>
      window.__llm_store?.().getState().status.model?.id === m &&
      window.__llm_store().getState().status.phase === 'ready',
    MODEL,
    { timeout: 600_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 180_000 },
  );
  // A hidden file input the attach step fills through CDP (attach-anything-probe's way).
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'probe-files';
    input.style.display = 'none';
    document.body.appendChild(input);
  });
  const profile = await page.evaluate(() => window.__llm_store().getState().status.profile);
  log(`model up: ${MODEL} on ${JSON.stringify(profile)}`);
  await sleep(8000);

  for (const task of TASKS) {
    if (!WANT.has(task.id)) continue;
    const dir = path.join(SHOT_DIR, task.id);
    mkdirSync(path.join(dir, 'files'), { recursive: true });
    log(`── ${task.id}: ${task.prompt.slice(0, 90)}…`);
    await page.click('[data-testid="new-chat"]').catch(() => {});
    await sleep(1500);
    const logFrom = existsSync(LOG) ? statSync(LOG).size : 0;
    const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
    await page.click('[data-testid="composer-input"]');
    // A figure that comes with the question: pasted as a file, never through the clipboard.
    if (task.attach !== undefined) {
      try {
        const file = path.join(path.dirname(new URL(import.meta.url).pathname), task.attach);
        const { root } = await cdp.send('DOM.getDocument', { depth: 1 });
        const { nodeId } = await cdp.send('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: '#probe-files',
        });
        await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
        await page.evaluate(() => {
          const data = new DataTransfer();
          for (const f of document.getElementById('probe-files').files) data.items.add(f);
          const target =
            document.activeElement ?? document.querySelector('[data-testid="composer-input"]');
          target.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
        });
        await sleep(1500);
        const chips = await page.evaluate(
          () => document.querySelectorAll('[data-testid="attach-chip"]').length,
        );
        log(`   attached ${task.attach} (${chips} chip${chips === 1 ? '' : 's'})`);
      } catch (e) {
        log(`   ATTACH FAILED ${task.attach}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await page.keyboard.insertText(task.prompt);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    // First token: the first assistant row with any text or thinking.
    let ttft = null;
    const ended = await (async () => {
      const deadline = Date.now() + TURN_CAP_MS;
      while (Date.now() < deadline) {
        const s = await page.evaluate((k) => {
          const st = window.__pi_store().getState();
          const m = st.messages.slice(k);
          const said = m.some(
            (x) =>
              x.kind === 'assistant' &&
              (x.blocks ?? []).some((b) => (b.text ?? b.thinking ?? '').length > 0),
          );
          const replied = m.some(
            (x) =>
              x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
          );
          return {
            said,
            done: replied && !st.messages.some((x) => x.isStreaming) && st.promptInFlight !== true,
          };
        }, n);
        if (ttft === null && s.said) ttft = Date.now() - t0;
        if (s.done) return true;
        await sleep(1000);
      }
      return false;
    })();
    await sleep(8000); // a present, a nudge, a follow-up
    const secs = Math.round((Date.now() - t0) / 1000);
    /* A TURN THAT HIT THE CAP IS STOPPED before the next task. MEASURED (the
       first run): a website turn still working at 15 minutes kept pi busy, so
       every later request queued behind it and seven tasks recorded nothing. */
    if (!ended) {
      await page.evaluate(() => window.__pi_abort?.()).catch(() => {});
      await page
        .waitForFunction(
          () => {
            const st = window.__pi_store().getState();
            return !st.messages.some((x) => x.isStreaming) && st.promptInFlight !== true;
          },
          undefined,
          { timeout: 60_000, polling: 500 },
        )
        .catch(() => {});
      await sleep(2000);
    }
    const tail = await page.evaluate((k) => {
      const s = window.__pi_store().getState();
      const m = s.messages.slice(k);
      const results = new Map();
      for (const x of m) if (x.kind === 'toolResult') results.set(x.toolCallId, x);
      const calls = [];
      for (const x of m) {
        if (x.kind !== 'assistant') continue;
        for (const b of x.blocks ?? []) {
          if (b.type !== 'toolCall') continue;
          const r = results.get(b.id);
          calls.push({
            name: b.name,
            command:
              typeof b.arguments?.command === 'string'
                ? b.arguments.command
                : JSON.stringify(b.arguments ?? {}),
            error: r?.isError === true,
            result: String(r?.text ?? '').slice(0, 400),
          });
        }
      }
      const text = m
        .filter((x) => x.kind === 'assistant')
        .flatMap((x) => (x.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text))
        .join('\n');
      return {
        calls,
        text,
        errors: m
          .filter((x) => x.kind === 'assistant' && x.errorMessage)
          .map((x) => x.errorMessage),
        presented: document.querySelectorAll('[data-testid="presented"]').length,
        media: document.querySelectorAll('[data-testid="media-card"]').length,
        canvasOpen: document.querySelector('[data-testid="canvas-pane"], .pd-canvas') !== null,
        workspace: window.__pi_workspace?.() ?? null,
      };
    }, n);
    const prefill = prefillSince(logFrom);
    await page.screenshot({ path: path.join(dir, 'chat.png') });
    // The whole thread, top to bottom, when it is taller than the window.
    await page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="chat-scroll"], .pd-thread-scroll');
        if (el) el.scrollTop = 0;
      })
      .catch(() => {});
    await sleep(400);
    await page.screenshot({ path: path.join(dir, 'chat-top.png') });
    await page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="chat-scroll"], .pd-thread-scroll');
        if (el) el.scrollTop = el.scrollHeight;
      })
      .catch(() => {});
    const files = tail.workspace
      ? filesUnder(tail.workspace).filter((f) => f.mtime >= t0 - 2000)
      : [];
    for (const f of files.slice(0, 40)) {
      const dst = path.join(dir, 'files', f.rel.replaceAll('/', '__'));
      try {
        copyFileSync(path.join(tail.workspace, f.rel), dst);
      } catch {
        /* a folder vanished mid-copy */
      }
    }
    const row = {
      task: task.id,
      kind: task.kind,
      ended,
      secs,
      ttftMs: ttft,
      calls: tail.calls.length,
      toolErrors: tail.calls.filter((c) => c.error).length,
      presented: tail.presented,
      media: tail.media,
      files: files.map((f) => `${f.rel} (${f.bytes} B)`),
      prefill,
      text: tail.text.slice(0, 1200),
      errors: tail.errors,
    };
    rows.push(row);
    writeFileSync(
      path.join(dir, 'task.json'),
      JSON.stringify({ ...row, calls: tail.calls }, null, 2),
    );
    const worst = prefill.reduce((a, p) => Math.max(a, p.computed ?? 0), 0);
    log(
      `   ${ended ? 'done' : 'CAP'} ${secs}s · ttft ${ttft}ms · ${tail.calls.length} calls (${row.toolErrors} err) · ${tail.presented} presented · ${files.length} files · worst computed ${worst}`,
    );
    for (const c of tail.calls)
      log(
        `      ${c.error ? 'ERR ' : '    '}${c.name} ${c.command.slice(0, 140).replace(/\n/g, ' ')}`,
      );
  }
} catch (err) {
  check(false, `threw: ${err?.stack ?? err}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'zz-error.png') }).catch(() => {});
} finally {
  const md = [
    `# Visual suite — ${MODEL}`,
    '',
    '| task | kind | ended | time | ttft | calls | tool errs | presented | files | requests (computed/prompt) |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.task} | ${r.kind} | ${r.ended ? 'yes' : 'CAP'} | ${r.secs}s | ${r.ttftMs ?? '—'}ms | ${r.calls} | ${r.toolErrors} | ${r.presented} | ${r.files.length} | ${r.prefill
          .map((p) => `${p.computed}/${p.prompt ?? '?'}`)
          .join(' ')} |`,
    ),
  ].join('\n');
  writeFileSync(path.join(SHOT_DIR, 'results.md'), `${md}\n`);
  log(`\n${md}`);
  await finish();
}
