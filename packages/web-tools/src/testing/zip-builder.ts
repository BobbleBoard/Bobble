/**
 * TEST ONLY: write a .zip byte by byte, so unzip/uv tests can make exactly the
 * archive they need — ZIP64 records, data descriptors, comments, and the broken
 * or hostile entries (bad CRC, `../` names, symlinks, lying sizes) a real tool
 * would refuse to write. Not exported from the package.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32Js } from '../unzip.js';

export interface BuildEntry {
  readonly name: string;
  /** File content; omit for a directory entry. */
  readonly data?: Buffer | string;
  /** 0 stored, 8 deflate (default), anything else is written as-is (stored bytes). */
  readonly method?: number;
  /** Unix mode including type bits (e.g. `0o100755`); marks the entry as made on Unix. */
  readonly mode?: number;
  /** Extra general-purpose flag bits (1 = encrypted, 8 = data descriptor). */
  readonly flags?: number;
  /** Override the CRC-32 written to the headers. */
  readonly crc?: number;
  /** Override the uncompressed size written to the central directory. */
  readonly declaredSize?: number;
}

export interface BuildOptions {
  /** Write ZIP64 records (extra fields, the 64-bit end record and its locator). */
  readonly zip64?: boolean;
  readonly comment?: string;
}

const u16 = (v: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const u64 = (v: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

export function buildZip(entries: readonly BuildEntry[], opts: BuildOptions = {}): Buffer {
  const zip64 = opts.zip64 === true;
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const push = (b: Buffer): void => {
    chunks.push(b);
    offset += b.length;
  };

  for (const e of entries) {
    const isDir = e.data === undefined;
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(e.data as Buffer | string);
    const method = isDir ? 0 : (e.method ?? 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.crc ?? crc32Js(raw);
    const flags = 0x800 | (e.flags ?? 0);
    const descriptor = (flags & 0x8) !== 0;
    const name = Buffer.from(e.name, 'utf8');
    const version = zip64 ? 45 : 20;
    const localOffset = offset;

    const localExtra = zip64
      ? Buffer.concat([u16(0x0001), u16(16), u64(raw.length), u64(body.length)])
      : Buffer.alloc(0);
    push(
      Buffer.concat([
        u32(0x04034b50),
        u16(version),
        u16(flags),
        u16(method),
        u16(0),
        u16(0x21),
        u32(descriptor ? 0 : crc),
        u32(descriptor ? 0 : zip64 ? 0xffffffff : body.length),
        u32(descriptor ? 0 : zip64 ? 0xffffffff : raw.length),
        u16(name.length),
        u16(localExtra.length),
        name,
        localExtra,
      ]),
    );
    push(body);
    if (descriptor) {
      push(
        zip64
          ? Buffer.concat([u32(0x08074b50), u32(crc), u64(body.length), u64(raw.length)])
          : Buffer.concat([u32(0x08074b50), u32(crc), u32(body.length), u32(raw.length)]),
      );
    }

    const size = e.declaredSize ?? raw.length;
    const madeBy = e.mode !== undefined ? (3 << 8) | version : version;
    const external = e.mode !== undefined ? (e.mode << 16) >>> 0 : isDir ? 0x10 : 0;
    const centralExtra = zip64
      ? Buffer.concat([u16(0x0001), u16(24), u64(size), u64(body.length), u64(localOffset)])
      : Buffer.alloc(0);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(madeBy),
        u16(version),
        u16(flags),
        u16(method),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(zip64 ? 0xffffffff : body.length),
        u32(zip64 ? 0xffffffff : size),
        u16(name.length),
        u16(centralExtra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(external),
        u32(zip64 ? 0xffffffff : localOffset),
        name,
        centralExtra,
      ]),
    );
  }

  const cd = Buffer.concat(central);
  const cdOffset = offset;
  push(cd);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');
  if (zip64) {
    const recordOffset = offset;
    push(
      Buffer.concat([
        u32(0x06064b50),
        u64(44),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(entries.length),
        u64(entries.length),
        u64(cd.length),
        u64(cdOffset),
      ]),
    );
    push(Buffer.concat([u32(0x07064b50), u32(0), u64(recordOffset), u32(1)]));
  }
  push(
    Buffer.concat([
      u32(0x06054b50),
      u16(zip64 ? 0xffff : 0),
      u16(zip64 ? 0xffff : 0),
      u16(zip64 ? 0xffff : entries.length),
      u16(zip64 ? 0xffff : entries.length),
      u32(zip64 ? 0xffffffff : cd.length),
      u32(zip64 ? 0xffffffff : cdOffset),
      u16(comment.length),
      comment,
    ]),
  );
  return Buffer.concat(chunks);
}
