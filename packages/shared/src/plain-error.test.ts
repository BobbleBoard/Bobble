import { describe, expect, it } from 'vitest';
import { errorText, plainError } from './plain-error';

describe('plainError — an error said so a person can act on it', () => {
  const cases: Array<[unknown, Parameters<typeof plainError>[1], RegExp]> = [
    ['TypeError: fetch failed', 'download', /reach the internet/],
    ['getaddrinfo ENOTFOUND huggingface.co', 'search', /reach the internet/],
    ['connect ECONNREFUSED 127.0.0.1:8080', 'engine', /engine is not running/],
    ['connect ECONNREFUSED 127.0.0.1:8080', 'connect', /Nothing answered/],
    ['ENOSPC: no space left on device, write', 'download', /disk is full/],
    ['GET https://hf.co/x failed: HTTP 404 Not Found', 'download', /not found on the server/],
    ['HTTP 429: Too Many Requests', 'search', /busy/],
    ['401 Client Error: Unauthorized', 'download', /refused/],
    ['ComfyUI /prompt failed (500): internal server error', 'generate', /server had a problem/],
    ["ENOENT: no such file or directory, open '/x/y.png'", 'open', /not there any more/],
    ['EACCES: permission denied, open /Users/j/Desktop/a', 'read', /did not allow/],
    ['rapid-mlx is not installed', 'engine', /rapid-mlx is not installed on this Mac/],
    ['checksum mismatch for model.gguf', 'download', /damaged/],
    ['Unexpected token < in JSON at position 0', 'read', /could not be read/],
    ['the recogniser did not answer in time', 'run', /took too long/],
    ['a download is already running', 'download', /already running/],
    ['Traceback (most recent call last): KeyError: "x"', 'generate', /did not finish/],
    [
      new Error('boom', { cause: new Error('getaddrinfo EAI_AGAIN') }),
      'download',
      /reach the internet/,
    ],
    [undefined, 'save', /could not be saved/],
  ];
  for (const [raw, ctx, want] of cases) {
    it(`${errorText(raw).slice(0, 50) || '(nothing)'} [${ctx}]`, () => {
      const out = plainError(raw, ctx);
      expect(out).toMatch(want);
      // Never the raw words, never a code.
      expect(out).not.toMatch(/ENOENT|EACCES|ENOSPC|ECONN|Traceback|HTTP \d|\{|fetch failed/);
    });
  }
});
