import { describe, expect, it } from 'vitest';
import type { GenSurfacePayload } from '../../electron/gen/gen-ipc-contract';
import { finishedOutputs, jobFromPayload, jobIdFromTab, latestPreview } from './gen-stream';
import { genFrameFrom } from './useDenoisePreview';

const MODEL = { id: 'z-image-turbo', label: 'Z-Image Turbo', license: 'apache-2.0' };

function payload(over: Partial<GenSurfacePayload> = {}): GenSurfacePayload {
  return {
    modality: 'image',
    model: MODEL,
    candidates: [],
    status: 'generating',
    ...over,
  };
}

describe('the stream carries what the inline card needs', () => {
  it('names the engine job so Cancel can reach it', () => {
    expect(jobIdFromTab('pi:gen-gen_123_abc')).toBe('gen_123_abc');
    // A stream id in some other shape is still an id, not an error.
    expect(jobIdFromTab('gen_123_abc')).toBe('gen_123_abc');
  });

  it('takes the NEWEST candidate preview, not the first', () => {
    // With n > 1 the engine works candidates in order, so the last preview is
    // the one being made now. Showing candidate 1 while 4 renders is the past.
    const p = payload({
      candidates: [
        { status: 'done', previewSrc: 'pd-file://f/a.png', finalSrc: 'pd-file://f/a.png' },
        { status: 'generating', previewSrc: 'pd-file://f/b.png' },
      ],
    });
    expect(latestPreview(p)).toBe('pd-file://f/b.png');
    expect(latestPreview(payload())).toBeUndefined();
  });

  it('lists only the outputs that actually landed', () => {
    const p = payload({
      candidates: [{ status: 'done', finalSrc: 'pd-file://f/a.wav' }, { status: 'generating' }],
    });
    expect(finishedOutputs(p)).toEqual(['pd-file://f/a.wav']);
  });

  it('derives the card shape from the size the job is rendering at', () => {
    const job = jobFromPayload('pi:gen-j1', payload({ size: { width: 768, height: 512 } }), 100);
    expect(job.aspect).toBeCloseTo(1.5);
    // Absent when the job never said — the card keeps whatever it had, rather
    // than resizing under the reader on the first decoded step.
    expect(jobFromPayload('pi:gen-j1', payload(), 100).aspect).toBeUndefined();
    expect(
      jobFromPayload('pi:gen-j1', payload({ size: { width: 0, height: 0 } }), 100).aspect,
    ).toBeUndefined();
  });

  it('carries the modality, so an audio job never lands in a picture frame', () => {
    expect(jobFromPayload('t', payload({ modality: 'audio' }), 0).modality).toBe('audio');
    expect(jobFromPayload('t', payload({ modality: 'video' }), 0).modality).toBe('video');
  });

  it('keeps the start time it was given, so the clock never restarts', () => {
    const opened = jobFromPayload('t', payload(), 1000);
    const updated = jobFromPayload('t', payload({ status: 'done' }), opened.startedAt);
    expect(updated.startedAt).toBe(1000);
  });
});

describe('a decoded step becomes a frame for the card', () => {
  /*
   * THE URL DOES NOT CHANGE BETWEEN STEPS. mflux writes its stepwise output into
   * one directory and the worker publishes the running composite from it — the
   * SAME FILE, rewritten in place. So `img.src = url` on step 3 assigns the
   * value already there and the card shows step 1 forever. The step number is a
   * frame's real identity, so it is what cache-busts the URL.
   */
  const p = (step: number) =>
    payload({
      candidates: [{ status: 'generating', previewSrc: 'pd-file://f/steps/composite.png' }],
      progress: { candidate: 0, step, total: 8 },
      size: { width: 1024, height: 1024 },
    });

  it('cache-busts on the step so a rewritten file still repaints', () => {
    const a = genFrameFrom(p(1));
    const b = genFrameFrom(p(2));
    expect(a?.dataUri).not.toBe(b?.dataUri);
    expect(b?.dataUri).toContain('pdstep=2');
    expect(b?.step).toBe(2);
    expect(b?.totalSteps).toBe(8);
    expect(b?.width).toBe(1024);
  });

  it('has no frame before the engine has decoded one', () => {
    expect(
      genFrameFrom(payload({ progress: { candidate: 0, step: 1, total: 8 } })),
    ).toBeUndefined();
  });

  it('never makes a picture out of a sound', () => {
    expect(
      genFrameFrom(
        payload({
          modality: 'audio',
          candidates: [{ status: 'generating', previewSrc: 'pd-file://f/x.png' }],
        }),
      ),
    ).toBeUndefined();
  });
});
