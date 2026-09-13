/**
 * The key/value header of a GGUF file, read without touching the tensors.
 *
 * What it is for: a GGUF carries its chat template under
 * `tokenizer.chat_template`, and a model with no canonical base repo has no
 * other template to patch (see chat-template.ts). The header is read with one
 * open file handle in 1 MiB pages; the token vocabulary (an array of ~150k
 * strings, which precedes the template) makes it a few MB, never more.
 *
 * Format (GGUF v2/v3, little-endian): magic "GGUF", u32 version, u64 tensor
 * count, u64 kv count, then kv pairs of (string key, u32 type, value). Strings
 * are u64 length + bytes; arrays are u32 element type + u64 count + elements.
 */
import { open } from 'node:fs/promises';

const PAGE = 1 << 20;

class Cursor {
  private buf = Buffer.alloc(0);
  private bufStart = 0;
  pos = 0;
  constructor(
    private readonly handle: {
      read: (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesRead: number }>;
    },
  ) {}

  private async ensure(n: number): Promise<void> {
    if (this.pos >= this.bufStart && this.pos + n <= this.bufStart + this.buf.length) return;
    const want = Math.max(PAGE, n);
    const fresh = Buffer.alloc(want);
    const { bytesRead } = await this.handle.read(fresh, 0, want, this.pos);
    if (bytesRead < n) throw new Error('gguf: header ended early');
    this.buf = fresh.subarray(0, bytesRead);
    this.bufStart = this.pos;
  }

  async u8(): Promise<number> {
    await this.ensure(1);
    return this.buf[this.pos++ - this.bufStart] as number;
  }
  async u32(): Promise<number> {
    await this.ensure(4);
    const v = this.buf.readUInt32LE(this.pos - this.bufStart);
    this.pos += 4;
    return v;
  }
  async u64(): Promise<number> {
    await this.ensure(8);
    const v = Number(this.buf.readBigUInt64LE(this.pos - this.bufStart));
    this.pos += 8;
    return v;
  }
  async skip(n: number): Promise<void> {
    this.pos += n;
  }
  async string(): Promise<string> {
    const len = await this.u64();
    await this.ensure(len);
    const s = this.buf.toString('utf8', this.pos - this.bufStart, this.pos - this.bufStart + len);
    this.pos += len;
    return s;
  }
}

/** GGUF value types → their fixed byte sizes (strings/arrays are variable). */
const SCALAR_SIZE: Record<number, number> = {
  0: 1, // uint8
  1: 1, // int8
  2: 2, // uint16
  3: 2, // int16
  4: 4, // uint32
  5: 4, // int32
  6: 4, // float32
  7: 1, // bool
  10: 8, // uint64
  11: 8, // int64
  12: 8, // float64
};
const T_STRING = 8;
const T_ARRAY = 9;

async function skipValue(c: Cursor, type: number): Promise<void> {
  if (type === T_STRING) {
    const len = await c.u64();
    await c.skip(len);
    return;
  }
  if (type === T_ARRAY) {
    const elem = await c.u32();
    const count = await c.u64();
    const size = SCALAR_SIZE[elem];
    if (size !== undefined) {
      await c.skip(size * count);
      return;
    }
    for (let i = 0; i < count; i++) await skipValue(c, elem);
    return;
  }
  const size = SCALAR_SIZE[type];
  if (size === undefined) throw new Error(`gguf: unknown value type ${type}`);
  await c.skip(size);
}

/**
 * The string values of `keys` from a GGUF's header (keys that are absent or not
 * strings are simply missing from the result). Stops as soon as every wanted
 * key has been seen.
 */
export async function readGgufStrings(
  path: string,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const handle = await open(path, 'r');
  try {
    const c = new Cursor(handle);
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (magic.toString('latin1') !== 'GGUF') throw new Error('gguf: bad magic');
    c.pos = 4;
    const version = await c.u32();
    if (version < 2 || version > 3) throw new Error(`gguf: unsupported version ${version}`);
    await c.u64(); // tensor count
    const nkv = await c.u64();
    const out: Record<string, string> = {};
    const wanted = new Set(keys);
    for (let i = 0; i < nkv && wanted.size > 0; i++) {
      const key = await c.string();
      const type = await c.u32();
      if (wanted.has(key) && type === T_STRING) {
        out[key] = await c.string();
        wanted.delete(key);
      } else {
        await skipValue(c, type);
      }
    }
    return out;
  } finally {
    await handle.close();
  }
}

/** The chat template a GGUF carries, or undefined when it has none. */
export async function ggufChatTemplate(path: string): Promise<string | undefined> {
  const kv = await readGgufStrings(path, ['tokenizer.chat_template']);
  const t = kv['tokenizer.chat_template'];
  return t !== undefined && t.length > 0 ? t : undefined;
}
