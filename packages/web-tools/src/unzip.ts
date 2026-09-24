/**
 * `.zip` EXTRACTION WITHOUT A DEPENDENCY OR A CHILD PROCESS.
 *
 * uv's Windows builds are zips (`uv-x86_64-pc-windows-msvc.zip` → `uv.exe`,
 * `uvx.exe`, `uvw.exe`), and so are llama.cpp's Windows builds. Shelling out is
 * the wrong answer on Windows: `tar.exe` only exists on Windows 10 1803+, a Git
 * Bash `tar` earlier on PATH cannot read zips, and any console child spawned from
 * the GUI flashes a window (crossplatform.md §2.4 A10). So this reads the archive
 * itself with `node:zlib`.
 *
 * What it supports is what real release archives use: stored (0) and deflate (8)
 * entries, data descriptors, archive comments and ZIP64 records. It streams each
 * entry (constant memory, so a 500 MB CUDA runtime zip is fine), checks every
 * entry's CRC-32 and size against the central directory, writes each file under a
 * temporary name and renames it into place, and refuses anything that could write
 * outside the destination: absolute paths, drive letters, `..` segments, symlink
 * entries, and on Windows `:` (an NTFS alternate data stream). Encrypted entries
 * and other compression methods are refused with a clear error.
 *
 * ONE EXTRACTOR (PLAN §2.2 R17): XP-02a's `packages/platform` `archive.ts` lifts
 * this file — moves it, with `unzip.test.ts`, `testing/zip-builder.ts` and
 * `fixtures/zip/`, and web-tools re-exports it — rather than writing a second
 * one. So it imports nothing but Node built-ins, and a test keeps it that way.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PassThrough, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export class ZipError extends Error {
  override readonly name: string = 'ZipError';
}

/** One central-directory entry, with its path already made safe. */
export interface ZipEntry {
  /** The name exactly as stored. */
  readonly rawName: string;
  /** Normalised relative path with `/` separators; `''` for a root-only entry. */
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  /** 0 = stored, 8 = deflate. */
  readonly method: number;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  /** Unix permission bits, when the archive was made on a Unix system. */
  readonly mode?: number;
}

export interface ExtractZipOptions {
  readonly signal?: AbortSignal;
  /** Host platform for the path rules (tests). Default: `process.platform`. */
  readonly platform?: string;
  /**
   * Moves each finished `.unzip-part` file to its name. Default: `fs.rename`.
   * On Windows a scanner can hold a just-written `.exe` for a moment, so a
   * caller installing executables passes a retrying rename (uv.ts passes
   * web-tools' `renameRetrying`); this file stays free of imports beyond Node.
   */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

let crcTable: Uint32Array | undefined;

/** CRC-32 (IEEE, the zip one) in plain JS; `prev` continues a running value. */
export function crc32Js(buf: Uint8Array, prev = 0): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  let crc = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (table[(crc ^ (buf[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `zlib.crc32` (Node ≥ 20.15 / 22.2) when present, else {@link crc32Js}. */
const crc32: (buf: Uint8Array, prev?: number) => number =
  typeof (zlib as { crc32?: unknown }).crc32 === 'function'
    ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0
    : crc32Js;

function u64(buf: Buffer, at: number, what: string): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(`${what} too large (${v})`);
  return Number(v);
}

async function readAt(fh: Awaited<ReturnType<typeof open>>, pos: number, len: number) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  if (got !== len) throw new ZipError(`unexpected end of archive at byte ${pos + got}`);
  return buf;
}

/**
 * A path from the archive made relative and safe, or a thrown {@link ZipError}.
 * Backslashes count as separators (zips written on Windows use them).
 */
export function safeEntryPath(rawName: string, platform: string = process.platform): string {
  if (rawName.includes('\0')) throw new ZipError(`NUL in archive path: ${JSON.stringify(rawName)}`);
  const unified = rawName.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw new ZipError(`absolute path in archive: ${rawName}`);
  }
  const parts: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new ZipError(`archive path escapes the destination: ${rawName}`);
    if (platform === 'win32' && seg.includes(':')) {
      throw new ZipError(`':' in archive path (NTFS stream): ${rawName}`);
    }
    parts.push(seg);
  }
  return parts.join('/');
}

interface Directory {
  readonly entries: number;
  readonly cdSize: number;
  readonly cdOffset: number;
}

async function readDirectoryLocation(
  fh: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Directory> {
  if (size < EOCD_SIZE) throw new ZipError('not a zip archive (too short)');
  const tailLen = Math.min(size, EOCD_SIZE + MAX_COMMENT);
  const tailStart = size - tailLen;
  const tail = await readAt(fh, tailStart, tailLen);

  // The end-of-central-directory record sits before an optional comment. Prefer
  // the one whose comment length reaches exactly to the end of the file.
  let eocd = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + EOCD_SIZE + commentLen === tail.length) {
      eocd = i;
      break;
    }
    if (eocd === -1 && i + EOCD_SIZE + commentLen <= tail.length) eocd = i;
  }
  if (eocd === -1) throw new ZipError('not a zip archive (no end of central directory)');

  const disk = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: a locator 20 bytes before the EOCD points at the 64-bit record.
  const eocdAbs = tailStart + eocd;
  if (eocdAbs >= 20) {
    const loc = await readAt(fh, eocdAbs - 20, 20);
    if (loc.readUInt32LE(0) === SIG_EOCD64_LOCATOR) {
      const recAt = u64(loc, 8, 'ZIP64 record offset');
      const rec = await readAt(fh, recAt, 56);
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('bad ZIP64 end of directory');
      if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) {
        throw new ZipError('multi-disk zip archives are not supported');
      }
      entries = u64(rec, 32, 'entry count');
      cdSize = u64(rec, 40, 'central directory size');
      cdOffset = u64(rec, 48, 'central directory offset');
      return { entries, cdSize, cdOffset };
    }
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('multi-disk zip archives are not supported');
  return { entries, cdSize, cdOffset };
}

/** Read the central directory. Throws {@link ZipError} on anything malformed or unsafe. */
export async function listZip(
  zipPath: string,
  opts: Pick<ExtractZipOptions, 'platform'> = {},
): Promise<ZipEntry[]> {
  const platform = opts.platform ?? process.platform;
  const fh = await open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const dir = await readDirectoryLocation(fh, size);
    if (dir.cdSize > MAX_CENTRAL_DIRECTORY) throw new ZipError('central directory too large');
    if (dir.cdOffset + dir.cdSize > size) throw new ZipError('central directory past end of file');
    const cd = await readAt(fh, dir.cdOffset, dir.cdSize);

    const out: ZipEntry[] = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL) {
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let entrySize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > cd.length) throw new ZipError('truncated central directory entry');
      const rawName = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);

      // ZIP64 extended information: only the fields saturated above are present.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let f = x + 4;
          const fEnd = f + len;
          if (entrySize === 0xffffffff && f + 8 <= fEnd) {
            entrySize = u64(cd, f, 'entry size');
            f += 8;
          }
          if (compressedSize === 0xffffffff && f + 8 <= fEnd) {
            compressedSize = u64(cd, f, 'compressed size');
            f += 8;
          }
          if (localHeaderOffset === 0xffffffff && f + 8 <= fEnd) {
            localHeaderOffset = u64(cd, f, 'local header offset');
          }
        }
        x += 4 + len;
      }

      const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0xffff : 0;
      const isSymlink = (unixMode & 0o170000) === 0o120000;
      const path = safeEntryPath(rawName, platform);
      // The DOS directory attribute counts for archives made on FAT (0), NTFS (10) or VFAT (14).
      const dosMade = [0, 10, 14].includes(madeBy >> 8);
      const isDirectory =
        rawName.endsWith('/') ||
        rawName.endsWith('\\') ||
        (unixMode & 0o170000) === 0o040000 ||
        (dosMade && (external & 0x10) !== 0);
      out.push({
        rawName,
        path,
        isDirectory,
        isSymlink,
        method,
        flags,
        crc32: crc,
        compressedSize,
        size: entrySize,
        localHeaderOffset,
        mode: unixMode !== 0 ? unixMode & 0o777 : undefined,
      });
      p = end;
    }
    if (out.length !== dir.entries) {
      throw new ZipError(`central directory lists ${out.length} entries, expected ${dir.entries}`);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Counts bytes and CRC-32 as they pass, failing past the declared size (bomb guard). */
function checker(entry: ZipEntry): Transform & { crc: number; bytes: number } {
  const t = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      t.bytes += chunk.length;
      if (t.bytes > entry.size) {
        cb(new ZipError(`${entry.rawName}: more data than the declared ${entry.size} bytes`));
        return;
      }
      t.crc = crc32(chunk, t.crc);
      cb(null, chunk);
    },
  }) as Transform & { crc: number; bytes: number };
  t.crc = 0;
  t.bytes = 0;
  return t;
}

/**
 * Extract every entry of `zipPath` into `destDir` (created if missing). Returns
 * the extracted files' relative paths. Throws {@link ZipError} before writing
 * anything when the directory holds an unsafe or unsupported entry.
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  opts: ExtractZipOptions = {},
): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  const moveIntoName = opts.rename ?? rename;
  const entries = await listZip(zipPath, { platform });
  for (const e of entries) {
    if (e.isSymlink) throw new ZipError(`symlink entries are not supported: ${e.rawName}`);
    if (e.flags & 0x1) throw new ZipError(`encrypted entries are not supported: ${e.rawName}`);
    if (!e.isDirectory && e.method !== 0 && e.method !== 8) {
      throw new ZipError(`unsupported compression method ${e.method}: ${e.rawName}`);
    }
  }

  const root = resolve(destDir);
  await mkdir(root, { recursive: true });
  const written: string[] = [];
  const fh = await open(zipPath, 'r');
  try {
    const { size: archiveSize } = await fh.stat();
    for (const e of entries) {
      opts.signal?.throwIfAborted();
      if (e.path === '') continue;
      const target = resolve(root, ...e.path.split('/'));
      const rel = relative(root, target);
      if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
        throw new ZipError(`archive path escapes the destination: ${e.rawName}`);
      }
      if (e.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }

      const local = await readAt(fh, e.localHeaderOffset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) {
        throw new ZipError(`${e.rawName}: bad local header at ${e.localHeaderOffset}`);
      }
      const dataStart = e.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (dataStart + e.compressedSize > archiveSize) {
        throw new ZipError(`${e.rawName}: data runs past the end of the archive`);
      }

      await mkdir(dirname(target), { recursive: true });
      const part = `${target}.${process.pid}.unzip-part`;
      const check = checker(e);
      try {
        if (e.compressedSize === 0) {
          if (e.size !== 0) throw new ZipError(`${e.rawName}: no data for ${e.size} bytes`);
          await pipeline(new PassThrough().end(), check, createWriteStream(part));
        } else {
          const src = createReadStream(zipPath, {
            start: dataStart,
            end: dataStart + e.compressedSize - 1,
          });
          const out = createWriteStream(part);
          if (e.method === 8) {
            await pipeline(src, zlib.createInflateRaw(), check, out, { signal: opts.signal });
          } else {
            await pipeline(src, check, out, { signal: opts.signal });
          }
        }
        if (check.bytes !== e.size) {
          throw new ZipError(`${e.rawName}: ${check.bytes} bytes, expected ${e.size}`);
        }
        if (check.crc >>> 0 !== e.crc32 >>> 0) {
          throw new ZipError(`${e.rawName}: CRC-32 mismatch`);
        }
        await moveIntoName(part, target);
      } catch (err) {
        await rm(part, { force: true }).catch(() => {});
        throw err;
      }
      if (platform !== 'win32' && e.mode !== undefined && e.mode !== 0) {
        await chmod(target, e.mode).catch(() => {});
      }
      written.push(e.path);
    }
  } finally {
    await fh.close();
  }
  return written;
}
