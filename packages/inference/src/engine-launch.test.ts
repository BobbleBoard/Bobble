import { describe, expect, it } from 'vitest';
import { assembleEngineLaunch } from './engine-launch.js';

const base = {
  command: '/venv/bin/tool',
  modelDir: '/store/text/mlx-community__qwen3.5-4b-mlx-8bit',
  servedModelId: 'qwen3.5-4b-mtp',
  host: '127.0.0.1',
  port: 5001,
  draftDir: '/store/text/z-lab__qwen3.5-4b-dflash',
  modelRoot: '/store/text',
};

describe('assembleEngineLaunch — one argv per (engine, spec), local paths only', () => {
  it('rapid-mlx: plain turns auto speculation OFF, mtp/dflash ask for it by config', () => {
    const plain = assembleEngineLaunch({ engine: 'rapid-mlx', spec: 'none' }, base);
    expect(plain.args).toEqual([
      'serve',
      base.modelDir,
      '--host',
      '127.0.0.1',
      '--port',
      '5001',
      '--served-model-name',
      'qwen3.5-4b-mtp',
      '--no-spec-decode',
    ]);
    expect(plain.healthPath).toBe('/v1/models');
    const mtp = assembleEngineLaunch({ engine: 'rapid-mlx', spec: 'mtp' }, base);
    expect(mtp.args.slice(-2)).toEqual([
      '--speculative-config',
      `{"method":"mtp","num_speculative_tokens":3,"model":"${base.draftDir}"}`,
    ]);
    // A twin that kept its own heads needs no sidecar.
    const embedded = assembleEngineLaunch(
      { engine: 'rapid-mlx', spec: 'mtp' },
      { ...base, draftDir: undefined },
    );
    expect(embedded.args.at(-1)).toBe('{"method":"mtp","num_speculative_tokens":3}');
    const dflash = assembleEngineLaunch({ engine: 'rapid-mlx', spec: 'dflash' }, base);
    expect(dflash.args.at(-1)).toBe(`{"method":"dflash","model":"${base.draftDir}"}`);
  });

  it('dflash-mlx needs its drafter and says so when it is missing', () => {
    const ok = assembleEngineLaunch({ engine: 'dflash-mlx', spec: 'dflash' }, base);
    expect(ok.args).toEqual([
      'serve',
      '--model',
      base.modelDir,
      '--draft-model',
      base.draftDir,
      '--host',
      '127.0.0.1',
      '--port',
      '5001',
    ]);
    expect(ok.servedModelId).toBe(base.modelDir);
    expect(() =>
      assembleEngineLaunch(
        { engine: 'dflash-mlx', spec: 'dflash' },
        { ...base, draftDir: undefined },
      ),
    ).toThrow(/drafter/);
  });

  it('mlx-dspark maps specs onto its modes and only attaches a drafter to the drafted ones', () => {
    const lookup = assembleEngineLaunch({ engine: 'mlx-dspark', spec: 'ngram' }, base);
    expect(lookup.args).toContain('lookup');
    expect(lookup.args).not.toContain('--drafter');
    const dspark = assembleEngineLaunch({ engine: 'mlx-dspark', spec: 'dspark' }, base);
    expect(dspark.args.slice(0, 7)).toEqual([
      'serve',
      '--model',
      base.modelDir,
      '--mode',
      'dspark',
      '--drafter',
      base.draftDir,
    ]);
    expect(assembleEngineLaunch({ engine: 'mlx-dspark', spec: 'none' }, base).args).toContain(
      'baseline',
    );
  });

  it('omlx serves a directory of models and names ours after its folder', () => {
    const l = assembleEngineLaunch({ engine: 'omlx', spec: 'none' }, base);
    expect(l.args).toEqual([
      'serve',
      '--model-dir',
      '/store/text',
      '--host',
      '127.0.0.1',
      '--port',
      '5001',
    ]);
    expect(l.servedModelId).toBe('qwen3.5-4b-mtp');
    expect(() =>
      assembleEngineLaunch({ engine: 'omlx', spec: 'none' }, { ...base, modelRoot: undefined }),
    ).toThrow(/root/);
  });

  it('mlx-lm and vllm take the local directory, never a hub id', () => {
    expect(assembleEngineLaunch({ engine: 'mlx-lm', spec: 'none' }, base).args).toEqual([
      '--model',
      base.modelDir,
      '--host',
      '127.0.0.1',
      '--port',
      '5001',
    ]);
    expect(assembleEngineLaunch({ engine: 'vllm', spec: 'none' }, base).args).toEqual([
      'serve',
      base.modelDir,
      '--host',
      '127.0.0.1',
      '--port',
      '5001',
      '--served-model-name',
      'qwen3.5-4b-mtp',
    ]);
  });
});
