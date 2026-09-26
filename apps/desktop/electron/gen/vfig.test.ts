/**
 * VFIG's stream against a stand-in llama-server: OpenAI chat chunks as the
 * real one streams them, over a real local socket. No limit on the reply — so
 * the one thing that must end a runaway is the loop cut, and it must keep the
 * drawing that came before the repetition.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { svgFromText } from '@pi-desktop/gen-service';
import { afterEach, describe, expect, it } from 'vitest';
import { streamVfig } from './vfig';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A server that streams `pieces`, then its stop — or, with `forever`, the last piece without end. */
async function standIn(
  pieces: readonly string[],
  { forever = false } = {},
): Promise<{ base: string; hungUp: Promise<void> }> {
  let hangUp: () => void = () => {};
  const hungUp = new Promise<void>((r) => {
    hangUp = r;
  });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (content: string) =>
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      for (const p of pieces) send(p);
      if (!forever) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_per_second: 88, predicted_n: 42 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      const again = pieces.at(-1) ?? '';
      const timer = setInterval(() => {
        if (!res.writableEnded) send(again);
      }, 1);
      res.on('close', () => {
        clearInterval(timer);
        hangUp();
      });
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, hungUp };
}

describe('a VFIG reply, streamed', () => {
  it('runs to its end and reports it', async () => {
    const { base } = await standIn([
      '<svg viewBox="0 0 10 10">',
      '<text x="1" y="2">L</text>',
      '</svg>',
    ]);
    const r = await streamVfig(base, { prompt: 'a box' }, () => {});
    expect(r).toEqual({
      text: '<svg viewBox="0 0 10 10"><text x="1" y="2">L</text></svg>',
      stop: 'eos',
      tokens: 42,
      tokPerSec: 88,
    });
  });

  it('is hung up on when it repeats itself, and keeps the figure before the repetition', async () => {
    const figure = '<svg viewBox="0 0 100 100"><text x="5" y="10">Fig. 3.1</text>';
    const { base, hungUp } = await standIn([figure, '<rect x="1" y="2" width="3" height="4"/>\n'], {
      forever: true,
    });
    const r = await streamVfig(base, { prompt: 'a figure' }, () => {});
    await hungUp;
    expect(r).toMatchObject({ stop: 'loop', text: figure });
    if ('text' in r)
      expect(svgFromText(r.text)).toEqual({ svg: `${figure}</svg>`, complete: false });
  });

  it('stops when the chat that asked stops', async () => {
    const { base } = await standIn(['<svg>', '<g>'], { forever: true });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await expect(streamVfig(base, { prompt: 'x' }, () => {}, stop.signal)).rejects.toThrow(
      'the drawing was stopped',
    );
  });
});
