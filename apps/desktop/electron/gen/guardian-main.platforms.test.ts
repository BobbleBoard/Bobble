/**
 * THE GUARDIAN'S EYES ON EVERY OS — driven through `startGuardian` itself, the
 * file the bug lived in (crossplatform.md §2.4 A6, package XP-01).
 *
 * Main used to hand `samplePressure` the same two stand-ins on every OS:
 * `free: 0` and a `readFile` that never read anything. macOS consults neither
 * (it is asked for its own verdict), so nothing showed on this Mac. Off macOS
 * they WERE the reading: Linux's /proc came back empty, the portable floor
 * took "0 bytes free" at its word, `verdictFromFree(0, total)` is `critical`,
 * and the first reading was a shed. With the memory guard on (the default) a
 * shed with nothing to end parks the chat model — so on an idle PC the chat
 * model was unloaded at every reading.
 *
 * The machine is faked at the Node boundary (`node:os`, `node:fs/promises`,
 * `node:child_process`) and the REAL sampler and judge run on top, so what is
 * tested is exactly what main does with what each OS says. The macOS case pins
 * the probes, the commands and the reading to what they always were: the same
 * file passes against the code from before the fix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const GiB = 1024 ** 3;

/** The machine the Node calls describe — each test sets the OS and its answers. */
const host = vi.hoisted(() => ({
  platform: 'darwin' as string,
  totalmem: 24 * 1024 ** 3,
  freemem: 0,
  /** /proc and /sys contents by path; a path not here is ENOENT. */
  files: new Map<string, string>(),
  /** stdout by `cmd args…`; a command not here fails like a missing tool. */
  commands: new Map<string, string>(),
  ran: [] as { cmd: string; args: string[]; timeout: number | undefined }[],
  read: [] as string[],
}));

/** Every reading main took, with the probes it handed the sampler. */
const sampled = vi.hoisted(() => ({
  probes: [] as import('@pi-desktop/inference').PressureProbes[],
  readings: [] as import('@pi-desktop/inference').SystemPressure[],
}));

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return {
    ...real,
    platform: () => host.platform,
    totalmem: () => host.totalmem,
    freemem: () => host.freemem,
    cpus: () =>
      Array.from({ length: 8 }, () => ({
        model: 'test',
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      })),
    loadavg: () => [0.5, 0.5, 0.5],
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (path: unknown, ...rest: unknown[]) => {
      const p = String(path);
      if (p.startsWith('/proc/') || p.startsWith('/sys/')) {
        host.read.push(p);
        const content = host.files.get(p);
        if (content === undefined) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
            code: 'ENOENT',
          });
        }
        return content;
      }
      return (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    // Callback-shaped, so `promisify(execFile)` resolves `{ stdout, stderr }`
    // exactly as the real one's custom promisifier does.
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: { timeout?: number } | undefined,
      cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
    ) => {
      host.ran.push({ cmd, args: [...args], timeout: opts?.timeout });
      const stdout = host.commands.get([cmd, ...args].join(' '));
      if (stdout === undefined) {
        cb(Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      } else {
        cb(null, { stdout, stderr: '' });
      }
      return {};
    },
  };
});

vi.mock('@pi-desktop/inference', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pi-desktop/inference')>();
  return {
    ...real,
    // The real sampler, watched: what main handed it and what it read.
    samplePressure: async (probes: import('@pi-desktop/inference').PressureProbes) => {
      const reading = await real.samplePressure(probes);
      sampled.probes.push(probes);
      sampled.readings.push(reading);
      return reading;
    },
  };
});

import { startGuardian } from './guardian-main';

/** A Linux box as the kernel describes it: PSI stall share and MemAvailable. */
function linuxBox({
  availableFraction,
  psiSome = 0,
  psi = true,
}: {
  availableFraction: number;
  psiSome?: number;
  psi?: boolean;
}): void {
  host.platform = 'linux';
  const totalKb = host.totalmem / 1024;
  const availableKb = Math.round(totalKb * availableFraction);
  // os.freemem() on Linux IS MemAvailable (libuv reads the same line).
  host.freemem = availableKb * 1024;
  if (psi) {
    host.files.set(
      '/proc/pressure/memory',
      `some avg10=${psiSome.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n` +
        'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    );
  }
  host.files.set(
    '/proc/meminfo',
    [
      `MemTotal:       ${totalKb} kB`,
      `MemFree:         ${Math.round(totalKb * 0.05)} kB`,
      `MemAvailable:   ${availableKb} kB`,
      'Buffers:          262144 kB',
      `Cached:         ${Math.round(totalKb * 0.4)} kB`,
      'SwapTotal:       8388604 kB',
      'SwapFree:        8388604 kB',
      '',
    ].join('\n'),
  );
  host.files.set('/proc/vmstat', 'nr_free_pages 262144\npgfault 918273\npswpin 12\npswpout 40\n');
}

/** A Windows PC: all Node reports is total and available physical memory. */
function windowsPc(availableFraction: number): void {
  host.platform = 'win32';
  // os.freemem() on Windows is ullAvailPhys (free + zeroed + standby).
  host.freemem = Math.round(host.totalmem * availableFraction);
}

interface Announced {
  verdict: string;
  reason: string;
  memoryFree?: number;
  shed?: readonly string[];
}

function start() {
  const announced: Announced[] = [];
  const parked: string[] = [];
  const g = startGuardian({
    queue: () => null,
    mode: () => 'auto',
    reserveGB: () => undefined,
    parkChatModel: async (why) => {
      parked.push(why);
    },
    announce: (e) => announced.push(e),
    log: () => {},
  });
  return { g, announced, parked };
}

/** The start-up reading, landed (it is always announced: nothing came before it). */
async function firstReading(announced: readonly Announced[]): Promise<void> {
  await vi.waitFor(() => expect(announced.length).toBeGreaterThan(0), { timeout: 2000 });
}

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  host.files.clear();
  host.commands.clear();
  host.ran.length = 0;
  host.read.length = 0;
  sampled.probes.length = 0;
  sampled.readings.length = 0;
});

describe('the guardian off macOS', () => {
  it('reads a calm Linux box as calm, sheds nothing and leaves the chat model alone', async () => {
    // The acceptance reading: PSI 0, 60% of memory available.
    linuxBox({ availableFraction: 0.6, psiSome: 0 });
    const { g, announced, parked } = start();
    stop = g.stop;
    await firstReading(announced);
    for (let i = 0; i < 3; i += 1) expect(await g.refresh()).toBe('calm');
    await new Promise((r) => setTimeout(r, 20));

    expect(announced.map((a) => a.verdict)).toEqual(['calm']);
    expect(parked).toEqual([]);
    const reading = sampled.readings.at(-1);
    expect(reading?.memory).toBe('normal');
    expect(reading?.memoryFree).toBeCloseTo(0.6, 3);
    expect(reading?.sources).toContain('linux-psi');
    expect(g.memoryFree()).toBeCloseTo(0.6, 3);
    // Admission works on the numbers: a 2 GB job fits beside 14 GB available.
    expect(g.admit(2)).toEqual({ ok: true });
    // The kernel's own files were read; nothing was spawned to read them.
    expect(host.read).toEqual(
      expect.arrayContaining(['/proc/pressure/memory', '/proc/meminfo', '/proc/vmstat']),
    );
    expect(host.ran).toEqual([]);
  });

  it('reads MemAvailable when the kernel has no PSI', async () => {
    linuxBox({ availableFraction: 0.6, psi: false });
    const { g, announced, parked } = start();
    stop = g.stop;
    await firstReading(announced);
    expect(await g.refresh()).toBe('calm');
    expect(parked).toEqual([]);
    expect(sampled.readings.at(-1)?.sources).toContain('linux-meminfo');
    expect(g.memoryFree()).toBeCloseTo(0.6, 3);
  });

  it('reads a calm Windows PC (40% available) as calm, sheds nothing and leaves the chat model alone', async () => {
    windowsPc(0.4);
    const { g, announced, parked } = start();
    stop = g.stop;
    await firstReading(announced);
    for (let i = 0; i < 3; i += 1) expect(await g.refresh()).toBe('calm');
    await new Promise((r) => setTimeout(r, 20));

    expect(announced.map((a) => a.verdict)).toEqual(['calm']);
    expect(parked).toEqual([]);
    const reading = sampled.readings.at(-1);
    expect(reading?.memory).toBe('normal');
    expect(sampled.probes.at(-1)?.memory()).toEqual({
      total: host.totalmem,
      free: host.freemem,
    });
    // Windows has no /proc, and nothing is spawned at the guardian's cadence.
    expect(host.read).toEqual([]);
    expect(host.ran).toEqual([]);
  });

  it('still sheds at the wall — on Linux by the kernel’s numbers, on Windows by what is available', async () => {
    linuxBox({ availableFraction: 0.06, psiSome: 0 });
    const linux = start();
    stop = linux.g.stop;
    await firstReading(linux.announced);
    expect(linux.announced[0]?.verdict).toBe('shed');
    expect(linux.announced[0]?.reason).toBe('only 6% of memory is free');
    // Nothing of ours ran, so the chat model is what goes — the designed last resort.
    await vi.waitFor(() => expect(linux.parked.length).toBe(1));
    linux.g.stop();

    host.files.clear();
    linuxBox({ availableFraction: 0.5, psiSome: 35 });
    const stalled = start();
    stop = stalled.g.stop;
    await firstReading(stalled.announced);
    expect(stalled.announced[0]?.verdict).toBe('shed');
    expect(stalled.announced[0]?.reason).toBe('the system reports critical memory pressure');
    stalled.g.stop();

    host.files.clear();
    windowsPc(0.03);
    const pc = start();
    stop = pc.g.stop;
    await firstReading(pc.announced);
    expect(pc.announced[0]?.verdict).toBe('shed');
    await vi.waitFor(() => expect(pc.parked.length).toBe(1));
  });
});

describe('the guardian on macOS', () => {
  /*
   * BYTE-IDENTICAL, pinned three ways: the probes main hands the sampler, the
   * commands those probes run (with their bound), and the reading that comes
   * back, down to its JSON. The fixtures are verbatim macOS output.
   */
  it('hands the sampler the same probes, runs the same commands and reads the same reading', async () => {
    host.platform = 'darwin';
    // THE LIE the sampler must never see: os.freemem() on a calm Mac.
    host.freemem = 2.3e9;
    host.commands.set('sysctl -n kern.memorystatus_vm_pressure_level', '1\n');
    host.commands.set('sysctl -n kern.memorystatus_level', '76\n');
    host.commands.set(
      'sysctl -n vm.swapusage',
      'total = 4096.00M  used = 2675.25M  free = 1420.75M  (encrypted)\n',
    );
    host.commands.set(
      'vm_stat',
      [
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
        'Pages free:                               10535.',
        'Pages active:                            362534.',
        'Pages inactive:                          358193.',
        'Pages speculative:                         3398.',
        'Pages wired down:                        200914.',
        'Swapins:                                 101315.',
        'Swapouts:                                229699.',
        '',
      ].join('\n'),
    );
    // Linux files present on disk must not be read on a Mac.
    host.files.set('/proc/meminfo', 'MemTotal: 1 kB\nMemAvailable: 0 kB\n');

    const before = Date.now();
    const { g, announced, parked } = start();
    stop = g.stop;
    await firstReading(announced);
    expect(await g.refresh()).toBe('calm');
    const after = Date.now();

    const commands = [
      { cmd: 'sysctl', args: ['-n', 'kern.memorystatus_vm_pressure_level'], timeout: 1500 },
      { cmd: 'sysctl', args: ['-n', 'kern.memorystatus_level'], timeout: 1500 },
      { cmd: 'sysctl', args: ['-n', 'vm.swapusage'], timeout: 1500 },
      { cmd: 'vm_stat', args: [], timeout: 1500 },
    ];
    // Two readings (start-up and the refresh), the same four commands each.
    expect(host.ran).toEqual([...commands, ...commands]);

    // Key order included. `at` is the wall clock the sampler stamps the swap
    // counters with; it is bracketed, then zeroed so the rest compares byte
    // for byte.
    const golden = {
      cpu: 0.0625,
      memory: 'normal',
      memoryFree: 0.76,
      swapUsed: 2675.25 / 4096,
      memoryFreeNow: (13933 * 16384) / (24 * GiB),
      swapCounters: { ins: 101315, outs: 229699, at: 0 },
      sources: ['loadavg', 'macos-pressure', 'macos-memlevel', 'macos-swap', 'macos-free-pages'],
    };
    expect(sampled.readings).toHaveLength(2);
    for (const reading of sampled.readings) {
      const stamped = reading.swapCounters?.at ?? Number.NaN;
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
      const unstamped = { ...reading, swapCounters: { ...reading.swapCounters, at: 0 } };
      expect(JSON.stringify(unstamped)).toBe(JSON.stringify(golden));
    }

    // The probes themselves: free memory stays 0 (never read on a Mac) and
    // readFile stays inert — nothing under /proc or /sys is touched.
    for (const probes of sampled.probes) {
      expect(probes.platform).toBe('darwin');
      expect(probes.quick).toBe(true);
      expect(probes.cpuCount).toBe(8);
      expect(probes.hasNvidia).toBeUndefined();
      expect(probes.previousSwap).toBeUndefined();
      expect(probes.loadAvg()).toEqual([0.5, 0.5, 0.5]);
      expect(probes.memory()).toEqual({ total: 24 * GiB, free: 0 });
      expect(await probes.readFile('/proc/meminfo')).toBeNull();
    }
    expect(host.read).toEqual([]);
    expect(announced.map((a) => a.verdict)).toEqual(['calm']);
    expect(announced[0]?.reason).toBe('76% of memory free');
    expect(parked).toEqual([]);
  });
});
