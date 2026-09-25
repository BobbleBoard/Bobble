/**
 * Where everything the eval needs lives — resolved from the repo, never from an
 * absolute path on one Mac (the research tools this replaces hard-coded the pnpm
 * store and a Playwright revision).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_ROOT = path.resolve(HERE, '..');
export const REPO = path.resolve(EVAL_ROOT, '../..');
export const PY_DIR = path.join(EVAL_ROOT, 'py');
export const FIXTURES = path.join(EVAL_ROOT, 'fixtures');
export const PROMPTS = path.join(EVAL_ROOT, 'prompts');
/**
 * The office pipeline under test. `VQ_OFFICE_GEN` points the eval at another
 * copy — main's, say — so a renderer change is judged before and after with
 * the same ruler.
 */
const { VQ_OFFICE_GEN } = process.env;
export const OFFICE_GEN = VQ_OFFICE_GEN
  ? path.resolve(VQ_OFFICE_GEN)
  : path.join(REPO, 'tools', 'office-gen');

const PY_LIBS = 'import pptx, docx, reportlab, PIL, pypdf, openpyxl';

/**
 * The Python the office pipeline runs on: an explicit one, the repo's pinned dev
 * venv (tools/office-gen/requirements-dev.txt), or the app's own office venv —
 * whichever imports the renderers' libraries first.
 */
export function resolvePython(explicit) {
  const { VQ_PYTHON } = process.env;
  const candidates = [
    explicit,
    VQ_PYTHON,
    path.join(OFFICE_GEN, '.venv', 'bin', 'python'),
    path.join(homedir(), '.cache', 'bobble', 'engines', 'office-venv', 'bin', 'python3'),
  ].filter((p) => typeof p === 'string' && p.length > 0);
  for (const py of candidates) {
    if (!existsSync(py)) continue;
    const r = spawnSync(py, ['-c', PY_LIBS], { encoding: 'utf8' });
    if (r.status === 0) return py;
  }
  throw new Error(
    'no Python with the office libraries. Make the dev venv:\n' +
      '  uv venv --python 3.12 tools/office-gen/.venv\n' +
      '  uv pip install --python tools/office-gen/.venv/bin/python -r tools/office-gen/requirements-dev.txt\n' +
      'or pass --python / VQ_PYTHON.',
  );
}

/** A package from the workspace's pnpm store (jiti, playwright), by name. */
function fromStore(name) {
  const req = createRequire(path.join(REPO, 'package.json'));
  for (const base of [REPO, path.join(REPO, 'node_modules', '.pnpm', 'node_modules')]) {
    try {
      return req.resolve(name, { paths: [base] });
    } catch {
      /* next */
    }
  }
  const store = path.join(REPO, 'node_modules', '.pnpm');
  const dir = existsSync(store)
    ? readdirSync(store)
        .filter((d) => d.startsWith(`${name}@`))
        .sort()
        .pop()
    : undefined;
  if (dir === undefined)
    throw new Error(`${name} is not installed in this workspace (run pnpm install)`);
  return createRequire(path.join(store, dir, 'node_modules', name, 'package.json')).resolve(name);
}

let jitiInstance;
/** Import a TypeScript module of the repo exactly as the app's code is written. */
export async function importTs(file) {
  if (jitiInstance === undefined) {
    const entry = fromStore('jiti');
    const jitiMjs = path.join(
      entry.slice(0, entry.lastIndexOf(`${path.sep}jiti${path.sep}`) + 6),
      'lib',
      'jiti.mjs',
    );
    const mod = await import(pathToFileURL(existsSync(jitiMjs) ? jitiMjs : entry).href);
    const create = mod.createJiti ?? mod.default?.createJiti ?? mod.default;
    jitiInstance = create(import.meta.url, { interopDefault: true });
  }
  return jitiInstance.import(path.isAbsolute(file) ? file : path.join(REPO, file));
}

/** Playwright's chromium, headless (no window, no focus), from the workspace. */
export async function launchChromium() {
  const pw = await import(pathToFileURL(fromStore('playwright')).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    // A Playwright revision newer than the browsers on disk: use the newest
    // headless shell that is there rather than downloading one.
    const cache = path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
    const shells = existsSync(cache)
      ? readdirSync(cache)
          .filter((d) => d.startsWith('chromium_headless_shell-'))
          .sort()
          .reverse()
      : [];
    for (const d of shells) {
      const exe = path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
      if (existsSync(exe)) return chromium.launch({ headless: true, executablePath: exe });
    }
    throw err;
  }
}

/**
 * The frontmost app, by name (macOS; null elsewhere). `lsappinfo` needs no
 * automation permission, unlike System Events.
 */
export function frontmost() {
  if (process.platform !== 'darwin') return null;
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8', timeout: 4000 }).trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'name', asn], {
      encoding: 'utf8',
      timeout: 4000,
    });
    const m = /"([^"]*)"/.exec(info);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** What the eval itself could put in front: QuickLook, Chromium, Python, Node. */
const OURS = /qlmanage|quicklook|chrom|python|node|electron|bobble/i;

/** "The eval took the screen" — only when the new front app is one we started. */
export function focusComplaint(before, after) {
  if (before === null || after === null || before === after) return null;
  if (!OURS.test(after)) return null; // the person switched apps; that is theirs to do
  return `focus moved during the eval: was "${before}", became "${after}"`;
}

/** Run a command, return stdout; throw with the stderr tail when it fails. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    const tail = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim().split('\n').slice(-12).join('\n');
    throw new Error(
      `${path.basename(cmd)} ${args.slice(0, 2).join(' ')} failed (${r.status}):\n${tail}`,
    );
  }
  return r.stdout;
}

/** The last line of stdout that is a JSON object (office.py's reply shape). */
export function lastJson(stdout) {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{') || l.startsWith('['));
  return line === undefined ? null : JSON.parse(line);
}
