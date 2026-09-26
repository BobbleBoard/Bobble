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

describe('rapid-mlx vision lane (the user 2026-09-23: vision on by default)', () => {
  it('asks for the vision lane and carries no speculative flags — that lane does not honour them', () => {
    const l = assembleEngineLaunch(
      { engine: 'rapid-mlx', spec: 'none' },
      {
        command: '/v/bin/rapid-mlx',
        modelDir: '/m/qwen',
        servedModelId: 'q@rapid-mlx',
        host: '127.0.0.1',
        port: 9000,
        draftDir: '/m/mtp',
        vision: true,
      },
    );
    expect(l.args).toContain('--mllm');
    expect(l.args).not.toContain('--speculative-config');
    expect(l.args).not.toContain('--no-spec-decode');
  });

  /* MEASURED 2026-09-25: a presented page came back as a picture in a
     12,041-token conversation and rapid-mlx refused it — its vision budget
     (8,192 by default) is for the whole prompt, not the picture. */
  it('lets a picture ride in a conversation as long as the context the app runs', () => {
    const vision = assembleEngineLaunch(
      { engine: 'rapid-mlx', spec: 'none' },
      { ...base, vision: true, contextWindow: 32_768 },
    );
    const at = vision.args.indexOf('--vision-prefill-token-budget');
    expect(at).toBeGreaterThan(-1);
    expect(vision.args[at + 1]).toBe('32768');
    // The text lane has no such budget, and nothing is invented without a window.
    const text = assembleEngineLaunch(
      { engine: 'rapid-mlx', spec: 'none' },
      { ...base, contextWindow: 32_768 },
    );
    expect(text.args).not.toContain('--vision-prefill-token-budget');
    const unknown = assembleEngineLaunch(
      { engine: 'rapid-mlx', spec: 'none' },
      { ...base, vision: true },
    );
    expect(unknown.args).not.toContain('--vision-prefill-token-budget');
  });
});
