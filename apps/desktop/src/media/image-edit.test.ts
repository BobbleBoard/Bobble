import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDIT_STRENGTHS, editSize, jobIdOfTab, versionLabel } from './image-edit';
import {
  finishReveal,
  runEdit,
  selectVersion,
  sessionOf,
  stopEdit,
  useImageEdits,
} from './image-edits-store';

describe('editSize', () => {
  it("asks for the picture's own shape, on the 16px grid", () => {
    expect(editSize(1024, 1024)).toBe('1024x1024');
    expect(editSize(1024, 576)).toBe('1024x576');
    // 1000 is not on the grid; 1008 is the nearest multiple of 16.
    expect(editSize(1000, 750)).toBe('1008x752');
  });

  it("keeps the long edge inside the studio's sizes", () => {
    expect(editSize(4032, 3024)).toBe('1536x1152');
    expect(editSize(256, 128)).toBe('512x256');
  });

  it('falls back to the default square for a picture with no size yet', () => {
    expect(editSize(0, 0)).toBe('1024x1024');
    expect(editSize(Number.NaN, 512)).toBe('1024x1024');
  });
});

describe('the edit vocabulary', () => {
  it('is the studio three, with Medium in the middle', () => {
    expect(EDIT_STRENGTHS.map((s) => s.value)).toEqual([0.3, 0.6, 0.85]);
  });

  it('labels a version with the words that made it, on one line', () => {
    expect(versionLabel('  make it\n golden hour ')).toBe('make it golden hour');
    expect(versionLabel('   ')).toBe('Edit');
  });

  it("reads main's job id out of a stream id", () => {
    expect(jobIdOfTab('pi:gen-gen_1_abc')).toBe('gen_1_abc');
    expect(jobIdOfTab('other')).toBeNull();
  });
});

type Listener = (e: { tabId: string; payload: unknown }) => void;

describe('an edit run', () => {
  const original = { path: '/g/fox/fox.png', name: 'fox.png', label: 'Original' };
  let listeners: Record<string, Listener[]>;
  let invoke: ReturnType<typeof vi.fn>;
  let resolveGenerate: (r: unknown) => void;

  beforeEach(() => {
    listeners = {};
    useImageEdits.setState({ sessions: {} });
    invoke = vi.fn((channel: string) => {
      if (channel === 'gen:generate') {
        return new Promise((r) => {
          resolveGenerate = r;
        });
      }
      return Promise.resolve({ canceled: true });
    });
    (globalThis as unknown as { window: unknown }).window = {
      piDesktop: {
        invoke,
        onEvent: (channel: string, fn: Listener) => {
          listeners[channel] = [...(listeners[channel] ?? []), fn];
          return () => {
            listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== fn);
          };
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  const emit = (channel: string, tabId: string, payload: unknown): void => {
    for (const fn of listeners[channel] ?? []) fn({ tabId, payload });
  };
  const box = { aspect: 1, width: 600, height: 600 };
  /** The request id this edit sent — main echoes it on its job's events. */
  const sentRequestId = (): string =>
    (invoke.mock.calls.find((c) => c[0] === 'gen:generate')?.[1] as { requestId: string })
      .requestId;

  it('edits the picture on screen, follows its own progress, and lands as a new version', async () => {
    const done = runEdit(original, {
      instruction: 'make it golden hour',
      strength: 0.6,
      size: '1024x1024',
      box,
    });
    expect(invoke).toHaveBeenCalledWith('gen:generate', {
      kind: 'image',
      prompt: 'make it golden hour',
      inputImage: '/g/fox/fox.png',
      strength: 0.6,
      size: '1024x1024',
      n: 1,
      requestId: expect.stringMatching(/^viewer-edit-/),
    });
    const requestId = sentRequestId();
    expect(sessionOf(original).job?.requestId).toBe(requestId);
    /* Someone else's job streaming at the same time is not this edit — not a
       chat's (no id), and not another request with the very same words. */
    emit('gen:open', 'pi:gen-chat', { modality: 'image', prompt: 'make it golden hour' });
    emit('gen:update', 'pi:gen-other', {
      modality: 'image',
      prompt: 'make it golden hour',
      requestId: 'studio-image-x-1',
      progress: { candidate: 0, step: 20, total: 24 },
    });
    expect(sessionOf(original).job?.jobId).toBeUndefined();
    emit('gen:open', 'pi:gen-mine', { modality: 'image', prompt: 'x', requestId });
    emit('gen:update', 'pi:gen-mine', {
      modality: 'image',
      prompt: 'x',
      requestId,
      progress: { candidate: 0, step: 6, total: 15 },
    });
    expect(sessionOf(original).job).toMatchObject({ jobId: 'mine', step: 6, total: 15 });

    resolveGenerate({ jobId: 'mine', outputs: [{ path: '/g/make-it/out.png' }] });
    await done;
    const landed = sessionOf(original);
    // In the history at once, on the stage after the reveal.
    expect(landed.versions.map((v) => v.label)).toEqual(['Original', 'make it golden hour']);
    expect(landed.index).toBe(0);
    expect(landed.job?.result?.path).toBe('/g/make-it/out.png');
    finishReveal(original);
    expect(sessionOf(original)).toMatchObject({ index: 1, job: null });
    // The listeners are gone with the run.
    expect(listeners['gen:open']).toEqual([]);
  });

  it('edits whichever version is on screen', async () => {
    useImageEdits.setState({
      sessions: {
        [original.path]: {
          versions: [original, { path: '/g/a.png', name: 'a.png', label: 'first' }],
          index: 0,
          job: null,
          error: null,
        },
      },
    });
    selectVersion(original, 1);
    void runEdit(original, { instruction: 'again', strength: 0.3, size: '512x512', box });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({ inputImage: '/g/a.png', strength: 0.3 });
  });

  it('says why when the edit fails', async () => {
    const done = runEdit(original, { instruction: 'x', strength: 0.6, size: '512x512', box });
    resolveGenerate({ jobId: '', outputs: [], error: 'the image module is not installed' });
    await done;
    expect(sessionOf(original)).toMatchObject({
      job: null,
      error: 'the image module is not installed',
    });
  });

  it('stops quietly: a stopped edit is not an error', async () => {
    const done = runEdit(original, { instruction: 'x', strength: 0.6, size: '512x512', box });
    emit('gen:open', 'pi:gen-j1', { modality: 'image', prompt: 'x', requestId: sentRequestId() });
    stopEdit(original);
    expect(invoke).toHaveBeenCalledWith('gen:cancel', { jobId: 'j1' });
    resolveGenerate({ jobId: '', outputs: [], error: 'canceled' });
    await done;
    expect(sessionOf(original)).toMatchObject({ job: null, error: null });
  });

  it('runs one edit at a time per picture', () => {
    void runEdit(original, { instruction: 'one', strength: 0.6, size: '512x512', box });
    void runEdit(original, { instruction: 'two', strength: 0.6, size: '512x512', box });
    expect(invoke.mock.calls.filter((c) => c[0] === 'gen:generate')).toHaveLength(1);
  });
});
