/**
 * INSTALLING AND REMOVING INFERENCE ENGINES (Settings → Engines).
 *
 * the user asked for "downloading/uninstalling all available engines 1 click".
 * The engines are not the same KIND of thing, which is the whole difficulty:
 *
 *   llama.cpp   a downloaded binary release under ~/.cache/pi-desktop/llamacpp
 *   rapid-mlx   a Python package tree in a managed venv
 *   dflash-mlx  a Python package (1.8 MB) that is useless without its 1.2 GB
 *               draft model, which is what the user actually pays for
 *
 * So "installed" is answered per engine by looking for the thing that would
 * actually be missing, not by trusting a flag we wrote earlier. A flag survives
 * a user deleting the cache directory; a probe does not, and the panel must
 * agree with the disk or the buttons lie.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it never installs a system-wide package,
 * never touches Homebrew, and never runs a network install outside the app's own
 * cache root. Everything it creates lives under ~/.cache/pi-desktop and can be
 * removed by deleting that directory, which is the property that makes a
 * one-click uninstall honest.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cacheRoot } from '@pi-desktop/inference';
import type { EngineState } from '../ipc-contract';

/** Where the managed Python venv for the MLX engines lives. */
function pyRoot(): string {
  return path.join(cacheRoot(), 'engines', 'mlx-venv');
}

/** ComfyUI's checkout, and the venv that runs it. */
function comfyRoot(): string {
  return path.join(cacheRoot(), 'engines', 'comfyui');
}
function comfyVenv(): string {
  return path.join(comfyRoot(), '.venv');
}
export function comfyMainPy(): string {
  return path.join(comfyRoot(), 'main.py');
}
/** Where ComfyUI is told to look for weights — the app's own model store. */
export function comfyModelPathsYaml(): string {
  return path.join(comfyRoot(), 'pi-model-paths.yaml');
}

function llamaRoot(): string {
  return path.join(cacheRoot(), 'llamacpp');
}

/** Recursive size, capped in effort — this is for a UI chip, not accounting. */
function dirBytes(dir: string, budget = 20_000): number {
  let total = 0;
  let seen = 0;
  const walk = (d: string): void => {
    if (seen > budget) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (seen > budget) return;
      seen += 1;
      const full = path.join(d, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  walk(dir);
  return total;
}

/** Does the managed venv have this Python package? */
function venvHasPackage(pkg: string): boolean {
  const site = path.join(pyRoot(), 'lib');
  if (!existsSync(site)) return false;
  try {
    for (const py of readdirSync(site)) {
      const pkgs = path.join(site, py, 'site-packages');
      if (!existsSync(pkgs)) continue;
      // A dist-info directory is the only reliable marker: the import name and
      // the distribution name differ for these (rapid-mlx imports as vllm_mlx).
      if (
        readdirSync(pkgs).some(
          (e) => e.toLowerCase().startsWith(`${pkg}-`) && e.endsWith('.dist-info'),
        )
      )
        return true;
    }
  } catch {
    /* unreadable venv reads as not installed */
  }
  return false;
}

function run(cmd: string, args: string[], timeoutMs = 20 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
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

/** `uv` is how the venv is created and populated; without it MLX installs fail. */
function uvPath(): string | null {
  for (const p of [
    path.join(process.env.HOME ?? '', '.local/bin/uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function ensureVenv(): Promise<string> {
  const uv = uvPath();
  if (uv === null) {
    throw new Error('uv is required to install MLX engines and was not found');
  }
  if (!existsSync(pyRoot())) {
    await run(uv, ['venv', pyRoot(), '--python', '3.12']);
  }
  return uv;
}

interface EngineOps {
  installed: () => boolean;
  bytes: () => number | undefined;
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
}

/**
 * Point ComfyUI at OUR model store instead of its own `models/` tree.
 *
 * ComfyUI expects `models/checkpoints`, `models/vae`, `models/text_encoders`
 * and so on under its checkout. Everything this app downloads lives in the
 * store, organised by what it MAKES rather than by what kind of tensor it is —
 * and copying weights into a second tree to satisfy a naming convention would
 * double the disk cost of every model.
 *
 * `--extra-model-paths-config` is ComfyUI's own answer to this: a YAML naming
 * extra roots per category. Pointing every category at the store's kind
 * directories means Comfy searches them recursively and finds whatever we have
 * fetched, wherever inside a repo's tree it happens to sit.
 */
function writeComfyModelPaths(): void {
  const store = path.join(cacheRoot(), 'store');
  const yaml = [
    '# Written by Bobble. ComfyUI reads its weights from the app model store.',
    'bobble:',
    `    base_path: ${store}`,
    '    is_default: true',
    '    checkpoints: image|video',
    '    diffusion_models: image|video',
    '    unet: image|video',
    '    vae: image|video',
    '    clip: image|video',
    '    text_encoders: image|video',
    '    loras: image|video',
    '    audio_checkpoints: audio',
    '',
  ].join('\n');
  writeFileSync(comfyModelPathsYaml(), yaml, 'utf8');
}

const OPS: Record<string, EngineOps> = {
  llamacpp: {
    installed: () => existsSync(llamaRoot()) && readdirSync(llamaRoot()).length > 0,
    bytes: () => (existsSync(llamaRoot()) ? dirBytes(llamaRoot()) : undefined),
    // The llama.cpp release download already has an owner (llamacpp-manager, on
    // the model-launch path). Re-implementing it here would give us two
    // downloaders that can disagree about which build is current, so this
    // reports state and leaves fetching to the launch path.
    install: async () => {
      throw new Error('llama.cpp is installed automatically when a GGUF model first launches');
    },
    uninstall: async () => {
      rmSync(llamaRoot(), { recursive: true, force: true });
    },
  },
  'rapid-mlx': {
    installed: () => venvHasPackage('rapid_mlx'),
    bytes: () => (existsSync(pyRoot()) ? dirBytes(pyRoot()) : undefined),
    install: async () => {
      const uv = await ensureVenv();
      await run(uv, ['pip', 'install', '--python', pyRoot(), 'rapid-mlx']);
    },
    uninstall: async () => {
      const uv = uvPath();
      if (uv === null) return;
      await run(uv, ['pip', 'uninstall', '--python', pyRoot(), 'rapid-mlx']).catch(() => undefined);
    },
  },
  /*
   * COMFYUI: a git clone plus its own venv, both under the app cache.
   *
   * Not pip-installable — upstream ships it as a checkout you run `main.py`
   * from, and it derives its base directory from that file's location. So the
   * clone IS the install, `--depth 1` because nobody here needs its history, and
   * the venv sits inside it so uninstalling is one `rm -rf`.
   *
   * The requirements pull Torch, which is the 6 GB the catalog quotes. On macOS
   * that is the MPS build and comes from the default index; no CUDA wheel is
   * requested, which is what would otherwise download 3 GB of unusable CUDA
   * libraries onto a Mac.
   */
  comfyui: {
    installed: () => existsSync(comfyMainPy()) && existsSync(comfyVenv()),
    // A Torch venv is tens of thousands of files, and the default walk budget
    // stopped a third of the way in — MEASURED 768 MB reported against 1.4 GB on
    // disk. A settings panel opening is not a hot path; the budget can afford
    // the whole tree here, and a size that is wrong by half is worse than slow.
    bytes: () => (existsSync(comfyRoot()) ? dirBytes(comfyRoot(), 400_000) : undefined),
    install: async () => {
      const uv = uvPath();
      if (uv === null) throw new Error('uv is required to install ComfyUI and was not found');
      if (!existsSync(comfyMainPy())) {
        rmSync(comfyRoot(), { recursive: true, force: true });
        await run(
          'git',
          ['clone', '--depth', '1', 'https://github.com/comfyanonymous/ComfyUI.git', comfyRoot()],
          10 * 60_000,
        );
      }
      if (!existsSync(comfyVenv())) {
        await run(uv, ['venv', comfyVenv(), '--python', '3.12']);
      }
      await run(
        uv,
        [
          'pip',
          'install',
          '--python',
          comfyVenv(),
          '-r',
          path.join(comfyRoot(), 'requirements.txt'),
        ],
        30 * 60_000,
      );
      writeComfyModelPaths();
    },
    uninstall: async () => {
      rmSync(comfyRoot(), { recursive: true, force: true });
    },
  },
  'dflash-mlx': {
    installed: () => venvHasPackage('dflash_mlx'),
    // The package is trivial; the drafter is the cost, and it is downloaded on
    // first use into the HF cache rather than here.
    bytes: () => undefined,
    install: async () => {
      const uv = await ensureVenv();
      await run(uv, ['pip', 'install', '--python', pyRoot(), 'dflash-mlx']);
    },
    uninstall: async () => {
      const uv = uvPath();
      if (uv === null) return;
      await run(uv, ['pip', 'uninstall', '--python', pyRoot(), 'dflash-mlx']).catch(
        () => undefined,
      );
    },
  },
};

/** In-flight operations, so the panel can grey a row while it works. */
const busy = new Map<string, 'installing' | 'removing'>();
const lastError = new Map<string, string>();

export function listEngines(ids: readonly string[]): EngineState[] {
  return ids.map((id) => {
    const ops = OPS[id];
    if (ops === undefined) {
      // An engine in the catalog with no installer here is reported honestly as
      // not-installed rather than pretended to be present.
      return { id, installed: false, error: lastError.get(id) };
    }
    let installed = false;
    let bytes: number | undefined;
    try {
      installed = ops.installed();
      bytes = installed ? ops.bytes() : undefined;
    } catch {
      installed = false;
    }
    return { id, installed, bytes, busy: busy.get(id), error: lastError.get(id) };
  });
}

export async function installEngine(id: string): Promise<{ success: boolean; error?: string }> {
  const ops = OPS[id];
  if (ops === undefined) return { success: false, error: `${id} cannot be installed from here` };
  if (busy.has(id)) return { success: false, error: 'already in progress' };
  busy.set(id, 'installing');
  lastError.delete(id);
  try {
    await ops.install();
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError.set(id, msg);
    return { success: false, error: msg };
  } finally {
    busy.delete(id);
  }
}

export async function uninstallEngine(id: string): Promise<{ success: boolean; error?: string }> {
  const ops = OPS[id];
  if (ops === undefined) return { success: false, error: `${id} cannot be removed from here` };
  if (busy.has(id)) return { success: false, error: 'already in progress' };
  busy.set(id, 'removing');
  lastError.delete(id);
  try {
    await ops.uninstall();
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastError.set(id, msg);
    return { success: false, error: msg };
  } finally {
    busy.delete(id);
  }
}
