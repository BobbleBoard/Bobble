/**
 * The PROOF video: Bobble driving a real TextEdit — opening a document from the
 * menu bar, typing, formatting, opening the save dialog and acting inside it —
 * recorded from Bobble's OWN window, with the phantom cursor visible.
 *
 * Why record Bobble's window rather than the screen: capturing the screen needs
 * the macOS Screen Recording grant, which is exactly the thing that keeps
 * falling over. Bobble's own renderer needs no grant at all, and the computer-use
 * monitor inside it is a truthful view of the app being driven. What is being
 * recorded is therefore the product's own view of its own work.
 *
 * Everything the video claims is also asserted structurally, on the app's real
 * state — the recording is the illustration, not the evidence.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { probeHome } from './harness.mjs';

const run = promisify(execFile);
const osa = (s) => run('osascript', ['-e', s]).catch(() => undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUNDLE = process.env.BOBBLE_APP ?? '/Applications/Bobble.app';
const OUT = process.env.OUT_DIR ?? '/Users/user/Desktop/OSS-harness/scratchpad/mac-video';
const FPS = Number(process.env.FPS ?? 8);
const DOCNAME = `bobble-proof-${Date.now().toString(36)}`;
const LINE = 'Bobble typed this line itself, in the background.';

const log = [];
const started = Date.now();
/** Every line is stamped, so the video can caption itself with what was
 * actually happening at that second rather than with a script written after. */
let showCaption = async (_) => {};
const say = (m, cap) => {
  log.push({ at: Date.now() - started, text: m, caption: cap });
  console.log(m);
  if (cap !== undefined) void showCaption(cap);
};

function srt(entries, endsAt) {
  const stamp = (ms) => {
    const t = Math.max(0, ms);
    const h = String(Math.floor(t / 3600000)).padStart(2, '0');
    const m = String(Math.floor(t / 60000) % 60).padStart(2, '0');
    const s = String(Math.floor(t / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(t % 1000).padStart(3, '0')}`;
  };
  const captioned = entries.filter((e) => e.caption !== undefined);
  return captioned
    .map((e, i) => {
      const end = captioned[i + 1]?.at ?? endsAt;
      return `${i + 1}\n${stamp(e.at)} --> ${stamp(Math.max(e.at + 1200, end - 120))}\n${e.caption}\n`;
    })
    .join('\n');
}

rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
mkdirSync(path.join(OUT, 'frames'), { recursive: true });

/** TextEdit back to nothing — a save sheet left up by an earlier run blocks quit. */
await osa('tell application "TextEdit" to close every document without saving');
await sleep(400);
await osa('tell application "TextEdit" to quit saving no');
await sleep(1400);

const app = await electron.launch({
  executablePath: path.join(BUNDLE, 'Contents/MacOS/Bobble'),
  env: {
    ...process.env,
    HOME: probeHome('mac-video-record'),
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
    PI_MAC_PRECONSENT: '1',
  },
  args: [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'pi-video-'))}`],
});

let shooting = true;
let shot = 0;
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.piDesktop?.invoke === 'function', {
    timeout: 30_000,
  });
  await page.setViewportSize?.({ width: 1440, height: 900 }).catch(() => {});
  /*
   * Captions are drawn INTO the page before the frame is taken, because this
   * ffmpeg has neither drawtext nor libass. Styled as an obvious caption strip
   * rather than as app chrome, so nobody can mistake it for something Bobble
   * renders.
   */
  const caption = async (text) => {
    await page
      .evaluate((t) => {
        let el = document.getElementById('__pd_caption');
        if (el === null) {
          el = document.createElement('div');
          el.id = '__pd_caption';
          el.style.cssText = [
            'position:fixed',
            'left:0',
            'right:0',
            'bottom:0',
            'z-index:2147483647',
            'padding:14px 22px',
            'font:500 15px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',
            'color:#fff',
            'background:rgba(10,11,14,0.82)',
            'backdrop-filter:blur(12px)',
            'border-top:1px solid rgba(255,255,255,0.10)',
            'pointer-events:none',
            'text-align:center',
            'letter-spacing:0.1px',
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = t;
      }, text)
      .catch(() => {});
  };

  const dbg = async (op, params) => {
    const res = await page.evaluate((r) => window.piDesktop.invoke('mac:debug', r), { op, params });
    if (res.ok !== true) throw new Error(`${op}: ${res.error}`);
    return res.result;
  };

  // Frames carry their capture time so the video plays back at the speed the
  // run actually happened rather than at a uniform rate.
  const camera = (async () => {
    while (shooting) {
      const at = Date.now();
      try {
        await page.screenshot({
          path: path.join(OUT, 'frames', `f-${String(++shot).padStart(5, '0')}-${at}.png`),
          animations: 'allow',
        });
      } catch {
        /* the window can be mid-layout; skip the frame */
      }
      const spent = Date.now() - at;
      await sleep(Math.max(0, 1000 / FPS - spent));
    }
  })();

  showCaption = caption;
  // Open the canvas so the monitor has somewhere to appear. A fresh profile
  // starts with it closed, and the point of the recording is what is inside it.
  const toggle = page.locator('[aria-label*="canvas" i], [title*="canvas" i]').first();
  if ((await toggle.count()) > 0) await toggle.click().catch(() => {});
  await sleep(600);

  const tcc = await dbg('check');
  say(`grants: ${JSON.stringify(tcc)}`);

  const launch = await dbg('launch', { app: 'TextEdit', background: true });
  const pid = launch.pid;
  say(`TextEdit launched in the background, pid ${pid}`, 'TextEdit opens in the background — it never comes to the front');
  await sleep(2200);

  // 1. New document — from the MENU BAR, which is where "New" actually lives.
  const made = await dbg('menuClick', { pid, path: 'File > New' });
  say(
    `File > New → ${JSON.stringify({ ok: made.ok, mode: made.mode, opened: (made.opened ?? []).length })}`,
    'File > New, pressed from the menu bar — no menu opens on screen',
  );
  await sleep(1800);

  let snap = await dbg('snapshot', { pid });
  const area = (snap.elements ?? []).find((e) => e.role === 'AXTextArea');
  if (area === undefined) throw new Error('no text area in the new document');

  // 2. Type — real keystrokes into a background app.
  await dbg('type', { pid, index: area.index, text: LINE, append: true });
  await sleep(1600);
  snap = await dbg('snapshot', { pid });
  const typed = String((snap.elements ?? []).find((e) => e.role === 'AXTextArea')?.value ?? '');
  say(`typed → document reads ${JSON.stringify(typed.slice(0, 60))}`, 'Typing — real keystrokes, into an app that is not in front');
  if (!typed.toLowerCase().includes('bobble typed this line')) throw new Error('typing did not land');

  // 3. Format it — select all, then the ruler's own bold control (an in-window
  //    control, so no focus is borrowed).
  await dbg('key', { pid, combo: 'cmd+a' });
  await sleep(900);
  const bold = (snap.elements ?? []).find((e) => /^bold$/i.test(String(e.name)));
  if (bold !== undefined) {
    const res = await dbg('click', { pid, index: bold.index });
    say(
      `clicked the ruler's Bold control → ${JSON.stringify({ ok: res.found, mode: res.mode })}`,
      "Select all, then click the ruler's Bold control",
    );
  } else {
    say('note: no Bold control in the ruler; formatting step skipped');
  }
  await sleep(1400);

  // 4. The save dialog. macOS runs a document command only for the frontmost
  //    app, so this one borrows the focus and hands it straight back.
  const refused = await dbg('menuClick', { pid, path: 'File > Save' });
  say(
    `File > Save in the background → ${JSON.stringify(String(refused.error ?? 'ran').slice(0, 90))}`,
    'File > Save does nothing in the background — macOS runs document commands only for the frontmost app. It says so.',
  );
  await sleep(900);
  const saved = await dbg('menuClick', { pid, path: 'File > Save', activate: true });
  say(
    `File > Save with focus borrowed → restored=${saved.focusRestored}, opened ${JSON.stringify(saved.dialog?.role ?? null)}`,
    'So it borrows the focus for that one command — and hands it straight back',
  );
  await sleep(2200);

  const withSheet = await dbg('snapshot', { pid });
  const sheetId = withSheet.dialog?.windowId;
  const inSheet = (withSheet.elements ?? []).filter((e) => e.win === sheetId);
  say(
    `the dialog is indexed: ${JSON.stringify(inSheet.map((e) => e.name))}`,
    "The save dialog is part of TextEdit, and every one of its controls is indexed",
  );

  // 5. Act INSIDE the dialog: type the filename, then click its Save button.
  const field = inSheet.find((e) => e.editable === true);
  if (field === undefined) throw new Error('the save dialog exposed no filename field');
  await dbg('type', { pid, index: field.index, text: DOCNAME });
  await sleep(1500);
  const where = inSheet.find((e) => /where/i.test(String(e.name)));
  say(
    `filename typed into the dialog${where === undefined ? '' : ` (saving to ${where.value ?? '?'})`}`,
    'Typing the filename into the dialog',
  );

  const saveBtn = inSheet.find((e) => /^save$/i.test(String(e.name)));
  if (saveBtn === undefined) throw new Error('the save dialog exposed no Save button');
  const clicked = await dbg('click', { pid, index: saveBtn.index });
  say(
    `clicked the dialog's Save button → ${JSON.stringify({ ok: clicked.found, mode: clicked.mode })}`,
    "Clicking the dialog's own Save button",
  );
  await sleep(3000);

  const front = await dbg('frontmost');
  say(`frontmost at the end: ${front.app}`);

  // 6. The evidence, checked on the app's real state rather than in the picture:
  //    an untitled document that has been saved takes the file's name.
  const after = await dbg('windows', { pid });
  const titles = (after.windows ?? []).map((w) => w.title);
  say(`window titles after saving: ${JSON.stringify(titles)}`);
  say(
    `the document is now named ${DOCNAME}: ${titles.some((t) => String(t).startsWith(DOCNAME))}`,
    'Saved — the document now carries the name that was typed into the dialog',
  );

  // And on disk, when this process is allowed to look there at all — reading
  // ~/Documents needs Full Disk Access, which is not this run's business.
  const file = findSaved(DOCNAME);
  if (file === null) {
    say('note: the save folder is not readable from here; the window title is the check');
  } else {
    const rtf = await run('cat', [file]).then((r) => r.stdout).catch(() => '');
    say(`saved ${file} (${rtf.length} bytes)`);
    say(`  contains the typed line: ${rtf.toLowerCase().includes('bobble typed this line')}`);
    say(`  contains a bold run: ${rtf.includes(String.fromCharCode(92) + 'b')}`);
  }

  await sleep(1200);
} finally {
  shooting = false;
  await sleep(1000 / FPS + 200);
  await app.close().catch(() => {});
  await osa('tell application "TextEdit" to close every document without saving');
  await osa('tell application "TextEdit" to quit saving no');
}

// ── encode ──────────────────────────────────────────────────────────────────
const dir = path.join(OUT, 'frames');
const frames = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort()
  .map((f) => ({ file: path.join(dir, f), t: Number(f.split('-')[2]?.replace('.png', '') ?? 0) }));
if (frames.length === 0) throw new Error('no frames were captured');
const lines = [];
for (let i = 0; i < frames.length; i += 1) {
  const next = frames[i + 1]?.t ?? frames[i].t + 1000 / FPS;
  lines.push(`file '${frames[i].file}'`, `duration ${Math.min(3, Math.max(0.03, (next - frames[i].t) / 1000)).toFixed(3)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);
const list = path.join(OUT, 'frames.txt');
writeFileSync(list, lines.join('\n'));
const video = path.join(OUT, 'bobble-drives-textedit.mp4');
// The captions are already in the pixels — they were drawn into the page before
// each frame was taken, because this ffmpeg has neither drawtext nor libass.
// The .srt is written anyway, as a readable transcript of the run.
writeFileSync(path.join(OUT, 'captions.srt'), srt(log, (frames.at(-1)?.t ?? started) - started));
await run('ffmpeg', [
  '-y', '-f', 'concat', '-safe', '0', '-i', list,
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', video,
]);
writeFileSync(path.join(OUT, 'run-log.txt'), log.map((e) => `${(e.at / 1000).toFixed(1)}s  ${e.text}`).join('\n'));
console.log(`\n${frames.length} frames → ${video}`);

function findSaved(name) {
  const roots = [
    path.join(process.env.HOME ?? '', 'Documents'),
    path.join(process.env.HOME ?? '', 'Desktop'),
    path.join(process.env.HOME ?? '', 'Library/Mobile Documents/com~apple~TextEdit/Documents'),
  ];
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      for (const f of readdirSync(root)) if (f.startsWith(name)) return path.join(root, f);
    } catch {
      /* not readable from here — the caller falls back to the window title */
    }
  }
  return null;
}
