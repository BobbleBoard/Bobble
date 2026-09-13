import { describe, expect, it } from 'vitest';
import {
  benchPrompts,
  chooseProfile,
  hardwareKey,
  median,
  planCandidates,
  profileOf,
  sampleFromTimings,
  summarise,
} from './calibrate.js';

const mac = {
  platform: 'darwin' as const,
  appleSilicon: true,
  installedEngines: [
    'llamacpp',
    'rapid-mlx',
    'dflash-mlx',
    'mlx-dspark',
    'omlx',
    'mlx-lm',
  ] as const,
  ggufPresent: true,
  mtpAvailable: true,
  draftsPresent: ['dflash'] as const,
  mlxPresent: true,
  mlxDraftsPresent: ['dflash'] as const,
  mlxMtpAvailable: true,
};

describe('planCandidates — only what runs offline, llama.cpp first', () => {
  it('lists llama.cpp plain first, then every method whose files are on disk', () => {
    const { candidates, skips } = planCandidates(mac);
    expect(candidates[0]?.id).toBe('llamacpp/none');
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain('llamacpp/mtp');
    expect(ids).toContain('llamacpp/dflash');
    expect(ids).toContain('llamacpp/ngram');
    expect(ids).not.toContain('llamacpp/eagle3');
    // The catalogue is unknown here, so the phrasing is the neutral one.
    expect(skips.find((s) => s.id === 'llamacpp/eagle3')?.reason).toBe(
      'EAGLE-3 drafter not downloaded',
    );
    expect(skips.find((s) => s.id === 'llamacpp/eagle3')?.fix).toBe('fetch');
    expect(ids).toContain('rapid-mlx/none');
    expect(ids).toContain('rapid-mlx/mtp');
    expect(ids).toContain('rapid-mlx/dflash');
    expect(ids).toContain('dflash-mlx/dflash');
    expect(ids).toContain('mlx-dspark/ngram');
    expect(ids).toContain('mlx-dspark/dflash');
    expect(ids).not.toContain('mlx-dspark/dspark');
    expect(ids).toContain('omlx/none');
    expect(ids).toContain('mlx-lm/none');
  });

  it('skips MLX engines that are not installed, or whose weights are missing, and says which', () => {
    const { candidates, skips } = planCandidates({
      ...mac,
      installedEngines: ['llamacpp', 'rapid-mlx'],
      mlxPresent: false,
    });
    expect(candidates.map((c) => c.id)).toEqual([
      'llamacpp/none',
      'llamacpp/mtp',
      'llamacpp/dflash',
      'llamacpp/ngram',
    ]);
    expect(skips.find((s) => s.id === 'rapid-mlx/none')?.reason).toBe('MLX weights not downloaded');
    // Without an installable list the engine is only known to be absent.
    expect(skips.find((s) => s.id === 'omlx/none')?.reason).toBe('engine not available here');
    expect(skips.find((s) => s.id === 'omlx/none')?.fix).toBe('none');
  });

  it('says what would fix a skip when the catalogue and the installable engines are known', () => {
    const { skips } = planCandidates({
      ...mac,
      installedEngines: ['llamacpp', 'rapid-mlx'],
      mlxPresent: false,
      draftsPresent: [],
      catalogued: { drafts: ['dflash'], mlx: true, mlxDrafts: ['dflash'], mlxMtp: true },
      installableEngines: ['omlx', 'mlx-lm'],
    });
    const by = (id: string) => skips.find((s) => s.id === id);
    // A drafter the catalogue names is a download away; one it does not is not.
    expect(by('llamacpp/dflash')).toMatchObject({
      reason: 'DFlash drafter not downloaded yet',
      fix: 'fetch',
    });
    expect(by('llamacpp/eagle3')).toMatchObject({
      reason: 'no EAGLE-3 drafter published for this model',
      fix: 'none',
    });
    expect(by('llamacpp/dspark')).toMatchObject({
      reason: 'no DSpark drafter published for this model',
      fix: 'none',
    });
    // Installed engine, twin catalogued but absent → fetch; installable engine → install;
    // an engine this machine cannot run → none.
    expect(by('rapid-mlx/none')).toMatchObject({
      reason: 'MLX weights not downloaded yet',
      fix: 'fetch',
    });
    expect(by('omlx/none')).toMatchObject({ reason: 'engine not installed', fix: 'install' });
    expect(by('dflash-mlx/none')).toMatchObject({
      reason: 'engine not available here',
      fix: 'none',
    });
  });

  it('plans nothing MLX on an Intel Mac or Linux, and vLLM only where installed', () => {
    const linux = planCandidates({
      ...mac,
      platform: 'linux',
      appleSilicon: false,
      installedEngines: ['llamacpp', 'vllm'],
      mlxPresent: false,
    });
    expect(linux.candidates.map((c) => c.id)).toEqual([
      'llamacpp/none',
      'llamacpp/mtp',
      'llamacpp/dflash',
      'llamacpp/ngram',
      'vllm/none',
    ]);
  });

  it('a model with no GGUF has no llama.cpp rows, and says so', () => {
    const { candidates, skips } = planCandidates({ ...mac, ggufPresent: false });
    expect(candidates.some((c) => c.engine === 'llamacpp')).toBe(false);
    expect(skips.find((s) => s.id === 'llamacpp/none')?.reason).toBe('GGUF not downloaded');
  });
});

describe('measurement math', () => {
  it('turns stream timings into prefill and decode rates', () => {
    const s = sampleFromTimings({
      sentAt: 1000,
      firstTokenAt: 1500,
      lastTokenAt: 3500,
      promptTokens: 1000,
      completionTokens: 101,
    });
    expect(s.prefillTps).toBeCloseTo(2000, 5);
    expect(s.decodeTps).toBeCloseTo(50, 5);
    expect(s.ttftMs).toBe(500);
  });

  it('summarises by median and keeps a failure honest', () => {
    const a = sampleFromTimings({
      sentAt: 0,
      firstTokenAt: 100,
      lastTokenAt: 1100,
      promptTokens: 100,
      completionTokens: 51,
    });
    const b = sampleFromTimings({
      sentAt: 0,
      firstTokenAt: 200,
      lastTokenAt: 1200,
      promptTokens: 100,
      completionTokens: 101,
    });
    const c = sampleFromTimings({
      sentAt: 0,
      firstTokenAt: 300,
      lastTokenAt: 1300,
      promptTokens: 100,
      completionTokens: 201,
    });
    const r = summarise('llamacpp/none', [a, b, c], 1234);
    expect(r.ok).toBe(true);
    expect(r.decodeTps).toBe(100);
    expect(r.ttftMs).toBe(200);
    expect(r.startupMs).toBe(1234);
    const failed = summarise('rapid-mlx/none', [], 0, 'server never became healthy');
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/healthy/);
    expect(median([])).toBe(0);
    expect(median([3, 1, 2, 4])).toBe(2.5);
  });
});

describe('chooseProfile — a winner has to beat the baseline clearly', () => {
  const r = (id: string, decode: number, prefill: number, ok = true) =>
    ({
      id,
      ok,
      prefillTps: prefill,
      decodeTps: decode,
      ttftMs: 100,
      startupMs: 1000,
      samples: [],
      ...(ok ? {} : { error: 'boom' }),
    }) as const;

  it('scores against llama.cpp plain and picks the best clear win', () => {
    const { ranked, chosen, baseline } = chooseProfile([
      r('llamacpp/none', 40, 1500),
      r('llamacpp/mtp', 62, 1450),
      r('rapid-mlx/none', 45, 2000),
      r('dflash-mlx/dflash', 0, 0, false),
    ]);
    expect(baseline?.id).toBe('llamacpp/none');
    expect(ranked[0]?.id).toBe('llamacpp/mtp');
    expect(ranked[0]?.score).toBeCloseTo(0.6 * (62 / 40) + 0.4 * (1450 / 1500), 5);
    expect(chosen?.id).toBe('llamacpp/mtp');
    expect(ranked[ranked.length - 1]?.id).toBe('dflash-mlx/dflash');
    expect(ranked[ranked.length - 1]?.error).toBe('boom');
  });

  it('keeps the baseline when the best is within the noise margin', () => {
    const { chosen } = chooseProfile([r('llamacpp/none', 40, 1500), r('llamacpp/ngram', 41, 1500)]);
    expect(chosen?.id).toBe('llamacpp/none');
  });

  it('falls back to the first working result when llama.cpp itself failed', () => {
    const { chosen, baseline } = chooseProfile([
      r('llamacpp/none', 0, 0, false),
      r('mlx-lm/none', 30, 900),
    ]);
    expect(baseline?.id).toBe('mlx-lm/none');
    expect(chosen?.id).toBe('mlx-lm/none');
  });

  it('chooses nothing when nothing ran', () => {
    expect(chooseProfile([r('llamacpp/none', 0, 0, false)]).chosen).toBeNull();
  });
});

describe('keys and prompts', () => {
  it('reads a profile back from its id and rejects nonsense', () => {
    expect(profileOf('mlx-dspark/dspark')).toEqual({ engine: 'mlx-dspark', spec: 'dspark' });
    expect(profileOf('nope/none')).toBeNull();
    expect(profileOf('llamacpp/turbo')).toBeNull();
  });

  it('keys a calibration on the machine, so a different Mac starts over', () => {
    expect(
      hardwareKey({ platform: 'darwin', arch: 'arm64', chip: 'Apple M5 Pro', totalRamGB: 24 }),
    ).toBe('darwin-arm64-Apple_M5_Pro-24GB');
  });

  it('uses the same two prompt shapes every time: a chat-sized one and a long one', () => {
    const [chat, long] = benchPrompts();
    expect(chat?.name).toBe('chat');
    expect(long?.name).toBe('long');
    expect((long?.system.length ?? 0) / (chat?.system.length ?? 1)).toBeGreaterThan(5);
  });
});
