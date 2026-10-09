/**
 * THE SVG BEING DRAWN RIGHT NOW, for the card in the thread.
 *
 * The user (2026-09-21): "svgs created with the svg plugin don't show the model
 * streaming the svg into an svg code block that'll render live as drawing".
 * OmniSVG's ids stream out of its llama-server and the app decodes the prefix a
 * few times a second (electron/gen/omnisvg.ts); this holds the latest drawing
 * — the shapes finished so far and an outline of the one under the pen — plus
 * which sample it is, so the card can say "take 2 of 3".
 *
 * ONE DRAWING AT A TIME, the same rule the gen-live store leans on: OmniSVG
 * runs one server for one job. A finished job stays until the next one starts,
 * so the card can settle onto the result rather than blink empty.
 */
import { create } from 'zustand';

export interface SvgLiveState {
  readonly status: 'idle' | 'drawing' | 'done' | 'error';
  /** The drawing so far (markup), or the finished file's markup. */
  readonly svg: string;
  readonly paths: number;
  readonly candidate: number;
  readonly candidates: number;
  readonly prompt?: string;
  /** The files that landed, when done. */
  readonly outputs: readonly {
    readonly path: string;
    readonly svg: string;
    readonly paths: number;
  }[];
  readonly error?: string;
  /** Renderer clock: when the current job's first event arrived. */
  readonly startedAt: number;
  readonly drawing: (p: {
    svg: string;
    paths: number;
    candidate: number;
    candidates: number;
    prompt?: string;
  }) => void;
  readonly done: (
    outputs: readonly { path: string; svg: string; paths: number }[],
    prompt?: string,
  ) => void;
  readonly failed: (error: string, prompt?: string) => void;
  readonly reset: () => void;
}

const IDLE = {
  status: 'idle' as const,
  svg: '',
  paths: 0,
  candidate: 0,
  candidates: 0,
  outputs: [] as SvgLiveState['outputs'],
  startedAt: 0,
};

export const useSvgLive = create<SvgLiveState>((set) => ({
  ...IDLE,
  drawing: (p) =>
    set((s) => ({
      status: 'drawing',
      svg: p.svg,
      paths: p.paths,
      candidate: p.candidate,
      candidates: p.candidates,
      ...(p.prompt === undefined ? {} : { prompt: p.prompt }),
      outputs: [],
      error: undefined,
      // A new job (the previous one finished or failed) restarts the clock.
      startedAt: s.status === 'drawing' ? s.startedAt : Date.now(),
    })),
  done: (outputs, prompt) =>
    set((s) => ({
      status: 'done',
      svg: outputs[0]?.svg ?? s.svg,
      paths: outputs[0]?.paths ?? s.paths,
      outputs,
      ...(prompt === undefined ? {} : { prompt }),
      error: undefined,
    })),
  failed: (error, prompt) =>
    set(() => ({ status: 'error', error, ...(prompt === undefined ? {} : { prompt }) })),
  reset: () => set(() => ({ ...IDLE, error: undefined })),
}));
