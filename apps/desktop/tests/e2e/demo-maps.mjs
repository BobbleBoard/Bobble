/**
 * MAPS, driven by computer use.
 *
 * Chosen because it is honest about what it tests: Maps exposes a real
 * Accessibility tree (60 elements, a search field at the top), so this measures
 * whether a model can READ an indexed list and act on it — the ordinary case —
 * without the confound of coordinate guessing. Blender is the other end of that
 * scale and gets its own run.
 *
 * The search term is deliberately a place no model would answer from memory in
 * the same words the app renders: the evidence is what MAPS says afterwards, not
 * what the model says it did.
 */
import { demoRun } from './demo-run.mjs';

const PLACE = process.env.PLACE ?? 'Golden Gate Bridge';
const MODEL = process.env.MAC_CU_MODEL ?? 'qwen3.5-9b-mtp';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';

await demoRun({
  name: process.env.RUN_NAME ?? `maps-${MODEL}-${MODE}`,
  app: 'Maps',
  model: MODEL,
  mode: MODE,
  prompt:
    `Use the Maps app on this Mac to search for "${PLACE}". ` +
    `I want it showing in Maps itself, not just described to me. ` +
    `Then tell me what the app is showing.`,
  /* THE APP'S OWN STATE, not the transcript. A search that happened puts the
     term in the field and the place in the window; a model that only said it
     searched leaves both empty. */
  verify: async (dbg, last) => {
    const snap = await dbg('snapshot', { app: 'Maps' });
    const els = snap.elements ?? [];
    const field = els.find((e) => e.role === 'AXTextField');
    const shown = [
      field?.value ?? '',
      snap.window ?? '',
      ...(snap.text ?? []),
      ...els.map((e) => e.name ?? ''),
    ]
      .join(' | ')
      .toLowerCase();
    const needle = PLACE.toLowerCase();
    const word = needle.split(' ')[0] ?? needle;
    return {
      searchField: field?.value ?? null,
      window: snap.window,
      mapsMentionsPlace: shown.includes(needle) || shown.includes(word),
      modelMentionsPlace: last.text.toLowerCase().includes(word),
      elements: els.length,
    };
  },
});
