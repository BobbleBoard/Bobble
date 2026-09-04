/**
 * WHAT THIS MACHINE IS DOING RIGHT NOW — on every platform, not just this Mac.
 *
 * the user: "it's not about this machine only … you need to handle a range of
 * hardware and a range of situations and bottlenecks."
 *
 * {@link accelerator.ts} answers what is IN the box, once, at startup. This
 * answers what is happening in it, repeatedly, while the app runs — because a
 * budget computed from `hw.memsize` at launch cannot know that the user has
 * since opened Lightroom, unplugged the charger, or started a game on the same
 * GPU we are about to fill.
 *
 * ## The reading is normalised; the gathering is not
 *
 * Every platform is asked in its own language and the answers are reduced to one
 * shape, because the POLICY should reason about "memory is tight" rather than
 * about `kern.memorystatus_vm_pressure_level`. What each platform can honestly
 * answer differs, so every field is optional and `undefined` means "this machine
 * would not say", never "zero".
 *
 * ## Two traps this exists to avoid
 *
 *   `os.freemem()` IS A LIE ON macOS. MEASURED on a 24 GB Mac sitting at
 *   pressure level 1 (normal, plenty of headroom): 2.3 GB "free". Most of the
 *   rest is file cache the OS will hand back the instant anyone asks. A policy
 *   built on free memory would put that machine into its most conservative mode
 *   permanently. macOS is asked for its own verdict instead
 *   (`memorystatus_vm_pressure_level`, plus how much it has actually swapped).
 *
 *   VRAM IS NOT SYSTEM RAM. On a discrete card the wall is the card's memory and
 *   system RAM is irrelevant; on unified memory they are the same pool and the
 *   OS is competing for it. `accelerator.ts` already draws that distinction and
 *   the policy leans on it — see {@link BottleneckClass}.
 *
 * Every probe is best-effort and non-fatal: a locked-down container, a Mac with
 * no `pmset`, a Linux without PSI compiled in must all still produce a usable
 * reading, degraded to the portable floor (total/free/swap, load average). The
 * parsers are pure and exported so the interesting cases are unit-tested without
 * owning the hardware.
 */

/** How hard the machine is being squeezed, 0 (idle) to 1 (at the wall). */
export type Load = number;

/** The OS's own verdict where it has one. */
export type MemoryVerdict = 'normal' | 'warn' | 'critical';

export interface SystemPressure {
  /**
   * Memory, as the OS judges it — NOT as free bytes. macOS reports a pressure
   * level directly; Linux's PSI `some avg10` is the equivalent honest signal;
   * elsewhere it is derived from available/total.
   */
  readonly memory?: MemoryVerdict;
  /**
   * How much of the swap file is in use, 0..1.
   *
   * A WEAK signal, and it took a live run to find out why. MEASURED on a 24 GB
   * Mac: 65% of swap in use while macOS reported pressure level 1 (normal) and
   * the swapin/swapout counters had not moved in three seconds. Swap usage is a
   * STOCK accumulated over days of uptime, not a statement about now — treating
   * it as pressure would pin every long-running machine into its most
   * conservative mode permanently. It corroborates; it never escalates alone.
   */
  readonly swapUsed?: Load;
  /**
   * Pages swapped in + out PER SECOND since the previous reading — the flow
   * rather than the stock, and the honest "is this machine thrashing right now".
   * Undefined on the first reading (a rate needs two).
   */
  readonly swapIoPerSec?: number;
  /** Raw cumulative swap counters, so the next reading can difference them. */
  readonly swapCounters?: { readonly ins: number; readonly outs: number; readonly at: number };
  /** Run-queue depth per core, clamped to 1. Undefined on Windows. */
  readonly cpu?: Load;
  /** GPU busy fraction, where the driver will say (NVIDIA anywhere, AMD on Linux). */
  readonly gpu?: Load;
  /** Fraction of the accelerator's own memory in use — the wall on a discrete card. */
  readonly vram?: Load;
  /** The machine is running on battery. */
  readonly onBattery?: boolean;
  /** The OS is throttling for heat, or the user turned on its own low-power mode. */
  readonly throttled?: boolean;
  /** Which probes answered — so a policy can tell "fine" from "did not say". */
  readonly sources: readonly string[];
}

/**
 * WHICH WALL THIS MACHINE IS NEAREST — and therefore which lever moves it.
 *
 * This is the reason a single "low power" slider is the wrong shape. The levers
 * that help are not the same across machines:
 *
 *   'unified'   Apple Silicon and iGPUs. The GPU eats the same RAM as the OS,
 *               so the wall is total memory and the symptom is swap. Context
 *               size, KV quantisation and not running two heavy things at once
 *               are what move it. Clock knobs do nothing — MEASURED on Metal in
 *               perf-args.ts, where `-ngl`, `-ub`, `-b` and `-t` were all within
 *               noise of llama.cpp's own auto-tuner.
 *   'discrete'  A card with its own memory. The wall is VRAM and it is HARD:
 *               one layer too many and llama.cpp spills to the host, which is
 *               not slightly slower, it is an order of magnitude. `-ngl` is the
 *               lever, and it is a real one.
 *   'cpu'       No usable accelerator. The wall is cores, and `--threads` is the
 *               one place "generate a bit slower so I can use my computer"
 *               translates directly into a flag.
 */
export type BottleneckClass = 'unified' | 'discrete' | 'cpu';

// ── pure parsers (exported for tests) ───────────────────────────────────────

/** `sysctl -n kern.memorystatus_vm_pressure_level` → 1 normal, 2 warn, 4 critical. */
export function parseMacPressureLevel(out: string): MemoryVerdict | undefined {
  const n = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(n)) return undefined;
  if (n >= 4) return 'critical';
  if (n >= 2) return 'warn';
  return 'normal';
}

/** `sysctl -n vm.swapusage` → `total = 4096.00M  used = 2675.25M  free = 1420.75M`. */
export function parseMacSwap(out: string): Load | undefined {
  const total = /total\s*=\s*([\d.]+)([MGK])/i.exec(out);
  const used = /used\s*=\s*([\d.]+)([MGK])/i.exec(out);
  if (total === null || used === null) return undefined;
  const scale = (unit: string): number => (unit === 'G' ? 1024 : unit === 'K' ? 1 / 1024 : 1);
  const totalMB = Number.parseFloat(total[1] ?? '0') * scale(total[2] ?? 'M');
  const usedMB = Number.parseFloat(used[1] ?? '0') * scale(used[2] ?? 'M');
  if (!(totalMB > 0)) return 0;
  return clamp01(usedMB / totalMB);
}

/**
 * `vm_stat` → the cumulative swapin/swapout page counters.
 *
 * These are what actually answer "is it thrashing": the difference between two
 * readings. The absolute values mean nothing on their own — see `swapUsed`.
 */
export function parseVmStatSwapCounters(out: string): { ins: number; outs: number } | undefined {
  const ins = /^Swapins:\s+(\d+)/m.exec(out);
  const outs = /^Swapouts:\s+(\d+)/m.exec(out);
  if (ins === null || outs === null) return undefined;
  return {
    ins: Number.parseInt(ins[1] ?? '0', 10),
    outs: Number.parseInt(outs[1] ?? '0', 10),
  };
}

/**
 * `/proc/vmstat` on Linux → `pswpin` / `pswpout`, the same two numbers.
 */
export function parseProcVmstatSwapCounters(
  out: string,
): { ins: number; outs: number } | undefined {
  const ins = /^pswpin\s+(\d+)/m.exec(out);
  const outs = /^pswpout\s+(\d+)/m.exec(out);
  if (ins === null || outs === null) return undefined;
  return {
    ins: Number.parseInt(ins[1] ?? '0', 10),
    outs: Number.parseInt(outs[1] ?? '0', 10),
  };
}

/** Pages/second between two cumulative readings. Undefined when they are not
 * comparable (a counter that went backwards means the machine rebooted). */
export function swapRate(
  now: { ins: number; outs: number; at: number },
  previous: { ins: number; outs: number; at: number } | undefined,
): number | undefined {
  if (previous === undefined) return undefined;
  const seconds = (now.at - previous.at) / 1000;
  if (!(seconds > 0)) return undefined;
  const pages = now.ins - previous.ins + (now.outs - previous.outs);
  if (pages < 0) return undefined;
  return pages / seconds;
}

/**
 * `pmset -g therm`. A healthy machine prints "No thermal warning level has been
 * recorded"; a throttling one prints `CPU_Speed_Limit = 70`.
 */
export function parseMacThermal(out: string): boolean | undefined {
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(out);
  if (limit !== null) return Number.parseInt(limit[1] ?? '100', 10) < 100;
  if (/no thermal warning/i.test(out)) return false;
  return undefined;
}

/** `pmset -g ps` → "Now drawing from 'AC Power'" / "'Battery Power'". */
export function parseMacPowerSource(out: string): boolean | undefined {
  if (/drawing from '.*battery/i.test(out)) return true;
  if (/drawing from '.*ac power/i.test(out)) return false;
  return undefined;
}

/**
 * Linux PSI: `/proc/pressure/memory` →
 * `some avg10=0.00 avg60=0.00 avg300=0.00 total=0`.
 *
 * The single best pressure signal on any platform — it is literally "how much
 * time was lost waiting for this resource", which is the question. `some avg10`
 * is the share of the last ten seconds in which at least one task stalled.
 */
export function parsePsi(out: string, line: 'some' | 'full' = 'some'): Load | undefined {
  const m = new RegExp(`^${line}\\s+avg10=([\\d.]+)`, 'm').exec(out);
  if (m === null) return undefined;
  const pct = Number.parseFloat(m[1] ?? '');
  return Number.isFinite(pct) ? clamp01(pct / 100) : undefined;
}

/** PSI memory stall → the same verdict macOS gives directly. */
export function psiToVerdict(stall: Load): MemoryVerdict {
  if (stall >= 0.2) return 'critical';
  if (stall >= 0.05) return 'warn';
  return 'normal';
}

/** `/proc/meminfo` → MemAvailable / MemTotal. MemAvailable is the honest one:
 * it already accounts for reclaimable cache, which `free` does not. */
export function parseMemInfoAvailable(out: string): Load | undefined {
  const total = /^MemTotal:\s+(\d+)/m.exec(out);
  const avail = /^MemAvailable:\s+(\d+)/m.exec(out);
  if (total === null || avail === null) return undefined;
  const t = Number.parseInt(total[1] ?? '0', 10);
  const a = Number.parseInt(avail[1] ?? '0', 10);
  if (!(t > 0)) return undefined;
  return clamp01(1 - a / t);
}

/**
 * `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`
 * → `42, 8192, 24564`. Works on Linux AND Windows, no privileges.
 */
export function parseNvidiaSmiUtil(out: string): { gpu?: Load; vram?: Load } {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return {};
  const [util = '', used = '', total = ''] = line.split(',').map((p) => p.trim());
  const u = Number.parseFloat(util);
  const usedMiB = Number.parseFloat(used);
  const totalMiB = Number.parseFloat(total);
  const out2: { gpu?: Load; vram?: Load } = {};
  if (Number.isFinite(u)) out2.gpu = clamp01(u / 100);
  if (Number.isFinite(usedMiB) && Number.isFinite(totalMiB) && totalMiB > 0) {
    out2.vram = clamp01(usedMiB / totalMiB);
  }
  return out2;
}

/** AMD on Linux: `/sys/class/drm/card0/device/gpu_busy_percent` → `37`. */
export function parseAmdBusy(out: string): Load | undefined {
  const n = Number.parseFloat(out.trim());
  return Number.isFinite(n) ? clamp01(n / 100) : undefined;
}

/** `/sys/class/power_supply/BAT0/status` → Discharging | Charging | Full. */
export function parseLinuxBattery(out: string): boolean | undefined {
  const s = out.trim().toLowerCase();
  if (s.length === 0) return undefined;
  return s === 'discharging';
}

/**
 * The portable floor, from figures every platform reports (Electron's
 * `process.getSystemMemoryInfo`, or `os`).
 *
 * DELIBERATELY NOT USED ON macOS — see the header. Free memory there is a
 * number about the page cache, not about pressure.
 */
export function verdictFromFree(freeBytes: number, totalBytes: number): MemoryVerdict | undefined {
  if (!(totalBytes > 0)) return undefined;
  const used = 1 - freeBytes / totalBytes;
  if (used >= 0.95) return 'critical';
  if (used >= 0.85) return 'warn';
  return 'normal';
}

/** Run-queue depth per core. >1 means tasks are waiting for a core. */
export function loadToCpu(load1: number, cpuCount: number): Load | undefined {
  if (!(cpuCount > 0) || !Number.isFinite(load1)) return undefined;
  return clamp01(load1 / cpuCount);
}

function clamp01(n: number): Load {
  return Math.min(1, Math.max(0, n));
}

// ── the sampler ─────────────────────────────────────────────────────────────

/** Everything the sampler needs, injected so it tests without a machine. */
export interface PressureProbes {
  /** Run a command, returning stdout, or null when it does not exist / fails. */
  readonly run: (cmd: string, args: readonly string[]) => Promise<string | null>;
  /** Read a file, or null. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** `[1m, 5m, 15m]`. */
  readonly loadAvg: () => readonly number[];
  readonly cpuCount: number;
  /** Total / free bytes, from whatever the host offers. */
  readonly memory: () => { total: number; free: number };
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** True when the accelerator has memory of its own (nvidia-smi is worth asking). */
  readonly hasNvidia?: boolean;
  /** The previous reading's swap counters, so this one can produce a RATE. */
  readonly previousSwap?: { readonly ins: number; readonly outs: number; readonly at: number };
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

/**
 * Take one reading. Never throws, never blocks on a missing tool: a probe that
 * cannot answer leaves its field undefined and its name out of `sources`, and
 * the policy treats absence as "unknown", not as "fine".
 */
export async function samplePressure(probes: PressureProbes): Promise<SystemPressure> {
  const sources: string[] = [];
  const at = (probes.now ?? Date.now)();
  const out: {
    memory?: MemoryVerdict;
    swapUsed?: Load;
    swapIoPerSec?: number;
    swapCounters?: { ins: number; outs: number; at: number };
    cpu?: Load;
    gpu?: Load;
    vram?: Load;
    onBattery?: boolean;
    throttled?: boolean;
  } = {};

  const cpu = loadToCpu(probes.loadAvg()[0] ?? Number.NaN, probes.cpuCount);
  if (cpu !== undefined) {
    out.cpu = cpu;
    sources.push('loadavg');
  }

  if (probes.platform === 'darwin') {
    const level = await probes.run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
    const verdict = level === null ? undefined : parseMacPressureLevel(level);
    if (verdict !== undefined) {
      out.memory = verdict;
      sources.push('macos-pressure');
    }
    const swap = await probes.run('sysctl', ['-n', 'vm.swapusage']);
    const swapUsed = swap === null ? undefined : parseMacSwap(swap);
    if (swapUsed !== undefined) {
      out.swapUsed = swapUsed;
      sources.push('macos-swap');
    }
    // The FLOW, not the stock — see `swapIoPerSec`.
    const vmstat = await probes.run('vm_stat', []);
    const counters = vmstat === null ? undefined : parseVmStatSwapCounters(vmstat);
    if (counters !== undefined) {
      out.swapCounters = { ...counters, at };
      const rate = swapRate({ ...counters, at }, probes.previousSwap);
      if (rate !== undefined) {
        out.swapIoPerSec = rate;
        sources.push('macos-swap-rate');
      }
    }
    const therm = await probes.run('pmset', ['-g', 'therm']);
    const throttled = therm === null ? undefined : parseMacThermal(therm);
    if (throttled !== undefined) {
      out.throttled = throttled;
      sources.push('macos-thermal');
    }
    const ps = await probes.run('pmset', ['-g', 'ps']);
    const onBattery = ps === null ? undefined : parseMacPowerSource(ps);
    if (onBattery !== undefined) {
      out.onBattery = onBattery;
      sources.push('macos-power');
    }
  } else if (probes.platform === 'linux') {
    const psi = await probes.readFile('/proc/pressure/memory');
    const stall = psi === null ? undefined : parsePsi(psi);
    if (stall !== undefined) {
      out.memory = psiToVerdict(stall);
      sources.push('linux-psi');
    } else {
      const meminfo = await probes.readFile('/proc/meminfo');
      const usedFrac = meminfo === null ? undefined : parseMemInfoAvailable(meminfo);
      if (usedFrac !== undefined) {
        out.memory = usedFrac >= 0.95 ? 'critical' : usedFrac >= 0.85 ? 'warn' : 'normal';
        sources.push('linux-meminfo');
      }
    }
    const vmstat = await probes.readFile('/proc/vmstat');
    const counters = vmstat === null ? undefined : parseProcVmstatSwapCounters(vmstat);
    if (counters !== undefined) {
      out.swapCounters = { ...counters, at };
      const rate = swapRate({ ...counters, at }, probes.previousSwap);
      if (rate !== undefined) {
        out.swapIoPerSec = rate;
        sources.push('linux-swap-rate');
      }
    }
    const amd = await probes.readFile('/sys/class/drm/card0/device/gpu_busy_percent');
    const busy = amd === null ? undefined : parseAmdBusy(amd);
    if (busy !== undefined) {
      out.gpu = busy;
      sources.push('linux-amd');
    }
    const bat = await probes.readFile('/sys/class/power_supply/BAT0/status');
    const onBattery = bat === null ? undefined : parseLinuxBattery(bat);
    if (onBattery !== undefined) {
      out.onBattery = onBattery;
      sources.push('linux-battery');
    }
  }

  // Windows, and anything the branches above could not answer, fall back to the
  // portable figures. Skipped on macOS on purpose (free memory means nothing there).
  if (out.memory === undefined && probes.platform !== 'darwin') {
    const { total, free } = probes.memory();
    const verdict = verdictFromFree(free, total);
    if (verdict !== undefined) {
      out.memory = verdict;
      sources.push('free-memory');
    }
  }

  // The card's own numbers, wherever nvidia-smi lives. This is the only probe
  // that can tell us the user is already using the GPU for something else.
  if (probes.hasNvidia === true) {
    const smi = await probes.run('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    if (smi !== null) {
      const { gpu, vram } = parseNvidiaSmiUtil(smi);
      if (gpu !== undefined) out.gpu = gpu;
      if (vram !== undefined) out.vram = vram;
      if (gpu !== undefined || vram !== undefined) sources.push('nvidia-smi');
    }
  }

  return { ...out, sources };
}
