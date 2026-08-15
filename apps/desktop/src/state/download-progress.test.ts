/**
 * Download progress as the USER reads it — the bar, the ETA, and the promise
 * that a percentage never goes backwards.
 *
 * The regression these lock down: once a model's companions started downloading
 * alongside its weights, the reported fraction was PER FILE. A 13 GB model
 * reached 100%, then the 0.9 GB projector restarted it at 0%. To anyone who had
 * been watching for seven minutes that is a failed download, not a second file.
 */
import { describe, expect, it } from 'vitest';
import {
  downloadEtaSeconds,
  downloadFraction,
  formatEta,
  type LlmDownloadState,
} from './llm-store';

const GB = 1e9;

/** A download mid-flight; overrides express the case under test. */
function state(over: Partial<LlmDownloadState> = {}): LlmDownloadState {
  return {
    modelId: 'qwen3.8-27b-mtp',
    file: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
    received: 6.7 * GB,
    total: 13.44 * GB,
    fraction: 0.5,
    bytesPerSec: 20e6,
    paused: false,
    fileIndex: 0,
    fileCount: 2,
    jobReceived: 6.7 * GB,
    jobTotal: 14.37 * GB,
    ...over,
  };
}

describe('downloadFraction', () => {
  it('follows the whole job, not the file', () => {
    // Half of the 13.44 GB weights is well under half of the 14.37 GB job.
    expect(downloadFraction(state())).toBeCloseTo(6.7 / 14.37, 3);
  });

  it('does NOT snap backwards when the projector starts', () => {
    const weightsDone = state({ received: 13.44 * GB, fraction: 1, jobReceived: 13.44 * GB });
    const projectorStarting = state({
      file: 'mmproj-F16.gguf',
      fileIndex: 1,
      received: 1e6,
      total: 0.93 * GB,
      fraction: 0.001,
      jobReceived: 13.44 * GB + 1e6,
    });
    expect(downloadFraction(weightsDone)).toBeLessThan(1);
    expect(downloadFraction(projectorStarting) ?? 0).toBeGreaterThan(
      downloadFraction(weightsDone) ?? 0,
    );
    // The old behaviour, for contrast: the file fraction really does collapse.
    expect(projectorStarting.fraction).toBeLessThan(weightsDone.fraction ?? 1);
  });

  it('falls back to the file fraction when the job total is unknown', () => {
    expect(downloadFraction(state({ jobTotal: null, fraction: 0.42 }))).toBe(0.42);
    expect(downloadFraction(state({ jobTotal: undefined, fraction: 0.42 }))).toBe(0.42);
  });

  it('stays inside 0..1 even if the numbers disagree', () => {
    const over = downloadFraction(state({ jobReceived: 99 * GB })) ?? 0;
    expect(over).toBe(1);
  });
});

describe('downloadEtaSeconds / formatEta', () => {
  it('estimates from the job remainder at the current rate', () => {
    // 14.37 - 6.7 = 7.67 GB left at 20 MB/s ≈ 383s.
    expect(downloadEtaSeconds(state()) ?? 0).toBeCloseTo(383.5, 0);
  });

  it('is unknown while paused or before a rate is sampled', () => {
    expect(downloadEtaSeconds(state({ paused: true }))).toBeNull();
    expect(downloadEtaSeconds(state({ bytesPerSec: null }))).toBeNull();
    expect(downloadEtaSeconds(state({ bytesPerSec: 0 }))).toBeNull();
  });

  it('formats at the scale a person would say it', () => {
    expect(formatEta(45)).toBe('45s left');
    expect(formatEta(200)).toBe('3m 20s left');
    expect(formatEta(180)).toBe('3m left');
    expect(formatEta(8100)).toBe('2h 15m left');
    expect(formatEta(200_000)).toBe('> 24h left');
  });

  it('renders nothing rather than a fake zero when it cannot know', () => {
    expect(formatEta(null)).toBe('');
    expect(formatEta(0)).toBe('');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe('');
  });
});
