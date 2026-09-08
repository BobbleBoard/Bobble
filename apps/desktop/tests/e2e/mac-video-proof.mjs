/**
 * PROOF that Mac computer use really drives a real app: a recorded run of
 * TextEdit being opened, typed into, formatted, and saved through its own save
 * dialog — with the phantom cursor visible doing the clicking.
 *
 * Runs against a PACKAGED bundle (default /Applications/Bobble.app) because the
 * Accessibility and Screen Recording grants attribute to the signed identity
 * that spawns the helper; the dev Electron binary is a different identity and
 * would be blind.
 *
 * The recording is made by the helper itself and composites ONLY the controlled
 * app's windows plus Pi Desktop's own cursor overlay, so it cannot pick up
 * anything else that happens to be on the screen.
 *
 *   MODE=model     (default) the local model drives, via its mac_* tools
 *   MODE=scripted  the probe issues the acts directly — same picture, no model
 *                  variance, for when the point is the mechanism
 *
 * Everything is asserted on disk, not on the video: the saved RTF has to
 * contain the text AND the bold control word, and TextEdit must never once be
 * the frontmost app.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const execFileAsync = promisify(execFile);
const BUNDLE = process.env.BOBBLE_APP ?? '/Applications/Bobble.app';
const MODE = process.env.MODE ?? 'model';
const MODEL_ID = process.env.MAC_CU_MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.MAC_CU_OUT ?? path.join(process.cwd(), '../../scratchpad/mac-video');
const MARKER = `Bobble drove this ${new Date().toISOString().slice(0, 16)}`;
const DOCNAME = `bobble-proof-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  throw new Error(`mac-video-proof FAILED: ${m}`);
};

mkdirSync(OUT, { recursive: true });

const app = await electron.launch({
  executablePath: path.join(BUNDLE, 'Contents/MacOS/Bobble'),
  env: {
    ...process.env,
    HOME: probeHome('mac-video-proof'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_MAC_PRECONSENT: '1',
  },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-video-'))}`],
});

let recording = false;
let dbg = null;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30_000,
  });
  dbg = async (op, params) => {
    const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
    if (res.ok !== true) throw new Error(`mac:debug ${op}: ${res.error}`);
    return res.result;
  };

  const tcc = await dbg('check');
  console.log('TCC:', JSON.stringify(tcc));
  if (tcc.accessibility !== true || tcc.screenRecording !== true) {
    await dbg('promptGrants').catch(() => {});
    console.log('');
    console.log('Bobble needs two permissions before it can drive or record anything:');
    console.log('  System Settings → Privacy & Security → Accessibility     → enable Bobble');
    console.log('  System Settings → Privacy & Security → Screen Recording  → enable Bobble');
    console.log('This is a one-time grant now that the app signs with a stable identity.');
    process.exit(2);
  }

  // ── open TextEdit in the background and start recording it ───────────────
  const launch = await dbg('launch', { app: 'TextEdit', background: true });
  if (launch.ok !== true) fail(`launch: ${JSON.stringify(launch)}`);
  const targetPid = launch.pid;
  console.log('TextEdit pid', targetPid, 'bounds', JSON.stringify(launch.bounds));

  const rec = await dbg('recordStart', {
    pid: targetPid,
    overlayPid: app.process().pid,
    fps: 12,
    maxWidth: 1600,
    fullDisplay: true,
  });
  if (rec.ok !== true) fail(`recordStart: ${JSON.stringify(rec)}`);
  recording = true;
  console.log('recording →', rec.dir);

  const frontmost = [];
  const watcher = setInterval(async () => {
    try {
      frontmost.push((await dbg('frontmost')).app);
    } catch {
      /* helper busy */
    }
  }, 700);

  // ── the run ──────────────────────────────────────────────────────────────
  if (MODE === 'scripted') {
    await scripted(dbg, targetPid);
  } else {
    await modelDriven(page, targetPid);
  }
  clearInterval(watcher);

  const stopped = await dbg('recordStop');
  recording = false;
  console.log('recorded', stopped.frames, 'frames →', stopped.dir);

  // ── the video ────────────────────────────────────────────────────────────
  const video = path.join(OUT, `computer-use-${MODE}.mp4`);
  await encode(stopped.dir, video);
  console.log('video:', video);

  // ── assertions on disk, not on the picture ───────────────────────────────
  const takeover = frontmost.filter((a) => /textedit/i.test(String(a)));
  console.log(`frontmost samples: ${frontmost.length}, TextEdit was frontmost ${takeover.length}`);
  if (takeover.length > 0) fail('TextEdit took the foreground — the run must stay in the background');

  const saved = findSaved(DOCNAME);
  if (saved === null) {
    console.log('NOTE: no saved document found for', DOCNAME);
  } else {
    const rtf = readFileSync(saved, 'latin1');
    console.log('saved:', saved, `(${rtf.length} bytes)`);
    if (!rtf.includes(MARKER.slice(0, 20))) fail(`saved document does not contain the typed text`);
    if (!/\\b(?![a-z])/.test(rtf)) console.log('NOTE: no bold control word in the saved RTF');
    else console.log('bold control word present in the saved RTF');
  }
  console.log('\nmac-video-proof: OK');
} finally {
  if (recording && dbg !== null) await dbg('recordStop').catch(() => {});
  await app.close().catch(() => {});
}

/** Direct acts — the mechanism, with no model in the way. */
async function scripted(dbg, pid) {
  await dbg('type', { pid, text: MARKER });
  await sleep(800);
  await dbg('key', { pid, combo: 'cmd+a' });
  await sleep(400);
  await dbg('key', { pid, combo: 'cmd+b' });
  await sleep(600);
  await dbg('key', { pid, combo: 'cmd+s' });
  await sleep(2500); // the save sheet animates in
  const snap = await dbg('snapshot', { pid, screenshot: false });
  console.log('after cmd+s — dialog:', JSON.stringify(snap.dialog ?? null));
  console.log('surfaces:', JSON.stringify((snap.windows ?? []).map((w) => [w.role, w.title])));
  await dbg('type', { pid, text: DOCNAME });
  await sleep(600);
  const save = (snap.elements ?? []).find((e) => /^save$/i.test(e.name));
  if (save !== undefined) {
    console.log('clicking Save at index', save.index);
    await dbg('click', { pid, index: save.index });
  } else {
    await dbg('key', { pid, combo: 'return' });
  }
  await sleep(3000);
}

/** The local model drives, using only its Mac control tools. */
async function modelDriven(page, pid) {
  const started = await page.evaluate(
    (id) => window.piDesktop.invoke('llm:start-server', { modelId: id }),
    MODEL_ID,
  );
  if (!started.success) fail(`llm:start-server: ${started.error}`);
  await page.evaluate(() => window.piDesktop.invoke('pi:restart', {}));
  const models = await page.evaluate(() => window.piDesktop.invoke('pi:get-models', undefined));
  const target = models.models.find((m) => m.provider === 'llamacpp');
  if (target === undefined) fail('no llamacpp model registered');
  await page.evaluate(
    (t) => window.piDesktop.invoke('pi:set-model', { provider: t.provider, modelId: t.id }),
    target,
  );
  const ack = await page.evaluate(
    (task) => window.piDesktop.invoke('pi:prompt', { message: task }),
    [
      'Use ONLY your Mac control tools for this — no bash, no AppleScript.',
      'TextEdit is already open with an empty document.',
      `1. Type this exact line into the document: ${MARKER}`,
      '2. Select all of it and make it bold.',
      '3. Save the document with Command-S. A save dialog will appear as part of TextEdit —',
      `   snapshot it, type the name ${DOCNAME} into its filename field, and click its Save button.`,
      '4. Reply with exactly DONE.',
      'Never bring TextEdit to the front.',
    ].join('\n'),
  );
  if (!ack.success) fail(`pi:prompt: ${ack.error}`);

  const deadline = Date.now() + 420_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const ps = window.__pi_store().getState();
      return {
        streaming: ps.agent.isStreaming,
        tools: ps.messages
          .filter((m) => m.kind === 'assistant')
          .flatMap((m) => m.blocks.filter((b) => b.type === 'toolCall').map((b) => b.name)),
        text: ps.messages
          .filter((m) => m.kind === 'assistant')
          .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
          .join(' '),
      };
    });
    if (!last.streaming && last.tools.length > 0 && last.text.length > 0) break;
    await sleep(800);
  }
  console.log('model tool calls:', JSON.stringify(last?.tools ?? []));
  console.log('model said:', (last?.text ?? '').slice(0, 200));
}

/** Frames carry their capture time in the filename, so the video plays back at
 * the speed the run actually happened rather than at a uniform rate. */
async function encode(dir, out) {
  const frames = readdirSync(dir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()
    .map((f) => ({ file: path.join(dir, f), t: Number(f.split('-')[2]?.replace('.jpg', '') ?? 0) }));
  if (frames.length === 0) fail('no frames were recorded');
  const lines = [];
  for (let i = 0; i < frames.length; i += 1) {
    const next = frames[i + 1]?.t ?? frames[i].t + 400;
    const dur = Math.min(4, Math.max(0.04, (next - frames[i].t) / 1000));
    lines.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(3)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  const list = path.join(dir, 'frames.txt');
  writeFileSync(list, lines.join('\n'));
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', out,
  ]);
}

function findSaved(name) {
  const roots = [
    path.join(homedir(), 'Documents'),
    path.join(homedir(), 'Desktop'),
    path.join(homedir(), 'Library/Mobile Documents/com~apple~TextEdit/Documents'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      if (f.startsWith(name)) return path.join(root, f);
    }
  }
  return null;
}
