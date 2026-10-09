/**
 * INSTALLING AND REMOVING INFERENCE ENGINES (Settings → Engines).
 *
 * The user asked for "downloading/uninstalling all available engines 1 click".
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cacheRoot, libraryRoot } from '@pi-desktop/inference';
import { ensureUv, findInstalledUv } from '@pi-desktop/web-tools';
import type { EngineState } from '../ipc-contract';
import {
  COMFY_H3_SHIM_DIRNAME,
  COMFY_H3_SHIM_PY,
  COMFY_MESH_ON_CPU_FILENAME,
  COMFY_MESH_ON_CPU_PY,
} from './comfy-h3-shim';
import {
  engineInstalled,
  mlxVenvRoot,
  rapidVisionMarker,
  rapidVisionReady,
  rapidVisionVenvRoot,
  vllmVenvRoot,
} from './engine-paths';

/** Where the managed Python venv for the MLX engines lives. */
function pyRoot(): string {
  return mlxVenvRoot();
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

/** A NInfer checkout (upstream or the 3090 fork), built in place. */
function ninferRoot(id: 'ninfer' | 'ninfer-3090'): string {
  return path.join(cacheRoot(), 'engines', id);
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
/**
 * The version of a distribution installed in the shared venv, or undefined —
 * read off its dist-info directory name (`rapid_mlx-0.14.1.dist-info`).
 */
function venvPackageVersion(pkg: string): string | undefined {
  const site = path.join(pyRoot(), 'lib');
  if (!existsSync(site)) return undefined;
  const norm = pkg.toLowerCase().replace(/-/g, '_');
  try {
    for (const py of readdirSync(site)) {
      const pkgs = path.join(site, py, 'site-packages');
      if (!existsSync(pkgs)) continue;
      for (const e of readdirSync(pkgs)) {
        const m = /^(.+)-([^-]+)\.dist-info$/.exec(e);
        if (m !== null && m[1]?.toLowerCase().replace(/-/g, '_') === norm) return m[2];
      }
    }
  } catch {
    /* unreadable venv: no version */
  }
  return undefined;
}

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
/**
 * A uv already on this machine, by the places people put it on its OS — on a Mac
 * `~/.local/bin` and Homebrew (as before), on Windows `%USERPROFILE%\.local\bin\uv.exe`,
 * Cargo, winget, Scoop and Chocolatey, on Linux the installer, Cargo, Linuxbrew
 * and system dirs (web-tools `knownUvLocations`) — plus the app's own pinned copy
 * (`ensureUv`'s marker, checked against this machine's build), which is what a
 * machine that never had Python tooling gets. `null` only when there is none of
 * either; an INSTALL then fetches the pinned copy (see {@link ensureUvPath})
 * rather than telling the user to go and install uv.
 */
function uvPath(): string | null {
  return findInstalledUv();
}

/** uv for an install: what is here, else the pinned copy, fetched. */
async function ensureUvPath(): Promise<string> {
  const here = uvPath();
  if (here !== null) return here;
  return (await ensureUv()).uvPath;
}

async function ensureVenv(): Promise<string> {
  const uv = await ensureUvPath();
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
/**
 * The categories ComfyUI looks up, mirroring `COMFY_MODEL_SUBDIRS` in
 * comfy-install.ts — the same names that module already creates under the store.
 */
const COMFY_CATEGORIES = [
  'checkpoints',
  'unet',
  'diffusion_models',
  'clip',
  'clip_vision',
  'text_encoders',
  'audio_encoders',
  'vae',
  'loras',
  'controlnet',
  'upscale_models',
  // The native 3D pipeline (ComfyUI ≥ 0.35): BiRefNet cuts the subject out,
  // MoGe reads the camera for Pixal3D; LTX-2.5's second stage is a latent
  // upscaler. Three type folders ComfyUI looks up that the list did not name,
  // so a repo laid out exactly as Comfy-Org ships it was invisible.
  'background_removal',
  'geometry_estimation',
  'latent_upscale_models',
] as const;

export function writeComfyModelPaths(): void {
  const store = path.join(cacheRoot(), 'store');
  /*
   * ONE ENTRY PER LIBRARY SHELF THAT HOLDS COMFY TYPE FOLDERS. The weights
   * moved out of the flat store onto the shelves (`Video/Generation/unet/…`,
   * `Audio/Music/checkpoints/…` — storage/library-migration.ts); ComfyUI
   * resolves a loader name against every base path listed here, so each shelf
   * with type folders is a base path of its own, and the legacy store stays
   * listed for a machine not yet migrated. Names in the graphs are unchanged.
   */
  const shelves: string[] = [];
  const lib = libraryRoot();
  for (const modality of ['Image', 'Video', 'Audio', '3D', 'Support', 'Unsorted']) {
    const folder = path.join(lib, modality);
    let subs: string[];
    try {
      subs = readdirSync(folder);
    } catch {
      continue;
    }
    const candidates =
      modality === 'Support' || modality === 'Unsorted'
        ? [folder]
        : subs.map((s) => path.join(folder, s));
    const hasTypeDir = (dir: string): boolean =>
      COMFY_CATEGORIES.some((c) => existsSync(path.join(dir, c)));
    for (const dir of candidates) {
      if (hasTypeDir(dir)) shelves.push(dir);
      /*
       * AND THE REPO FOLDERS ON THE SHELF. The model store lands a repo as
       * `<shelf>/<org__repo>/<its own tree>` (download-repo.ts), and Comfy-Org
       * ships that tree the way ComfyUI reads it — `diffusion_models/…`,
       * `vae/…` — one level below the shelf, or two when a repo keeps its files
       * under `split_files/`. MEASURED: with only the shelf listed, the 3D
       * weights sat on disk and the graph was refused with "'dino_v3_vit_l
       * .safetensors' not in []".
       */
      let repos: string[];
      try {
        repos = readdirSync(dir);
      } catch {
        continue;
      }
      for (const repo of repos) {
        const repoDir = path.join(dir, repo);
        if (hasTypeDir(repoDir)) shelves.push(repoDir);
        const split = path.join(repoDir, 'split_files');
        if (hasTypeDir(split)) shelves.push(split);
      }
    }
  }
  const entryFor = (name: string, base: string, isDefault: boolean): string[] => [
    `${name}:`,
    `  base_path: ${base}`,
    ...(isDefault ? ['  is_default: true'] : []),
    ...COMFY_CATEGORIES.map((c) => `  ${c}: ${c}`),
  ];
  /*
   * ONE DIRECTORY PER CATEGORY, NAMED THE SAME AS THE CATEGORY.
   *
   * This used to write `checkpoints: image|video` for every row, on the theory
   * that the store is organised by what a model MAKES. Two things were wrong
   * with that, and together they meant ComfyUI found nothing at all:
   *
   *  - the store is NOT organised by modality. comfy-install.ts creates
   *    `checkpoints/`, `unet/`, `vae/`, `text_encoders/` … under the store and
   *    every pack's `targetSubdir` is one of those. There has never been an
   *    `image/` or a `video/` directory to find.
   *  - `|` is not ComfyUI's separator. A value in extra_model_paths.yaml is one
   *    path, or several separated by NEWLINES — so `image|video` was read as a
   *    single directory literally named "image|video".
   *
   * VERIFIED after the fix: ComfyUI's /object_info lists our checkpoints, unet,
   * vae and text_encoders, and the graphs that reference them run.
   */
  const yaml = [
    '# Written by Bobble. ComfyUI reads its weights from the model library',
    '# (~/Bobble/Models, one entry per shelf) and the legacy store.',
    '# Do not edit by hand; rewritten whenever the engine is prepared.',
    ...entryFor('bobble', store, true),
    ...shelves.flatMap((dir, i) => entryFor(`bobble_shelf_${i + 1}`, dir, false)),
    '',
  ].join('\n');
  writeFileSync(comfyModelPathsYaml(), yaml, 'utf8');
}

/**
 * GGUF loaders for ComfyUI, and the two libraries their tokenisers need.
 *
 * Not a nicety on this platform: MPS REFUSES fp8 casts, so for anything larger
 * than a small model the choice is fp16 or nothing — and fp16 is what makes a
 * 24GB Mac page. Wan's umt5-xxl text encoder is 11GB at fp16 and 4.1GB as
 * Q5_K_M; MEASURED, that difference is a 48-frame clip taking over 45 minutes
 * versus a LARGER 49-frame clip taking 8.7. The LTX-2.5 weights the catalog
 * points at are GGUF for the same reason.
 *
 * `sentencepiece` and `protobuf` are separate because the GGUF CLIP loader only
 * asks for them when it actually builds a tokeniser — so without them the node
 * installs fine, loads fine, and fails at the first text encode with an
 * ImportError, which is the worst moment to discover a missing dependency.
 */
/**
 * A GitHub tree WITHOUT git. `git` on a Mac that has never installed the
 * Command Line Tools is a stub that pops Apple's install dialog and exits —
 * so a `git clone` here was the difference between "one click" and "install
 * Xcode's tools first" for every fresh Mac (the user, 2026-09-14: one-click
 * modules on any M1–M6 Mac). GitHub serves the same tree as a tarball, and
 * `tar` ships with macOS. Same tip-of-branch the shallow clone fetched.
 */
async function fetchGitHubTree(
  owner: string,
  repo: string,
  branch: string,
  dest: string,
): Promise<void> {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`;
  const res = await fetch(url, { headers: { 'user-agent': 'bobble-engines' } });
  if (!res.ok) throw new Error(`could not fetch ${owner}/${repo} (${res.status})`);
  const scratch = mkdtempSync(path.join(tmpdir(), `bobble-${repo}-`));
  const archive = path.join(scratch, 'tree.tar.gz');
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  await run('tar', ['-xzf', archive, '-C', scratch], 10 * 60_000);
  const extracted = readdirSync(scratch).find((n) => n !== 'tree.tar.gz');
  if (extracted === undefined) throw new Error(`${owner}/${repo}: empty archive`);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(path.join(scratch, extracted), dest);
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * The ComfyUI this app's graphs are written against. The native TRELLIS.2 and
 * Pixal3D nodes (image → 3D with no git, no Xcode, no custom wheels) landed in
 * 0.34.0; the graphs were verified on 0.35.0. Qwen-Image 2.1 (the image
 * default since 2026-09-20: TextEncodeQwenImage21, the 2.1 DiT and VAE)
 * landed on master on 2026-09-19 and reports 0.37.0.
 */
export const COMFY_REQUIRED_VERSION = '0.37.0';

/** `__version__` from the checkout's comfyui_version.py; null when unreadable. */
export function comfyVersionInstalled(): string | null {
  try {
    const text = readFileSync(path.join(comfyRoot(), 'comfyui_version.py'), 'utf8');
    return /__version__\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Dotted-number comparison: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Below the version the graphs need — a checkout that predates the nodes. */
export function comfyTreeIsStale(): boolean {
  const v = comfyVersionInstalled();
  return v === null || compareVersions(v, COMFY_REQUIRED_VERSION) < 0;
}

/**
 * What survives a refresh of the checkout: the venv (a 6 GB torch install),
 * the custom nodes we fetched or wrote, and everything the person's own use
 * of ComfyUI produced. The rest IS the version, and is replaced.
 */
const COMFY_KEEP = new Set([
  '.venv',
  'custom_nodes',
  'user',
  'input',
  'output',
  'temp',
  'models',
  'pi-model-paths.yaml',
  'extra_model_paths.yaml',
]);

/**
 * Bring the checkout to master while keeping the venv.
 *
 * The install fetched the tree once and never again, so a Mac that installed
 * ComfyUI at 0.33.0 (this one did, on 2026-09-12) would never have gained the
 * native 3D nodes that arrived in 0.34, and the 3D studio's graph would fail
 * with "node not found" for as long as that checkout lived. Fetching master is
 * a 12 MB tarball; the requirements install afterwards is uv answering "already
 * satisfied" in a couple of seconds when nothing moved, and the real download
 * only when a pin did.
 */
export async function refreshComfyTree(uv: string): Promise<void> {
  const root = comfyRoot();
  const scratch = mkdtempSync(path.join(tmpdir(), 'bobble-comfy-tree-'));
  try {
    await fetchGitHubTree('comfyanonymous', 'ComfyUI', 'master', path.join(scratch, 'tree'));
    for (const name of readdirSync(root)) {
      if (COMFY_KEEP.has(name)) continue;
      rmSync(path.join(root, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(path.join(scratch, 'tree'))) {
      if (name === 'custom_nodes' || name === 'user' || name === 'input' || name === 'output')
        continue;
      if (name === 'models' && existsSync(path.join(root, 'models'))) continue;
      renameSync(path.join(scratch, 'tree', name), path.join(root, name));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  await run(
    uv,
    ['pip', 'install', '--python', comfyVenv(), '-r', path.join(root, 'requirements.txt')],
    30 * 60_000,
  );
}

/**
 * A checkout on the version the graphs need. No-op when it already is; the
 * refresh otherwise — called by the installer and by the studio before it
 * starts the server, the way the model-paths yaml is rewritten on every start.
 */
export async function ensureComfyCurrent(): Promise<void> {
  if (!existsSync(comfyMainPy()) || !existsSync(comfyVenv()) || !comfyTreeIsStale()) return;
  const uv = await ensureUvPath();
  await refreshComfyTree(uv);
}

async function installComfyGguf(uv: string): Promise<void> {
  const dir = path.join(comfyRoot(), 'custom_nodes', 'ComfyUI-GGUF');
  if (!existsSync(dir)) {
    await fetchGitHubTree('city96', 'ComfyUI-GGUF', 'main', dir);
  }
  await run(
    uv,
    ['pip', 'install', '--python', comfyVenv(), 'gguf>=0.13.0', 'sentencepiece', 'protobuf'],
    10 * 60_000,
  );
}

/**
 * Drop the H3 detection shim beside ComfyUI's other custom nodes.
 *
 * Rewritten on every install rather than written once, so a corrected shim
 * reaches a machine that already has one. See `comfy-h3-shim.ts` for what it
 * does and for why a file we WRITE is not the custom node §4 forbids us to
 * AUTHOR into the app.
 */
export function writeComfyShim(): void {
  const dir = path.join(comfyRoot(), 'custom_nodes', COMFY_H3_SHIM_DIRNAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '__init__.py'), COMFY_H3_SHIM_PY);
  writeFileSync(path.join(dir, COMFY_MESH_ON_CPU_FILENAME), COMFY_MESH_ON_CPU_PY);
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
    installed: () => engineInstalled('rapid-mlx') || venvHasPackage('rapid_mlx'),
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
   * RAPID-MLX'S VISION RUNTIME — its own venv, because its vision lane needs
   * `rapid-mlx[vision]` (mlx-vlm pinned to exactly 0.6.17, torch, torchvision,
   * opencv) and the shared venv holds oMLX's git pin of mlx-vlm instead.
   * MEASURED 2026-09-23: 1.2 GB. The user: vision "should always be on unless the
   * user says to turn it off" — so this is fetched with the default engines
   * while Vision is on (llm-store ensureDefaultEngines), and until it lands a
   * vision launch on rapid-mlx goes to llama.cpp (vision-launch.ts).
   */
  'rapid-mlx-vision': {
    installed: () => rapidVisionReady(),
    bytes: () =>
      existsSync(rapidVisionVenvRoot()) ? dirBytes(rapidVisionVenvRoot(), 400_000) : undefined,
    install: async () => {
      const uv = await ensureUvPath();
      const root = rapidVisionVenvRoot();
      rmSync(rapidVisionMarker(), { force: true });
      if (!existsSync(path.join(root, 'bin', 'python'))) {
        await run(uv, ['venv', root, '--python', '3.12']);
      }
      // The same rapid-mlx the shared venv runs, so its two lanes are one engine.
      const version = venvPackageVersion('rapid-mlx');
      await run(
        uv,
        [
          'pip',
          'install',
          '--python',
          root,
          version === undefined ? 'rapid-mlx[vision]' : `rapid-mlx[vision]==${version}`,
        ],
        30 * 60_000,
      );
      writeFileSync(rapidVisionMarker(), `${new Date().toISOString()}\n`);
    },
    uninstall: async () => {
      rmSync(rapidVisionVenvRoot(), { recursive: true, force: true });
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
      const uv = await ensureUvPath();
      if (!existsSync(comfyMainPy())) {
        rmSync(comfyRoot(), { recursive: true, force: true });
        await fetchGitHubTree('comfyanonymous', 'ComfyUI', 'master', comfyRoot());
      } else if (comfyTreeIsStale()) {
        // Installed before the native 3D nodes existed: the venv stays, the
        // tree moves to master (refreshComfyTree explains).
        await refreshComfyTree(uv);
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
      await installComfyGguf(uv);
      writeComfyShim();
      writeComfyModelPaths();
    },
    uninstall: async () => {
      rmSync(comfyRoot(), { recursive: true, force: true });
    },
  },
  'dflash-mlx': {
    installed: () => engineInstalled('dflash-mlx') || venvHasPackage('dflash_mlx'),
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
  /*
   * MLX-DSPARK: the DSpark / DFlash / lookup speculative server for MLX. One pip
   * package; the drafters it needs are fetched with the model (model-downloader),
   * never here, so calibration has them without a network.
   */
  'mlx-dspark': {
    installed: () => engineInstalled('mlx-dspark'),
    bytes: () => undefined,
    install: async () => {
      const uv = await ensureVenv();
      await run(uv, ['pip', 'install', '--python', pyRoot(), 'mlx-dspark']);
    },
    uninstall: async () => {
      const uv = uvPath();
      if (uv === null) return;
      await run(uv, ['pip', 'uninstall', '--python', pyRoot(), 'mlx-dspark']).catch(
        () => undefined,
      );
    },
  },
  /*
   * OMLX is not on PyPI — `pip install omlx` resolves to nothing — so it is
   * installed from its source repository. Same venv, so it shares the MLX
   * runtime the others already paid for.
   */
  omlx: {
    installed: () => engineInstalled('omlx'),
    bytes: () => undefined,
    install: async () => {
      const uv = await ensureVenv();
      await run(
        uv,
        ['pip', 'install', '--python', pyRoot(), 'omlx @ git+https://github.com/jundot/omlx'],
        30 * 60_000,
      );
    },
    uninstall: async () => {
      const uv = uvPath();
      if (uv === null) return;
      await run(uv, ['pip', 'uninstall', '--python', pyRoot(), 'omlx']).catch(() => undefined);
    },
  },
  /*
   * MLX-LM arrives as a dependency of rapid-mlx; its `mlx_lm.server` is the
   * plain reference server calibration measures as the MLX floor. Reported,
   * never installed on its own.
   */
  'mlx-lm': {
    installed: () => engineInstalled('mlx-lm'),
    bytes: () => undefined,
    install: async () => {
      const uv = await ensureVenv();
      await run(uv, ['pip', 'install', '--python', pyRoot(), 'mlx-lm']);
    },
    uninstall: async () => {
      const uv = uvPath();
      if (uv === null) return;
      await run(uv, ['pip', 'uninstall', '--python', pyRoot(), 'mlx-lm']).catch(() => undefined);
    },
  },
  /*
   * VLLM (Linux): its own venv, because the CUDA / ROCm wheels are several
   * gigabytes and nothing else here wants them. `uv` picks the wheel for the
   * machine's accelerator from the default index.
   */
  vllm: {
    installed: () => engineInstalled('vllm'),
    bytes: () => (existsSync(vllmVenvRoot()) ? dirBytes(vllmVenvRoot(), 400_000) : undefined),
    install: async () => {
      if (process.platform !== 'linux') throw new Error('vLLM runs on Linux only');
      const uv = await ensureUvPath();
      if (!existsSync(vllmVenvRoot())) await run(uv, ['venv', vllmVenvRoot(), '--python', '3.12']);
      await run(uv, ['pip', 'install', '--python', vllmVenvRoot(), 'vllm'], 60 * 60_000);
    },
    uninstall: async () => {
      rmSync(vllmVenvRoot(), { recursive: true, force: true });
    },
  },
  /*
   * NINFER (RTX 5090, Linux) and its RTX 3090 port: C++/CUDA engines with no
   * wheel and no install target — "run NInfer from its source build tree". So
   * the install IS the clone and the cmake build, under the app cache like
   * everything else, and the panel reports the compiler's last lines when the
   * box lacks CUDA 13.1 / 12.8, Ninja or a C++20 compiler. The catalogue keeps
   * both rows off every other card (engine-catalog `requiresGpu`); this only
   * refuses the platform it cannot build on. Not exercised on a 5090 here —
   * the build recipe is the upstream README's, verbatim.
   */
  ninfer: {
    installed: () => existsSync(path.join(ninferRoot('ninfer'), 'build', 'apps', 'ninfer-serve')),
    bytes: () =>
      existsSync(ninferRoot('ninfer')) ? dirBytes(ninferRoot('ninfer'), 200_000) : undefined,
    install: async () => {
      if (process.platform !== 'linux') throw new Error('NInfer builds on Linux only');
      const root = ninferRoot('ninfer');
      if (!existsSync(path.join(root, 'CMakeLists.txt'))) {
        rmSync(root, { recursive: true, force: true });
        await run(
          'git',
          ['clone', '--depth', '1', 'https://github.com/Neroued/ninfer.git', root],
          20 * 60_000,
        );
      }
      await run(
        'cmake',
        ['-S', root, '-B', path.join(root, 'build'), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'],
        20 * 60_000,
      );
      await run('cmake', ['--build', path.join(root, 'build'), '-j'], 90 * 60_000);
    },
    uninstall: async () => {
      rmSync(ninferRoot('ninfer'), { recursive: true, force: true });
    },
  },
  'ninfer-3090': {
    installed: () =>
      existsSync(path.join(ninferRoot('ninfer-3090'), 'build-sm86', 'apps', 'ninfer-serve')),
    bytes: () =>
      existsSync(ninferRoot('ninfer-3090'))
        ? dirBytes(ninferRoot('ninfer-3090'), 200_000)
        : undefined,
    install: async () => {
      if (process.platform !== 'linux') {
        throw new Error(
          'On Windows, NInfer 3090 ships as a zip: github.com/Don-Chad/ninfer-3090/releases',
        );
      }
      const root = ninferRoot('ninfer-3090');
      if (!existsSync(path.join(root, 'CMakeLists.txt'))) {
        rmSync(root, { recursive: true, force: true });
        await run(
          'git',
          [
            'clone',
            '--depth',
            '1',
            '--branch',
            'release/v0.6.0-rtx3090',
            'https://github.com/Don-Chad/ninfer-3090.git',
            root,
          ],
          20 * 60_000,
        );
      }
      await run(
        'cmake',
        [
          '-S',
          root,
          '-B',
          path.join(root, 'build-sm86'),
          '-G',
          'Ninja',
          '-DCMAKE_BUILD_TYPE=Release',
          '-DCMAKE_CUDA_ARCHITECTURES=86',
          '-DNINFER_BUILD_APPS=ON',
          '-DBUILD_TESTING=OFF',
          '-DNINFER_BUILD_BENCHMARKS=OFF',
        ],
        20 * 60_000,
      );
      await run(
        'cmake',
        ['--build', path.join(root, 'build-sm86'), '--parallel', '2'],
        120 * 60_000,
      );
    },
    uninstall: async () => {
      rmSync(ninferRoot('ninfer-3090'), { recursive: true, force: true });
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

/**
 * Install whatever of a set is missing, one at a time.
 *
 * The user: "download a few generally good engines at the start of downloading the
 * app eg. if on apple silicon mac, omlx rapidmlx and dflashmlx (always llamacpp
 * also, on any machine we always have llamacpp first and foremost), on some
 * other machines like big linux boxes, vllm would be part of this set."
 *
 * WHICH engines is the catalogue's call (settings/engine-catalog.ts
 * `defaultEngineSet`, per platform); this is only the doing. llama.cpp is never
 * in the set because the model launch path fetches it, and a second fetcher
 * here would be a second opinion on which build is current. Never throws — a
 * machine without uv, or offline, stays as it is and the Engines panel says so
 * per row. `onChange` fires after every row settles so a menu can redraw.
 */
export async function ensureEngines(
  ids: readonly string[],
  onChange?: () => void,
): Promise<{ installed: string[]; failed: Array<{ id: string; error: string }> }> {
  const installed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    const ops = OPS[id];
    if (ops === undefined) continue;
    let present = false;
    try {
      present = ops.installed();
    } catch {
      present = false;
    }
    if (present) continue;
    const res = await installEngine(id);
    if (res.success) installed.push(id);
    else failed.push({ id, error: res.error ?? 'install failed' });
    onChange?.();
  }
  return { installed, failed };
}
