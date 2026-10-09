/**
 * VISION IS ON UNLESS THE USER TURNS IT OFF — live, on a real model.
 *
 * The user (2026-09-23): "mmproj/vision should always be loaded and usable by
 * default unless explicitly turned off, put this in the engines option and
 * leave a setting to not load vision by default." And the note their computer-use
 * runs kept getting — "this model is currently running in TEXT-ONLY mode" —
 * which was true: the chosen engine could not see.
 *
 *   1. Default settings: the model starts WITH its projector, the vision-state
 *      file says `1`, and a picture of a red square is called red.
 *   2. Vision switched off (the engine menu's switch, through the store): the
 *      server comes back without the projector, the state says `0:off`, and an
 *      attached picture gets the honest note naming the switch — never the old
 *      "TEXT-ONLY mode".
 *
 * Real library + cache, throwaway HOME, hidden window.
 *
 *   MODEL=qwen3.5-4b-mtp OUT=/tmp/vision-default node apps/desktop/tests/e2e/vision-default-probe.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { _electron } from '@playwright/test';
import { probeHome } from './harness.mjs';

const MODEL = process.env.MODEL ?? 'qwen3.5-4b-mtp';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'vision-default');
mkdirSync(OUT, { recursive: true });
const CACHE = process.env.PI_DESKTOP_CACHE_DIR ?? path.join(homedir(), '.cache', 'bobble');
const LIBRARY = process.env.PI_DESKTOP_MODELS_DIR ?? path.join(homedir(), 'Bobble', 'Models');
const home = probeHome('vision-default');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }),
);
const userData = mkdtempSync(path.join(tmpdir(), 'vision-udd-'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const failures = [];
const check = (ok, msg) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

/** A 96×96 solid PNG, built here so the probe needs no fixture. */
function solidPng(r, g, b) {
  const W = 96;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const RED = solidPng(220, 20, 30);

const mainLog = [];
const app = await _electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
  env: {
    ...process.env,
    HOME: home,
    PI_DESKTOP_CACHE_DIR: CACHE,
    PI_DESKTOP_MODELS_DIR: LIBRARY,
    PI_E2E: '1',
    PI_E2E_BACKGROUND: '1',
  },
});
const onLog = (d) => {
  for (const line of String(d).split('\n')) if (line.trim() !== '') mainLog.push(line);
};
app.process().stdout?.on('data', onLog);
app.process().stderr?.on('data', onLog);
const visionState = () => {
  try {
    return readFileSync(path.join(userData, 'vision-state'), 'utf8').trim();
  } catch {
    return null;
  }
};

try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60000 });
  await win.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 });
  await win.waitForTimeout(1500);

  const ready = async (timeout = 300_000) =>
    win
      .waitForFunction(
        (m) => {
          const s = window.__llm_store?.().getState().status;
          return s?.model?.id === m && s.phase === 'ready' && s.serverRunning === true;
        },
        MODEL,
        { timeout },
      )
      .then(() => true)
      .catch(() => false);
  const status = () => win.evaluate(() => window.piDesktop.invoke('llm:get-status', undefined));
  const lastReply = () =>
    win.evaluate(() => {
      const rows = window.__pi_store().getState().messages;
      const last = [...rows].reverse().find((m) => m.kind === 'assistant');
      return (last?.blocks ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
    });
  const idle = () =>
    win.waitForFunction(
      () => {
        const s = window.__pi_store().getState();
        return s.agent.isStreaming !== true && s.promptInFlight !== true;
      },
      undefined,
      { timeout: 180_000 },
    );
  /** What the provider actually put in front of the model for the last turn. */
  const ask = async (text, images) => {
    await win.evaluate(({ text, images }) => window.__pi_send?.(text, images), { text, images });
    await win.waitForTimeout(800);
    await idle();
    await win.waitForTimeout(400);
    return lastReply();
  };

  /* ── 1. default: vision on ── */
  log(`starting ${MODEL} with default settings…`);
  await win.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  check(await ready(), 'the model server came up');
  await win.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 60_000 },
  );
  await win.waitForTimeout(3000);
  const on = await status();
  log(
    'status:',
    JSON.stringify({
      profile: on.profile,
      visionReady: on.visionReady,
      blind: on.blindReason,
      fallback: on.visionFallback,
    }),
  );
  const visionLines = mainLog.filter((l) => /\[engine\] vision|--mmproj/.test(l));
  log('engine vision lines:', visionLines.slice(-3).join(' | '));
  check(
    visionState() === '1',
    `vision-state is "1" by default (read ${JSON.stringify(visionState())})`,
  );
  check(on.visionReady === true, 'the server reports it can read images (projector attached)');
  const seen = await ask('What colour is this picture? Reply with one word.', [RED]);
  log('reply (vision on):', JSON.stringify(seen));
  check(/red/i.test(seen), `the model SEES the picture: "${seen.slice(0, 80)}"`);
  await win.screenshot({ path: path.join(OUT, '1-vision-on.png') });

  /* ── 2. the switch: vision off, clicked in the engine menu ── */
  log('switching vision OFF (engine menu → Vision)…');
  await win.click('[data-testid="engine-menu-button"]');
  await win.waitForSelector('[data-testid="engine-vision"]', { timeout: 10_000 });
  await win.waitForTimeout(400);
  const menuBox = await win.locator('[data-testid="engine-menu"]').boundingBox();
  if (menuBox !== null) {
    await win.screenshot({
      path: path.join(OUT, '1b-engine-menu-vision-on.png'),
      clip: {
        x: Math.max(0, menuBox.x - 8),
        y: Math.max(0, menuBox.y - 8),
        width: menuBox.width + 16,
        height: menuBox.height + 16,
      },
    });
  }
  log('vision row:', await win.textContent('[data-testid="engine-vision-line"]'));
  await win.click('[data-testid="engine-vision-switch"]');
  await win.waitForTimeout(1500);
  await win
    .waitForFunction(
      () => {
        const s = window.__llm_store?.().getState().status;
        return s?.phase === 'ready' && s.serverRunning === true && s.blindReason === 'off';
      },
      undefined,
      { timeout: 300_000 },
    )
    .catch(() => {});
  await win.waitForTimeout(800);
  if (menuBox !== null && (await win.$('[data-testid="engine-menu"]')) !== null) {
    await win.screenshot({
      path: path.join(OUT, '2b-engine-menu-vision-off.png'),
      clip: {
        x: Math.max(0, menuBox.x - 8),
        y: Math.max(0, menuBox.y - 8),
        width: menuBox.width + 16,
        height: menuBox.height + 16,
      },
    });
  }
  log('vision row:', await win.textContent('[data-testid="engine-vision-line"]').catch(() => null));
  await win.keyboard.press('Escape');
  const off = await status();
  log(
    'status:',
    JSON.stringify({ profile: off.profile, visionReady: off.visionReady, blind: off.blindReason }),
  );
  check(off.blindReason === 'off', `the engine reports vision switched off (${off.blindReason})`);
  check(
    visionState() === '0:off',
    `vision-state names the reason (read ${JSON.stringify(visionState())})`,
  );
  await win.click('[data-testid="new-chat"]').catch(() => {});
  await win.waitForTimeout(1500);
  const blind = await ask('What colour is this picture? If you cannot see it, say exactly why.', [
    RED,
  ]);
  log('reply (vision off):', JSON.stringify(blind));
  const after = await status();
  check(
    after.blindReason === 'off' && after.visionReady !== true,
    `nothing relaunched behind the switch: still ${after.profile?.engine}/${after.profile?.spec}, blind=${after.blindReason}`,
  );
  const badge = await win
    .textContent('[data-testid="blind-image-note"]', { timeout: 3000 })
    .catch(() => null);
  check(
    /Vision is off/.test(badge ?? ''),
    `the picture in the thread says vision was off (${JSON.stringify(badge)})`,
  );
  check(!/TEXT-ONLY mode/i.test(blind), 'the reply never repeats the old "TEXT-ONLY mode" claim');
  check(
    /off|switch|vision|cannot|can't|unable/i.test(blind),
    `the model says plainly that it cannot see, and why: "${blind.slice(0, 120)}"`,
  );
  await win.screenshot({ path: path.join(OUT, '2-vision-off.png') });
} finally {
  writeFileSync(path.join(OUT, 'main.log'), mainLog.join('\n'));
  await app.close().catch(() => {});
  log(
    failures.length === 0 ? 'vision-default OK' : `vision-default: ${failures.length} failure(s)`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}
