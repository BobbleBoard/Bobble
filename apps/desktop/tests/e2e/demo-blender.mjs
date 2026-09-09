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
 * The task is deliberately the smallest real one — delete the default cube —
 * because the interesting measurement is whether a model can locate anything in
 * a dense custom UI at all, not whether it can model.
 *
 * VERIFIED FROM OUTSIDE. Blender tells Accessibility nothing about its scene, so
 * the run cannot check itself; the window title is the one signal it does give
 * (Blender marks an edited file). The scene itself is checked separately, from
 * this session's Blender MCP, so the evidence never comes from the model.
 */
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'qwen3.5-9b-mtp';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';

await demoRun({
  name: process.env.RUN_NAME ?? `blender-${MODEL}-${MODE}`,
  app: 'Blender',
  model: MODEL,
  mode: MODE,
  prompt:
    'Use Blender on this Mac to delete the default cube from the scene. ' +
    'It draws its own interface, so look at its window and work from what you see. ' +
    'Then tell me what you did and what the viewport shows now.',
  verify: async (dbg, last) => {
    const snap = await dbg('snapshot', { app: 'Blender' });
    const shot = await dbg('screenshot', { app: 'Blender' }).catch(() => null);
    return {
      window: snap.window,
      axElements: (snap.elements ?? []).length,
      // Proof the pixels were actually there for it to work from — a Blender run
      // without them is measuring something else entirely.
      screenshotBytes: shot?.base64 ? shot.base64.length : 0,
      modelDescribedResult: last.text.length > 0,
    };
  },
});
