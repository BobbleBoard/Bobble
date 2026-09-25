/**
 * The OmniSVG stream against a stand-in llama-server: `data: {…}` lines as the
 * real one sends them (return_tokens), over a real local socket.
 *
 * MEASURED 2026-09-25: a quarter to a half of the samples looped on one command
 * of no length until the 1,536-id limit (~22 s). The stream now hangs up the
 * moment the tail repeats, and hands back the drawing before the loop.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildOmniSvgRequest } from '@pi-desktop/gen-service';
import { afterEach, describe, expect, it } from 'vitest';
import { streamCompletion } from './omnisvg';

const DRAWING = Array.from({ length: 40 }, (_, i) => 1000 + i);
const CURVE = [7, 501, 501, 501];

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A llama-server that streams `ids` a few at a time, then its stop line — or, with `forever`, never stops. */
async function standIn(
  ids: readonly number[],
  { forever = false }: { forever?: boolean } = {},
): Promise<{ base: string; sent: () => number; hungUp: Promise<void> }> {
  let sent = 0;
  let hangUp: () => void = () => {};
  const hungUp = new Promise<void>((r) => {
    hangUp = r;
  });
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      if (i < ids.length || forever) {
        const chunk = i < ids.length ? ids.slice(i, i + 4) : CURVE;
        i += 4;
        sent += chunk.length;
        res.write(`data: ${JSON.stringify({ tokens: chunk })}\n\n`);
        return;
      }
      res.end(
        `data: ${JSON.stringify({ tokens: [], stop: true, stop_type: 'eos', timings: { predicted_per_second: 60 } })}\n\n`,
      );
      clearInterval(tick);
    }, 1);
    res.on('close', () => {
      clearInterval(tick);
      hangUp();
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, sent: () => sent, hungUp };
}

describe('streamCompletion — the drawing as it streams', () => {
  const body = buildOmniSvgRequest({ prompt: 'A running person, side view silhouette' });

  it('hangs up on a sample caught in a loop and keeps the drawing before it', async () => {
    const stub = await standIn(DRAWING, { forever: true });
    const seen: number[] = [];
    const out = await streamCompletion(stub.base, body, (ids) => seen.push(ids.length));
    expect(out).toEqual({ ids: DRAWING, stop: 'loop', tokPerSec: null });
    // It stopped the stream itself: the stand-in would have gone on for ever.
    await stub.hungUp;
    expect(stub.sent()).toBeLessThan(DRAWING.length + 12 * CURVE.length + 16);
    // The partial drawing was never shown with the loop in it.
    expect(Math.max(...seen)).toBeLessThan(DRAWING.length + 12 * CURVE.length);
  });

  it('reads a finished drawing to its end, untouched', async () => {
    const stub = await standIn(DRAWING);
    const out = await streamCompletion(stub.base, body, () => {});
    expect(out).toEqual({ ids: DRAWING, stop: 'eos', tokPerSec: 60 });
  });
});
