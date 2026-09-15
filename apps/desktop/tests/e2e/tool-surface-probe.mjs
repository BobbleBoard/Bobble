/**
 * EVERY TOOL, THROUGH THE APP — the user (2026-09-15): "i'm noticing some issues
 * attempting to use features in the chat, media tools among a few others seem
 * to immediately fail, test every tool and check it works generally."
 *
 * Real cache, throwaway home, headless, bash-CLI mode (the default). The
 * composer's `!` prefix runs a line through pi's own shell — the PATH the
 * model's `bash` tool gets — so the model's judgement is out of the question:
 * a command either answers or it does not.
 *
 * Pass 1: the whole surface, discovered from the app itself. `tools` names the
 * groups, `<group> --help` names the commands, `<command> --help` proves each
 * one is registered, runnable and documented from its real schema.
 *
 * Pass 2: the commands actually RUN, with real arguments, where that is safe
 * on a headless Mac — a picture is made, a voice speaks, a page is read, a
 * file is written and read back. Anything that would take the screen or ask
 * the OS for a permission (a TCC prompt IS taking the screen) is help-only
 * and says so.
 *
 * Pass 3 (MODEL=… or default): the failure the user saw, reproduced with a real
 * model — "image of a cow on the moon", then "present it" — checking that the
 * picture came from the media tool (not PIL) and that the file was presented.
 *
 *   SHOT_DIR=/tmp/tool-surface node apps/desktop/tests/e2e/tool-surface-probe.mjs
 *   PASSES=1,2   MODEL=qwen3.5-4b-mtp   ENGINE=rapid-mlx/mtp
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const ENGINE = process.env.ENGINE ?? 'rapid-mlx/mtp';
const PASSES = new Set((process.env.PASSES ?? '1,2,3').split(','));
const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/tool-surface';
mkdirSync(SHOT_DIR, { recursive: true });

/*
 * A home of our own, with the model chosen up front: launchApp's default home
 * picks a TIER, and the app then boots that tier's model at start — a
 * different, larger one than MODEL, which `llm:start-server` then queued
 * behind for the whole five-minute wait. Removed at the end (launchApp only
 * removes a home it made itself).
 */
const home = probeHome('tool-surface');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }, null, 2)}\n`,
);
const { app, page, shot, check, finish } = await launchApp('tool-surface', {
  realCache: true,
  /* The media tools are behind the generation experiment (the user's settings have
     it on); a throwaway home starts with it off, and the env is the switch. */
  env: {
    HOME: home,
    PI_BIN: undefined,
    PI_DESKTOP_GEN: '1',
    /* The mflux / mlx-audio workers read the Hugging Face cache under HOME, and
       a throwaway home has none — the weights are in the real one. */
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
  },
  timeout: 120_000,
});
// The main process's own log — the queue, the guardian, the module installs.
const mainLog = path.join(SHOT_DIR, 'main.log');
for (const stream of [app.process().stderr, app.process().stdout]) {
  stream?.on('data', (chunk) => appendFileSync(mainLog, chunk));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rows = [];
const row = (pass, command, ok, note) => {
  rows.push({ pass, command, ok, note: note.replace(/\s+/g, ' ').slice(0, 400) });
  log(`${ok ? 'OK  ' : 'FAIL'} ${command}${ok ? '' : ` — ${note.slice(0, 200)}`}`);
};

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 90_000 });
  /*
   * bash-CLI is the default, so it is NOT set here: writing the setting made
   * the app restart pi a few seconds later, in the middle of pass 1 — "write
   * after end" on one run, "pi exited (143)" on the next.
   */
  await page.evaluate(() => window.piDesktop.invoke('pi:start', {}));
  await sleep(3000);

  /**
   * One line through the app's own shell — `pi:bash`, the IPC behind the
   * composer's `!` prefix. pi runs it in its own process, which is where the
   * harness put the shim directory on PATH, so the answer is the answer the
   * model's `bash` tool gets. No timeout of its own: a generation takes as
   * long as it takes, and the deadline here is the probe's, not the app's.
   */
  const runBash = async (cmd, timeoutMs = 60_000) => {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ success: false, error: `probe: no answer in ${timeoutMs / 1000}s` }),
        timeoutMs,
      );
    });
    const res = await Promise.race([
      page.evaluate((c) => window.piDesktop.invoke('pi:bash', { command: c }), cmd),
      late,
    ]);
    clearTimeout(timer);
    if (!res.success) return `(${res.error ?? 'failed'})`;
    const code = res.result?.exitCode ?? 0;
    return `${res.result?.output ?? ''}${code !== 0 ? `\n\nCommand exited with code ${code}` : ''}`;
  };

  /** The chat model, up and pointed at by pi — `office make` and pass 3 need it. */
  const startModel = async () => {
    log(`starting ${MODEL}…`);
    // The settings above already boot it; ask only if the app has not.
    const up = await page.evaluate((m) => {
      const s = window.__llm_store?.().getState().status;
      return (
        s?.model?.id === m &&
        (s.phase === 'ready' || s.phase === 'starting' || s.phase === 'downloading')
      );
    }, MODEL);
    if (!up) {
      await page.evaluate(async (modelId) => {
        await window.piDesktop.invoke('llm:start-server', { modelId });
      }, MODEL);
    }
    await page.waitForFunction(
      (m) =>
        window.__llm_store?.().getState().status.model?.id === m &&
        window.__llm_store().getState().status.phase === 'ready',
      MODEL,
      { timeout: 300_000 },
    );
    const [engine, spec] = ENGINE.split('/');
    const already = await page.evaluate(
      ({ engine, spec }) => {
        const s = window.__llm_store().getState().status;
        return s.profile?.engine === engine && s.profile?.spec === spec;
      },
      { engine, spec },
    );
    if (ENGINE !== 'llamacpp/none' && !already) {
      await page.evaluate(
        ({ engine, spec }) => window.__llm_store().getState().switchProfile(engine, spec),
        { engine, spec },
      );
      await page.waitForFunction(
        ({ engine, spec }) => {
          const s = window.__llm_store().getState().status;
          return s.phase === 'ready' && s.profile?.engine === engine && s.profile?.spec === spec;
        },
        { engine, spec },
        { timeout: 300_000 },
      );
    }
    const want = ENGINE.startsWith('llamacpp') ? MODEL : `${MODEL}@${ENGINE.split('/')[0]}`;
    await page.waitForFunction(
      (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
      want,
      { timeout: 120_000 },
    );
    /* The app RESTARTS pi to point it at the server it just started — so
       nothing runs through pi until that has happened, or the command in
       flight dies with it ("pi exited (143)", MEASURED twice in pass 1). */
    await sleep(4000);
    log(`model ${want} up, pi repointed`);
  };

  await startModel();

  // ── pass 1: the surface, from the app ─────────────────────────────────────
  const root = await runBash('tools');
  writeFileSync(path.join(SHOT_DIR, 'tools.txt'), root);
  // `  <group padded to 10> <summary>` — one space after a ten-letter group;
  // the Examples block underneath names commands, not groups.
  const groups = [
    ...new Set(
      [...root.split(/^Examples:/m)[0].matchAll(/^\s{2}([a-z]+)\s+\S/gm)].map((m) => m[1]),
    ),
  ];
  check(groups.length >= 10, `\`tools\` lists the groups (${groups.join(' ')})`);
  const commands = [];
  for (const g of groups) {
    const help = await runBash(`${g} --help`);
    writeFileSync(path.join(SHOT_DIR, `${g}.txt`), help);
    // `  <command padded to 28> <first sentence>` — a 29-letter command gets one
    // space, so the command ends where the padding or the Capitalised sentence
    // begins.
    const found = [
      ...help.matchAll(
        new RegExp(`^\\s{2}(${g}(?: [a-z0-9]+)*?)(?=\\s{2,}|\\s+[^a-z0-9\\s]|$)`, 'gm'),
      ),
    ].map((m) => m[1]);
    if (found.length === 0 && /^Usage:/m.test(help)) found.push(g); // a one-command group (svg)
    row(1, `${g} --help`, found.length > 0, found.length > 0 ? `${found.length} commands` : help);
    commands.push(...found);
  }
  log(`${commands.length} commands: ${commands.join(' | ')}`);
  if (PASSES.has('1')) {
    for (const c of commands) {
      const help = await runBash(`${c} --help`);
      writeFileSync(path.join(SHOT_DIR, `help-${c.replace(/\s+/g, '_')}.txt`), help);
      const ok = /^Usage:/m.test(help) && !/not registered|no such command|not found/i.test(help);
      row(1, `${c} --help`, ok, ok ? help.split('\n').slice(0, 2).join(' ') : help);
    }
  }

  // ── pass 2: real invocations ──────────────────────────────────────────────
  if (PASSES.has('2')) {
    const ws = path.join(home, 'Bobble');
    mkdirSync(ws, { recursive: true });
    /*
     * The image module's marker lives in the cache, and this Mac made every
     * picture before markers existed — so the first `media generate image`
     * would show the Download card and wait four minutes for a press. The
     * probe presses it the way the card does (the same IPC), which on a Mac
     * with the packages cached is seconds.
     */
    const modules = await page.evaluate(() => window.piDesktop.invoke('gen:module-status', {}));
    for (const id of ['image', 'audio']) {
      const m = (modules.modules ?? []).find((x) => x.id === id);
      if (m === undefined || m.ready) continue;
      log(`installing the ${id} module (marker absent)…`);
      const t0 = Date.now();
      await page.evaluate((mid) => window.piDesktop.invoke('gen:module-install', { id: mid }), id);
      const ok = await page
        .waitForFunction(
          async (mid) => {
            const s = await window.piDesktop.invoke('gen:module-status', {});
            return (s.modules ?? []).some((x) => x.id === mid && x.ready === true);
          },
          id,
          { timeout: 900_000, polling: 2000 },
        )
        .then(() => true)
        .catch(() => false);
      row(2, `gen:module-install ${id}`, ok, `${Math.round((Date.now() - t0) / 1000)}s`);
    }

    /** [command line, what proves it worked (regex on the output), timeout, group] */
    const RUNS = [
      ['tools search voice', /media generate speech/, 20_000],
      [
        'file write --path=probe-note.md --content="# hello from the probe"',
        /probe-note|wrote|written|created/i,
        20_000,
      ],
      ['file read --path=probe-note.md', /hello from the probe/, 20_000],
      [
        'file edit --path=probe-note.md --edits=\'[{"oldText":"hello","newText":"hi"}]\'',
        /probe-note|edit|replaced|applied/i,
        20_000,
      ],
      ['file ls --path=.', /probe-note\.md/, 20_000],
      ['machine python --script="print(6*7)"', /\b42\b/, 120_000],
      ['machine search --query=Bobble', /\S/, 30_000],
      ['web search --query="Bobble local AI desktop app"', /\S{20}/, 60_000],
      ['web fetch --url=https://example.com', /Example Domain/i, 60_000],
      ['browser navigate --url=https://example.com', /example/i, 60_000],
      ['browser read', /Example Domain/i, 30_000],
      ['browser snapshot', /\[\d+\]|example/i, 30_000],
      ['browser scroll --direction=down', /\S/, 30_000],
      ['browser wait --seconds=1', /\S/, 30_000],
      ['browser click --index=1', /\S/, 30_000],
      ['browser back', /\S/, 30_000],
      ['browser forward', /\S/, 30_000],
      ['browser key --key=Escape', /\S/, 30_000],
      ['browser navigate --url=https://html.duckduckgo.com/html/', /duck/i, 60_000],
      ['browser type --index=FIELD --text=probe', /typed|probe/i, 30_000],
      ['mcp list', /\S/, 30_000, 'mcp'],
      [
        'coordinate plan --title=Probe --plan=\'[{"text":"look","status":"done"},{"text":"do","status":"in_progress"}]\'',
        /plan|look|updated|published/i,
        20_000,
      ],
      ['coordinate present --path=probe-note.md', /present|shown|preview|probe-note/i, 30_000],
      [
        'coordinate schedule --name="Probe task" --prompt="Say hello." --frequency=manual',
        /Probe task|saved|created|schedul/i,
        30_000,
      ],
      [
        'media generate sfx --prompt="a wooden door slams shut" --seconds=2',
        /\.(wav|mp3|flac|ogg)\b/i,
        300_000,
      ],
      [
        'media generate speech --prompt="Hello from the probe."',
        /\.(wav|mp3|flac|ogg)\b/i,
        300_000,
      ],
      [
        'media generate music --prompt="a short upbeat ukulele jingle" --seconds=5',
        /\.(wav|mp3|flac|ogg)\b/i,
        600_000,
      ],
      [
        'media generate image --prompt="a red fox sitting in snow, photo" --save_to=probe-images --size=512x512',
        /\.(png|jpg|jpeg|webp)\b/i,
        900_000,
      ],
      ['svg --prompt="a simple five-pointed star"', /\.svg\b/i, 600_000],
      ['office-venv', /venv/, 600_000],
      [
        'office make --kind=docx --out=probe.docx --brief="A one-page internal note titled Probe Results for the Bobble team. Audience: the two engineers who maintain the tool surface. Purpose: record that on 15 September 2026 the tool surface probe ran 46 commands through the app and every one answered its --help, and that the media commands made a picture, a sound effect, a jingle and a spoken line on-device. Sections in order: Summary (three sentences), What ran (a short bullet list naming the groups: browser, mac, chrome, personal, web, media, svg, office, coordinate, machine, file), Numbers (46 commands, 13 groups, 0 not found), Next (one sentence: keep the probe in the pre-ship checks)."',
        /\.docx\b/i,
        900_000,
      ],
      ['office inspect --file=probe.docx', /Probe|paragraph|docx|heading/i, 120_000],
    ];
    const outputs = new Map();
    for (const [cmd, proof, timeoutMs, needsGroup] of RUNS) {
      if (needsGroup !== undefined && !groups.includes(needsGroup)) {
        row(2, cmd, true, `skipped: no \`${needsGroup}\` group in this home (nothing configured)`);
        continue;
      }
      const t0 = Date.now();
      if (cmd === 'office-venv') {
        /*
         * THE OFFICE INTERPRETER, which the app builds in the background at
         * launch (a venv under the cache root; this Mac's was dangling — see
         * office-gen-env.ts) and pi only sees at its next spawn. Wait for it,
         * then restart pi the way the app does, so the tool runs on it.
         */
        const venv = path.join(
          homedir(),
          '.cache',
          'bobble',
          'engines',
          'office-venv',
          'bin',
          'python3',
        );
        const cacheVenv = path.join(
          process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble'),
          'engines',
          'office-venv',
          'bin',
          'python3',
        );
        const deadline = Date.now() + timeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          if (existsSync(venv) || existsSync(cacheVenv)) {
            ready = true;
            break;
          }
          await sleep(5000);
        }
        if (ready) {
          await sleep(3000);
          await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
          await page.waitForFunction(
            (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
            MODEL,
            { timeout: 120_000 },
          );
          await sleep(4000);
        }
        row(
          2,
          'office venv (built by the app, pi restarted onto it)',
          ready,
          `${Math.round((Date.now() - t0) / 1000)}s`,
        );
        continue;
      }
      let line = cmd;
      if (line.includes('--index=FIELD')) {
        // The field's index comes from the page, as it would for the model.
        const snap = await runBash('browser snapshot', 30_000);
        const m = /\[(\d+)\][^\n]*(?:textbox|searchbox|input|search)/i.exec(snap);
        line = line.replace('FIELD', m?.[1] ?? '1');
      }
      const out = await runBash(line, timeoutMs);
      outputs.set(cmd, out);
      const ok =
        proof.test(out) &&
        !/not registered|no such command|Command exited with code [1-9]/i.test(out);
      row(2, cmd, ok, `${Math.round((Date.now() - t0) / 1000)}s: ${out}`);
      writeFileSync(
        path.join(
          SHOT_DIR,
          `run-${cmd
            .split(' ')
            .slice(0, 3)
            .join('_')
            .replace(/[^a-z0-9_]/gi, '')}.txt`,
        ),
        out,
      );
    }
    // The image edit needs the picture the image run made — the path it printed.
    const imageOut = [...outputs.entries()].find(([c]) =>
      c.startsWith('media generate image'),
    )?.[1];
    const made = /Saved to:\s*1\. (\S+\.png)/.exec(imageOut ?? '')?.[1];
    if (made !== undefined && existsSync(made)) {
      const out = await runBash(
        `media edit image --image_path=${made} --instruction="make the fox blue"`,
        900_000,
      );
      row(
        2,
        'media edit image …',
        /\.(png|jpg|jpeg|webp)\b/i.test(out) && !/exited with code [1-9]/.test(out),
        out,
      );
    } else {
      row(2, 'media edit image …', false, 'no picture to edit (the image run made none)');
    }
    await shot('pass2-thread');
  }

  // ── pass 3: the reported failure, with a real model ───────────────────────
  if (PASSES.has('3')) {
    const turn = async (text, timeoutMs) => {
      const n = await page.evaluate(() => window.__pi_store().getState().messages.length);
      await page.click('[data-testid="composer-input"]');
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      const t0 = Date.now();
      await page
        .waitForFunction(
          (k) => {
            const s = window.__pi_store().getState();
            const m = s.messages.slice(k);
            const replied = m.some(
              (x) =>
                x.kind === 'assistant' && (x.blocks ?? []).some((b) => (b.text ?? '').length > 0),
            );
            return replied && !s.messages.some((x) => x.isStreaming) && s.promptInFlight !== true;
          },
          n,
          { timeout: timeoutMs },
        )
        .catch(() => undefined);
      await sleep(1500);
      const tail = await page.evaluate((k) => {
        const m = window.__pi_store().getState().messages.slice(k);
        // Calls live on assistant rows as `toolCall` blocks; their results are
        // separate `toolResult` rows keyed by toolCallId.
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
              command: typeof b.arguments?.command === 'string' ? b.arguments.command : undefined,
              error: r?.isError === true,
              result: String(r?.text ?? '').slice(0, 200),
            });
          }
        }
        const text = m
          .filter((x) => x.kind === 'assistant')
          .flatMap((x) => (x.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text))
          .join('\n')
          .slice(0, 600);
        return { calls, text };
      }, n);
      log(`turn "${text}" ${Math.round((Date.now() - t0) / 1000)}s: ${tail.calls.length} calls`);
      for (const c of tail.calls)
        log(
          `   ${c.error ? 'ERR ' : '    '}${c.name} ${c.command ?? ''} → ${c.result.slice(0, 100)}`,
        );
      return tail;
    };

    const cow = await turn('image of a cow on the moon', 900_000);
    const mediaRan = cow.calls.some(
      (c) => /(^|\s)media\s+generate\s+image\b/.test(c.command ?? '') && !c.error,
    );
    const notFound = cow.calls.some((c) => /not found/.test(c.result));
    const diy = cow.calls.some((c) => /PIL|ImageDraw|Pillow/.test(c.command ?? ''));
    check(mediaRan, 'the picture was asked of `media generate image` (a real run, no error)');
    check(!notFound, 'no tool call came back "not found"');
    check(!diy, 'the model did not paint the picture itself with PIL');
    await shot('pass3-cow');
    const present = await turn('present it', 300_000);
    const presented = present.calls.some(
      (c) => /coordinate\s+present\b/.test(c.command ?? '') && !c.error,
    );
    check(presented, 'asked to present it, the model ran `coordinate present` and it worked');
    const presentCard = await page.evaluate(
      () => document.querySelector('[data-testid="presented"]') !== null,
    );
    check(presentCard, 'a present card is in the thread');
    // The picture in the canvas, and no red error row after the reply (the
    // vision relaunch used to fire while the harness's follow-up was in flight).
    await sleep(8000);
    const afterPresent = await page.evaluate(() => ({
      canvasError: document.querySelector('.pd-media-error')?.textContent ?? null,
      canvasImage: [...document.querySelectorAll('.pd-media img')].some(
        (i) => i.complete && i.naturalWidth > 0,
      ),
      turnErrors: window
        .__pi_store()
        .getState()
        .messages.filter((m) => m.kind === 'assistant' && m.errorMessage !== undefined)
        .map((m) => m.errorMessage),
    }));
    check(
      afterPresent.canvasError === null,
      `the canvas tab shows no error (${afterPresent.canvasError})`,
    );
    check(afterPresent.canvasImage, 'the presented picture is loaded in the canvas');
    check(
      afterPresent.turnErrors.length === 0,
      `no assistant turn ended in an error (${afterPresent.turnErrors.join(' | ')})`,
    );
    await shot('pass3-present');
  }
} finally {
  const table = rows
    .map((r) => `| ${r.pass} | \`${r.command}\` | ${r.ok ? 'OK' : 'FAIL'} | ${r.note} |`)
    .join('\n');
  writeFileSync(
    path.join(SHOT_DIR, 'results.md'),
    `| pass | command | result | note |\n|---|---|---|---|\n${table}\n`,
  );
  const fails = rows.filter((r) => !r.ok);
  log(
    `${rows.length - fails.length}/${rows.length} OK; failures: ${fails.map((f) => f.command).join(' | ') || 'none'}`,
  );
  for (const f of fails) check(false, `${f.command}: ${f.note}`);
  await finish();
  if (process.env.PI_E2E_KEEP_HOME !== '1') rmSync(home, { recursive: true, force: true });
}
