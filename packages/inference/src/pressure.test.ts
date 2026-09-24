/**
 * The sampler's parsers, one per thing a real machine says.
 *
 * Every fixture here is verbatim output from the tool it names — the macOS ones
 * captured on this machine, the Linux and NVIDIA ones from their documented
 * formats. A parser that has never seen real output is a guess.
 */
import { describe, expect, it } from 'vitest';
import {
  loadToCpu,
  parseAmdBusy,
  parseLinuxBattery,
  parseMacMemoryLevel,
  parseMacPowerSource,
  parseMacPressureLevel,
  parseMacSwap,
  parseMacThermal,
  parseMemInfoAvailable,
  parseNvidiaSmiUtil,
  parseProcVmstatSwapCounters,
  parsePsi,
  parseVmStatFreeNow,
  parseVmStatSwapCounters,
  psiToVerdict,
  samplePressure,
  swapRate,
  verdictFromFree,
} from './pressure.js';

describe('macOS', () => {
  it('reads the pressure level the OS reports', () => {
    expect(parseMacPressureLevel('1\n')).toBe('normal');
    expect(parseMacPressureLevel('2\n')).toBe('warn');
    expect(parseMacPressureLevel('4\n')).toBe('critical');
    expect(parseMacPressureLevel('nonsense')).toBeUndefined();
  });

  /*
   * The coarse verdict has three values and flips late. MEASURED on a 24 GB Mac:
   * `kern.memorystatus_level` read 76 while the pressure level was still 1 — so
   * a policy watching only the verdict cannot see pressure BUILDING.
   */
  it("reads the OS's own graded free-memory percentage", () => {
    expect(parseMacMemoryLevel('76\n')).toBeCloseTo(0.76, 2);
    expect(parseMacMemoryLevel('8')).toBeCloseTo(0.08, 2);
    expect(parseMacMemoryLevel('')).toBeUndefined();
  });

  it('reads swap usage — captured verbatim from this machine', () => {
    const out = 'total = 4096.00M  used = 2675.25M  free = 1420.75M  (encrypted)';
    expect(parseMacSwap(out)).toBeCloseTo(0.653, 2);
  });

  it('handles a machine with no swap at all without dividing by zero', () => {
    expect(parseMacSwap('total = 0.00M  used = 0.00M  free = 0.00M')).toBe(0);
  });

  it('understands both shapes `pmset -g therm` prints', () => {
    expect(parseMacThermal('Note: No thermal warning level has been recorded')).toBe(false);
    expect(parseMacThermal('CPU_Speed_Limit \t= 70')).toBe(true);
    expect(parseMacThermal('CPU_Speed_Limit \t= 100')).toBe(false);
    expect(parseMacThermal('')).toBeUndefined();
  });

  it('tells AC from battery', () => {
    expect(parseMacPowerSource("Now drawing from 'AC Power'")).toBe(false);
    expect(parseMacPowerSource("Now drawing from 'Battery Power'")).toBe(true);
    expect(parseMacPowerSource('')).toBeUndefined();
  });
});

describe('Linux', () => {
  it('reads PSI, which is the best signal on any platform', () => {
    const psi = 'some avg10=12.34 avg60=5.00 avg300=1.00 total=123\nfull avg10=3.00 avg60=1.00';
    expect(parsePsi(psi)).toBeCloseTo(0.1234, 4);
    expect(parsePsi(psi, 'full')).toBeCloseTo(0.03, 4);
  });

  it('is undefined when the kernel was built without PSI', () => {
    expect(parsePsi('')).toBeUndefined();
  });

  it('turns a stall fraction into the same verdict macOS gives directly', () => {
    expect(psiToVerdict(0.0)).toBe('normal');
    expect(psiToVerdict(0.1)).toBe('warn');
    expect(psiToVerdict(0.5)).toBe('critical');
  });

  it('uses MemAvailable, not MemFree — cache is not pressure', () => {
    const meminfo =
      'MemTotal:       16384000 kB\nMemFree:          512000 kB\nMemAvailable:    8192000 kB\n';
    // Half available ⇒ half used, NOT the 97% that MemFree alone would claim.
    expect(parseMemInfoAvailable(meminfo)).toBeCloseTo(0.5, 2);
  });

  it('reads AMD busy percent and battery status', () => {
    expect(parseAmdBusy('37\n')).toBeCloseTo(0.37, 2);
    expect(parseLinuxBattery('Discharging\n')).toBe(true);
    expect(parseLinuxBattery('Charging\n')).toBe(false);
    expect(parseLinuxBattery('')).toBeUndefined();
  });
});

describe('NVIDIA, on Linux and Windows alike', () => {
  it('reads utilisation and VRAM together', () => {
    const { gpu, vram } = parseNvidiaSmiUtil('42, 8192, 24564\n');
    expect(gpu).toBeCloseTo(0.42, 2);
    expect(vram).toBeCloseTo(0.333, 2);
  });

  it('says nothing rather than zero when there is no card', () => {
    expect(parseNvidiaSmiUtil('')).toEqual({});
  });
});

describe('the portable floor', () => {
  it('derives a verdict from free/total where nothing better exists', () => {
    expect(verdictFromFree(8e9, 16e9)).toBe('normal');
    expect(verdictFromFree(2e9, 16e9)).toBe('warn');
    expect(verdictFromFree(0.5e9, 16e9)).toBe('critical');
  });

  it('turns load average into per-core contention', () => {
    expect(loadToCpu(4, 8)).toBeCloseTo(0.5, 2);
    expect(loadToCpu(16, 8)).toBe(1);
    expect(loadToCpu(1, 0)).toBeUndefined();
  });
});

/** A probe set that answers nothing — the locked-down container case. */
const silent = {
  run: async () => null,
  readFile: async () => null,
  loadAvg: () => [2, 2, 2],
  cpuCount: 8,
  memory: () => ({ total: 16e9, free: 8e9 }),
} as const;

describe('samplePressure', () => {
  it('never throws when every probe is missing, and says what it could not read', async () => {
    const p = await samplePressure({ ...silent, platform: 'linux' });
    expect(p.cpu).toBeCloseTo(0.25, 2);
    // The portable floor still answers.
    expect(p.memory).toBe('normal');
    expect(p.sources).toContain('free-memory');
    expect(p.sources).not.toContain('linux-psi');
  });

  it('does NOT use free memory on macOS', async () => {
    // MEASURED on a 24 GB Mac at pressure level 1: os.freemem() reported 2.3 GB.
    // Deriving a verdict from that would pin the machine to its most
    // conservative mode forever.
    const p = await samplePressure({
      ...silent,
      platform: 'darwin',
      memory: () => ({ total: 24e9, free: 2.3e9 }),
    });
    expect(p.memory).toBeUndefined();
    expect(p.sources).not.toContain('free-memory');
  });

  it('prefers the OS verdict on macOS and reports what answered', async () => {
    const p = await samplePressure({
      ...silent,
      platform: 'darwin',
      run: async (cmd, args) => {
        if (cmd === 'sysctl' && args.includes('kern.memorystatus_vm_pressure_level')) return '2';
        if (cmd === 'sysctl' && args.includes('vm.swapusage')) {
          return 'total = 4096.00M  used = 2048.00M  free = 2048.00M';
        }
        if (cmd === 'pmset' && args.includes('therm')) return 'CPU_Speed_Limit = 60';
        if (cmd === 'pmset' && args.includes('ps')) return "Now drawing from 'Battery Power'";
        return null;
      },
    });
    expect(p.memory).toBe('warn');
    expect(p.swapUsed).toBeCloseTo(0.5, 2);
    expect(p.throttled).toBe(true);
    expect(p.onBattery).toBe(true);
    expect(p.sources).toEqual(
      expect.arrayContaining(['macos-pressure', 'macos-swap', 'macos-thermal', 'macos-power']),
    );
  });

  it('prefers PSI over meminfo on Linux', async () => {
    const p = await samplePressure({
      ...silent,
      platform: 'linux',
      readFile: async (path) =>
        path === '/proc/pressure/memory' ? 'some avg10=30.00 avg60=1.00' : null,
    });
    expect(p.memory).toBe('critical');
    expect(p.sources).toContain('linux-psi');
    expect(p.sources).not.toContain('linux-meminfo');
  });

  it('asks the card itself when there is one', async () => {
    const p = await samplePressure({
      ...silent,
      platform: 'win32',
      hasNvidia: true,
      run: async (cmd) => (cmd === 'nvidia-smi' ? '91, 23000, 24564' : null),
    });
    expect(p.gpu).toBeCloseTo(0.91, 2);
    expect(p.vram).toBeCloseTo(0.936, 2);
    expect(p.sources).toContain('nvidia-smi');
  });
});

describe('samplePressure off macOS', () => {
  /*
   * os.freemem() on Windows is GlobalMemoryStatusEx's ullAvailPhys (free +
   * zeroed + standby lists): the honest "available" figure, not the page-cache
   * fiction it is on a Mac. The reading says Windows gave it.
   */
  it('reads Windows from available memory, labelled as its own', async () => {
    const p = await samplePressure({
      ...silent,
      platform: 'win32',
      memory: () => ({ total: 16e9, free: 6.4e9 }),
    });
    expect(p.memory).toBe('normal');
    expect(p.sources).toContain('windows-available');
    expect(p.sources).not.toContain('free-memory');
    // The graded fraction waits for the commit charge and a pause that can
    // land on Windows (XP-14/XP-15); until then the verdict alone.
    expect(p.memoryFree).toBeUndefined();
  });

  it('reads the Windows wall as the wall', async () => {
    const warm = await samplePressure({
      ...silent,
      platform: 'win32',
      memory: () => ({ total: 16e9, free: 2e9 }),
    });
    expect(warm.memory).toBe('warn');
    const tight = await samplePressure({
      ...silent,
      platform: 'win32',
      memory: () => ({ total: 16e9, free: 0.4e9 }),
    });
    expect(tight.memory).toBe('critical');
  });

  it('says nothing, rather than critical, when a Windows host reports no total', async () => {
    const p = await samplePressure({
      ...silent,
      platform: 'win32',
      memory: () => ({ total: 0, free: 0 }),
    });
    expect(p.memory).toBeUndefined();
    expect(p.sources).not.toContain('windows-available');
    expect(p.sources).not.toContain('free-memory');
  });

  it('reads no files and runs nothing on Windows without a card to ask', async () => {
    const read: string[] = [];
    const ran: string[] = [];
    await samplePressure({
      ...silent,
      platform: 'win32',
      readFile: async (path) => {
        read.push(path);
        return null;
      },
      run: async (cmd) => {
        ran.push(cmd);
        return null;
      },
    });
    expect(read).toEqual([]);
    expect(ran).toEqual([]);
  });

  /*
   * The guardian reads every half second while heavy work runs and judges
   * memory and swap alone, so its quick reading leaves the GPU-busy and
   * battery files for the power manager's full one, as on the Mac.
   */
  it('reads memory and swap only on a quick Linux reading', async () => {
    const files: Record<string, string> = {
      '/proc/pressure/memory': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      '/proc/meminfo': 'MemTotal:       16000000 kB\nMemAvailable:    9600000 kB\n',
      '/proc/vmstat': 'pswpin 1\npswpout 2\n',
      '/sys/class/drm/card0/device/gpu_busy_percent': '37\n',
      '/sys/class/power_supply/BAT0/status': 'Discharging\n',
    };
    const read: string[] = [];
    const readFile = async (path: string): Promise<string | null> => {
      read.push(path);
      return files[path] ?? null;
    };

    const quick = await samplePressure({ ...silent, platform: 'linux', quick: true, readFile });
    expect(read).toEqual(['/proc/pressure/memory', '/proc/vmstat', '/proc/meminfo']);
    expect(quick.memory).toBe('normal');
    expect(quick.memoryFree).toBeCloseTo(0.6, 3);
    expect(quick.swapCounters).toMatchObject({ ins: 1, outs: 2 });
    expect(quick.gpu).toBeUndefined();
    expect(quick.onBattery).toBeUndefined();

    read.length = 0;
    const full = await samplePressure({ ...silent, platform: 'linux', readFile });
    expect(read).toEqual(
      expect.arrayContaining([
        '/sys/class/drm/card0/device/gpu_busy_percent',
        '/sys/class/power_supply/BAT0/status',
      ]),
    );
    expect(full.gpu).toBeCloseTo(0.37, 2);
    expect(full.onBattery).toBe(true);
    expect(full.sources).toEqual(expect.arrayContaining(['linux-amd', 'linux-battery']));
  });
});

describe('swap: the flow, not the stock', () => {
  /*
   * The bug a live run caught. MEASURED on a 24 GB Mac: 65% of swap in use,
   * macOS reporting pressure level 1, and the counters not moving at all over
   * three seconds. The 65% was days of uptime, not a machine in trouble.
   */
  it('reads the cumulative counters macOS and Linux each publish', () => {
    const vmStat = 'Swapins:   16222831.\nSwapouts:  29163414.\n';
    expect(parseVmStatSwapCounters(vmStat)).toEqual({ ins: 16222831, outs: 29163414 });
    const procVmstat = 'pgfault 123\npswpin 400\npswpout 900\n';
    expect(parseProcVmstatSwapCounters(procVmstat)).toEqual({ ins: 400, outs: 900 });
  });

  it('has no rate from a single reading — a flow needs two', () => {
    expect(swapRate({ ins: 10, outs: 10, at: 1000 }, undefined)).toBeUndefined();
  });

  it('is zero when nothing moved, however full the swap file is', () => {
    const a = { ins: 16222831, outs: 29163414, at: 0 };
    expect(swapRate({ ...a, at: 3000 }, a)).toBe(0);
  });

  it('is pages per second when it did', () => {
    const a = { ins: 100, outs: 100, at: 0 };
    expect(swapRate({ ins: 400, outs: 400, at: 2000 }, a)).toBe(300);
  });

  it('gives up rather than lie when the counters went backwards (a reboot)', () => {
    const a = { ins: 500, outs: 500, at: 0 };
    expect(swapRate({ ins: 10, outs: 10, at: 1000 }, a)).toBeUndefined();
  });
});

describe('parseVmStatFreeNow', () => {
  it('turns free + speculative pages into a fraction of the machine', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               10535.',
      'Pages active:                            362534.',
      'Pages speculative:                         3398.',
      'Swapins:                                 101315.',
      'Swapouts:                                229699.',
    ].join('\n');
    // The jetsam reading: 10,535 + 3,398 pages of 16 KB on a 24 GB Mac.
    const total = 24 * 1024 ** 3;
    const f = parseVmStatFreeNow(out, total);
    expect(f).toBeDefined();
    expect(Math.round((f ?? 0) * 1000) / 1000).toBe(0.009);
    expect(parseVmStatFreeNow('nothing here', total)).toBeUndefined();
  });
});
