import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callModelFromEnv, UTILITY_BASE_URL_ENV, UTILITY_FILE_ENV } from './call-model.js';

/**
 * THE 12-SECOND BUG. On a normal app open pi starts BEFORE the model server, so
 * the endpoint env vars are simply absent at spawn — and this returned undefined
 * forever, killing the system-prompt warm-up for the life of that process. The
 * app's own comment had already named the gap: "a server that starts WITHOUT a
 * subsequent pi respawn won't re-point the already-running child."
 */
describe('the utility endpoint survives a server that starts after pi', () => {
  const fileWith = (body: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'util-'));
    const file = path.join(dir, 'utility-endpoint.json');
    writeFileSync(file, body);
    return file;
  };

  it('reads the LIVE file when the env was never set', () => {
    const file = fileWith(JSON.stringify({ baseUrl: 'http://127.0.0.1:9999', model: 'qwen' }));
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: file })).toBeDefined();
  });

  it('is undefined while no server exists yet — and BECOMES defined once one does', () => {
    // The whole point: asking again later must be able to succeed.
    const file = fileWith('{}');
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: file })).toBeUndefined();
    writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:9999', model: 'qwen' }));
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: file })).toBeDefined();
  });

  it('prefers the env when a spawn already knew the endpoint', () => {
    const file = fileWith(JSON.stringify({ baseUrl: 'http://file', model: 'from-file' }));
    expect(
      callModelFromEnv({ [UTILITY_BASE_URL_ENV]: 'http://env', [UTILITY_FILE_ENV]: file }),
    ).toBeDefined();
  });

  it('never throws on a missing, empty or half-written file', () => {
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: '/nope/does-not-exist.json' })).toBeUndefined();
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: fileWith('') })).toBeUndefined();
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: fileWith('{"baseUrl":') })).toBeUndefined();
    expect(callModelFromEnv({ [UTILITY_FILE_ENV]: fileWith('{"baseUrl":""}') })).toBeUndefined();
  });

  it('is undefined with neither env nor file — no hardcoded URL, ever', () => {
    expect(callModelFromEnv({})).toBeUndefined();
  });
});
