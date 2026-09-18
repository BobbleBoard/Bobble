/**
 * THE MODEL ITSELF, through the connector's own wire. the user (2026-09-17): "3d
 * should be a connector … the card … a little embedded viewport rotatable".
 *
 * Drives the REAL engine (hidden app, throwaway HOME on the real cache) the
 * way the harness's `generate_3d` / `refine_3d` do: over the gen3d bridge
 * socket, with the harness's own client. A grey text→3D build (Mage-Flow for
 * the picture, TRELLIS.2 for the shape, no bake), then a rig of the result.
 * Each answer is a .glb the probe then seeds into the chat exactly as the tool
 * would report it, and photographs as the card — a real result in the real
 * card, with the controls the file earns.
 *
 * Also the gate: with the connector on and the engine here, the pi the app
 * spawns is told PI_BOBBLE_3D_READY=1 (the mock records it).
 *
 *   SHOT_DIR=/tmp/model-real node apps/desktop/tests/e2e/model-tool-real-probe.mjs
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { launchApp, probeHome } from './harness.mjs';

/*
 * The harness's bridge client, in miniature: one line in, one line out (the
 * wire contract itself is pinned by gen3d-bridge.test.ts against the real
 * client; a plain node script cannot import the TypeScript package).
 */
function bridgeCall(sock, token, method, params, timeoutMs = 45 * 60_000) {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    let buffer = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timed out' }), timeoutMs);
    socket.on('connect', () => {
      socket.setEncoding('utf8');
      socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, nl)));
      } catch {
        done({ ok: false, error: 'bad reply' });
      }
    });
    socket.on('error', (e) => done({ ok: false, error: String(e) }));
  });
}
/** The tool result the harness writes (model-tools.ts modelToolResult), verbatim in shape. */
function toolResultText(verb, abs, root) {
  const url = `pd-file://f${abs.split('/').map(encodeURIComponent).join('/')}`;
  const rel = path.relative(root, abs);
  return `${url}\n${verb} ${abs}\nRefer to it as "${rel}" — the path relative to the working folder; the model is shown in the chat as a card the user can turn.`;
}

const SHOT_DIR = process.env.SHOT_DIR ?? '/tmp/model-real';
mkdirSync(SHOT_DIR, { recursive: true });
const home = probeHome('model-real');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  `${JSON.stringify(
    {
      userMode: 'power',
      moduleConnectors: { '3d': true },
      /* This probe HOME's own reserve (never the shared settings): the
         guardian keeps `reserve` GB untouched beside the job, and a Mac
         carrying a desktop's worth of other apps has been MEASURED at 14.2 GB
         available against 12.5 + 4 needed. Two is the smallest the policy
         allows; the shipped default stays 4. */
      powerReserveGB: 2,
    },
    null,
    2,
  )}\n`,
);
const SOCK = path.join(home, 'gen3d-probe.sock');
const TOKEN = 'probe-token-3d';
const piLog = path.join(home, 'mock-pi.log');
const { page, check, finish } = await launchApp('model-real', {
  realCache: true,
  waitFor: '[data-testid="composer-input"]',
  env: {
    HOME: home,
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    // The app publishes these for pi; stated here so the probe can be pi.
    PI_DESKTOP_GEN3D_SOCK: SOCK,
    PI_DESKTOP_GEN3D_TOKEN: TOKEN,
    MOCK_PI_LOG: piLog,
  },
  timeout: 120_000,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (patch) => page.evaluate((p) => window.__pi_store().setState(p), patch);
const shot = (label) => page.screenshot({ path: `${SHOT_DIR}/${label}.png` });
const clip = async (label, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  if (box) {
    await page.screenshot({
      path: `${SHOT_DIR}/${label}.png`,
      clip: {
        x: Math.max(0, box.x - 24),
        y: Math.max(0, box.y - 24),
        width: box.width + 48,
        height: box.height + 48,
      },
    });
  } else await shot(label);
};
const client = { call: (method, params) => bridgeCall(SOCK, TOKEN, method, params) };

const call = (id, name, args, ts) => ({
  kind: 'assistant',
  id: `a-${id}`,
  blocks: [{ type: 'toolCall', id, name, arguments: args }],
  timestamp: ts,
  isStreaming: false,
});
const result = (id, name, text, ts) => ({
  kind: 'toolResult',
  id: `tr-${id}`,
  toolCallId: id,
  toolName: name,
  text,
  isError: false,
  timestamp: ts,
});
const readCard = (n) =>
  page.evaluate((n) => {
    const card = document.querySelectorAll('[data-testid="media-card"][data-kind="model"]')[n];
    const host = card?.querySelector('.pd-media-model-host');
    return card
      ? {
          framing: host?.dataset.pdFraming ? JSON.parse(host.dataset.pdFraming) : null,
          buttons: [
            ...(card.querySelector('[data-testid="model-controls"]')?.querySelectorAll('button') ??
              []),
          ].map((b) => b.textContent),
          skeleton: host?.dataset.pdSkeleton ?? null,
          caption: card.querySelector('.pd-media-meta')?.textContent ?? null,
        }
      : null;
  }, n);
const framed = (n) =>
  page.waitForFunction(
    (n) => {
      const hosts = [
        ...document.querySelectorAll(
          '[data-testid="media-card"][data-kind="model"] .pd-media-model-host',
        ),
      ];
      return hosts.length === n && hosts.every((h) => h.dataset.pdFraming !== undefined);
    },
    n,
    { timeout: 120_000, polling: 500 },
  );

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', { timeout: 60_000 });
  await sleep(2000);
  // The gate, as the app decided it for the pi it spawned.
  const gates = readFileSync(piLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'spawn')
    .map((r) => r.gates?.PI_BOBBLE_3D_READY);
  check(
    gates.at(-1) === '1',
    `pi is told the 3D tools may register on this Mac with the connector on (${JSON.stringify(gates)})`,
  );

  /*
   * A REAL MODEL TO WORK ON: an engine output from this Mac's own runs (an
   * astronaut, textured), copied into the probe HOME's engine sandbox — where
   * a result lands today and inside the pd-file fence. The stage legs
   * (retopo, rig) are light (2 GB / 1 GB footprints) and deterministic; the
   * generate leg from its picture is the heavy one and comes last.
   */
  // A bake from AFTER the dark-crackle fix (65b6ae02): the retopo re-bakes
  // from the source's texture, so a pre-fix source would hand its gutters on.
  const OLD = path.join(homedir(), '.pi', 'desktop', 'sandbox', 'gen3d', '385fa85ad18b');
  const dir = path.join(home, '.pi', 'desktop', 'sandbox', 'gen3d', 'probe-src');
  mkdirSync(dir, { recursive: true });
  const modelPath = path.join(dir, 'model.glb');
  const imagePath = path.join(dir, 'prompt-image.png');
  copyFileSync(path.join(OLD, 'model.glb'), modelPath);
  copyFileSync(path.join(OLD, 'prompt-image.png'), imagePath);
  const srcText = toolResultText('Generated 3D model saved at', modelPath, home);
  const thread = [
    { kind: 'user', id: 'u1', text: 'make me an astronaut', timestamp: 1 },
    call('g1', 'generate_3d', { prompt: 'an astronaut', finish: 'pbr' }, 2),
    result('g1', 'generate_3d', srcText, 3),
  ];
  await set({ session: { cwd: home }, messages: thread, agent: { isStreaming: false } });

  /* ── 1. refine_3d retopo (quick), over the wire ── */
  const t0 = Date.now();
  const retopo = await client.call('refine_3d', { op: 'retopo', modelPath });
  const retopoSec = Math.round((Date.now() - t0) / 1000);
  console.log('refine_3d retopo', JSON.stringify(retopo), `${retopoSec}s`);
  check(
    retopo.ok === true,
    `refine_3d retopo answered in ${retopoSec}s: ${JSON.stringify(retopo)}`,
  );
  if (retopo.ok) {
    check(
      retopo.path !== modelPath &&
        retopo.path.endsWith('.glb') &&
        existsSync(retopo.path) &&
        statSync(retopo.path).size > 10_000,
      `the retopo is a NEW .glb on disk (${retopo.path}, ${existsSync(retopo.path) ? statSync(retopo.path).size : 0} B)`,
    );
    check(
      retopo.path.startsWith(path.join(home, '.pi', 'desktop', 'sandbox', 'gen3d')),
      `…inside the fence the card can read (${retopo.path})`,
    );
    thread.push(
      { kind: 'user', id: 'u2', text: 'make a low-poly version', timestamp: 4 },
      call('g2', 'refine_3d', { model_path: path.relative(home, modelPath), op: 'retopo' }, 5),
      result(
        'g2',
        'refine_3d',
        toolResultText('Retopologised model saved at', retopo.path, home),
        6,
      ),
    );
    await set({ messages: [...thread] });
    await framed(2);
    await sleep(1200);
    await page
      .locator('[data-testid="media-card"][data-kind="model"]')
      .nth(1)
      .scrollIntoViewIfNeeded();
    await sleep(400);
    const card = await readCard(1);
    console.log('retopo card', JSON.stringify(card));
    await clip('1-retopo-card', '[data-testid="media-card"][data-kind="model"] >> nth=1');
    check(
      card?.framing?.bodies >= 1 &&
        JSON.stringify(card.buttons) === JSON.stringify(['Color', 'Normals', 'Grey']),
      `the real low-poly result is in the card with Color / Normals / Grey (${JSON.stringify(card)})`,
    );
  }

  /* ── 2. refine_3d rig, on the astronaut ── */
  const t1 = Date.now();
  const rig = await client.call('refine_3d', { op: 'rig', modelPath });
  const rigSec = Math.round((Date.now() - t1) / 1000);
  console.log('refine_3d rig', JSON.stringify(rig), `${rigSec}s`);
  check(rig.ok === true, `refine_3d rig answered in ${rigSec}s: ${JSON.stringify(rig)}`);
  if (rig.ok) {
    check(
      rig.path !== modelPath && existsSync(rig.path),
      `the rig is a NEW file beside the original (${rig.path})`,
    );
    thread.push(
      { kind: 'user', id: 'u3', text: 'rig it', timestamp: 7 },
      call('g3', 'refine_3d', { model_path: path.relative(home, modelPath), op: 'rig' }, 8),
      result('g3', 'refine_3d', toolResultText('Rigged model saved at', rig.path, home), 9),
    );
    await set({ messages: [...thread] });
    const n = thread.filter((m) => m.kind === 'toolResult').length;
    await framed(n);
    await sleep(1500);
    await page
      .locator('[data-testid="media-card"][data-kind="model"]')
      .nth(n - 1)
      .scrollIntoViewIfNeeded();
    await sleep(500);
    const card = await readCard(n - 1);
    console.log('rig card', JSON.stringify(card));
    await clip('2-rigged-card', `[data-testid="media-card"][data-kind="model"] >> nth=${n - 1}`);
    check(
      card?.framing?.skinned === true &&
        card.buttons.includes('Skeleton') &&
        card.skeleton === 'true',
      `the rigged result shows its skeleton with the Skeleton control (${JSON.stringify(card)})`,
    );
    await shot('3-thread');
  }

  /* ── 3. generate_3d from the picture, low, grey — the heavy leg ──
     Opt-in (REAL_GENERATE=1): a TRELLIS build is ~10 GB resident, and on a
     24 GB Mac carrying a desktop's worth of other apps the guardian has
     MEASURED-shed it at 102 s ("Stopped to keep your Mac responsive"). That
     is the machine, not the wire — the wire is the two legs above. */
  if (process.env.REAL_GENERATE !== '1') {
    console.log('generate leg skipped (REAL_GENERATE=1 runs it)');
  } else {
    const t2 = Date.now();
    const gen = await client.call('generate_3d', {
      imagePath,
      prompt: 'an astronaut',
      finish: 'grey',
      // The tool's own default: MEASURED 2026-09-18, medium (~19 GB) was refused
      // by the guardian with 15.8 GB free on this 24 GB Mac; low is ~10 GB.
      resolution: 'low',
    });
    const genSec = Math.round((Date.now() - t2) / 1000);
    console.log('generate_3d', JSON.stringify(gen), `${genSec}s`);
    check(
      gen.ok === true,
      `generate_3d (image → 3D, low, grey) answered with a model in ${genSec}s: ${JSON.stringify(gen)}`,
    );
    if (gen.ok) {
      check(
        gen.path.endsWith('.glb') && existsSync(gen.path) && statSync(gen.path).size > 50_000,
        `the answer is a real .glb on disk (${gen.path}, ${existsSync(gen.path) ? statSync(gen.path).size : 0} B)`,
      );
      thread.push(
        { kind: 'user', id: 'u4', text: 'make a fresh grey one from the picture', timestamp: 10 },
        call(
          'g4',
          'generate_3d',
          { image_path: path.relative(home, imagePath), finish: 'grey' },
          11,
        ),
        result(
          'g4',
          'generate_3d',
          toolResultText('Generated 3D model saved at', gen.path, home),
          12,
        ),
      );
      await set({ messages: [...thread] });
      const n = thread.filter((m) => m.kind === 'toolResult').length;
      await framed(n);
      await sleep(1500);
      await page
        .locator('[data-testid="media-card"][data-kind="model"]')
        .nth(n - 1)
        .scrollIntoViewIfNeeded();
      await sleep(500);
      const card = await readCard(n - 1);
      console.log('generated card', JSON.stringify(card));
      await clip(
        '4-generated-card',
        `[data-testid="media-card"][data-kind="model"] >> nth=${n - 1}`,
      );
      check(card?.framing?.bodies >= 1, `the fresh model is in the card (${JSON.stringify(card)})`);
    }
  }
} finally {
  await finish();
  rmSync(home, { recursive: true, force: true });
}
