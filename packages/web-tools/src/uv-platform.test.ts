import { describe, expect, it, vi } from 'vitest';
import { PINNED_UV } from './uv-pins.js';
import {
  detectUvHost,
  parseRegQueryValue,
  UnsupportedUvHostError,
  type UvHost,
  uvAssetUrl,
  uvReleaseFor,
  uvReleaseForTarget,
  uvTargetCandidates,
  uvTargetFor,
  windowsArchName,
  windowsOsArch,
} from './uv-platform.js';

const glibc = (arch: string, v: string): UvHost => ({
  platform: 'linux',
  arch,
  libc: 'glibc',
  glibcVersion: v,
});

describe('uvTargetFor — one row per machine class', () => {
  it.each<[string, UvHost, string]>([
    ['macOS Apple Silicon', { platform: 'darwin', arch: 'arm64' }, 'aarch64-apple-darwin'],
    ['macOS Intel', { platform: 'darwin', arch: 'x64' }, 'x86_64-apple-darwin'],
    [
      'macOS x64 process under Rosetta',
      { platform: 'darwin', arch: 'x64', appleSilicon: true },
      'aarch64-apple-darwin',
    ],
    ['Windows x64', { platform: 'win32', arch: 'x64' }, 'x86_64-pc-windows-msvc'],
    ['Windows on ARM', { platform: 'win32', arch: 'arm64' }, 'aarch64-pc-windows-msvc'],
    ['Windows 32-bit', { platform: 'win32', arch: 'ia32' }, 'i686-pc-windows-msvc'],
    // By the OS's architecture, as uv-installer.ps1's Get-Arch picks it:
    [
      'Windows on ARM, x64 app (emulated)',
      { platform: 'win32', arch: 'x64', osArch: 'arm64' },
      'aarch64-pc-windows-msvc',
    ],
    [
      'Windows x64, 32-bit app (WOW64)',
      { platform: 'win32', arch: 'ia32', osArch: 'x64' },
      'x86_64-pc-windows-msvc',
    ],
    [
      'Windows on ARM, 32-bit app (WOW64)',
      { platform: 'win32', arch: 'ia32', osArch: 'arm64' },
      'aarch64-pc-windows-msvc',
    ],
    ['32-bit Windows', { platform: 'win32', arch: 'ia32', osArch: 'ia32' }, 'i686-pc-windows-msvc'],
    [
      'Windows x64, native',
      { platform: 'win32', arch: 'x64', osArch: 'x64' },
      'x86_64-pc-windows-msvc',
    ],
    ['Ubuntu 24.04 x64', glibc('x64', '2.39'), 'x86_64-unknown-linux-gnu'],
    ['Ubuntu 24.04 arm64', glibc('arm64', '2.39'), 'aarch64-unknown-linux-gnu'],
    ['CentOS 7 x64 (glibc 2.17)', glibc('x64', '2.17'), 'x86_64-unknown-linux-gnu'],
    ['arm64 at exactly the glibc floor', glibc('arm64', '2.28'), 'aarch64-unknown-linux-gnu'],
    ['arm64 below the glibc floor', glibc('arm64', '2.27'), 'aarch64-unknown-linux-musl'],
    ['x64 below the glibc floor', glibc('x64', '2.12'), 'x86_64-unknown-linux-musl'],
    ['Alpine x64', { platform: 'linux', arch: 'x64', libc: 'musl' }, 'x86_64-unknown-linux-musl'],
    [
      'Alpine arm64',
      { platform: 'linux', arch: 'arm64', libc: 'musl' },
      'aarch64-unknown-linux-musl',
    ],
    ['Linux x64, libc unreadable', { platform: 'linux', arch: 'x64' }, 'x86_64-unknown-linux-musl'],
    [
      'Raspberry Pi ARMv7',
      { ...glibc('arm', '2.36'), armVersion: 7 },
      'armv7-unknown-linux-gnueabihf',
    ],
    [
      'Raspberry Pi ARMv7 on musl',
      { platform: 'linux', arch: 'arm', libc: 'musl', armVersion: 7 },
      'armv7-unknown-linux-musleabihf',
    ],
    ['ARMv7 with the version unknown', glibc('arm', '2.36'), 'armv7-unknown-linux-gnueabihf'],
    [
      'Raspberry Pi ARMv6',
      { ...glibc('arm', '2.36'), armVersion: 6 },
      'arm-unknown-linux-musleabihf',
    ],
    ['Linux 32-bit x86', glibc('ia32', '2.31'), 'i686-unknown-linux-gnu'],
    ['POWER little-endian', glibc('ppc64', '2.34'), 'powerpc64le-unknown-linux-gnu'],
    ['RISC-V with a new glibc', glibc('riscv64', '2.31'), 'riscv64gc-unknown-linux-gnu'],
    ['RISC-V with an old glibc', glibc('riscv64', '2.30'), 'riscv64gc-unknown-linux-musl'],
    ['IBM Z', glibc('s390x', '2.28'), 's390x-unknown-linux-gnu'],
    [
      'IBM Z, libc unreadable (no static build to fall back to)',
      { platform: 'linux', arch: 's390x' },
      's390x-unknown-linux-gnu',
    ],
  ])('%s', (_label, host, target) => {
    expect(uvTargetFor(host)).toBe(target);
  });

  it.each<[string, UvHost]>([
    ['FreeBSD', { platform: 'freebsd', arch: 'x64' }],
    ['Linux LoongArch', glibc('loong64', '2.36')],
    ['32-bit ARM Windows', { platform: 'win32', arch: 'arm' }],
    ['Windows RT (32-bit ARM Windows)', { platform: 'win32', arch: 'arm', osArch: 'arm' }],
    ['Itanium Windows', { platform: 'win32', arch: 'ia32', osArch: 'ia64' }],
    ['32-bit macOS', { platform: 'darwin', arch: 'ia32' }],
    ['POWER on musl (no build)', { platform: 'linux', arch: 'ppc64', libc: 'musl' }],
    ['IBM Z below its glibc floor', glibc('s390x', '2.12')],
    ['Android (Termux)', { platform: 'android', arch: 'arm64' }],
  ])('refuses %s with a sentence naming the machine and version', (_label, host) => {
    expect(() => uvTargetFor(host)).toThrow(UnsupportedUvHostError);
    try {
      uvTargetFor(host);
    } catch (err) {
      expect((err as Error).message).toContain(`uv ${PINNED_UV.version} has no build`);
      expect((err as Error).message).toContain(`${host.platform}-${host.arch}`);
    }
  });

  it('prefers the glibc build and keeps the static build as the fallback', () => {
    expect(uvTargetCandidates(glibc('x64', '2.39'))).toEqual([
      'x86_64-unknown-linux-gnu',
      'x86_64-unknown-linux-musl',
    ]);
    expect(uvTargetCandidates({ platform: 'linux', arch: 'x64', libc: 'musl' })).toEqual([
      'x86_64-unknown-linux-musl',
    ]);
  });
});

describe('the pinned table', () => {
  it('covers exactly the targets some machine can select', () => {
    const reachable = new Set<string>();
    const libcs: Array<Partial<UvHost>> = [
      { libc: 'glibc', glibcVersion: '2.39' },
      { libc: 'glibc', glibcVersion: '2.10' },
      { libc: 'musl' },
      {},
    ];
    for (const platform of ['darwin', 'win32', 'linux']) {
      for (const arch of ['x64', 'arm64', 'ia32', 'arm', 'ppc64', 'riscv64', 's390x']) {
        for (const extra of [...libcs, { armVersion: 6 }, { appleSilicon: true }]) {
          for (const t of uvTargetCandidates({ platform, arch, ...extra })) reachable.add(t);
        }
      }
    }
    expect([...reachable].sort()).toEqual(PINNED_UV.assets.map((a) => a.target).sort());
  });

  it('is well-formed: one row per target, sorted, sha256 hex, names that match', () => {
    expect(PINNED_UV.version).toMatch(/^\d+\.\d+\.\d+$/);
    const targets = PINNED_UV.assets.map((a) => a.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect([...targets].sort()).toEqual(targets);
    for (const a of PINNED_UV.assets) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      const ext = a.target.includes('-windows-') ? 'zip' : 'tar.gz';
      expect(a.assetName).toBe(`uv-${a.target}.${ext}`);
      expect(a.bytes).toBeGreaterThan(10_000_000);
      expect(a.bytes).toBeLessThan(100_000_000);
      if (a.target.includes('-linux-gnu')) expect(a.minGlibc).toMatch(/^2\.\d+$/);
      else expect(a.minGlibc).toBeUndefined();
    }
  });

  it('keeps the macOS arm64 build the app has always installed', () => {
    const mac = PINNED_UV.assets.find((a) => a.target === 'aarch64-apple-darwin');
    expect(PINNED_UV.version).toBe('0.11.28');
    expect(mac?.assetName).toBe('uv-aarch64-apple-darwin.tar.gz');
    // The digest of the archive already on the user's Mac (checked 2026-09-23).
    expect(mac?.sha256).toBe('33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232');
  });
});

describe('uvReleaseFor', () => {
  it('describes a Windows build as a zip carrying uv.exe', () => {
    const r = uvReleaseFor({ platform: 'win32', arch: 'x64' });
    expect(r).toEqual({
      version: PINNED_UV.version,
      target: 'x86_64-pc-windows-msvc',
      assetName: 'uv-x86_64-pc-windows-msvc.zip',
      binName: 'uv.exe',
      archive: 'zip',
      sha256: '0a23463216d09c6a72ff80ef5dc5a795f07dc1575cb84d24596c2f124a441b7b',
      bytes: 25568726,
    });
    expect(uvAssetUrl(r)).toBe(
      `https://github.com/astral-sh/uv/releases/download/${PINNED_UV.version}/uv-x86_64-pc-windows-msvc.zip`,
    );
  });

  it('describes every other build as a tar.gz carrying uv', () => {
    for (const t of [
      'aarch64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'armv7-unknown-linux-musleabihf',
    ]) {
      const r = uvReleaseForTarget(t);
      expect(r.archive).toBe('tar.gz');
      expect(r.binName).toBe('uv');
    }
  });

  it('refuses a target the pin does not carry', () => {
    expect(() => uvReleaseForTarget('loongarch64-unknown-linux-gnu')).toThrow(/no pinned build/);
  });
});

describe('detectUvHost', () => {
  it('reads glibc from the process report on Linux', () => {
    const host = detectUvHost({
      platform: 'linux',
      arch: 'x64',
      report: () => ({ header: { glibcVersionRuntime: '2.39' } }),
      listDir: () => {
        throw new Error('not needed when glibc is known');
      },
    });
    expect(host).toEqual({ platform: 'linux', arch: 'x64', libc: 'glibc', glibcVersion: '2.39' });
  });

  it('recognises musl by its loader when Node reports no glibc', () => {
    const host = detectUvHost({
      platform: 'linux',
      arch: 'arm64',
      report: () => ({ header: {} }),
      listDir: (d) => (d === '/lib' ? ['libc.musl-aarch64.so.1', 'ld-musl-aarch64.so.1'] : []),
    });
    expect(host).toEqual({ platform: 'linux', arch: 'arm64', libc: 'musl' });
  });

  it('leaves libc unknown when neither answers (the static build is then chosen)', () => {
    const host = detectUvHost({
      platform: 'linux',
      arch: 'x64',
      report: () => undefined,
      listDir: () => [],
    });
    expect(host.libc).toBeUndefined();
    expect(uvTargetFor(host)).toBe('x86_64-unknown-linux-musl');
  });

  it('records the ARM version on 32-bit ARM', () => {
    const host = detectUvHost({
      platform: 'linux',
      arch: 'arm',
      report: () => ({ header: { glibcVersionRuntime: '2.36' } }),
      armVersion: 6,
    });
    expect(uvTargetFor(host)).toBe('arm-unknown-linux-musleabihf');
  });

  it('asks sysctl only for an x64 process on macOS, and sees Rosetta', () => {
    const sysctl = vi.fn((name: string) => (name === 'hw.optional.arm64' ? '1' : undefined));
    expect(detectUvHost({ platform: 'darwin', arch: 'arm64', sysctl }).appleSilicon).toBe(true);
    expect(sysctl).not.toHaveBeenCalled();
    const rosetta = detectUvHost({ platform: 'darwin', arch: 'x64', sysctl });
    expect(rosetta.appleSilicon).toBe(true);
    expect(uvTargetFor(rosetta)).toBe('aarch64-apple-darwin');
    const intel = detectUvHost({ platform: 'darwin', arch: 'x64', sysctl: () => undefined });
    expect(intel.appleSilicon).toBe(false);
    expect(uvTargetFor(intel)).toBe('x86_64-apple-darwin');
  });

  it('adds nothing Windows-only on other systems (no registry read, no osArch)', () => {
    const registry = vi.fn(() => 'ARM64');
    const env = { PROCESSOR_ARCHITEW6432: 'ARM64' };
    for (const platform of ['darwin', 'linux']) {
      const host = detectUvHost({
        platform,
        arch: 'x64',
        env,
        windowsRegistryArch: registry,
        report: () => ({ header: { glibcVersionRuntime: '2.39' } }),
        sysctl: () => '0',
      });
      expect(host.osArch).toBeUndefined();
    }
    expect(registry).not.toHaveBeenCalled();
  });

  it('reads the real process report and leaves its excludeNetwork setting as it was', () => {
    const report = process.report as { excludeNetwork?: boolean };
    const before = report.excludeNetwork;
    const host = detectUvHost({ platform: 'linux', arch: 'x64' });
    expect(report.excludeNetwork).toBe(before);
    // On a real Linux runner Node's report names its glibc; elsewhere nothing is found.
    if (process.platform === 'linux') expect(host.libc).toBeDefined();
    expect(() => uvTargetFor(host)).not.toThrow();
  });

  it('describes the real machine, once', () => {
    const a = detectUvHost();
    expect(a.platform).toBe(process.platform);
    expect(a.arch).toBe(process.arch);
    expect(detectUvHost()).toBe(a);
    // Whatever this machine is, it is one uv publishes a build for.
    expect(() => uvReleaseFor(a)).not.toThrow();
  });
});

describe('Windows: the build follows the OS architecture, as uv-installer.ps1 picks it', () => {
  const noRegistry = (): string => {
    throw new Error('the registry is not needed here');
  };

  it.each<[string, string, Record<string, string>, string]>([
    [
      'a 32-bit app on x64 Windows (WOW64)',
      'ia32',
      { PROCESSOR_ARCHITEW6432: 'AMD64' },
      'x86_64-pc-windows-msvc',
    ],
    [
      'a 32-bit app on Windows on ARM (WOW64)',
      'ia32',
      { PROCESSOR_ARCHITEW6432: 'ARM64' },
      'aarch64-pc-windows-msvc',
    ],
    ['an arm64 app (it only runs on ARM64 Windows)', 'arm64', {}, 'aarch64-pc-windows-msvc'],
  ])('%s: known without the registry', (_label, arch, env, target) => {
    const host = detectUvHost({ platform: 'win32', arch, env, windowsRegistryArch: noRegistry });
    expect(uvTargetFor(host)).toBe(target);
  });

  it.each<[string, string, string | undefined, string | undefined, string]>([
    ['an x64 app emulated on Windows on ARM', 'x64', 'ARM64', 'arm64', 'aarch64-pc-windows-msvc'],
    ['an x64 app on x64 Windows', 'x64', 'AMD64', 'x64', 'x86_64-pc-windows-msvc'],
    [
      'an x64 app, registry unreadable (the process arch stands, as the installer’s fallback)',
      'x64',
      undefined,
      undefined,
      'x86_64-pc-windows-msvc',
    ],
    [
      'a 32-bit app whose environment was scrubbed, on x64 Windows',
      'ia32',
      'AMD64',
      'x64',
      'x86_64-pc-windows-msvc',
    ],
    ['a 32-bit app on 32-bit Windows', 'ia32', 'x86', 'ia32', 'i686-pc-windows-msvc'],
  ])('%s: asks the registry once', (_label, arch, registry, osArch, target) => {
    const read = vi.fn(() => registry);
    const host = detectUvHost({ platform: 'win32', arch, env: {}, windowsRegistryArch: read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.osArch).toBe(osArch);
    expect(uvTargetFor(host)).toBe(target);
  });

  it('names both architectures when it cannot serve the machine', () => {
    expect(() => uvTargetFor({ platform: 'win32', arch: 'ia32', osArch: 'ia64' })).toThrow(
      /win32-ia32, on ia64 Windows/,
    );
  });

  it('reads the value out of reg.exe’s answer', () => {
    // What `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    // /v PROCESSOR_ARCHITECTURE` prints: a blank line, the key, the value row in
    // four-space columns, a blank line — CRLF throughout.
    const answer = (value: string): string =>
      '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' +
      `\r\n    PROCESSOR_ARCHITECTURE    REG_SZ    ${value}\r\n\r\n`;
    expect(parseRegQueryValue(answer('ARM64'), 'PROCESSOR_ARCHITECTURE')).toBe('ARM64');
    expect(parseRegQueryValue(answer('AMD64'), 'PROCESSOR_ARCHITECTURE')).toBe('AMD64');
    expect(parseRegQueryValue(answer('x86'), 'processor_architecture')).toBe('x86');
    // A value with single spaces in it survives whole; other rows are ignored.
    expect(
      parseRegQueryValue(
        '    PROCESSOR_IDENTIFIER    REG_SZ    ARMv8 (64-bit) Family 8 Model 1 Revision 201\r\n',
        'PROCESSOR_IDENTIFIER',
      ),
    ).toBe('ARMv8 (64-bit) Family 8 Model 1 Revision 201');
    expect(parseRegQueryValue(answer('ARM64'), 'PROCESSOR_LEVEL')).toBeUndefined();
    expect(
      parseRegQueryValue(
        'ERROR: The system was unable to find the specified registry key or value.',
        'PROCESSOR_ARCHITECTURE',
      ),
    ).toBeUndefined();
  });

  it('maps Windows CPU names to process.arch terms, case-insensitively', () => {
    expect(windowsArchName('AMD64')).toBe('x64');
    expect(windowsArchName('ARM64')).toBe('arm64');
    expect(windowsArchName('x86')).toBe('ia32');
    expect(windowsArchName(' arm64 ')).toBe('arm64');
    expect(windowsArchName('ARM')).toBe('arm');
    expect(windowsArchName('IA64')).toBe('ia64');
    expect(windowsArchName('')).toBeUndefined();
    expect(windowsArchName(undefined)).toBeUndefined();
  });

  it('agrees with windowsOsArch, which detectUvHost uses', () => {
    expect(windowsOsArch('x64', {}, () => 'ARM64')).toBe('arm64');
    expect(windowsOsArch('ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' }, noRegistry)).toBe('x64');
    expect(windowsOsArch('x64', {}, () => undefined)).toBeUndefined();
  });
});
