import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildZip } from './testing/zip-builder.js';
import { crc32Js, extractZip, listZip, safeEntryPath, ZipError } from './unzip.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/zip/${name}`, import.meta.url));

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'pi-web-tools-unzip-'));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true }).catch(() => {});
});

async function zipFile(name: string, bytes: Buffer): Promise<string> {
  const p = join(work, name);
  await writeFile(p, bytes);
  return p;
}

/** Every file under `root`, relative, `/`-separated. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else out.push(r);
    }
  };
  if (existsSync(root)) walk(root, '');
  return out.sort();
}

describe('crc32Js', () => {
  it('matches zlib.crc32, including when continued across chunks', () => {
    for (const len of [0, 1, 7, 64, 1000, 65_537]) {
      const buf = randomBytes(len);
      expect(crc32Js(buf)).toBe(zlib.crc32(buf) >>> 0);
      const cut = Math.floor(len / 3);
      expect(crc32Js(buf.subarray(cut), crc32Js(buf.subarray(0, cut)))).toBe(zlib.crc32(buf) >>> 0);
    }
    expect(crc32Js(Buffer.from('123456789'))).toBe(0xcbf43926); // the standard check value
  });
});

describe('extractZip on archives real tools wrote', () => {
  it('reads Python zipfile output: deflate + stored + a directory entry + a comment', async () => {
    const dest = join(work, 'out');
    const written = await extractZip(fixture('python-deflate.zip'), dest);
    expect(written.sort()).toEqual(['README.txt', 'bin/uv.exe', 'bin/uvx.exe']);
    expect(await readFile(join(dest, 'bin/uv.exe'))).toEqual(
      Buffer.concat([Buffer.from('MZ'), Buffer.from('uv-binary-payload '.repeat(400))]),
    );
    expect(await readFile(join(dest, 'bin/uvx.exe'), 'utf8')).toBe(`MZ${'uvx '.repeat(50)}`);
    expect(await readFile(join(dest, 'README.txt'), 'utf8')).toBe('stored, not deflated\n');
  });

  it('reads streamed entries: data descriptors (flag bit 3) and ZIP64 local extras', async () => {
    const entries = await listZip(fixture('python-stream-zip64.zip'));
    expect(entries.map((e) => [e.path, e.flags & 0x8])).toEqual([
      ['uv.exe', 0x8],
      ['uvw.exe', 0x8],
    ]);
    const dest = join(work, 'out');
    await extractZip(fixture('python-stream-zip64.zip'), dest);
    const payload = Buffer.alloc(256 * 64);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    expect(await readFile(join(dest, 'uv.exe'))).toEqual(
      Buffer.concat([Buffer.from('MZ'), payload]),
    );
    expect(await readFile(join(dest, 'uvw.exe'), 'utf8')).toBe('MZ window-less');
  });

  it('reads Info-ZIP output and keeps its Unix modes', async () => {
    const dest = join(work, 'out');
    await extractZip(fixture('infozip.zip'), dest);
    const uv = join(dest, 'uv-x86_64-unknown-linux-gnu', 'uv');
    const text = await readFile(uv, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text.split('\n').filter((l) => l.startsWith('echo')).length).toBe(60);
    if (process.platform !== 'win32') {
      expect(statSync(uv).mode & 0o777).toBe(0o755);
      expect(statSync(join(dest, 'uv-x86_64-unknown-linux-gnu', 'LICENSE')).mode & 0o777).toBe(
        0o644,
      );
    }
    const entries = await listZip(fixture('infozip.zip'));
    expect(entries.find((e) => e.path.endsWith('/uv'))?.method).toBe(8);
    expect(entries.find((e) => e.isDirectory)?.path).toBe('uv-x86_64-unknown-linux-gnu');
  });
});

describe('extractZip on built archives', () => {
  it('extracts stored, deflated, nested and empty files and directory entries', async () => {
    const zip = await zipFile(
      'a.zip',
      buildZip([
        { name: 'uv.exe', data: 'MZ deflated '.repeat(100) },
        { name: 'uvx.exe', data: 'MZ stored', method: 0 },
        { name: 'docs/' },
        { name: 'docs/nested/readme.md', data: '# hi\n' },
        { name: 'empty.txt', data: '' },
      ]),
    );
    const dest = join(work, 'out');
    const written = await extractZip(zip, dest);
    expect(written.sort()).toEqual(['docs/nested/readme.md', 'empty.txt', 'uv.exe', 'uvx.exe']);
    expect(await readFile(join(dest, 'uv.exe'), 'utf8')).toBe('MZ deflated '.repeat(100));
    expect(await readFile(join(dest, 'uvx.exe'), 'utf8')).toBe('MZ stored');
    expect(await readFile(join(dest, 'docs/nested/readme.md'), 'utf8')).toBe('# hi\n');
    expect(await readFile(join(dest, 'empty.txt'), 'utf8')).toBe('');
    expect(statSync(join(dest, 'docs')).isDirectory()).toBe(true);
    expect(tree(dest)).toEqual(['docs/nested/readme.md', 'empty.txt', 'uv.exe', 'uvx.exe']);
  });

  it('reads ZIP64 end records and extra fields', async () => {
    const zip = await zipFile(
      'z64.zip',
      buildZip(
        [
          { name: 'uv.exe', data: 'sixty-four '.repeat(64) },
          { name: 'uvw.exe', data: 'w', method: 0, flags: 0x8 },
        ],
        { zip64: true },
      ),
    );
    const entries = await listZip(zip);
    expect(entries.map((e) => [e.path, e.size])).toEqual([
      ['uv.exe', 11 * 64],
      ['uvw.exe', 1],
    ]);
    const dest = join(work, 'out');
    await extractZip(zip, dest);
    expect(await readFile(join(dest, 'uv.exe'), 'utf8')).toBe('sixty-four '.repeat(64));
    expect(await readFile(join(dest, 'uvw.exe'), 'utf8')).toBe('w');
  });

  it('finds the end record behind an archive comment', async () => {
    const zip = await zipFile(
      'c.zip',
      buildZip([{ name: 'uv.exe', data: 'x' }], { comment: 'PK\u0005\u0006 looks like a record' }),
    );
    await extractZip(zip, join(work, 'out'));
    expect(await readFile(join(work, 'out', 'uv.exe'), 'utf8')).toBe('x');
  });

  it('refuses a CRC mismatch and leaves no file behind', async () => {
    const zip = await zipFile('bad.zip', buildZip([{ name: 'uv.exe', data: 'payload', crc: 1 }]));
    const dest = join(work, 'out');
    await expect(extractZip(zip, dest)).rejects.toThrow(/CRC-32 mismatch/);
    expect(tree(dest)).toEqual([]);
  });

  it('refuses more data than the declared size (a zip bomb guard)', async () => {
    const zip = await zipFile(
      'bomb.zip',
      buildZip([{ name: 'uv.exe', data: 'A'.repeat(100_000), declaredSize: 10 }]),
    );
    await expect(extractZip(zip, join(work, 'out'))).rejects.toThrow(/more data than the declared/);
    expect(tree(join(work, 'out'))).toEqual([]);
  });

  it.each([
    '../evil.exe',
    'a/../../evil.exe',
    '/etc/evil',
    '\\evil.exe',
    'C:/Windows/evil.exe',
    'c:evil.exe',
    '..\\..\\evil.exe',
  ])('refuses the path %j before writing anything', async (name) => {
    const zip = await zipFile(
      'slip.zip',
      buildZip([
        { name: 'first.txt', data: 'written only if the archive is safe' },
        { name, data: 'evil' },
      ]),
    );
    const dest = join(work, 'deep', 'out');
    await expect(extractZip(zip, dest)).rejects.toBeInstanceOf(ZipError);
    expect(tree(join(work, 'deep'))).toEqual([]);
    expect(existsSync(join(work, 'evil.exe'))).toBe(false);
  });

  it('refuses symlink entries, encrypted entries and unknown methods', async () => {
    const link = await zipFile(
      'link.zip',
      buildZip([{ name: 'uv', data: '/etc/passwd', method: 0, mode: 0o120777 }]),
    );
    await expect(extractZip(link, join(work, 'o1'))).rejects.toThrow(/symlink/);
    const enc = await zipFile('enc.zip', buildZip([{ name: 'uv', data: 'x', flags: 0x1 }]));
    await expect(extractZip(enc, join(work, 'o2'))).rejects.toThrow(/encrypted/);
    const lzma = await zipFile('lzma.zip', buildZip([{ name: 'uv', data: 'x', method: 14 }]));
    await expect(extractZip(lzma, join(work, 'o3'))).rejects.toThrow(/compression method 14/);
    expect(tree(work).filter((p) => !p.endsWith('.zip'))).toEqual([]);
  });

  it('refuses a colon in a name on Windows (an NTFS alternate data stream)', async () => {
    expect(() => safeEntryPath('uv.exe:hidden', 'win32')).toThrow(/NTFS/);
    expect(safeEntryPath('uv.exe:hidden', 'linux')).toBe('uv.exe:hidden');
    expect(safeEntryPath('./bin\\uv.exe', 'win32')).toBe('bin/uv.exe');
    expect(safeEntryPath('./', 'darwin')).toBe('');
  });

  it('says clearly when the file is not a zip', async () => {
    const junk = await zipFile('junk.zip', Buffer.from('definitely not a zip archive'));
    await expect(listZip(junk)).rejects.toThrow(/not a zip archive/);
    const tiny = await zipFile('tiny.zip', Buffer.from('PK'));
    await expect(listZip(tiny)).rejects.toThrow(/too short/);
    const good = buildZip([{ name: 'uv.exe', data: 'x'.repeat(50) }]);
    const cut = await zipFile('cut.zip', good.subarray(0, good.length - 10));
    await expect(listZip(cut)).rejects.toThrow(ZipError);
  });

  it('stops when aborted', async () => {
    const zip = await zipFile(
      'a.zip',
      buildZip([
        { name: 'one', data: '1' },
        { name: 'two', data: '2' },
      ]),
    );
    const ctl = new AbortController();
    ctl.abort();
    await expect(extractZip(zip, join(work, 'out'), { signal: ctl.signal })).rejects.toThrow();
    expect(tree(join(work, 'out'))).toEqual([]);
  });
});

/** fs.rename, waiting out a real scanner's hold (on a Windows runner) for up to 5 s. */
async function realRenameWaiting(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises');
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 50) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe('extractZip moves each finished file with the rename it is given', () => {
  it('uses the caller’s rename for every file (uv passes one that waits out a scanner)', async () => {
    const zip = await zipFile(
      'exes.zip',
      buildZip([
        { name: 'uv.exe', data: 'MZ uv' },
        { name: 'uvx.exe', data: 'MZ uvx' },
      ]),
    );
    const moved: string[] = [];
    let held = 1;
    const rename = async (from: string, to: string): Promise<void> => {
      moved.push(
        `${from.slice(from.lastIndexOf(sep) + 1).replace(/\.\d+\./, '.<pid>.')} -> ${to.slice(to.lastIndexOf(sep) + 1)}`,
      );
      // Held once, the way a scanner holds a new .exe; a caller's retrying rename
      // absorbs this, and extractZip reports whatever the rename finally reports.
      if (held-- > 0) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      await realRenameWaiting(from, to);
    };
    const retrying = async (from: string, to: string): Promise<void> => {
      try {
        await rename(from, to);
      } catch {
        await rename(from, to);
      }
    };
    await extractZip(zip, join(work, 'out'), { rename: retrying });
    expect(moved).toEqual([
      'uv.exe.<pid>.unzip-part -> uv.exe',
      'uv.exe.<pid>.unzip-part -> uv.exe',
      'uvx.exe.<pid>.unzip-part -> uvx.exe',
    ]);
    expect(tree(join(work, 'out'))).toEqual(['uv.exe', 'uvx.exe']);

    // A rename that keeps failing fails the extraction and leaves no part file.
    const stuck = async (): Promise<void> => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    };
    await expect(extractZip(zip, join(work, 'stuck'), { rename: stuck })).rejects.toMatchObject({
      code: 'EBUSY',
    });
    expect(tree(join(work, 'stuck'))).toEqual([]);
  });
});

describe('one extractor (PLAN §2.2 R17): the files XP-02a lifts stay self-contained', () => {
  const src = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const specifiers = (text: string): string[] =>
    [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map(
      (m) => m[1] as string,
    );

  it('unzip.ts imports nothing but Node built-ins', () => {
    const found = specifiers(src('./unzip.ts'));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });

  it('its test helper imports only Node and unzip.ts itself', () => {
    const found = specifiers(src('./testing/zip-builder.ts'));
    expect(found.filter((s) => !s.startsWith('node:'))).toEqual(['../unzip.js']);
  });
});
