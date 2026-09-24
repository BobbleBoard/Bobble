/**
 * LIVE uv install checks — env-guarded, so a normal run skips them. The
 * `uv bootstrap` CI workflow runs them on every runner OS.
 *
 *   PI_DESKTOP_UV_LIVE=1
 *     - the pins equal the release's own `sha256.sum` (one small download);
 *     - this machine's build installs through `ensureUv({ ignorePath: true })`
 *       (~25 MB), `uv --version` answers with the pinned version, and a second
 *       call reuses it through the marker without the network.
 *
 *   PI_DESKTOP_UV_EXPECT_TARGET=<target>
 *     - the build this machine picked must be that one. CI sets it per runner,
 *       so the choice itself is checked on real hardware (an x64 Node on Windows
 *       on ARM must still get `aarch64-pc-windows-msvc`, a musl Linux the static
 *       build), not only compared with what uv-platform computes.
 *
 *   PI_DESKTOP_UV_LIVE_TARGETS=primary | all | <target>,<target>
 *     - also installs those builds HERE, into throwaway dirs, through the same
 *       code path (download, pinned sha256, zip or tar.gz), and checks that each
 *       binary is the right format for the right CPU (Mach-O / ELF / PE header)
 *       and that the archive held exactly the executables the release lists.
 *       A build this machine can run (its own; x86_64 macOS under Rosetta) is
 *       also run. `primary` = both macOS builds, Windows x64 + arm64, Linux x64 +
 *       arm64 glibc and x64 musl (~175 MB in 25 MB files); `all` = every build.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureUv } from './uv.js';
import { PINNED_UV } from './uv-pins.js';
import { detectUvHost, uvReleaseFor, uvReleaseForTarget } from './uv-platform.js';

const RUN = process.env.PI_DESKTOP_UV_LIVE === '1';
const TARGETS = process.env.PI_DESKTOP_UV_LIVE_TARGETS ?? '';
const EXPECT_TARGET = process.env.PI_DESKTOP_UV_EXPECT_TARGET ?? '';
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${PINNED_UV.version}`;

const PRIMARY = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
];

function targetsToCheck(): string[] {
  if (TARGETS === '') return [];
  if (TARGETS === 'primary') return PRIMARY;
  if (TARGETS === 'all') return PINNED_UV.assets.map((a) => a.target);
  return TARGETS.split(',').map((t) => t.trim());
}

/** What a target's binary must be: container format + CPU, e.g. `pe/aarch64`. */
function expectedKind(target: string): string {
  const cpu = target.split('-')[0] as string;
  const machine: Record<string, string> = {
    x86_64: 'x86_64',
    aarch64: 'aarch64',
    i686: 'i386',
    arm: 'arm',
    armv7: 'arm',
    powerpc64le: 'ppc64',
    riscv64gc: 'riscv',
    s390x: 's390',
  };
  const format = target.includes('-apple-darwin')
    ? 'mach-o'
    : target.includes('-windows-')
      ? 'pe'
      : 'elf';
  return `${format}/${machine[cpu] ?? cpu}`;
}

/** Read an executable's header: container format + CPU. */
async function binaryKind(file: string): Promise<string> {
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(4096);
  try {
    await fh.read(buf, 0, buf.length, 0);
  } finally {
    await fh.close();
  }
  if (buf.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = buf.readUInt32LE(4);
    return `mach-o/${cpu === 0x0100000c ? 'aarch64' : cpu === 0x01000007 ? 'x86_64' : cpu.toString(16)}`;
  }
  if (buf.readUInt32BE(0) === 0x7f454c46) {
    const le = buf[5] === 1;
    const m = le ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
    // e_machine: 0x3E x86-64, 0xB7 AArch64, 0x03 i386, 0x28 ARM, 0x15 PPC64, 0xF3 RISC-V, 0x16 S390.
    const names: Record<number, string> = {
      62: 'x86_64',
      183: 'aarch64',
      3: 'i386',
      40: 'arm',
      21: 'ppc64',
      243: 'riscv',
      22: 's390',
    };
    return `elf/${names[m] ?? m.toString(16)}`;
  }
  if (buf.toString('latin1', 0, 2) === 'MZ') {
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 6 <= buf.length && buf.toString('latin1', pe, pe + 4) === 'PE\0\0') {
      const m = buf.readUInt16LE(pe + 4);
      // IMAGE_FILE_MACHINE_*: 0x8664 AMD64, 0xAA64 ARM64, 0x14C I386.
      const names: Record<number, string> = { 34404: 'x86_64', 43620: 'aarch64', 332: 'i386' };
      return `pe/${names[m] ?? m.toString(16)}`;
    }
  }
  return 'unknown';
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'pi-desktop-web-tools-live' } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

function uvVersion(uvPath: string): string {
  return execFileSync(uvPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
}

let work: string;
beforeAll(async () => {
  if (RUN) work = await mkdtemp(join(tmpdir(), 'pi-web-tools-uv-live-'));
});
afterAll(async () => {
  if (work !== undefined) await rm(work, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!RUN)('uv live: pins and this machine', () => {
  it('pins every build exactly as the release’s sha256.sum lists it', async () => {
    const sums = new Map<string, string>();
    for (const line of (await getText(`${RELEASE_BASE}/sha256.sum`)).split('\n')) {
      const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
      if (m?.[2]?.startsWith('uv-')) sums.set(m[2], (m[1] as string).toLowerCase());
    }
    expect([...sums.keys()].sort()).toEqual(PINNED_UV.assets.map((a) => a.assetName).sort());
    for (const a of PINNED_UV.assets) expect(sums.get(a.assetName)).toBe(a.sha256);
  });

  it('installs this machine’s build, runs it, and reuses it through the marker', async () => {
    const host = detectUvHost();
    const release = uvReleaseFor(host);
    const dir = join(work, 'native');
    const install = await ensureUv({ ignorePath: true, dir });
    console.log(
      `[LIVE] host=${JSON.stringify(host)} target=${install.target} path=${install.uvPath}`,
    );
    expect(install.source).toBe('download');
    expect(install.target).toBe(release.target);
    if (EXPECT_TARGET !== '') expect(install.target).toBe(EXPECT_TARGET);
    expect(await binaryKind(install.uvPath)).toBe(expectedKind(release.target));
    const version = uvVersion(install.uvPath);
    console.log(`[LIVE] ${version}`);
    expect(version).toMatch(new RegExp(`^uv ${PINNED_UV.version.replace(/\./g, '\\.')}\\b`));

    const again = await ensureUv({
      ignorePath: true,
      dir,
      fetchImpl: (() => {
        throw new Error('the marker should answer without the network');
      }) as unknown as typeof fetch,
    });
    expect(again.uvPath).toBe(install.uvPath);
  });
});

describe.skipIf(!RUN || targetsToCheck().length === 0)('uv live: other builds, here', () => {
  let manifest: {
    artifacts: Record<string, { assets?: Array<{ kind: string; path: string }> }>;
  };
  beforeAll(async () => {
    manifest = JSON.parse(await getText(`${RELEASE_BASE}/dist-manifest.json`));
  });

  it.each(targetsToCheck())('%s installs, verifies and is the right binary', async (target) => {
    const release = uvReleaseForTarget(target);
    const dir = join(work, target);
    const install = await ensureUv({ ignorePath: true, dir, release });
    const kind = await binaryKind(install.uvPath);
    const installDir = join(dir, `uv-${target}`);
    const files = readdirSync(installDir).sort();
    console.log(`[LIVE] ${target}: ${kind} files=${files.join(',')}`);
    expect(install.uvPath).toBe(join(installDir, release.binName));
    expect(kind).toBe(expectedKind(target));

    // Exactly the executables the release says the archive carries.
    const listed = (manifest.artifacts[release.assetName]?.assets ?? [])
      .filter((a) => a.kind === 'executable')
      .map((a) => a.path)
      .sort();
    expect(listed.length).toBeGreaterThan(0);
    expect(files).toEqual(listed);

    const native = uvReleaseFor(detectUvHost()).target;
    const rosetta = process.platform === 'darwin' && target === 'x86_64-apple-darwin';
    if (target === native || rosetta) {
      try {
        const version = uvVersion(install.uvPath);
        console.log(`[LIVE] ${target} runs here: ${version}`);
        expect(version.startsWith(`uv ${PINNED_UV.version}`)).toBe(true);
      } catch (err) {
        if (target === native) throw err;
        console.log(`[LIVE] ${target} cannot run here (no Rosetta?): ${(err as Error).message}`);
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
});
