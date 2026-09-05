/**
 * A HUGGING FACE THAT MISBEHAVES ON PURPOSE.
 *
 * Round 2, the user: "stress tests of downloading". The real thing is 13 GB a run
 * and never drops a connection when you want it to, so the interesting states —
 * a transfer cut halfway, four of them at once, a server that ignores Range, a
 * repo that 404s, one that stalls — are unreachable against it. This serves the
 * same shapes the app already speaks (`/<repo>/resolve/main/<file>` with
 * `accept-ranges: bytes`, and `/api/models/...` for search + tree) from
 * localhost, at a speed and with a failure mode the test chooses.
 *
 * The app is pointed here with HF_ENDPOINT (see `hfEndpoint` in
 * @pi-desktop/inference), which is the variable huggingface_hub itself honours
 * — so this is the same seam a mirror or an air-gapped proxy uses, not a
 * test-only backdoor.
 *
 * Deliberately NOT a replacement for the real download probe. It proves the
 * transfer machinery and the UI around it; only huggingface.co proves
 * huggingface.co.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * Deterministic bytes for a given file, generated rather than stored: a 400 MB
 * fixture in the repo is not a fixture. The pattern is cheap and stable, so the
 * sha256 the app verifies against is computable here.
 */
export function fileBytes(seed, size) {
  const buf = Buffer.allocUnsafe(size);
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x >>> 24;
  }
  return buf;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {object} opts
 * @param {Record<string, number>} opts.files  path → size in bytes
 * @param {number} [opts.bytesPerSecond]       throttle, so progress is watchable
 * @param {boolean} [opts.ignoreRange]         answer 200 to a Range request
 */
export async function startMirror(opts) {
  const { files, bytesPerSecond = 0, ignoreRange = false } = opts;
  const content = new Map();
  for (const [name, size] of Object.entries(files)) content.set(name, fileBytes(name, size));

  /**
   * Live knobs a test turns DURING a transfer.
   *
   * `cutAfterBytes` drops the socket mid-file without an end event, which is
   * what a flaky network does and what a graceful 500 does not — the resume
   * path only runs when the transfer dies dirty.
   */
  const state = {
    cutAfterBytes: new Map(), // file → bytes to send before hanging up
    stall: new Set(), // files to accept and then never write to
    fail: new Map(), // file → status code
    requests: [], // { file, range, at }
    served: new Map(), // file → total bytes actually written
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = { 'access-control-allow-origin': '*' };

    // /api/models/<repo>/tree/main — enough for the app's file listing.
    if (url.pathname.startsWith('/api/models/')) {
      const body = JSON.stringify(
        [...content.entries()].map(([p, b]) => ({ type: 'file', path: p, size: b.length })),
      );
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // /<org>/<repo>/resolve/main/<file>
    const m = url.pathname.match(/\/resolve\/main\/(.+)$/);
    const file = m === null ? null : decodeURIComponent(m[1]);
    const buf = file === null ? undefined : content.get(file);
    state.requests.push({ file, range: req.headers.range ?? null, at: Date.now() });

    if (buf === undefined) {
      res.writeHead(404, cors);
      res.end('not found');
      return;
    }
    const forced = state.fail.get(file);
    if (forced !== undefined) {
      res.writeHead(forced, cors);
      res.end('forced failure');
      return;
    }
    if (state.stall.has(file)) {
      res.writeHead(200, { ...cors, 'content-length': String(buf.length) });
      return; // headers, then silence — the client's read timeout has to save it
    }

    // Range, honoured the way HF does (206 + content-range), unless told not to.
    let start = 0;
    let status = 200;
    const range = ignoreRange ? null : (req.headers.range ?? null);
    if (range !== null) {
      const rm = /bytes=(\d+)-/.exec(range);
      if (rm !== null) {
        start = Number(rm[1]);
        status = 206;
      }
    }
    const slice = buf.subarray(start);
    const headers = {
      ...cors,
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-length': String(slice.length),
      etag: `"${sha256(buf).slice(0, 16)}"`,
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${buf.length - 1}/${buf.length}`;
    res.writeHead(status, headers);

    // Written in chunks so a throttle and a mid-flight cut are both possible.
    // 16 KB rather than 64: the chunk is the resolution of BOTH knobs, and a
    // cut is only honoured at a boundary — at 64 KB a whole small file went out
    // in one write and `cutAfter` did nothing at all (measured, first run).
    const cut = state.cutAfterBytes.get(file);
    const CHUNK = 16 * 1024;
    let sent = 0;
    for (let off = 0; off < slice.length; off += CHUNK) {
      if (cut !== undefined && start + sent >= cut) {
        res.destroy(); // hang up dirty — no end event, like a dropped network
        state.served.set(file, (state.served.get(file) ?? 0) + sent);
        return;
      }
      // …and stop EXACTLY on the requested byte, not at the next boundary past
      // it, so a test can say "cut at 8 KB" and mean it.
      const room = cut === undefined ? CHUNK : Math.max(1, cut - (start + sent));
      const piece = slice.subarray(off, off + Math.min(CHUNK, room));
      if (!res.write(piece)) {
        await new Promise((r) => res.once('drain', r));
      }
      sent += piece.length;
      off -= CHUNK - piece.length; // a truncated piece advances by its own size
      if (bytesPerSecond > 0) {
        await new Promise((r) => setTimeout(r, (piece.length / bytesPerSecond) * 1000));
      }
      if (res.destroyed) break;
    }
    state.served.set(file, (state.served.get(file) ?? 0) + sent);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    endpoint: `http://127.0.0.1:${port}`,
    sha256: (name) => sha256(content.get(name)),
    size: (name) => content.get(name).length,
    state,
    /** Cut this file's transfer once N bytes have gone out. */
    cutAfter: (name, bytes) => state.cutAfterBytes.set(name, bytes),
    heal: (name) => state.cutAfterBytes.delete(name),
    failWith: (name, status) => state.fail.set(name, status),
    stall: (name) => state.stall.add(name),
    close: () => new Promise((r) => server.close(r)),
  };
}
