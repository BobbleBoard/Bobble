/**
 * THE CANVAS, AS A REAL USER WOULD MEET IT — assessed, not changed.
 *
 * the user: "stress test the app as a normal complex user would want, test every
 * feature of the canvas as real user with real inputs with real models using
 * real tools, don't change anything, assess, comprehensive eg. work with every
 * file type and use case."
 *
 * So: a real chat model, the app's default tool interface, a fixture project
 * holding every file type the canvas claims to route (images, clips, sounds, a
 * mesh, docx / xlsx / pptx / pdf, code, data, markdown, html, svg), and a list
 * of things a person actually asks for. After every turn the probe records what
 * the canvas did — the tabs and their kinds, the active one, console errors, a
 * screenshot — and the person reading the output decides. Nothing here asserts;
 * the point is to SEE.
 *
 * Headless and backgrounded (PI_E2E_BACKGROUND), an isolated HOME so the chat
 * list and settings are not polluted, the real model cache so the models are
 * the real ones.
 *
 *   MODEL=qwen3.5-9b-mtp OUT=/tmp/canvas-assess/run node tests/e2e/canvas-assess.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

/** The real model library, beside the real cache (see harness.mjs REAL_LIBRARY). */
const REAL_LIBRARY_DEFAULT = path.join(homedir(), 'Bobble', 'Models');

const MODEL = process.env.MODEL ?? 'qwen3.5-9b-mtp';
const PROJECT = process.env.PROJECT ?? '/tmp/canvas-assess/project';
const OUT = process.env.OUT ?? '/tmp/canvas-assess/run';
const TURN_MS = Number(process.env.TURN_MS ?? 300_000);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const say = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${m}`);

/**
 * The scenarios. `chat: 'new'` starts a fresh conversation (a person does not
 * do everything in one thread, and a 9B's prefill grows with every turn).
 * `ui` runs after the turn: interactions a person would do with the mouse.
 */
const SCENARIOS = [
  {
    id: 'site',
    chat: 'new',
    prompt:
      'Create a tiny website in ./site: index.html with a stylesheet and a button that counts clicks in JS. Then open it so I can see it.',
  },
  {
    id: 'site-click',
    ui: 'click-counter',
    prompt: 'Is the counter button working? Just check the page you opened.',
  },
  {
    id: 'site-edit',
    prompt:
      'Change the button label in ./site/index.html to "Count me" and make the page background dark.',
  },
  {
    id: 'script',
    chat: 'new',
    prompt:
      'Write ./analysis/stats.py that computes the mean and median of [3, 9, 1, 7, 5, 11] and prints them as a small table, run it, and show me the output.',
  },
  {
    id: 'markdown',
    prompt:
      'Write a markdown report at ./docs/report.md with a title, two sections, a table of three rows and a Python code block, then open it.',
  },
  {
    id: 'json',
    prompt: 'Open ./data/users.json and tell me how many users are over 60.',
  },
  {
    id: 'bigjson',
    ui: 'scroll-editor',
    prompt: 'Open ./data/big.json — I want to look through it.',
  },
  {
    id: 'csv-txt',
    prompt:
      'Open ./data/data.csv and ./data/notes.txt side by side; what is the most expensive item?',
  },
  {
    id: 'svg',
    chat: 'new',
    prompt: 'Draw a simple flat logo of a red paper boat on blue water and save it as ./boat.svg.',
  },
  {
    id: 'image',
    prompt: 'Open ./media/mug.png. Then also open ./media/mug.gif and ./media/mug.webp.',
  },
  {
    id: 'video',
    prompt: 'Open ./media/clip.mp4 so I can watch it.',
  },
  {
    id: 'audio',
    prompt: 'Open ./media/beat.flac and ./media/beat.mp3 so I can listen.',
  },
  {
    id: 'model',
    prompt: 'Open the 3D model ./media/mug.glb.',
  },
  {
    id: 'docx',
    chat: 'new',
    prompt: 'Open ./docs/letter.docx and change "paper boats" to "wooden boats".',
  },
  {
    id: 'docx-complex',
    prompt: 'Now open ./docs/kitchen-sink.docx and tell me what is in it.',
  },
  {
    id: 'xlsx',
    prompt: 'Open ./docs/budget.xlsx and add an April row with rent 1250 and food 380.',
  },
  {
    id: 'pptx',
    prompt: 'Open ./docs/pitch.pptx and add a third slide titled "How" with two bullet points.',
  },
  {
    id: 'pdf',
    prompt: 'Open ./docs/sample.pdf and read me what it says.',
  },
  {
    id: 'new-docx',
    prompt:
      'Make me a new Word document ./docs/invoice.docx — a simple invoice with three line items and a total — and open it.',
  },
  {
    id: 'browser',
    chat: 'new',
    prompt: 'Open https://example.com in the browser and tell me the page heading.',
  },
  {
    id: 'filetree',
    prompt: 'Show me the project folder.',
  },
  {
    id: 'tabs',
    ui: 'tabs',
    prompt: 'Open ./media/mug.png, ./docs/README.md and ./site/index.html.',
  },
  {
    id: 'subagent',
    chat: 'new',
    prompt:
      'Use a subagent to write a haiku about paper boats into ./docs/haiku.txt, then open the file.',
  },
];

const home = probeHome('canvas-assess');
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'canvas-assess-udd-'))}`],
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: home,
    // The real models, in an otherwise clean house.
    PI_DESKTOP_CACHE_DIR: path.join(homedir(), '.cache', 'pi-desktop'),
    PI_DESKTOP_MODELS_DIR: process.env.PI_DESKTOP_MODELS_DIR ?? REAL_LIBRARY_DEFAULT,
    HF_HOME: path.join(homedir(), '.cache', 'pi-desktop', 'gen3d', 'hf'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_DESKTOP_GEN: '1',
  },
});

const consoleErrors = [];
const fullErrors = [];
const report = [];
let scenarioLog = [];
// The main process's own log — where "fetch failed" and a server restart would
// explain themselves. SEEN without it: a 5-minute "Getting this ready" with
// nothing to say why.
const mainLog = [];
app.process().stdout?.on('data', (d) => mainLog.push(...String(d).split('\n').filter(Boolean)));
app.process().stderr?.on('data', (d) => mainLog.push(...String(d).split('\n').filter(Boolean)));

try {
  const win = await app.firstWindow();
  win.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const line = `[${m.type()}] ${m.text().slice(0, 300)}`;
      consoleErrors.push(line);
      scenarioLog.push(line);
      // The whole thing too, for mapping a minified stack after a crash.
      if (m.type() === 'error') fullErrors.push(m.text());
    }
  });
  win.on('pageerror', (e) => {
    scenarioLog.push(`[pageerror] ${String(e).slice(0, 300)}`);
    fullErrors.push(String(e.stack ?? e));
  });

  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(2000);

  /*
   * The project folder. Main learns it from `project:set`; the RENDERER's
   * project store learns it on mount (`load`), and it is that store the
   * new-chat flow reads — SEEN: set over IPC alone, every new chat rooted in a
   * per-chat sandbox. A reload after the set is what a relaunch would do.
   */
  await win.evaluate((p) => window.piDesktop.invoke('project:set', { path: p }), PROJECT);
  await win.reload();
  await win.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 60000,
  });
  await win.waitForTimeout(2500);

  const up = await win.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL,
  );
  if (up.success !== true) throw new Error(`llm:start-server: ${up.error}`);
  await win.evaluate((p) => window.piDesktop.invoke('pi:restart', { cwd: p }), PROJECT);
  const models = await win.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  await win.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  await win.evaluate(
    (id) =>
      window
        .__settings_store?.()
        .getState?.()
        .update?.({ modelSelection: { mode: 'model', modelId: id } }),
    MODEL,
  );
  await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
  /*
   * pi is restarting with the new cwd; a prompt typed before its session exists
   * is dropped on the floor (SEEN: a sent bubble and no reply). Wait for the
   * session, then a beat for the model to attach.
   */
  await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
    timeout: 60000,
  });
  await win.waitForTimeout(3000);
  say(
    `model up: ${MODEL}; project: ${PROJECT}; session: ${await win.evaluate(() => window.__pi_store().getState().session?.sessionFile ?? '?')}`,
  );

  const ready = () =>
    win.evaluate(() => {
      const s = window.__pi_store().getState();
      return (
        !s.agent.isStreaming && !s.promptInFlight && s.bgRun?.streaming !== true && !s.resuming
      );
    });
  /*
   * A DIALOG IS A QUESTION TO THE PERSON. Consent to drive Chrome, an ask_user,
   * a permission prompt — a user asked to see a local file does not hand over
   * their browser, so the probe answers the way they would (Cancel) and writes
   * down that it was asked, which is itself a finding.
   */
  const dialogsSeen = [];
  const answerDialogs = async () => {
    const found = await win
      .evaluate(() => {
        const dlg = document.querySelector('[role="dialog"], [role="alertdialog"]');
        if (!dlg) return null;
        const title = (dlg.querySelector('h1,h2,h3,[id$="title"]')?.textContent ?? '').trim();
        const buttons = [...dlg.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
        // "Don't" is the reviewer guard's refusal ("Run this command?"); the
        // rest are the app's other ways of saying no.
        const cancel = [...dlg.querySelectorAll('button')].find((b) =>
          /don.?t|cancel|not now|dismiss|deny|^no\b/i.test(b.textContent ?? ''),
        );
        if (cancel) {
          cancel.click();
          return { title, buttons, answered: 'Cancel' };
        }
        return { title, buttons, answered: null };
      })
      .catch(() => null);
    if (found !== null) {
      dialogsSeen.push(found);
      scenarioLog.push(
        `[dialog] "${found.title}" [${found.buttons.join(' | ')}] → ${found.answered ?? 'left open'}`,
      );
      await win.waitForTimeout(800);
    }
  };
  const waitReady = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await answerDialogs();
      if (await ready()) return true;
      await win.waitForTimeout(1000);
    }
    return false;
  };
  const canvasState = () =>
    win
      .evaluate(() => {
        const c = window.__pi_canvas?.();
        if (!c) return { tabs: [], active: null, open: false };
        const s = c.getState();
        return {
          open: document.querySelector('[data-testid="canvas-tabs-panel"]') !== null,
          active: s.activeTabId,
          tabs: s.tabs.map((t) => ({
            id: t.id,
            kind: t.kind,
            title: t.title ?? '',
            url: t.url ?? '',
            path: t.path ?? t.filePath ?? '',
          })),
        };
      })
      .catch(() => ({ tabs: [], active: null, open: false, error: 'canvas unavailable' }));
  const lastTurn = () =>
    win.evaluate(() => {
      const msgs = window.__pi_store().getState().messages;
      const tools = [];
      let text = '';
      for (const m of msgs) {
        if (m.kind === 'toolCall' || m.toolName) tools.push(m.toolName ?? m.name);
        if (m.kind === 'assistant' && typeof m.text === 'string' && m.text.trim())
          text = m.text.trim();
      }
      return { tools: tools.slice(-12), text: text.slice(0, 400), msgs: msgs.length };
    });
  const panelIssues = () =>
    win.evaluate(() => {
      const panel = document.querySelector('[data-testid="canvas-tabs-panel"]');
      if (!panel) return [];
      const text = panel.innerText ?? '';
      const found = [];
      for (const needle of [
        'No surface',
        'no surface',
        'Failed',
        'failed',
        'Error',
        'error',
        'Unavailable',
        'not available',
        'Could not',
      ]) {
        if (text.includes(needle)) found.push(needle);
      }
      const empties = [...panel.querySelectorAll('img, video, audio, iframe, canvas')].filter(
        (el) => {
          const r = el.getBoundingClientRect();
          return r.width < 8 || r.height < 8;
        },
      ).length;
      return { hints: [...new Set(found)], tinyMedia: empties, chars: text.length };
    });

  let n = 0;
  for (const sc of SCENARIOS) {
    if (ONLY !== null && !ONLY.has(sc.id)) continue;
    n += 1;
    scenarioLog = [];
    const tag = `${String(n).padStart(2, '0')}-${sc.id}`;
    if (sc.chat === 'new') {
      await win.click('[data-testid="new-chat"]').catch(() => {});
      await win.waitForTimeout(1500);
      /*
       * SEEN: a new chat lands in a per-chat sandbox
       * (~/Bobble/<first-words-of-the-prompt>/), not the project, because the
       * project was set over IPC rather than through the sidebar's store — so
       * every "open ./media/…" in a later chat found nothing. Re-root the new
       * session the way the store's applyWorkingFolder does.
       */
      await win.evaluate((p) => window.piDesktop.invoke('pi:restart', { cwd: p }), PROJECT);
      await win.waitForFunction(() => window.__pi_store().getState().session !== null, {
        timeout: 60000,
      });
      await win.waitForTimeout(2500);
      await win.evaluate(() => window.__modality_store?.().getState().setView('chat'));
      await win.waitForTimeout(800);
      const cwd = await win.evaluate(() => window.__pi_store().getState().session?.cwd ?? '?');
      say(`new chat, cwd: ${cwd}`);
    }
    await waitReady(30_000);
    const editor = win.locator('[contenteditable="true"]').first();
    await editor.click();
    await win.keyboard.type(sc.prompt, { delay: 4 });
    await win.waitForTimeout(300);
    await win.keyboard.press('Enter');
    const started = Date.now();
    const turnBefore = await win.evaluate(() => window.__pi_store().getState().messages.length);
    say(`${tag}: sent`);
    await win.waitForTimeout(3000);
    // A reply has to START before "ready" means anything — the store is idle
    // both before the model answers and after it has.
    await win
      .waitForFunction(
        (before) => window.__pi_store().getState().messages.length > before,
        turnBefore,
        { timeout: 45000 },
      )
      .catch(() => {});
    const finished = await waitReady(TURN_MS);
    const seconds = Math.round((Date.now() - started) / 1000);
    await win.waitForTimeout(1200);
    await win.screenshot({ path: path.join(OUT, `${tag}.png`) });
    const canvas = await canvasState();
    const turn = await lastTurn();
    const issues = await panelIssues();

    // The person's own interactions after the turn.
    const ui = {};
    if (sc.ui === 'click-counter') {
      ui.clicked = await win
        .evaluate(() => {
          const frame = document.querySelector('[data-testid="canvas-tabs-panel"] iframe');
          const doc = frame?.contentDocument;
          const btn = doc?.querySelector('button');
          if (!btn) return 'no button in the html tab';
          btn.click();
          btn.click();
          return `clicked twice → "${(doc.body.innerText ?? '').slice(0, 120).replace(/\n/g, ' ')}"`;
        })
        .catch((e) => `iframe not reachable: ${String(e).slice(0, 120)}`);
      await win.screenshot({ path: path.join(OUT, `${tag}-after-click.png`) });
    }
    if (sc.ui === 'scroll-editor') {
      const panel = win.locator('[data-testid="canvas-tabs-panel"]');
      const box = await panel.boundingBox().catch(() => null);
      if (box) {
        const t = Date.now();
        for (let i = 0; i < 20; i++) {
          await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await win.mouse.wheel(0, 1200);
          await win.waitForTimeout(40);
        }
        ui.scroll = `20 wheel steps in ${Date.now() - t}ms`;
        await win.screenshot({ path: path.join(OUT, `${tag}-scrolled.png`) });
      }
    }
    if (sc.ui === 'tabs') {
      const tabs = win.locator('[data-testid="canvas-tabs-panel"] [role="tab"]');
      const count = await tabs.count();
      ui.tabCount = count;
      for (let i = 0; i < count; i++) {
        await tabs
          .nth(i)
          .click()
          .catch(() => {});
        await win.waitForTimeout(500);
        await win.screenshot({ path: path.join(OUT, `${tag}-tab${i}.png`) });
      }
      // popout, then back; collapse, then reopen
      const pop = win.locator('[data-testid="canvas-popout"]');
      if ((await pop.count()) > 0) {
        await pop
          .first()
          .click()
          .catch(() => {});
        await win.waitForTimeout(1500);
        ui.popout = `windows after popout: ${app.windows().length}`;
        await win.screenshot({ path: path.join(OUT, `${tag}-popout.png`) });
        for (const w of app.windows()) {
          if (w !== win) {
            await w
              .screenshot({ path: path.join(OUT, `${tag}-popout-window.png`) })
              .catch(() => {});
            await w.close().catch(() => {});
          }
        }
        await win.waitForTimeout(800);
      }
      const toggle = win.locator('[data-testid="canvas-toggle"]');
      if ((await toggle.count()) > 0) {
        await toggle
          .first()
          .click()
          .catch(() => {});
        await win.waitForTimeout(700);
        await win.screenshot({ path: path.join(OUT, `${tag}-collapsed.png`) });
        await toggle
          .first()
          .click()
          .catch(() => {});
        await win.waitForTimeout(700);
        ui.toggle = 'collapsed and reopened';
      }
      // close the active tab with its close control, if it has one
      const close = win
        .locator('[data-testid="canvas-tabs-panel"] [aria-label*="Close" i]')
        .first();
      if ((await close.count()) > 0) {
        await close.click().catch(() => {});
        await win.waitForTimeout(500);
        ui.closed = 'closed one tab';
        await win.screenshot({ path: path.join(OUT, `${tag}-closed.png`) });
      }
      ui.after = await canvasState();
    }

    const entry = {
      dialogs: dialogsSeen.splice(0),
      scenario: sc.id,
      prompt: sc.prompt,
      finished,
      seconds,
      tools: turn.tools,
      reply: turn.text,
      canvas,
      issues,
      ui,
      console: scenarioLog.slice(0, 12),
    };
    report.push(entry);
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
    say(
      `${tag}: ${finished ? 'done' : 'TIMEOUT'} in ${seconds}s · tools=${turn.tools.join(',')} · tabs=${canvas.tabs.map((t) => t.kind).join(',')} · issues=${JSON.stringify(issues.hints ?? issues)}`,
    );
  }
} finally {
  writeFileSync(path.join(OUT, 'console.txt'), consoleErrors.join('\n'));
  writeFileSync(path.join(OUT, 'main.log'), mainLog.join('\n'));
  writeFileSync(path.join(OUT, 'errors-full.txt'), fullErrors.join('\n\n=====\n\n'));
  await app.close().catch(() => {});
}
say('assessment run complete');
