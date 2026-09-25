/**
 * The uv downloader releases its file handle before it renames or removes the
 * `.part` file. `end()`'s callback fires on 'finish', while the handle is still
 * being closed; renaming or removing then races the close (on Windows a file
 * removed while open can linger as "delete pending"). Each rename and removal
 * below records whether the write stream had closed by then.
 */
import { createHash } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => ({
  streams: [] as WriteStream[],
  events: [] as Array<{ op: string; path: string; closed: boolean }>,
}));

function lastStreamClosed(): boolean {
  const s = trace.streams.at(-1);
  return s === undefined || s.closed;
}

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const createWriteStream = ((...args: Parameters<typeof real.createWriteStream>) => {
    const s = real.createWriteStream(...args);
    trace.streams.push(s);
    return s;
  }) as typeof real.createWriteStream;
  return { ...real, createWriteStream, default: { ...real, createWriteStream } };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const rename: typeof real.rename = async (from, to) => {
    trace.events.push({ op: 'rename', path: String(from), closed: lastStreamClosed() });
    return real.rename(from, to);
  };
  const rmTraced: typeof real.rm = async (p, opts) => {
    if (String(p).endsWith('.part')) {
      trace.events.push({ op: 'rm', path: String(p), closed: lastStreamClosed() });
    }
    return real.rm(p, opts);
  };
  return { ...real, rename, rm: rmTraced, default: { ...real, rename, rm: rmTraced } };
});

const { ChecksumMismatchError, downloadFile } = await import('./download.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-web-tools-download-'));
  trace.streams.length = 0;
  trace.events.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const body = Buffer.alloc(3 * 1024 * 1024, 7); // several writes, so draining happens
const sha = createHash('sha256').update(body).digest('hex');
const serve = (bytes: Buffer): typeof fetch =>
  (async () => new Response(new Uint8Array(bytes))) as typeof fetch;

describe('downloadFile closes the .part file before touching it', () => {
  it('renames it into place only once the handle is closed', async () => {
    const dest = join(dir, 'uv.zip');
    const r = await downloadFile({
      url: 'https://x/uv.zip',
      dest,
      expectedSha256: sha,
      fetchImpl: serve(body),
    });
    expect(r.sha256).toBe(sha);
    expect((await readFile(dest)).equals(body)).toBe(true);
    expect(trace.events.map((e) => [e.op, e.path])).toContainEqual(['rename', `${dest}.part`]);
    expect(trace.events.filter((e) => !e.closed)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['uv.zip']);
  });

  it('removes it only once closed when the digest is wrong', async () => {
    const dest = join(dir, 'uv.zip');
    await expect(
      downloadFile({
        url: 'https://x/uv.zip',
        dest,
        expectedSha256: '0'.repeat(64),
        fetchImpl: serve(body),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(trace.events.map((e) => [e.op, e.path])).toEqual([['rm', `${dest}.part`]]);
    expect(trace.events.filter((e) => !e.closed)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes it only once closed when the transfer breaks off', async () => {
    const dest = join(dir, 'uv.zip');
    const breaking = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(body.subarray(0, 1024 * 1024)));
            c.error(new Error('connection reset'));
          },
        }),
      )) as typeof fetch;
    await expect(
      downloadFile({ url: 'https://x/uv.zip', dest, expectedSha256: sha, fetchImpl: breaking }),
    ).rejects.toThrow('connection reset');
    expect(trace.events.map((e) => [e.op, e.path])).toEqual([['rm', `${dest}.part`]]);
    expect(trace.events.filter((e) => !e.closed)).toEqual([]);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('reports a .part file it cannot open, instead of hanging or crashing', async () => {
    const dest = join(dir, 'uv.zip');
    // A folder where the .part file should go: opening it for writing fails.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(`${dest}.part`);
    await expect(
      downloadFile({ url: 'https://x/uv.zip', dest, expectedSha256: sha, fetchImpl: serve(body) }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM|EACCES)$/) });
  });
});
