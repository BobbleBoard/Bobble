/**
 * WHEN AN AGENT TURNS THE WORKSPACE PATH INTO A RELATIVE ONE.
 *
 * Measured twice, in two different shapes, both fatal:
 *
 *   run 9   cwd  …/scratchpad/mesh9/ws
 *           wrote `scratchpad/mesh9/ws/test_converter.py`
 *           landed …/ws/scratchpad/mesh9/ws/test_converter.py — parents missing,
 *           so the write FAILED and no file appeared anywhere.
 *
 *   run 11  cwd  /private/tmp/claude-501/<uuid>/scratchpad/mesh11/ws
 *           wrote `private/tmp/claude-501/<uuid>/scratchpad/mesh11/ws/src/cli.py`
 *           landed …/ws/private/tmp/…/ws/src/cli.py — a complete SHADOW COPY of
 *           the product, four levels down, invisible to the gate. The engineer
 *           then submitted `python3 run_tests.py` eight times and was refused
 *           eight times with "No such file or directory", because everything it
 *           had built was in the shadow and the real tree held three files.
 *
 * Both are one mistake: the model reads the absolute workspace path out of a
 * shell prompt or an `ls`, drops some leading part of it, and passes the rest to
 * a file tool that resolves relative paths against that very directory. It is not
 * a comprehension failure a prompt can fix — the prompt already says to use bare
 * relative paths, and it has said so since run 8.
 *
 * The rule below is exact rather than heuristic: a relative path whose LEADING
 * components are a SUFFIX of the workspace's own components is that mistake, and
 * nothing else. `.../a/b/ws` + `b/ws/main.py` means `main.py`. Two components
 * minimum, so a project that legitimately contains a directory named like the
 * workspace's last folder is untouched.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/** Split a path into components, dropping the root and any empties. */
function parts(p: string): string[] {
  return p.split(path.sep).filter((c) => c !== '');
}

/** Fewest leading components that may be treated as a mangled prefix. One would
 * strip a legitimate `src/x.py` under a workspace that happens to end in `src`. */
const MIN_PREFIX = 2;

/**
 * The path the agent MEANT, when it re-stated part of the workspace path as a
 * relative one. Returns `undefined` when the path is fine as given — which is the
 * overwhelmingly common case, so this must be cheap and must not guess.
 */
export function unmanglePath(cwd: string, rel: string): string | undefined {
  if (path.isAbsolute(rel)) return undefined;
  const cwdParts = parts(path.resolve(cwd));
  const relParts = parts(rel);
  const most = Math.min(cwdParts.length, relParts.length - 1);
  for (let k = most; k >= MIN_PREFIX; k--) {
    const head = relParts.slice(0, k);
    const tail = cwdParts.slice(-k);
    if (head.every((c, i) => c === tail[i])) {
      const rest = relParts.slice(k);
      if (rest.length > 0) return rest.join(path.sep);
    }
  }
  return undefined;
}

/**
 * Directories inside `cwd` that are a re-stated copy of `cwd` itself — the roots
 * of any shadow tree. Cheap: at most one `existsSync` per suffix length.
 */
export function shadowRoots(cwd: string): string[] {
  const abs = path.resolve(cwd);
  const cwdParts = parts(abs);
  const found: string[] = [];
  for (let k = cwdParts.length; k >= MIN_PREFIX; k--) {
    const candidate = path.join(abs, ...cwdParts.slice(-k));
    if (existsSync(candidate) && statSync(candidate).isDirectory()) found.push(candidate);
  }
  const leaf = leafShadowRoot(abs);
  if (leaf !== undefined && !found.includes(leaf)) found.push(leaf);
  return found;
}

/**
 * The ONE-component shadow: `<cwd>/<leaf>` where `<leaf>` is the workspace's own
 * name — `.../platformer/platformer`.
 *
 * `MIN_PREFIX` is 2 because a lone repeated name is often legitimate (`src/src`,
 * a Python package inside its project). Rooting the corp at the directory the
 * task names made this case common rather than exotic: the model is told to
 * build "at .../platformer", is already standing in `platformer`, and creates
 * `platformer/` again. Run 19 built its whole game in
 * `platformer/platformer/2D Platformer/`.
 *
 * So it is detected on EVIDENCE rather than on the name: the inner directory
 * holds the project's entry point and the outer one does not. A genuine nested
 * package has no such marker at the inner level only, and is left alone.
 */
function leafShadowRoot(abs: string): string | undefined {
  const leaf = path.basename(abs);
  const candidate = path.join(abs, leaf);
  try {
    if (!statSync(candidate).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const marker = (dir: string): boolean => ENTRY_MARKERS.some((m) => existsSync(path.join(dir, m)));
  if (marker(abs)) return undefined; // the real project is already at the top
  if (marker(candidate)) return candidate;
  // Or one level further in, which is how run 19 nested it.
  try {
    for (const name of readdirSync(candidate)) {
      const deep = path.join(candidate, name);
      if (statSync(deep).isDirectory() && marker(deep)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Files that mark "this directory is the project", not a subfolder of one. */
const ENTRY_MARKERS = [
  'project.godot',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'index.html',
  'main.py',
];

/** One file moved out of a shadow tree. */
export interface RepairedFile {
  readonly from: string;
  readonly to: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) walkFiles(full, out);
      else out.push(full);
    } catch {
      // a file that vanished mid-walk is not worth failing over
    }
  }
  return out;
}

/**
 * Move everything out of a shadow tree into the place the agent meant, so the
 * gate, `submit_work` and every other agent see one product instead of two.
 *
 * NON-DESTRUCTIVE ON PURPOSE. A file whose destination already exists is left
 * where it is rather than overwritten: the shadow copy is usually the newer
 * intent, but "usually" is not a good enough reason to destroy work at 4am with
 * nobody awake. The real tree wins, the orphan stays readable, and the run
 * reports both. Never throws.
 */
export function repairShadowTree(cwd: string): RepairedFile[] {
  const abs = path.resolve(cwd);
  const moved: RepairedFile[] = [];
  for (const root of shadowRoots(abs)) {
    for (const file of walkFiles(root)) {
      const rel = path.relative(root, file);
      const dest = path.join(abs, rel);
      if (existsSync(dest)) continue;
      try {
        mkdirSync(path.dirname(dest), { recursive: true });
        renameSync(file, dest);
        moved.push({ from: path.relative(abs, file), to: rel });
      } catch {
        // a move that fails leaves the shadow copy in place — still readable
      }
    }
  }
  return moved;
}

/** What the team is told when files were rescued, so the next `ls` is not a shock. */
export function repairNote(moved: readonly RepairedFile[]): string {
  if (moved.length === 0) return '';
  const lines = moved.slice(0, 8).map((m) => `  ${m.from}  ->  ${m.to}`);
  const more = moved.length > lines.length ? `\n  …and ${moved.length - lines.length} more` : '';
  return [
    `--- FILES MOVED INTO PLACE ---`,
    `Some work was written to a path that repeated the workspace's own folders, so`,
    `it landed in a nested copy of the workspace where nothing could run it. It has`,
    `been moved to where it belongs:`,
    ...lines,
    more,
    `Use BARE relative paths — \`cli.py\`, \`src/cli.py\`. Never paste the workspace's`,
    `own directory path into a file tool; you are already inside it.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * A cheap signature of the product tree: every file's path, size and mtime.
 *
 * Exists to answer one question — "has anything actually changed since last
 * time?" Run 13 spent its last twenty minutes (1200 of 1800 seconds) with ZERO
 * file writes while an engineer submitted the same failing command three times,
 * and run 12 produced three byte-identical rejections the same way. A rejection
 * carrying the real error is worth nothing to a model that reads it as "try
 * again" rather than "change something".
 *
 * Ignores the machinery: session files, caches, and compiled artefacts churn on
 * their own and would make every fingerprint unique. Never throws.
 */
export function productFingerprint(cwd: string): string {
  const skip = /(^|\/)(\.pi|\.pytest_cache|__pycache__|node_modules|\.git)(\/|$)/;
  const root = path.resolve(cwd);
  const items: string[] = [];
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file);
    if (skip.test(rel)) continue;
    try {
      const st = statSync(file);
      items.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      // vanished mid-walk — not worth failing over
    }
  }
  return items.sort().join('|');
}

/**
 * THE PLACE THE USER NAMED — the corp's working directory.
 *
 * The corp used to root at the CHAT's folder (`req.ctx.cwd`), which in practice
 * is whatever project the conversation belongs to — the Desktop, for most of
 * The user's chats. Ask for a game at `/Users/user/bobble-testbed/platformer` and the
 * roles would work in `~/Desktop` instead, so every relative shell command landed
 * there: `mkdir -p platformer/scripts` built `~/Desktop/bobble-testbed/platformer`
 * while the reply named the path that had been asked for.
 *
 * The sandbox fence stopped this for the pi file tools (`isNamedDestination`),
 * but BASH is not fenced and never will be sensibly — a shell can write a hundred
 * ways. The durable fix is to put the roles IN the directory the user named, so
 * relative and absolute both land in the same right place.
 *
 * Returns the deepest path the task names under HOME, or null when it names none.
 * Two levels minimum and never bare HOME — the same rule the write fence uses,
 * for the same reason: `~/notes.txt` is a dump, `~/games/x` is a destination.
 */
/**
 * A directory the user NAMED IN THE PROMPT — a place to DELIVER to, not a place
 * to live.
 *
 * THIS USED TO DECIDE THE WORKSPACE ROOT, and that was the misconception behind
 * every path bug this harness has produced. Inferring a root from English prose
 * cannot work: a sentence-ending full stop became part of the directory
 * (`godotdemo.`); the deepest match won, so naming an input and an output rooted
 * the whole team at the input (`~/Downloads/report.pdf`); and each time it went
 * wrong it went wrong SILENTLY, because a team works perfectly wherever you put
 * it.
 *
 * The user settled it: "the workspace should be the workspace. default: no project,
 * which makes a project specific folder that all the model's write commands,
 * terminal python etc immediately start from automatically ... or they might
 * start in a specified directory." A path in the prompt is delivery — "make a
 * slide deck and put it in this folder" says where the OUTPUT goes.
 *
 * So this now answers only "did they name somewhere to deliver?". Writing there
 * is already permitted: `isNamedDestination` exists for exactly this case.
 * Returns null when the task names no destination.
 */
export function deliveryFromTask(task: string, home: string): string | null {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:~|${escaped})(?:/[\\w.@-]+)+`, 'g');
  const candidates = task.match(re) ?? [];
  let best: string | null = null;
  const dirish: string[] = [];
  const fileish: string[] = [];
  for (const candidate of candidates) {
    /*
     * A SENTENCE-ENDING FULL STOP IS NOT PART OF THE PATH.
     *
     * The character class above allows `.` (real directories contain dots), so
     * "build it in ~/work/mygame." captures the period too and the whole team
     * is rooted in a directory called `mygame.` — which it then creates, works
     * in correctly, and delivers to. Nothing errors. The user looks in `mygame`,
     * finds nothing, and the run appears to have produced no output at all.
     *
     * MEASURED: cost most of a 20-minute run, and I had already walked past the
     * same symptom once (a hierarchy directory named `demo.-b0654bf7`) and
     * dismissed the dot as phrasing.
     *
     * Trailing dots are stripped, never interior ones: `~/a/my.project` keeps
     * its dot, `~/a/my.project.` loses only the last. A directory whose name
     * genuinely ends in a period is legal and never intended.
     */
    const raw = candidate.replace(/\.+$/, '');
    if (raw === '' || raw === '~') continue;
    const abs = path.resolve(raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw);
    const rest = abs.startsWith(`${home}/`) ? abs.slice(home.length + 1) : '';
    // Needs a folder under home, and must not be application state.
    if (!rest.includes('/') || rest.startsWith('.') || rest.startsWith('Library/')) continue;
    /*
     * A WORKSPACE IS A DIRECTORY, NOT A FILE.
     *
     * "Deepest wins" was written for prompts naming one path. The moment a task
     * names an INPUT and an OUTPUT the deepest one is usually the input file,
     * and the whole team gets rooted there. MEASURED:
     *
     *   "build a tool in .../salestool that loads .../salesdata/sales.csv"
     *      -> .../salesdata/sales.csv
     *   "convert ~/Downloads/report.pdf and put the result in ~/work/out"
     *      -> ~/Downloads/report.pdf
     *
     * The second is the one that matters: a corporation rooted inside the user's
     * Downloads, at a PDF. Every task that reads something and writes somewhere
     * else has this shape, which is most real work.
     *
     * So directories are PREFERRED over file-looking candidates, rather than
     * file-looking ones being banned — a directory genuinely named `my.project`
     * still wins when it is the only thing named.
     */
    const looksLikeFile = /\.[a-z0-9]{1,6}$/i.test(path.basename(abs));
    const bucket = looksLikeFile ? fileish : dirish;
    bucket.push(abs);
  }
  // Deepest within the preferred bucket: "at ~/a/b/game" still beats "~/a".
  const pool = dirish.length > 0 ? dirish : fileish;
  for (const abs of pool) {
    if (best === null || abs.length > best.length) best = abs;
  }
  return best;
}
