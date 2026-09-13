import { describe, expect, it } from 'vitest';
import type { LlmCatalogEntry, LlmStatus } from '../../../electron/ipc-contract';
import {
  flagMatches,
  methodAvailability,
  runningValue,
  sameConfig,
  setFlag,
  shellJoin,
} from './engine-settings-logic';

const entry = {
  id: 'qwen3.8-27b-mtp',
  mtp: true,
  variants: [
    { method: 'mtp', embedded: true },
    { method: 'dflash', draftRepo: 'z-lab/Qwen3.8-27B-DFlash2-GGUF' },
    { method: 'dspark', draftRepo: 'Anbeeld/Qwen3.8-27B-DSpark-GGUF' },
  ],
} as unknown as LlmCatalogEntry;

const specTypes = [
  'none',
  'draft-mtp',
  'draft-dflash',
  'draft-dspark',
  'draft-eagle3',
  'ngram-mod',
];

describe('methodAvailability — the bar offers only what this model and build can do', () => {
  it('offers the catalogued heads, marks the missing drafter, names DFlash2', () => {
    const a = methodAvailability(entry, { draftsOnDisk: ['dflash'], specTypes });
    const by = Object.fromEntries(a.map((x) => [x.method, x]));
    expect(by.mtp).toMatchObject({ offered: true, ready: true });
    expect(by.dflash).toMatchObject({ offered: true, ready: true, label: 'DFlash2' });
    expect(by.dspark).toMatchObject({
      offered: true,
      ready: false,
      note: 'drafter not downloaded yet',
    });
    expect(by.eagle3).toMatchObject({ offered: false });
    expect(by.custom).toMatchObject({ offered: true, ready: true });
    expect(by.ngram).toMatchObject({ offered: true });
  });

  it('withholds a method the llama.cpp build cannot run, and MTP for a model without heads', () => {
    const a = methodAvailability({ ...entry, mtp: false } as LlmCatalogEntry, {
      draftsOnDisk: [],
      specTypes: ['none', 'draft-mtp'],
    });
    const by = Object.fromEntries(a.map((x) => [x.method, x]));
    expect(by.mtp?.offered).toBe(false);
    expect(by.dflash).toMatchObject({
      offered: false,
      note: 'this llama.cpp build cannot run dflash',
    });
    expect(by.ngram?.offered).toBe(false);
  });
});

describe('editing a draft', () => {
  it('sets, replaces and clears; a cleared flag is absent, not false', () => {
    let v = setFlag({}, '--jinja', true);
    v = setFlag(v, '--reasoning-budget', 512);
    expect(v).toEqual({ '--jinja': true, '--reasoning-budget': 512 });
    v = setFlag(v, '--jinja', null);
    expect(v).toEqual({ '--reasoning-budget': 512 });
    expect(setFlag(v, '--reasoning-budget', '')).toEqual({});
  });

  it('compares configs by value, not by object', () => {
    expect(
      sameConfig(
        { flags: { a: 1, b: 'x' }, rawArgs: ['--q'] },
        { flags: { b: 'x', a: 1 }, rawArgs: ['--q'] },
      ),
    ).toBe(true);
    expect(sameConfig({ flags: { a: 1 }, rawArgs: [] }, { flags: { a: 2 }, rawArgs: [] })).toBe(
      false,
    );
  });
});

describe('reading the running server', () => {
  const status = {
    launchArgs: ['-m', 'x.gguf', '-c', '65536', '--jinja', '--reasoning-budget', '-1', '-fa', 'on'],
  } as unknown as LlmStatus;
  it('reads a value, a bare switch and a negative number off the argv', () => {
    expect(runningValue(status, ['-c', '--ctx-size'])).toBe('65536');
    expect(runningValue(status, ['--jinja', '--no-jinja'])).toBe('on');
    expect(runningValue(status, ['--reasoning-budget'])).toBe('-1');
    expect(runningValue(status, ['--top-k'])).toBeNull();
  });

  it('renders a command line with quoting only where needed', () => {
    expect(shellJoin('/bin/llama-server', ['-m', 'my model.gguf', '--alias', "it's"])).toBe(
      "/bin/llama-server -m 'my model.gguf' --alias 'it'\\''s'",
    );
  });

  it('searches every spelling and the description', () => {
    const f = {
      key: '--ctx-size',
      aliases: ['-c', '--ctx-size'],
      description: 'size of the prompt context',
    };
    expect(flagMatches(f, 'CTX')).toBe(true);
    expect(flagMatches(f, '-c')).toBe(true);
    expect(flagMatches(f, 'prompt context')).toBe(true);
    expect(flagMatches(f, 'batch')).toBe(false);
  });
});
