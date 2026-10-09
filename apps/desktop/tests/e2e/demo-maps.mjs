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

/*
 * A DIFFERENT PLACE EVERY RUN.
 *
 * The user: "make sure you vary some tasks so that for example it doesn't open maps
 * like it just did to the golden gate already there." The user is right that it
 * invalidates the measurement: after one run the place is in Maps' Recents, and
 * the next model can find it without searching — one of them said as much in its
 * own reasoning ("there's already a Golden Gate Bridge entry in the recents
 * list"). The task has to be new to the app each time or it stops being a task.
 */
const PLACES = [
  'Sydney Opera House',
  'Mount Fuji',
  'Colosseum, Rome',
  'Table Mountain',
  'Reykjavik Harbour',
  'Machu Picchu',
];
const PLACE =
  process.env.PLACE ?? PLACES[Math.floor(Math.random() * PLACES.length)] ?? 'Mount Fuji';
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
    /*
     * A VERDICT, ON THE SAME THREE-ANSWER RULE AS THE CHROME DEMO.
     *
     * This demo collected all the evidence and then never said what it meant,
     * so the matrix ledger's verdict column came back "?" — and since Blender
     * did the same, NINE of the twelve runs were unscoreable. The evidence was
     * always here; only the sentence was missing.
     *
     * `pass` only on the app's OWN evidence (Maps is showing the place),
     * `unseen` when Maps exposed nothing to judge on at all — which is not the
     * same as failing, and mis-scoring it would mark a good model bad — and
     * `fail` when Maps was readable and the place is not in it. The model's own
     * claim is recorded beside it and deliberately does not decide anything.
     */
    const mapsMentionsPlace = shown.includes(needle) || shown.includes(word);
    const verdict = els.length === 0 ? 'unseen' : mapsMentionsPlace ? 'pass' : 'fail';

    return {
      verdict,
      searchField: field?.value ?? null,
      window: snap.window,
      mapsMentionsPlace,
      modelMentionsPlace: last.text.toLowerCase().includes(word),
      elements: els.length,
    };
  },
});
