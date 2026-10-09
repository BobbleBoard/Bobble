/**
 * BLENDER — the hard end of the scale, and the reason this matrix exists.
 *
 * Blender draws its entire interface itself. MEASURED: an Accessibility
 * snapshot returns THREE elements — close, zoom, minimize — and two menu bar
 * titles. There is no indexed list to act on, so this is coordinate work off a
 * screenshot, which is the case the user wants gauged: "this data will be really
 * good to have to gauge computer use capabilities on difficult apps."
 *
 * It is therefore also the only app here that cannot work at all without the
 * Screen Recording grant: with no pixels the model is acting blind.
 *
 * THE TASK IS TO ADD, NOT TO DELETE. It was "delete the default cube" until the
 * scene was checked from outside: the user's startup file is EMPTY —
 * `bpy.data.objects` is `[]`, no cube, no camera, no light. So the task had no
 * cube to delete and every run "passed" by doing nothing, which is the same
 * mistake as asking for a Maps place that was already on screen. Adding a
 * primitive cannot be passed by inaction, and it is the same kind of work:
 * find the Add menu in a dense custom interface and drive it.
 *
 * VERIFIED FROM INSIDE BLENDER. The scene is read over the MCP add-on's own
 * socket while Blender is still up, so the evidence is Blender's object list
 * rather than the model's account of it — and a screenshot is written next to
 * the video so the viewport can be LOOKED AT (the user: "videos should be visually
 * verified by frames after significant actions").
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoRun } from './demo-run.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

const MODEL = process.env.MAC_CU_MODEL ?? 'qwen3.5-9b-mtp';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';

/* A different primitive per run, so a scene left dirty by an earlier run cannot
   be mistaken for this one's success. */
const SHAPES = [
  { name: 'cube', type: 'MESH', match: /cube/i },
  { name: 'UV sphere', type: 'MESH', match: /sphere/i },
  { name: 'cylinder', type: 'MESH', match: /cylinder/i },
  { name: 'cone', type: 'MESH', match: /cone/i },
];
const SHAPE = SHAPES[Math.floor(Math.random() * SHAPES.length)] ?? SHAPES[0];

/*
 * NO_SPLASH=1 — the same task, minus Blender's welcome screen.
 *
 * MEASURED across all six cold runs: none of them got past the splash. A 4B
 * clicked four times inside it, a 27B left its cursor hovering "Sculpting", and
 * not one model reached the Add menu the task is actually about. That IS a
 * finding — an unfamiliar modal stops every model here — but it means the cold
 * runs cannot say anything about driving Blender itself, because nothing ever
 * drove Blender.
 *
 * Opening a FILE skips the splash (Blender only shows it for an empty start), so
 * this variant hands the model the same empty scene with the interface already
 * on screen. The two together separate "can you dismiss a modal you have never
 * seen" from "can you find a menu in a dense custom interface".
 */
const NO_SPLASH = process.env.NO_SPLASH === '1';
const SCENE = `${REPO_ROOT}/scratchpad/demos/empty-scene.blend`;

/**
 * Ask the running Blender what is in its scene.
 *
 * The add-on speaks null-delimited JSON on 127.0.0.1:9876 (the name resolves to
 * ::1 first, where it is not listening) and autostarts with
 * Blender, so this needs no setup — and it is the only channel that can answer
 * the question at all, since Blender tells Accessibility nothing about a scene.
 */
function askBlender(code, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 9876 });
    let buf = '';
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done({ error: 'timeout' }));
    socket.on('error', (e) => done({ error: String(e.message ?? e) }));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'execute', code, strict_json: true })}\0`);
    });
    socket.on('data', (d) => {
      buf += d.toString();
      const nul = buf.indexOf('\0');
      if (nul < 0) return;
      try {
        done(JSON.parse(buf.slice(0, nul)));
      } catch (e) {
        done({ error: `bad response: ${String(e)}` });
      }
    });
  });
}

if (NO_SPLASH) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('osascript', ['-e', 'tell application "Blender" to quit']).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  // -g so preparing the scene never takes the screen the run must not take.
  await run('open', ['-g', '-a', 'Blender', SCENE]);
  await new Promise((r) => setTimeout(r, 9000));
}

await demoRun({
  name: process.env.RUN_NAME ?? `blender-${MODEL}-${MODE}`,
  app: 'Blender',
  // With the scene already open, the run must not restart Blender — that would
  // put the splash straight back.
  attach: NO_SPLASH,
  model: MODEL,
  mode: MODE,
  prompt:
    `Use Blender on this Mac to add a ${SHAPE.name} to the scene. ` +
    'It draws its own interface, so look at its window and work from what you see. ' +
    'Then tell me what you did and what the viewport shows now.',
  verify: async (dbg, last) => {
    const snap = await dbg('snapshot', { app: 'Blender' });
    const shot = await dbg('screenshot', { app: 'Blender' }).catch(() => null);

    let shotPath = null;
    if (shot?.base64) {
      const dir = path.join(
        `${REPO_ROOT}/scratchpad/demos`,
        process.env.RUN_NAME ?? `blender-${MODEL}-${MODE}`,
      );
      mkdirSync(dir, { recursive: true });
      shotPath = path.join(dir, 'blender-final.png');
      writeFileSync(shotPath, Buffer.from(shot.base64, 'base64'));
    }

    const scene = await askBlender(
      'import bpy\nresult = {"objects": [[o.name, o.type] for o in bpy.data.objects]}',
    );
    const objects = scene?.result?.objects ?? scene?.objects ?? [];
    const names = Array.isArray(objects) ? objects.map((o) => (Array.isArray(o) ? o[0] : o)) : [];

    const shapeInScene = names.some((n) => SHAPE.match.test(String(n)));
    /*
     * THE VERDICT — same three-answer rule as the Chrome demo, and for the same
     * reason: a false failure is worse than no answer.
     *
     * Blender is the best-placed of the three to be judged, because the
     * evidence is Blender's own `bpy.data.objects` rather than anything read off
     * a screen. So `unseen` is reserved for the one case where that evidence is
     * genuinely missing — the scene query itself failed — and everything else
     * is a real pass or a real fail.
     */
    const noEvidence = scene == null || scene.error != null;
    const verdict = noEvidence ? 'unseen' : shapeInScene ? 'pass' : 'fail';

    return {
      verdict,
      asked: SHAPE.name,
      // Blender's OWN answer, not the model's.
      sceneObjects: names,
      shapeInScene,
      sceneQuery: scene?.error ?? 'ok',
      finalScreenshot: shotPath,
      window: snap.window,
      axElements: (snap.elements ?? []).length,
      screenshotBytes: shot?.base64 ? shot.base64.length : 0,
      modelDescribedResult: last.text.length > 0,
    };
  },
});
