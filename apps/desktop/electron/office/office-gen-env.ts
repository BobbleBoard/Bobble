/**
 * What the document pipeline needs from the app: where its scripts are, a
 * Python that has its libraries, and somewhere to scratch.
 *
 * The harness's `office` tool (packages/harness/src/tools/office-tool.ts) runs
 * `office.py` inside the pi child, so everything it needs is published on that
 * child's env at spawn (pi-main's buildPiEnv). The server URL is not here: the
 * child already has the live utility endpoint and hands it over itself.
 *
 * THE INTERPRETER. The renderers need python-pptx, python-docx, openpyxl,
 * reportlab and pillow. Three sources, in order:
 *   1. the app's own venv (<cache>/engines/office-venv), provisioned once with
 *      uv — the one that works on a machine where nothing else is installed;
 *   2. the system `python3`, when it already imports all five (a developer's
 *      Mac, typically) — used while (1) is still installing, or instead of it;
 *   3. nothing yet: the tool runs `python3` and reports the missing library by
 *      name, and the venv install started here finishes in the background.
 *
 * Probing is async (it spawns python) and buildPiEnv is sync, so `prime()` runs
 * at app start and the env reads the cached answer — pi's first spawn may see
 * only the default, which is the same `python3` the harness falls back to.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cacheRoot } from '@pi-desktop/inference';
import { createLogger } from '@pi-desktop/shared';
import { ensureUv } from '@pi-desktop/web-tools';
import { app } from 'electron';

const log = createLogger('desktop:office-gen');

/** The libraries office.py imports, as pip names → import names. */
const LIBS: ReadonlyArray<{ pip: string; mod: string }> = [
  { pip: 'python-pptx', mod: 'pptx' },
  { pip: 'python-docx', mod: 'docx' },
  { pip: 'openpyxl', mod: 'openpyxl' },
  { pip: 'reportlab', mod: 'reportlab' },
  { pip: 'pillow', mod: 'PIL' },
];

export function officeGenDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'office-gen')
    : path.join(app.getAppPath(), '..', '..', 'tools', 'office-gen');
}

/** Where raw model output, specs and the photo cache go — never the scripts' dir. */
export function officeScratchDir(): string {
  const dir = path.join(cacheRoot(), 'office-gen');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* the pipeline creates it too */
  }
  return dir;
}

function venvDir(): string {
  return path.join(cacheRoot(), 'engines', 'office-venv');
}
function venvPython(): string {
  return path.join(venvDir(), 'bin', 'python3');
}

/** Does this interpreter import everything the renderers need? */
export function hasLibs(python: string, spawnImpl: typeof spawn = spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(python, ['-c', `import ${LIBS.map((l) => l.mod).join(', ')}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 15_000);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * THE VENV'S PYTHON MUST OUTLIVE WHOEVER MADE IT.
 *
 * MEASURED 2026-09-15 on the user's Mac: `office make` answered "No module named
 * 'docx'" with every library installed in the venv — its `bin/python` was a
 * symlink into `/var/folders/…/pd-home-office-live-d585Rc/.local/share/uv/
 * python/…`, a probe's throwaway home, long deleted. uv keeps its managed
 * interpreters under HOME by default, and the venv lives under the cache
 * root, so a venv made under one home dangles under the next. The
 * interpreters go under the cache root too, beside the venv that needs them.
 */
function uvEnv(): NodeJS.ProcessEnv {
  return { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(cacheRoot(), 'uv', 'python') };
}

/** A venv directory whose interpreter no longer resolves — see uvEnv. */
function venvIsBroken(): boolean {
  if (!existsSync(venvDir())) return false;
  try {
    lstatSync(venvPython());
  } catch {
    return true; // the dir is there and the link is not: half-made, or half-removed
  }
  return !existsSync(venvPython()); // the link is there and points at nothing
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: uvEnv() });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr = `${stderr}${String(d)}`.slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `exit ${code}`));
    });
  });
}

/** Build the venv with uv. Network on first run, like every other engine here. */
async function provisionVenv(): Promise<string> {
  const { uvPath } = await ensureUv();
  const dir = venvDir();
  if (venvIsBroken()) {
    log.warn('office venv interpreter is gone; rebuilding the venv', { dir });
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(venvPython())) {
    await run(uvPath, ['venv', dir, '--python', '3.12'], 5 * 60_000);
  }
  await run(
    uvPath,
    ['pip', 'install', '--python', venvPython(), '--quiet', ...LIBS.map((l) => l.pip)],
    15 * 60_000,
  );
  return venvPython();
}

let resolved: string | undefined;
let priming: Promise<void> | null = null;

/**
 * Work out which interpreter to publish, provisioning the venv when nothing
 * has the libraries. Idempotent; the second caller awaits the first.
 */
export function primeOfficeGen(): Promise<void> {
  if (priming !== null) return priming;
  priming = (async () => {
    const venv = venvPython();
    if (existsSync(venv) && (await hasLibs(venv))) {
      resolved = venv;
      return;
    }
    if (await hasLibs('python3')) {
      resolved = 'python3';
      /* The system Python works today; the venv is still worth having, quietly,
         so a `brew upgrade` that drops a library does not take the pipeline
         with it. Background, never awaited. */
      void provisionVenv()
        .then(() => log.info('office venv ready (background)', { venv }))
        .catch((err) => log.warn('office venv install failed', { err: String(err) }));
      return;
    }
    log.info('no interpreter has the office libraries; provisioning the venv', { venv });
    try {
      resolved = await provisionVenv();
      log.info('office venv ready', { venv });
    } catch (err) {
      log.warn('office venv install failed — the office tool will name the missing library', {
        err: String(err),
      });
    }
  })();
  return priming;
}

/** The env the pi child needs for `office`. Sync; reads what prime() found. */
export function officeGenEnv(): Record<string, string> {
  return {
    PI_OFFICE_GEN_DIR: officeGenDir(),
    PI_OFFICE_GEN_SCRATCH: officeScratchDir(),
    ...(resolved !== undefined ? { PI_OFFICE_GEN_PYTHON: resolved } : {}),
  };
}

/** Test seam. */
export function _resetOfficeGenForTests(): void {
  resolved = undefined;
  priming = null;
}
