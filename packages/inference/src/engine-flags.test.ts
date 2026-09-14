import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  categorize,
  configFingerprint,
  flagsToArgs,
  groupFlags,
  MANAGED_LLAMA_FLAGS,
  parseArgparseHelp,
  parseCommandLine,
  parseLlamaHelp,
  tokenizeCommand,
} from './engine-flags.js';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const llama = parseLlamaHelp(fixture('llama-server-b10603-help.txt'));

describe('parseLlamaHelp — the pinned build, every flag', () => {
  it('reads the whole list, not a hand-picked subset', () => {
    // b10603 prints 253 flag lines; help/usage/version are dropped.
    expect(llama.length).toBeGreaterThan(240);
    expect(llama.map((f) => f.key)).not.toContain('--help');
  });

  it('keeps aliases, placeholder, default and env for a common flag', () => {
    const ctx = llama.find((f) => f.key === '--ctx-size');
    expect(ctx?.aliases).toEqual(['-c', '--ctx-size']);
    expect(ctx?.placeholder).toBe('N');
    expect(ctx?.control).toEqual({ kind: 'number' });
    expect(ctx?.defaultValue).toBe('0, 0 = loaded from model');
    expect(ctx?.env).toBe('LLAMA_ARG_CTX_SIZE');
    expect(ctx?.category).toBe('Model & context');
  });

  it('files sampling and speculative flags under the engine’s own sections', () => {
    expect(llama.find((f) => f.key === '--top-k')?.section).toBe('sampling');
    expect(llama.find((f) => f.key === '--top-k')?.category).toBe('Sampling');
    const draft = llama.find((f) => f.key === '--spec-draft-threads');
    expect(draft?.section).toBe('speculative');
    expect(draft?.aliases).toContain('-td');
    expect(draft?.aliases).toContain('--threads-draft');
  });

  it('reads a flag whose description starts on the next line', () => {
    const seq = llama.find((f) => f.key === '--sampler-seq');
    expect(seq?.aliases).toEqual(['--sampler-seq', '--sampling-seq']);
    expect(seq?.placeholder).toBe('SEQUENCE');
    expect(seq?.description).toMatch(/simplified sequence/);
    expect(seq?.defaultValue).toBe('edskypmxt');
  });

  it('turns enumerated placeholders into selects and bare flags into switches', () => {
    const spec = llama.find((f) => f.key === '--spec-type');
    expect(spec?.control.kind).toBe('select');
    expect(spec?.control.kind === 'select' ? spec.control.options : []).toContain('draft-dflash');
    expect(llama.find((f) => f.key === '--cpu-strict')?.control).toEqual({
      kind: 'select',
      options: ['0', '1'],
    });
    expect(llama.find((f) => f.key === '--jinja')?.control).toEqual({ kind: 'switch' });
    const reasoning = llama.find((f) => f.key === '--reasoning-budget');
    expect(reasoning?.control.kind).toBe('number');
    expect(llama.find((f) => f.key === '--reasoning-budget-message')?.control.kind).toBe('text');
    expect(llama.find((f) => f.key === '--reasoning-budget')?.category).toBe('Reasoning & chat');
  });

  it('reads the enumerations llama.cpp writes as prose, and not the lists it writes as prose', () => {
    // "list of built-in templates: bailing, …" → a select of the names; the
    // file flag stays a path and neither description carries the 54 names.
    const named = llama.find((f) => f.key === '--chat-template');
    expect(named?.control.kind).toBe('select');
    const names = named?.control.kind === 'select' ? named.control.options : [];
    expect(names).toContain('chatml');
    expect(names).toContain('gemma');
    expect(names.length).toBeGreaterThan(40);
    expect(named?.description).not.toContain('bailing');
    const file = llama.find((f) => f.key === '--chat-template-file');
    expect(file?.control).toEqual({ kind: 'path' });
    expect(file?.description).not.toContain('bailing');
    // "one of: - none: … - deepseek: …" bullets, with the default added when
    // the bullets leave it out; quoted levels ('minimal', 'low', …) too.
    expect(llama.find((f) => f.key === '--reasoning-format')?.control).toEqual({
      kind: 'select',
      options: ['none', 'deepseek', 'deepseek-legacy', 'auto'],
    });
    expect(llama.find((f) => f.key === '--split-mode')?.control).toEqual({
      kind: 'select',
      options: ['none', 'layer', 'row', 'tensor'],
    });
    expect(llama.find((f) => f.key === '--reasoning-effort')?.control).toEqual({
      kind: 'select',
      options: ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
    // `N0,N1,N2,...` and `<dev1,dev2,..>` are lists the user types, not choices.
    for (const k of ['--tensor-split', '--device', '--fit-target', '--tools']) {
      expect(llama.find((f) => f.key === k)?.control, k).toEqual({ kind: 'text' });
    }
  });

  it('has the popular flags the user named', () => {
    for (const k of [
      '--reasoning-budget',
      '--reasoning-budget-message',
      '--reasoning-format',
      '--jinja',
    ])
      expect(llama.some((f) => f.key === k)).toBe(true);
  });

  it('groups in the panel’s order with nothing lost', () => {
    const groups = groupFlags(llama);
    expect(groups[0]?.category).toBe('Model & context');
    expect(groups.reduce((n, g) => n + g.flags.length, 0)).toBe(llama.length);
    expect(groups.find((g) => g.category === 'Speculative decoding')?.flags.length).toBeGreaterThan(
      20,
    );
  });
});

describe('parseArgparseHelp — the MLX engines', () => {
  it('reads rapid-mlx serve, with choices and metavars', () => {
    const flags = parseArgparseHelp(fixture('rapid-mlx-serve-help.txt'));
    expect(flags.length).toBeGreaterThan(80);
    const prec = flags.find((f) => f.key === '--image-weight-precision');
    expect(prec?.control).toEqual({ kind: 'select', options: ['q4', 'bf16'] });
    const spec = flags.find((f) => f.key === '--speculative-config');
    expect(spec?.description).toMatch(/vLLM-style/);
    expect(flags.find((f) => f.key === '--disk-stream')?.control).toEqual({ kind: 'switch' });
    expect(flags.some((f) => f.key === '--help')).toBe(false);
  });

  it('reads dflash, mlx-dspark and omlx', () => {
    for (const name of [
      'dflash-serve-help.txt',
      'mlx-dspark-serve-help.txt',
      'omlx-serve-help.txt',
    ]) {
      const flags = parseArgparseHelp(fixture(name));
      expect(flags.length).toBeGreaterThan(10);
      expect(flags.some((f) => f.key === '--port')).toBe(true);
    }
    const mode = parseArgparseHelp(fixture('mlx-dspark-serve-help.txt')).find(
      (f) => f.key === '--mode',
    );
    expect(mode?.control).toEqual({
      kind: 'select',
      options: ['auto', 'dspark', 'dflash', 'lookup', 'baseline'],
    });
  });
});

describe('a pasted command becomes rows', () => {
  it('tokenises quotes and escapes like a shell', () => {
    expect(
      tokenizeCommand(`llama-server -m "my model.gguf" --alias 'a b' -c 8192 \\\n --jinja`),
    ).toEqual(['llama-server', '-m', 'my model.gguf', '--alias', 'a b', '-c', '8192', '--jinja']);
  });

  it('pairs values with the flags that take them and marks what Bobble manages', () => {
    const rows = parseCommandLine(
      './build/bin/llama-server -m x.gguf -c 8192 --jinja --reasoning-budget 512 --port 8080 --mystery-flag 3 --temp=0.7',
      llama,
    );
    expect(rows.map((r) => [r.flag, r.value])).toEqual([
      ['--model', 'x.gguf'],
      ['--ctx-size', '8192'],
      ['--jinja', null],
      ['--reasoning-budget', '512'],
      ['--port', '8080'],
      ['--mystery-flag', '3'],
      ['--temp', '0.7'],
    ]);
    expect(rows[0]?.managed).toBe('refused');
    expect(rows[1]?.managed).toBe('override');
    expect(rows[2]?.managed).toBeUndefined();
    expect(rows[5]?.known).toBeUndefined();
  });

  it('turns values into argv and refuses the flags a launch cannot survive', () => {
    const { args, refused } = flagsToArgs(
      {
        '--jinja': true,
        '--reasoning-budget': 512,
        '--no-mmap': false,
        '--port': 1,
        '--alias': 'x',
      },
      {
        refused: Object.keys(MANAGED_LLAMA_FLAGS).filter(
          (k) => MANAGED_LLAMA_FLAGS[k] === 'refused',
        ),
      },
    );
    expect(args).toEqual(['--jinja', '--reasoning-budget', '512', '--alias', 'x']);
    expect(refused).toEqual(['--port']);
  });

  it('categorises by name where the section says nothing', () => {
    expect(categorize('--mmproj', 'common')).toBe('Multimodal');
    expect(categorize('--lora', 'common')).toBe('Adapters');
    expect(categorize('--cache-type-k', 'common')).toBe('Memory & performance');
    expect(categorize('--api-key', 'server')).toBe('Server & API');
  });
});

describe('configFingerprint', () => {
  it('ignores key order and notices a value', () => {
    const a = configFingerprint({ flags: { '--jinja': true, '--ctx-size': 8192 }, rawArgs: [] });
    const b = configFingerprint({ rawArgs: [], flags: { '--ctx-size': 8192, '--jinja': true } });
    const c = configFingerprint({ flags: { '--jinja': true, '--ctx-size': 4096 }, rawArgs: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('argparseDefault', () => {
  it('reads the parenthesised default even when the sentence starts with "Default"', async () => {
    const { argparseDefault } = await import('./engine-flags.js');
    expect(argparseDefault('Default max tokens for generation (default: 32768).')).toBe('32768');
    expect(argparseDefault('KV cache dtype (R15 #300, default: bf16). int8/int4 shrink…')).toBe(
      'bf16',
    );
    expect(argparseDefault('Prefill step size (default: 2048; bench-verified profiles…)')).toBe(
      '2048; bench-verified profiles…',
    );
    expect(argparseDefault('Nothing said here')).toBeUndefined();
  });
});
