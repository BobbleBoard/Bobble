/**
 * WHERE TWO CONSECUTIVE REQUESTS PART COMPANY.
 *
 * Reads the bodies `PI_DIAG_PROMPTS_FULL=1` recorded (`<file>.bodies.jsonl`)
 * and, for each pair of consecutive requests to the same engine, reports the
 * first thing that differs in what the server would render in order: the
 * system prompt, then each tool (name, description, parameters), then each
 * message. A prefix cache can only reuse up to that point.
 *
 *   node apps/desktop/tests/e2e/prompt-diff.mjs <file>.bodies.jsonl
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) throw new Error('usage: prompt-diff.mjs <file>.bodies.jsonl');
const rows = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};
const show = (s, at) => JSON.stringify(s.slice(Math.max(0, at - 60), at + 80));

const byEngine = new Map();
for (const r of rows) {
  const list = byEngine.get(r.engine) ?? [];
  list.push(r.body);
  byEngine.set(r.engine, list);
}
for (const [engine, bodies] of byEngine) {
  console.log(`\n=== ${engine}: ${bodies.length} requests ===`);
  for (let i = 1; i < bodies.length; i++) {
    const a = bodies[i - 1];
    const b = bodies[i];
    const am = a.messages ?? [];
    const bm = b.messages ?? [];
    const label = `#${i - 1} (${am.length} msgs) → #${i} (${bm.length} msgs)`;
    // 1. system prompt
    const asys = am.find((m) => m.role === 'system')?.content ?? '';
    const bsys = bm.find((m) => m.role === 'system')?.content ?? '';
    if (asys !== bsys) {
      const at = firstDiff(asys, bsys);
      console.log(`${label}: SYSTEM PROMPT differs at char ${at} of ${asys.length}/${bsys.length}`);
      console.log(`   was ${show(asys, at)}`);
      console.log(`   now ${show(bsys, at)}`);
      continue;
    }
    // 2. tools
    const at_ = JSON.stringify(a.tools ?? []);
    const bt = JSON.stringify(b.tools ?? []);
    if (at_ !== bt) {
      const an = (a.tools ?? []).map((t) => t.function?.name);
      const bn = (b.tools ?? []).map((t) => t.function?.name);
      const at = firstDiff(at_, bt);
      console.log(`${label}: TOOLS differ (${an.length} → ${bn.length}) at char ${at}`);
      console.log(`   was [${an.join(',')}]`);
      console.log(`   now [${bn.join(',')}]`);
      console.log(`   was ${show(at_, at)}`);
      console.log(`   now ${show(bt, at)}`);
      continue;
    }
    // 3. messages, in order (skipping system)
    const ams = am.filter((m) => m.role !== 'system');
    const bms = bm.filter((m) => m.role !== 'system');
    let reported = false;
    for (let k = 0; k < ams.length; k++) {
      const x = JSON.stringify(ams[k]);
      const y = JSON.stringify(bms[k]);
      if (x !== y) {
        const at = firstDiff(x, y);
        console.log(`${label}: MESSAGE ${k} (${ams[k].role}) differs at char ${at}`);
        console.log(`   was ${show(x, at)}`);
        console.log(`   now ${show(y, at)}`);
        reported = true;
        break;
      }
    }
    if (!reported) {
      const extra = bms.slice(ams.length).map((m) => m.role);
      const other = Object.keys(b)
        .filter((k) => k !== 'messages' && k !== 'tools')
        .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      console.log(
        `${label}: prefix identical through message ${ams.length - 1}; appended [${extra.join(',')}]${
          other.length > 0 ? `; other fields changed: ${other.join(',')}` : ''
        }`,
      );
    }
  }
}
