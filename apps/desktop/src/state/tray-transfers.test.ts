import { describe, expect, it } from 'vitest';
import type { LlmStatus } from '../../electron/ipc-contract';
import type { LlmDownloadState } from './llm-store';
import {
  elapsedText,
  learnableLoad,
  llmDownloadRow,
  loadFraction,
  loadRow,
  moduleRow,
  nextExpectedMs,
  pairBytes,
  percentText,
  storeDownloadRow,
  transferRows,
} from './tray-transfers';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const status = (over: Partial<LlmStatus>): LlmStatus => ({
  phase: 'idle',
  serverRunning: false,
  baseUrl: null,
  model: null,
  metrics: null,
  downloadedModelIds: [],
  ...over,
});

const download = (over: Partial<LlmDownloadState>): LlmDownloadState =>
  ({
    modelId: 'qwen3.5-4b-mtp',
    file: 'Qwen3.5-4B-Q8_0.gguf',
    received: 1.2 * GIB,
    total: 4.8 * GIB,
    fraction: 0.25,
    paused: false,
    bytesPerSec: null,
    ...over,
  }) as LlmDownloadState;

describe('what a download row says', () => {
  it('writes received over total in the total’s unit', () => {
    expect(pairBytes(4.2 * GIB, 31 * GIB)).toBe('4.2 / 31 GB');
    expect(pairBytes(120 * MIB, 800 * MIB)).toBe('120 / 800 MB');
    expect(pairBytes(0.5 * GIB, 2 * GIB)).toBe('0.5 / 2 GB');
    // No total yet: what has arrived.
    expect(pairBytes(3 * GIB, null)).toBe('3 GB');
  });

  it('prints a floored percentage and a readable elapsed time', () => {
    expect(percentText(0.529)).toBe('52%');
    expect(percentText(1.2)).toBe('100%');
    expect(elapsedText(14_300)).toBe('14 s');
    expect(elapsedText(125_000)).toBe('2 m 05 s');
  });

  it('a model download: the job’s bytes, stoppable, pausable; paused says so', () => {
    const d = download({ jobReceived: 1.1 * GIB, jobTotal: 5.7 * GIB });
    const row = llmDownloadRow(d, 'Qwen3.5 4B');
    expect(row).toMatchObject({
      section: 'downloads',
      title: 'Qwen3.5 4B',
      amount: '1.1 / 5.7 GB',
      cancel: { kind: 'llm-download' },
      pause: { paused: false },
    });
    expect(row.fraction).toBeCloseTo(1.1 / 5.7, 5);
    expect(llmDownloadRow(download({ paused: true }), 'Qwen3.5 4B').amount).toBe('Paused');
  });

  it('says how long is left when the rate is known, and nothing while paused', () => {
    const moving = download({
      jobReceived: 1 * GIB,
      jobTotal: 5 * GIB,
      bytesPerSec: 20 * MIB,
    });
    expect(llmDownloadRow(moving, 'Qwen3.5 4B').note).toMatch(/left$/);
    expect(llmDownloadRow({ ...moving, paused: true }, 'Qwen3.5 4B').note).toBeUndefined();
    expect(llmDownloadRow(download({ bytesPerSec: null }), 'Qwen3.5 4B').note).toBeUndefined();
  });

  it('a repo from the store, and a module install that cannot be stopped', () => {
    const store = storeDownloadRow({
      repo: 'mlx-community/Qwen3.5-4B',
      file: 'model.safetensors',
      fileIndex: 0,
      fileCount: 2,
      received: 2 * GIB,
      total: 4 * GIB,
      fraction: 0.5,
    });
    expect(store).toMatchObject({
      amount: '2 / 4 GB',
      fraction: 0.5,
      cancel: { kind: 'store-download', repo: 'mlx-community/Qwen3.5-4B' },
    });
    const mod = moduleRow({
      id: 'image',
      label: 'Image module',
      blurb: '',
      approxGB: 2.5,
      ready: false,
      installing: true,
      wanted: false,
    } as never);
    expect(mod).toMatchObject({ title: 'Image module', fraction: null, amount: '~2.5 GB' });
    expect(mod.cancel).toBeUndefined();
  });
});

describe('a model load', () => {
  it('walks at the last load’s pace, bends before the end, and never claims done', () => {
    const expected = 10_000;
    let last = -1;
    for (let t = 0; t <= 60_000; t += 250) {
      const f = loadFraction(t, expected) as number;
      expect(f).toBeGreaterThanOrEqual(last);
      expect(f).toBeLessThan(0.95);
      last = f;
    }
    expect(loadFraction(5_000, expected)).toBeCloseTo(0.5, 5);
    // No lurch where the straight part meets the bend.
    const a = loadFraction(6_990, expected) as number;
    const b = loadFraction(7_010, expected) as number;
    expect(b - a).toBeLessThan(0.003);
    // Nothing to go on: the bar sweeps.
    expect(loadFraction(5_000, undefined)).toBeNull();
  });

  it('names the model, says how far, and can be stopped; nothing when not loading', () => {
    const s = status({
      phase: 'starting',
      loading: { modelId: 'qwen3.5-4b-mtp', displayName: 'Qwen3.5 4B', since: 1_000 },
    });
    const row = loadRow(s, 6_000, 10_000);
    expect(row).toMatchObject({
      section: 'loading',
      title: 'Loading Qwen3.5 4B',
      amount: '50%',
      cancel: { kind: 'llm-load' },
    });
    expect(loadRow(s, 6_000, undefined)?.amount).toBe('5 s');
    expect(loadRow(status({ phase: 'ready' }), 6_000, 10_000)).toBeNull();
  });

  it('an engine compile says what it is and does not pretend to know how far', () => {
    const s = status({
      phase: 'starting',
      loading: { modelId: 'k2', displayName: 'K2 Horizon', since: 0 },
      engineBuild: { variantId: 'v', note: 'building' },
    });
    const row = loadRow(s, 90_000, 10_000);
    expect(row).toMatchObject({
      title: 'Building the engine for K2 Horizon',
      fraction: null,
      amount: '1 m 30 s',
    });
  });

  it('learns from an ordinary load only', () => {
    const loading = { modelId: 'm', displayName: 'M', since: 1_000 };
    const before = status({ phase: 'starting', loading });
    const after = status({ phase: 'ready' });
    expect(learnableLoad(before, after, false, 9_000)).toEqual({ modelId: 'm', ms: 8_000 });
    expect(learnableLoad(before, after, true, 9_000)).toBeNull();
    expect(learnableLoad({ ...before, calibrating: true }, after, false, 9_000)).toBeNull();
    expect(learnableLoad(before, status({ phase: 'error' }), false, 9_000)).toBeNull();
    expect(nextExpectedMs(undefined, 8_000)).toBe(8_000);
    expect(nextExpectedMs(10_000, 6_000)).toBe(8_000);
  });
});

describe('the two groups together', () => {
  it('lists downloads first, then the load', () => {
    const rows = transferRows({
      llmDownload: download({}),
      llmName: 'Qwen3.5 4B',
      store: [],
      modules: [],
      status: status({
        phase: 'starting',
        loading: { modelId: 'g', displayName: 'Gemma 4', since: 0 },
      }),
      now: 3_000,
      expectedLoadMs: undefined,
    });
    expect(rows.map((r) => r.section)).toEqual(['downloads', 'loading']);
  });
});
