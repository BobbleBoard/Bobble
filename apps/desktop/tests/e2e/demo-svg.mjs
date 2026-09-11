/**
 * THE SVG CONNECTOR, END TO END: a chat model reaches for `svg`, OmniSVG runs
 * under its own llama-server, and a vector file lands in Generated.
 *
 * The verdict comes from the FILE, not the transcript: it exists, it is an SVG
 * with at least one path, and its fill is the colour that was asked for. A
 * model that only described a heart leaves no file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { demoRun } from './demo-run.mjs';

const MODEL = process.env.MAC_CU_MODEL ?? 'minicpm5-2b';
const MODE = process.env.TOOL_INTERFACE === 'schemas' ? 'schemas' : 'bash-cli';

function findSvgs(root) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.svg')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

await demoRun({
  name: process.env.RUN_NAME ?? `svg-${MODEL}-${MODE}`,
  app: 'Finder',
  attach: true,
  model: MODEL,
  mode: MODE,
  prompt:
    'Make me an SVG icon of a red heart with smooth curved edges, centered. ' +
    'Use the svg command to generate it, then tell me the path of the file.',
  verify: async (_dbg, last, ctx) => {
    const svgs = findSvgs(ctx.home).filter((p) => p.includes('enerated'));
    const newest = svgs.map((p) => ({ p, t: statSync(p).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (newest === undefined) {
      return { verdict: 'fail', svgFiles: svgs.length, reason: 'no .svg landed in Generated' };
    }
    const text = readFileSync(newest.p, 'utf8');
    const paths = (text.match(/<path\b/g) ?? []).length;
    const fills = [...text.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
    /* "Red": the red channel dominates in at least one fill. */
    const red = fills.some((f) => {
      const r = Number.parseInt(f.slice(1, 3), 16);
      const g = Number.parseInt(f.slice(3, 5), 16);
      const b = Number.parseInt(f.slice(5, 7), 16);
      return r > 150 && r > g + 60 && r > b + 60;
    });
    return {
      verdict: paths > 0 && red ? 'pass' : paths > 0 ? 'unseen' : 'fail',
      file: newest.p,
      paths,
      fills,
      red,
      modelNamedFile: last.text.includes('.svg'),
    };
  },
});
