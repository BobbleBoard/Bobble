/**
 * A MODEL CHANGES A BLENDER SCENE THROUGH THE `blender` COMMAND — code, not clicks.
 *
 * The read-only path (`blender scene`) was verified 2026-10-07; a run that
 * CHANGES a scene waited on the user's OK to touch Blender, given 2026-10-09.
 *
 * Kept off the user's own work all the same: the scene is a throwaway copy of an
 * empty .blend, opened with `open -g` (Blender comes up behind whatever is in
 * front and never takes focus), and if Blender is ALREADY running — the user's
 * session, possibly with unsaved work — the probe stops and says so instead.
 *
 * Real app (hidden window, throwaway HOME, real weights), real model. The ask is
 * a small scene; the evidence is Blender's own object list read over the
 * add-on's socket after the turn, plus a render written by the probe, LOOKED AT.
 *
 *   MODEL (default qwen3.8-27b-mtp)   OUT (default $TMPDIR/blender-edit)
 */
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { launchApp, probeHome, REPO_ROOT } from './harness.mjs';

const run = promisify(execFile);
const MODEL = process.env.MODEL ?? 'qwen3.8-27b-mtp';
const OUT = process.env.OUT ?? path.join(tmpdir(), 'blender-edit');
mkdirSync(OUT, { recursive: true });
const SCENE = path.join(OUT, 'scene.blend');
const RENDER = path.join(OUT, 'probe-render.png');
const ASK =
  process.env.ASK ??
  'Using Blender, build this scene: a large grey ground plane, a red cube resting on the plane at the centre, ' +
    'a blue sphere resting on the plane to the right of the cube, a sun light, and a camera looking at both. ' +
    'Then render a preview image and show it to me.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);

/** Run bpy code in Blender over the add-on's socket; resolves its reply. */
function askBlender(code, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 9876 });
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('blender did not answer'));
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'execute', code, strict_json: true })}\0`);
    });
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      const nul = buf.indexOf('\0');
      if (nul !== -1) {
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(buf.slice(0, nul)));
        } catch (e) {
          reject(e);
        }
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const blenderRunning = async () => {
  try {
    const { stdout } = await run('pgrep', ['-x', 'Blender']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
};

if (await blenderRunning()) {
  console.log(
    'blender-edit: Blender is already open — that is the user’s session; not touching it.',
  );
  process.exit(2);
}

copyFileSync(path.join(REPO_ROOT, 'scratchpad', 'demos', 'empty-scene.blend'), SCENE);
log('opening a throwaway scene in Blender, behind everything (open -g)…');
await run('open', ['-g', '-a', 'Blender', SCENE]);
let up = false;
for (let i = 0; i < 120 && !up; i += 1) {
  try {
    const r = await askBlender('result["file"] = bpy.data.filepath', 3000);
    up = r?.status === 'ok' && String(r.result?.file ?? '').endsWith('scene.blend');
  } catch {
    await sleep(1000);
  }
}
if (!up) {
  console.log('blender-edit: Blender’s add-on never answered on 9876');
  await run('osascript', ['-e', 'tell application "Blender" to quit']).catch(() => {});
  process.exit(1);
}
const before = await askBlender('result["objects"] = [o.name for o in bpy.data.objects]');
log(`blender up; scene objects before: ${JSON.stringify(before.result?.objects)}`);

const DIAG = path.join(OUT, 'prompts.log');
writeFileSync(DIAG, '');
writeFileSync(`${DIAG}.bodies.jsonl`, '');
const home = probeHome('blender-edit');
writeFileSync(
  path.join(home, '.pi', 'desktop', 'settings.json'),
  JSON.stringify({ userMode: 'power', modelSelection: { mode: 'model', modelId: MODEL } }),
);
const { app, page, check, shot, finish } = await launchApp('blender-edit', {
  realCache: true,
  env: {
    HOME: home,
    PI_BIN: undefined,
    HF_HOME: path.join(homedir(), '.cache', 'huggingface'),
    PI_DIAG_PROMPTS: DIAG,
    PI_DIAG_PROMPTS_FULL: '1',
  },
  waitFor: '[data-testid="composer-input"]',
  timeout: 120_000,
});
const APP_LOG = path.join(OUT, 'app.log');
writeFileSync(APP_LOG, '');
for (const s of [app.process().stderr, app.process().stdout]) {
  s?.on('data', (c) => appendFileSync(APP_LOG, c));
}

try {
  await page.waitForFunction(() => typeof window.__pi_store === 'function', undefined, {
    timeout: 60_000,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async (modelId) => {
    await window.piDesktop.invoke('pi:start', {});
    await window.piDesktop.invoke('llm:start-server', { modelId });
  }, MODEL);
  await page.waitForFunction(
    (m) => {
      const s = window.__llm_store?.().getState().status;
      return s?.model?.id === m && s.phase === 'ready' && s.serverRunning === true;
    },
    MODEL,
    { timeout: 600_000 },
  );
  await page.waitForFunction(
    (m) => (window.__pi_store().getState().agent.model?.id ?? '').startsWith(m),
    MODEL,
    { timeout: 120_000 },
  );
  log(`${MODEL} ready`);
  await sleep(6000);

  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(ASK);
  await page.keyboard.press('Enter');
  log('asked; waiting for the turn to finish…');
  await page.waitForFunction(
    () => window.__pi_store().getState().agent.isStreaming === true,
    undefined,
    { timeout: 120_000 },
  );
  await page.waitForFunction(
    () => {
      const s = window.__pi_store().getState();
      return s.agent.isStreaming !== true && s.promptInFlight !== true;
    },
    undefined,
    { timeout: 1_800_000, polling: 1000 },
  );
  log('turn finished');

  // What the model ran: the blender commands in the chain.
  const commands = await page.evaluate(() =>
    window
      .__pi_store()
      .getState()
      .messages.flatMap((m) => m.blocks ?? [])
      .filter((b) => b.type === 'toolCall' || b.type === 'tool_call' || b.toolName !== undefined)
      .map((b) => JSON.stringify(b.args ?? b.arguments ?? b.input ?? {}).slice(0, 160)),
  );
  writeFileSync(path.join(OUT, 'commands.txt'), commands.join('\n'));
  log(`${commands.length} tool calls (OUT/commands.txt)`);

  // The evidence: Blender's own scene, read after the turn.
  const scene = await askBlender(`
objs = []
for o in bpy.data.objects:
    col = None
    if o.type == 'MESH' and o.active_material is not None:
        m = o.active_material
        if m.use_nodes and m.node_tree is not None:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    col = [round(x, 2) for x in n.inputs['Base Color'].default_value[:3]]
        if col is None:
            col = [round(x, 2) for x in m.diffuse_color[:3]]
    objs.append({'name': o.name, 'type': o.type, 'loc': [round(x, 2) for x in o.location],
                 'dims': [round(x, 2) for x in o.dimensions], 'color': col,
                 'data': (o.data.type if o.type == 'LIGHT' else (o.data.name if o.data else None))})
result['objects'] = objs
result['camera'] = bpy.context.scene.camera.name if bpy.context.scene.camera else None
`);
  const objs = scene.result?.objects ?? [];
  writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify(scene.result, null, 1));
  for (const o of objs)
    log(
      `   ${o.type.padEnd(7)} ${o.name.padEnd(16)} loc=${JSON.stringify(o.loc)} color=${JSON.stringify(o.color)} ${o.data ?? ''}`,
    );
  const meshes = objs.filter((o) => o.type === 'MESH');
  const reddish = (c) => Array.isArray(c) && c[0] > 0.5 && c[1] < 0.35 && c[2] < 0.35;
  const bluish = (c) => Array.isArray(c) && c[2] > 0.5 && c[0] < 0.35;
  check(meshes.length >= 3, `at least three meshes (plane, cube, sphere): ${meshes.length}`);
  check(
    meshes.some((o) => /cube/i.test(o.name) && reddish(o.color)),
    'a red cube',
  );
  check(
    meshes.some((o) => /sphere/i.test(o.name) && bluish(o.color)),
    'a blue sphere',
  );
  check(
    objs.some((o) => o.type === 'LIGHT'),
    'a light',
  );
  check(scene.result?.camera !== null, 'a scene camera');

  // A render of our own, to LOOK at (the model's own preview is in the chat).
  const r = await askBlender(
    `
scn = bpy.context.scene
scn.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else scn.render.engine
scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage = 960, 540, 100
scn.render.filepath = ${JSON.stringify(RENDER)}
bpy.ops.render.render(write_still=True)
result['ok'] = True
`,
    180_000,
  ).catch((e) => ({ status: 'error', message: String(e) }));
  log(
    `probe render: ${r.status === 'ok' && existsSync(RENDER) ? RENDER : JSON.stringify(r).slice(0, 200)}`,
  );
  await shot('01-chat-after-blender');
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="thread-scroll"], .pd-thread-scroll');
    el?.scrollTo?.(0, 0);
  });
  await shot('02-chat-top');
} catch (error) {
  check(false, `probe error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // Save the throwaway copy (so quitting raises no "save changes?" sheet), then quit.
  await askBlender('bpy.ops.wm.save_mainfile()').catch(() => {});
  await run('osascript', ['-e', 'tell application "Blender" to quit']).catch(() => {});
  for (let i = 0; i < 20 && (await blenderRunning()); i += 1) await sleep(500);
  log(`blender ${(await blenderRunning()) ? 'STILL RUNNING' : 'closed'}`);
  const appLog = existsSync(APP_LOG) ? readFileSync(APP_LOG, 'utf8') : '';
  writeFileSync(
    path.join(OUT, 'blender-lines.txt'),
    appLog
      .split('\n')
      .filter((l) => /blender/i.test(l))
      .join('\n'),
  );
  await finish();
}
