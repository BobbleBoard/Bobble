// @vitest-environment jsdom
/**
 * A CHAT CARD SHOWS ITS OWN JOB'S FRAMES, AND NO ONE ELSE'S.
 *
 * The thread's generating card takes the engine's decoded frames as they land
 * (`live`): a picture's denoise steps, a clip's rendered frames. It used to take
 * EVERY frame from both streams with one high-water mark, on the premise that
 * only one job ever runs — which stopped being true (review of the 2026-09-23
 * wave, renderer-ui): a HyperFrames render is a light job that runs beside
 * others, gen3d's image jobs are outside the queue altogether, and a studio,
 * a subagent or a chat in the background can each be generating at the same
 * moment. So a picture's card swept away onto a motion-graphics frame and then
 * dropped its own steps (all below the clip's frame numbers), and a clip's card
 * showed someone else's denoising.
 *
 * Frames come through a stand-in bridge; which chat started which job comes
 * from the app's own registry (state/chat-jobs), fed as main feeds it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteAgentJob } from '../state/chat-jobs';
import { usePiStore } from '../state/pi-slice';
import { type PendingKind, PendingMediaCard } from './PendingMediaCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const handlers = new Map<string, Set<(payload: unknown) => void>>();
function emit(channel: string, payload: unknown): void {
  act(() => {
    for (const fn of handlers.get(channel) ?? []) fn(payload);
  });
}

const CHAT = '/s/chat.jsonl';
const OTHER_CHAT = '/s/other.jsonl';

/** A gen3d image job's decoded step (the chat's generate_image / edit_image). */
function gen3dStep(jobId: string, step: number, tag: string): void {
  emit('gen3d:job', {
    jobId,
    stage: 'image',
    message: '',
    stagePercent: 0,
    overallPercent: 0,
    done: false,
    preview: {
      dataUri: `data:image/png;base64,${tag}`,
      step,
      totalSteps: 8,
      width: 512,
      height: 512,
    },
  });
}
/** A gen-service frame: an mflux step or a HyperFrames frame, on disk. */
function genFrame(
  jobId: string,
  modality: 'image' | 'video',
  step: number,
  extra: Record<string, unknown> = {},
): void {
  emit('gen:update', {
    tabId: `pi:gen-${jobId}`,
    payload: {
      modality,
      model: { id: 'm', label: 'M', license: 'MIT' },
      candidates: [{ status: 'generating', previewSrc: `pd-file://f/tmp/${jobId}/frame.png` }],
      progress: { candidate: 0, step, total: 121 },
      status: 'generating',
      ...extra,
    },
  });
}

let root: Root | null = null;
function mount(kind: PendingKind): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PendingMediaCard kind={kind} live progressKey="call-1" />));
  return container;
}
const shown = (el: HTMLElement): string | null =>
  el.querySelector('[data-testid="pending-preview"]')?.getAttribute('src') ?? null;

beforeEach(() => {
  handlers.clear();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(window, 'piDesktop', {
    configurable: true,
    value: {
      invoke: async () => ({}),
      onEvent: (channel: string, fn: (payload: unknown) => void) => {
        const set = handlers.get(channel) ?? new Set();
        set.add(fn);
        handlers.set(channel, set);
        return () => set.delete(fn);
      },
    },
  });
  usePiStore.setState({ session: { sessionFile: CHAT }, bgRun: null });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a picture's card", () => {
  it('never takes a clip’s frame — a HyperFrames render elsewhere', () => {
    const card = mount('image');
    noteAgentJob('gen3d', 'img-1', undefined);
    genFrame('hf-studio', 'video', 100, { requestId: 'studio-7' });
    noteAgentJob('gen', 'hf-sub', 'sub-1');
    genFrame('hf-sub', 'video', 101);
    expect(shown(card)).toBeNull();
  });

  it('still shows its own steps after a clip’s frame numbered far past them', () => {
    const card = mount('image');
    noteAgentJob('gen3d', 'img-1', undefined);
    genFrame('hf-studio', 'video', 100, { requestId: 'studio-7' });
    gen3dStep('img-1', 3, 'OWN3');
    expect(shown(card)).toBe('data:image/png;base64,OWN3');
  });

  it('never takes a studio’s picture, on either engine', () => {
    const card = mount('image');
    genFrame('studio-img', 'image', 2, { requestId: 'studio-8' });
    // The 3D studio's own image stage: a gen3d job no agent announced.
    gen3dStep('g3d-studio', 2, 'STUDIO');
    expect(shown(card)).toBeNull();
  });

  it('never takes the picture of a chat running in the background', () => {
    const card = mount('image');
    usePiStore.setState({ bgRun: { sessionFile: OTHER_CHAT, streaming: true } } as never);
    noteAgentJob('gen3d', 'img-bg', undefined);
    usePiStore.setState({ bgRun: null });
    gen3dStep('img-bg', 2, 'BG');
    expect(shown(card)).toBeNull();
  });

  it('follows one job: a second job of its kind in the same chat does not cut in', () => {
    const card = mount('image');
    noteAgentJob('gen3d', 'img-1', undefined);
    noteAgentJob('gen', 'img-2', 'sub-1');
    gen3dStep('img-1', 2, 'A2');
    genFrame('img-2', 'image', 5);
    gen3dStep('img-1', 3, 'A3');
    expect(shown(card)).toBe('data:image/png;base64,A3');
  });
});

describe("a clip's card", () => {
  it('never takes a picture’s denoise steps', () => {
    const card = mount('video');
    noteAgentJob('gen3d', 'img-1', undefined);
    gen3dStep('img-1', 2, 'PIC');
    expect(shown(card)).toBeNull();
  });

  it('shows its own clip’s frames as they are drawn', () => {
    const card = mount('video');
    noteAgentJob('gen', 'hf-1', undefined);
    genFrame('hf-1', 'video', 12);
    expect(shown(card)).toBe('pd-file://f/tmp/hf-1/frame.png?pdstep=12');
  });
});
