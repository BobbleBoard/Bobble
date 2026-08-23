/**
 * WHAT IS IN THIS MACHINE — every platform, not just this Mac.
 *
 * the user: "you detect all hardware/memory, figure out for any model on the hf hub
 * optimal engine… this is paramount to the whole out of the box experience on
 * any users machine… you get 99% of the way there on 99% of models on 99% of
 * hardware to a person who knows how to do their stuff and manually configures
 * stuff for maximum performance."
 *
 * Nothing downstream of this can be better than it is. An engine ranking that
 * does not know whether there is a CUDA card in the box is a ranking of
 * opinions; one that does is a decision. So this answers four questions, and
 * they are the four every later choice turns on:
 *
 *   1. WHICH OS — decides which engines exist at all (vLLM is Linux, DirectML
 *      is Windows, Metal is macOS).
 *   2. WHICH ACCELERATOR VENDOR — decides which of those actually run (CUDA
 *      kernels on an AMD card are not slow, they are absent).
 *   3. HOW MUCH MEMORY THE ACCELERATOR HAS, which is NOT system RAM on a
 *      discrete GPU and IS on a unified-memory Mac. Conflating the two is the
 *      single most common way a recommender promises something that OOMs.
 *   4. WHETHER THERE IS AN NPU, because on recent Windows and AMD laptops that
 *      is a third processor with its own runtime.
 *
 * EVERY PROBE IS BEST-EFFORT AND NON-FATAL. A machine with no `nvidia-smi`, no
 * `wmic`, a locked-down PowerShell, or a container with no `/sys` must still
 * produce a usable answer — degraded to "CPU with this much RAM", which is a
 * real configuration and not an error state. The parsers are pure and exported
 * so the interesting cases are unit-tested without owning the hardware.
 */
import { execFile as execFileCb } from 'node:child_process';
import { arch, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export type OsPlatform = 'darwin' | 'win32' | 'linux';
export type GpuVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown';

export interface GpuInfo {
  readonly vendor: GpuVendor;
  /** Marketing name as the system reports it, e.g. "NVIDIA GeForce RTX 4090". */
  readonly name: string;
  /**
   * Dedicated video memory in GB, when the system reports it.
   *
   * Undefined on unified-memory machines BY DESIGN — an Apple GPU has no VRAM
   * of its own, and reporting the system total here would make a 24 GB Mac look
   * like a 24 GB discrete card, which is not the same budget at all (the OS,
   * the app and the model share it).
   */
  readonly vramGB?: number;
  /** CUDA compute capability major version, when known (7 = Turing, 8 = Ampere…). */
  readonly cudaMajor?: number;
}

export interface AcceleratorInfo {
  readonly platform: OsPlatform;
  /** `arm64` | `x64` | … as Node reports it. */
  readonly arch: string;
  readonly appleSilicon: boolean;
  /** Physical RAM in GB. */
  readonly totalRamGB: number;
  /** GPUs found, best first. Empty means CPU-only, which is a real answer. */
  readonly gpus: readonly GpuInfo[];
  /**
   * The GPU shares system RAM (Apple Silicon, most iGPUs) rather than having
   * its own. Decides whether `vramGB` or `totalRamGB` is the budget.
   */
  readonly unifiedMemory: boolean;
  /** An NPU is present (Windows Copilot+, AMD Ryzen AI, Apple Neural Engine). */
  readonly npu: boolean;
  /** Chip brand string when known, e.g. "Apple M5 Pro". */
  readonly chip?: string;
  readonly cpuCount?: number;
}

/**
 * The memory a model actually gets to use, in GB.
 *
 * On a discrete GPU that is its VRAM — system RAM is irrelevant, spilling into
 * it is what "it ran but at one token a second" means. On unified memory it is
 * the system total, minus what the OS and the app need to stay responsive.
 *
 * The 25% reserve is deliberately generous and deliberately not a setting: it
 * is the difference between a recommendation that runs and one that swaps, and
 * a user who wants to gamble their whole machine on a bigger quant can pick it
 * by hand.
 */
export function usableMemoryGB(info: AcceleratorInfo): number {
  const gpu = info.gpus[0];
  if (gpu !== undefined && !info.unifiedMemory && gpu.vramGB !== undefined) return gpu.vramGB;
  return Math.max(1, Math.round(info.totalRamGB * 0.75));
}

// ── pure parsers (exported for tests) ───────────────────────────────────────

/** `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader`. */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', mem = '', cap = ''] = line.split(',').map((p) => p.trim());
      // nvidia-smi reports MiB; a 24564 MiB card is a 24 GB card, so round to
      // the nearest GB rather than truncating it to 23.
      const mib = Number.parseFloat(mem.replace(/[^0-9.]/g, ''));
      const major = Number.parseInt(cap.split('.')[0] ?? '', 10);
      return {
        vendor: 'nvidia' as const,
        name,
        ...(Number.isFinite(mib) && mib > 0 ? { vramGB: Math.round(mib / 1024) } : {}),
        ...(Number.isFinite(major) ? { cudaMajor: major } : {}),
      };
    })
    .filter((g) => g.name.length > 0);
}

/** Vendor from a marketing name, for the paths that only give us one. */
export function vendorFromName(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (/nvidia|geforce|rtx |gtx |quadro|tesla/.test(n)) return 'nvidia';
  if (/amd|radeon|instinct|firepro/.test(n)) return 'amd';
  if (/intel|arc |iris|uhd graphics|hd graphics/.test(n)) return 'intel';
  if (/apple m\d/.test(n)) return 'apple';
  return 'unknown';
}

/** `system_profiler SPDisplaysDataType -json`. */
export function parseMacDisplays(json: string): GpuInfo[] {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (body as { SPDisplaysDataType?: unknown }).SPDisplaysDataType;
  if (!Array.isArray(list)) return [];
  return list
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const name = typeof r.sppci_model === 'string' ? r.sppci_model : String(r._name ?? '');
      const vendorRaw = typeof r.spdisplays_vendor === 'string' ? r.spdisplays_vendor : '';
      const vendor: GpuVendor = vendorRaw.includes('Apple') ? 'apple' : vendorFromName(name);
      // No vramGB on purpose — see GpuInfo.vramGB.
      return { vendor, name };
    })
    .filter((g) => g.name.length > 0);
}

/**
 * Windows: `wmic path win32_VideoController get Name,AdapterRAM /format:csv`
 * (and the PowerShell CIM equivalent, which prints the same two fields).
 *
 * AdapterRAM is a 32-bit field, so it SATURATES at 4 GB on anything bigger and
 * a 24 GB card reports 4294967295. Reading that as the VRAM would tell an RTX
 * 4090 owner they have 4 GB, so a saturated value is discarded rather than
 * believed — `nvidia-smi` is asked first anyway, and this is the fallback for
 * the cards it does not cover.
 */
export function parseWindowsVideoControllers(stdout: string): GpuInfo[] {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // `/format:csv` emits a header row naming the columns, and their ORDER is not
  // guaranteed — wmic sorts them alphabetically, which is why AdapterRAM comes
  // before Name. Reading positionally works until it silently does not.
  const headerIndex = lines.findIndex((l) => /(^|,)Name(,|$)/i.test(l));
  if (headerIndex === -1) return [];
  const header = (lines[headerIndex] ?? '').split(',').map((c) => c.trim().toLowerCase());
  const nameCol = header.indexOf('name');
  const ramCol = header.indexOf('adapterram');
  const out: GpuInfo[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split(',').map((c) => c.trim());
    const name = nameCol >= 0 ? (cells[nameCol] ?? '') : '';
    if (name.length === 0) continue;
    const bytes = ramCol >= 0 ? Number.parseInt(cells[ramCol] ?? '', 10) : Number.NaN;
    const saturated = bytes >= 4_294_000_000;
    out.push({
      vendor: vendorFromName(name),
      name,
      ...(Number.isFinite(bytes) && bytes > 0 && !saturated
        ? { vramGB: Math.round(bytes / 1024 ** 3) }
        : {}),
    });
  }
  return out;
}

/** `lspci -mm` lines for VGA/3D controllers. */
export function parseLspci(stdout: string): GpuInfo[] {
  const out: GpuInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) continue;
    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
    // lspci -mm: slot "class" "vendor" "device" …
    const vendorName = quoted[1] ?? '';
    const device = quoted[2] ?? '';
    const name = `${vendorName} ${device}`.trim();
    if (name.length === 0) continue;
    out.push({ vendor: vendorFromName(name), name });
  }
  return out;
}

/** Best GPU first: a discrete card outranks the iGPU that shares its box. */
export function rankGpus(gpus: readonly GpuInfo[]): GpuInfo[] {
  const score = (g: GpuInfo): number => {
    if (g.vendor === 'nvidia') return 4;
    if (g.vendor === 'apple') return 3;
    if (g.vendor === 'amd') return 2;
    if (g.vendor === 'intel') return 1;
    return 0;
  };
  return [...gpus].sort((a, b) => score(b) - score(a) || (b.vramGB ?? 0) - (a.vramGB ?? 0));
}

// ── detection ───────────────────────────────────────────────────────────────

export type RunFn = (cmd: string, args: readonly string[]) => Promise<string>;

const defaultRun: RunFn = async (cmd, args) => {
  const { stdout } = await execFile(cmd, [...args], { timeout: 8000 });
  return stdout;
};

async function tryRun(run: RunFn, cmd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await run(cmd, args);
  } catch {
    // A missing tool is the normal case on most machines, not a failure worth
    // surfacing: this whole module degrades rather than errors.
    return null;
  }
}

export interface DetectOptions {
  readonly run?: RunFn;
  readonly platformOverride?: OsPlatform;
  readonly archOverride?: string;
  readonly totalMemBytes?: number;
}

export async function detectAccelerators(opts: DetectOptions = {}): Promise<AcceleratorInfo> {
  const run = opts.run ?? defaultRun;
  const os = (opts.platformOverride ?? platform()) as OsPlatform;
  const cpuArch = opts.archOverride ?? arch();
  const totalRamGB = Math.round((opts.totalMemBytes ?? totalmem()) / 1024 ** 3);
  const appleSilicon = os === 'darwin' && cpuArch === 'arm64';

  let gpus: GpuInfo[] = [];
  let chip: string | undefined;
  let npu = false;

  // NVIDIA first everywhere it might exist: it is the only probe that reports a
  // trustworthy VRAM figure, and a machine that has it wants it used.
  if (os !== 'darwin') {
    const smi = await tryRun(run, 'nvidia-smi', [
      '--query-gpu=name,memory.total,compute_cap',
      '--format=csv,noheader',
    ]);
    if (smi !== null) gpus = parseNvidiaSmi(smi);
  }

  if (os === 'darwin') {
    const displays = await tryRun(run, 'system_profiler', ['SPDisplaysDataType', '-json']);
    if (displays !== null) gpus = parseMacDisplays(displays);
    const brand = await tryRun(run, 'sysctl', ['-n', 'machdep.cpu.brand_string']);
    chip = brand?.trim() || undefined;
    // Every Apple Silicon Mac has a Neural Engine.
    npu = appleSilicon;
  } else if (os === 'win32') {
    if (gpus.length === 0) {
      const wmic = await tryRun(run, 'wmic', [
        'path',
        'win32_VideoController',
        'get',
        'Name,AdapterRAM',
        '/format:csv',
      ]);
      if (wmic !== null) gpus = parseWindowsVideoControllers(wmic);
    }
    // Copilot+ NPUs surface as a device with "NPU" or "AI Boost" in the name.
    const devices = await tryRun(run, 'wmic', ['path', 'win32_PnPEntity', 'get', 'Name']);
    npu = devices !== null && /\bNPU\b|AI Boost|Neural Processor/i.test(devices);
  } else {
    if (gpus.length === 0) {
      const lspci = await tryRun(run, 'lspci', ['-mm']);
      if (lspci !== null) gpus = parseLspci(lspci);
    }
  }

  const ranked = rankGpus(gpus);
  const best = ranked[0];
  const unifiedMemory =
    appleSilicon || (best !== undefined && best.vendor !== 'nvidia' && best.vramGB === undefined);

  return {
    platform: os,
    arch: cpuArch,
    appleSilicon,
    totalRamGB,
    gpus: ranked,
    unifiedMemory,
    npu,
    ...(chip === undefined ? {} : { chip }),
  };
}
