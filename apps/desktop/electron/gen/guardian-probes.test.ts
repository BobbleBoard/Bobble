/**
 * The guardian's probes per OS (XP-01), pure: a host in, the probes out, and
 * the REAL sampler and judge on top. The wiring through `startGuardian` is
 * pinned in guardian-main.platforms.test.ts; this is the acceptance in the
 * plan's own words: a calm Linux or Windows reading judges `calm`, the wall is
 * still the wall, and the Mac's probes never read free memory or a file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';
import { judge, limitsFor, type PowerMode, samplePressure } from '@pi-desktop/inference';
import { describe, expect, it } from 'vitest';
import {
  type GuardianHost,
  guardianPlatform,
  guardianProbes,
  nodeGuardianHost,
  readSmallFile,
} from './guardian-probes';

const MODES: readonly PowerMode[] = ['low', 'auto', 'full'];

/** A 32 GB Linux box, as its kernel describes it. */
const MEM_TOTAL_KB = 32_803_452;

function linuxHost({
  availableFraction,
  psiSome = 0,
}: {
  availableFraction: number;
  psiSome?: number;
}): { host: GuardianHost; read: string[]; ran: string[] } {
  const availableKb = Math.round(MEM_TOTAL_KB * availableFraction);
  const files: Record<string, string> = {
    '/proc/pressure/memory':
      `some avg10=${psiSome.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n` +
      'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    '/proc/meminfo': [
      `MemTotal:       ${MEM_TOTAL_KB} kB`,
      'MemFree:         1638400 kB',
      `MemAvailable:   ${availableKb} kB`,
      'Buffers:          524288 kB',
      'Cached:         12582912 kB',
      '',
    ].join('\n'),
    '/proc/vmstat': 'nr_free_pages 409600\npswpin 0\npswpout 0\n',
  };
  const read: string[] = [];
  const ran: string[] = [];
  return {
    read,
    ran,
    host: {
      platform: 'linux',
      totalmem: () => MEM_TOTAL_KB * 1024,
      // libuv's os.freemem() on Linux is this same MemAvailable line.
      freemem: () => availableKb * 1024,
      cpuCount: () => 16,
      loadavg: () => [1, 1, 1],
      run: async (cmd) => {
        ran.push(cmd);
        return null;
      },
      readFile: async (p) => {
        read.push(p);
        return files[p] ?? null;
      },
    },
  };
}

function windowsHost(availableFraction: number): {
  host: GuardianHost;
  read: string[];
  ran: string[];
} {
  const total = 16 * 1024 ** 3;
  const read: string[] = [];
  const ran: string[] = [];
  return {
    read,
    ran,
    host: {
      platform: 'win32',
      totalmem: () => total,
      // os.freemem() on Windows is ullAvailPhys.
      freemem: () => Math.round(total * availableFraction),
      cpuCount: () => 12,
      loadavg: () => [0, 0, 0], // Windows has no load average
      run: async (cmd) => {
        ran.push(cmd);
        return null;
      },
      readFile: async (p) => {
        read.push(p);
        return null;
      },
    },
  };
}

describe('a calm PC judges calm (XP-01 acceptance)', () => {
  it('Linux: PSI 0 and 60% MemAvailable is calm in every power mode', async () => {
    const { host, ran } = linuxHost({ availableFraction: 0.6, psiSome: 0 });
    const reading = await samplePressure(guardianProbes(host));
    expect(reading.memory).toBe('normal');
    expect(reading.memoryFree).toBeCloseTo(0.6, 3);
    for (const mode of MODES) {
      expect(judge(reading, limitsFor(mode))).toEqual({
        verdict: 'calm',
        reason: '60% of memory free',
      });
    }
    // The kernel's files, not a subprocess, at the guardian's cadence.
    expect(ran).toEqual([]);
  });

  it('Windows: 40% available is calm in every power mode', async () => {
    const { host, read, ran } = windowsHost(0.4);
    const reading = await samplePressure(guardianProbes(host));
    expect(reading.memory).toBe('normal');
    expect(reading.sources).toContain('windows-available');
    for (const mode of MODES) {
      expect(judge(reading, limitsFor(mode)).verdict).toBe('calm');
    }
    expect(read).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('the wall is still the wall', async () => {
    const tightLinux = await samplePressure(
      guardianProbes(linuxHost({ availableFraction: 0.05 }).host),
    );
    expect(judge(tightLinux, limitsFor('auto'))).toEqual({
      verdict: 'shed',
      reason: 'only 5% of memory is free',
    });
    // Between the lines: stopped in place, not ended (Linux has SIGSTOP).
    const pausingLinux = await samplePressure(
      guardianProbes(linuxHost({ availableFraction: 0.12 }).host),
    );
    expect(judge(pausingLinux, limitsFor('auto')).verdict).toBe('pause');
    const stalledLinux = await samplePressure(
      guardianProbes(linuxHost({ availableFraction: 0.5, psiSome: 40 }).host),
    );
    expect(judge(stalledLinux, limitsFor('auto')).verdict).toBe('shed');

    const tightWindows = await samplePressure(guardianProbes(windowsHost(0.03).host));
    expect(judge(tightWindows, limitsFor('auto')).verdict).toBe('shed');
    const warmWindows = await samplePressure(guardianProbes(windowsHost(0.1).host));
    expect(judge(warmWindows, limitsFor('auto')).verdict).toBe('hold');
  });
});

describe('the Mac keeps its probes', () => {
  it('never reads free memory or a file, whatever the host would say', async () => {
    let fileReads = 0;
    const run = async () => null;
    const probes = guardianProbes({
      platform: 'darwin',
      totalmem: () => 24 * 1024 ** 3,
      // THE LIE (pressure.ts): os.freemem() on a calm 24 GB Mac.
      freemem: () => 2.3e9,
      cpuCount: () => 18,
      loadavg: () => [2, 2, 2],
      run,
      readFile: async () => {
        fileReads += 1;
        return 'MemTotal: 1 kB\nMemAvailable: 0 kB\n';
      },
    });
    expect(probes.platform).toBe('darwin');
    expect(probes.quick).toBe(true);
    expect(probes.cpuCount).toBe(18);
    expect(probes.loadAvg()).toEqual([2, 2, 2]);
    expect(probes.memory()).toEqual({ total: 24 * 1024 ** 3, free: 0 });
    expect(await probes.readFile('/proc/meminfo')).toBeNull();
    expect(fileReads).toBe(0);
    expect(probes.run).toBe(run);
    expect(probes.hasNvidia).toBeUndefined();
    expect(probes.previousSwap).toBeUndefined();
  });
});

describe('the host', () => {
  it("maps Node's platform names the way main always did", () => {
    expect(guardianPlatform('darwin')).toBe('darwin');
    expect(guardianPlatform('win32')).toBe('win32');
    expect(guardianPlatform('linux')).toBe('linux');
    expect(guardianPlatform('freebsd')).toBe('linux');
  });

  it('reads the machine this runs on', async () => {
    const host = nodeGuardianHost();
    expect(host.platform).toBe(guardianPlatform(platform()));
    expect(host.totalmem()).toBeGreaterThan(0);
    expect(host.cpuCount()).toBeGreaterThan(0);
    expect(await host.run('xp01-no-such-command', [])).toBeNull();
    const dir = mkdtempSync(path.join(tmpdir(), 'xp01-probe-'));
    try {
      const file = path.join(dir, 'pressure');
      writeFileSync(file, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
      expect(await host.readFile(file)).toBe('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
      expect(await host.readFile(path.join(dir, 'missing'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds a file read like a command: an answer, null, or null in time', async () => {
    expect(await readSmallFile('/x', 50, async () => 'ok')).toBe('ok');
    expect(await readSmallFile('/x', 50, async () => Promise.reject(new Error('EACCES')))).toBe(
      null,
    );
    expect(
      await readSmallFile('/x', 50, () => {
        throw new Error('sync');
      }),
    ).toBeNull();
    const started = Date.now();
    expect(await readSmallFile('/x', 30, () => new Promise<string>(() => {}))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
