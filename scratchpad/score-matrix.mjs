#!/usr/bin/env node
/**
 * Score every matrix run from its OWN recorded evidence.
 *
 * The three demos grew their verdicts at different times — Chrome had one from
 * the start, Maps and Blender did not, which is how nine of twelve runs came
 * back "?" — so reading the ledger's verdict column means reading a mix of
 * rules. This applies ONE rule to all of them, computed from the VERIFY line
 * each run already wrote, so a comparison across models is a comparison of
 * models rather than of which script version happened to run.
 *
 * The rule is the same three answers everywhere, and it is the app's own
 * evidence that decides — never the model's claim about itself:
 *
 *   chrome   pass = 2TB is the chosen storage radio; unseen = no radios on
 *            screen to read (a Chrome window exposes only its ACTIVE tab)
 *   maps     pass = Maps itself is showing the place; unseen = Maps exposed
 *            no elements at all
 *   blender  pass = the shape is in `bpy.data.objects`; unseen = the scene
 *            query failed, so there is no evidence either way
 *
 * `unseen` is deliberately not `fail`: across twelve runs a false failure
 * quietly marks a good model bad, which is worse than declining to answer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] ?? 'scratchpad/demos/matrix';
const rows = readFileSync(path.join(DIR, 'ledger.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

/** The VERIFY object a run wrote, or null when it never got that far. */
function evidenceFor(name) {
  try {
    const log = readFileSync(path.join(DIR, `${name}.log`), 'utf8');
    const m = log.match(/^VERIFY: (\{.*\})$/m);
    return m === null ? null : JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function score(app, e) {
  if (e === null) return 'no-verify';
  if (app === 'chrome') {
    if (typeof e.storageOffered === 'number' && e.storageOffered === 0) return 'unseen';
    return e.selected2TB === true ? 'pass' : 'fail';
  }
  if (app === 'maps') {
    if (typeof e.elements === 'number' && e.elements === 0) return 'unseen';
    return e.mapsMentionsPlace === true ? 'pass' : 'fail';
  }
  if (app === 'blender') {
    if (e.sceneQuery !== undefined && e.sceneQuery !== 'ok') return 'unseen';
    return e.shapeInScene === true ? 'pass' : 'fail';
  }
  return 'unknown-app';
}

const out = [];
for (const r of rows) {
  const e = evidenceFor(r.name);
  const m = r.modality === null || r.modality === undefined ? {} : JSON.parse(r.modality);
  out.push({
    n: r.n,
    app: r.app,
    model: r.model,
    take: r.take,
    scored: r.invalid == null ? score(r.app, e) : 'INVALID',
    ledgerSaid: r.verdict,
    seconds: r.seconds,
    attempts: r.attempts ?? 1,
    focus: r.focus,
    calls: m.byIndex + m.byCoord || 0,
    dom: m.domSnapshots ?? 0,
    ax: m.axSnapshots ?? 0,
    images: m.images ?? 0,
    modelClaimed:
      e === null
        ? null
        : (e.modelMentions2TB ?? e.modelMentionsPlace ?? e.modelDescribedResult ?? null),
  });
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(
  `${pad('#', 3)}${pad('app', 9)}${pad('model', 18)}${pad('take', 10)}${pad('scored', 10)}${pad('secs', 6)}${pad('att', 4)}${pad('focus', 7)}${pad('dom', 5)}${pad('ax', 4)}${pad('img', 5)}claimed`,
);
for (const r of out) {
  console.log(
    `${pad(r.n, 3)}${pad(r.app, 9)}${pad(r.model, 18)}${pad(r.take, 10)}${pad(r.scored, 10)}${pad(r.seconds, 6)}${pad(r.attempts, 4)}${pad(r.focus, 7)}${pad(r.dom, 5)}${pad(r.ax, 4)}${pad(r.images, 5)}${r.modelClaimed}`,
  );
}

const tally = {};
for (const r of out) tally[r.scored] = (tally[r.scored] ?? 0) + 1;
console.log(`\n${out.length} runs:`, tally);
/* Focus is the standing rule, not a metric: a single MOVED is a bug report. */
const moved = out.filter((r) => r.focus !== 'held');
console.log(moved.length === 0 ? 'focus HELD on every run.' : `FOCUS MOVED on: ${moved.map((r) => r.n).join(', ')}`);
