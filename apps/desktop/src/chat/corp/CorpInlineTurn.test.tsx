// @vitest-environment jsdom
/**
 * CorpInlineTurn — the corp run as a normal in-chat assistant turn.
 *
 * Mounted with the repo's plain react-dom + act() pattern (the same helper
 * packages/canvas/src/test-utils.tsx uses — no separate testing library in
 * this repo). States covered:
 *
 *  A. collapsed: the "Waiting for N of M tasks to finish · K in progress"
 *     shimmer label + the honest progressbar at done/total.
 *  B. expanded: one row per org-chart node, active rows on top, leads reading
 *     "waiting for other subagents to finish", spinners only on working rows.
 *  C. a row expanded: fetchTranscript(nodeId) is called and the shared
 *     CorpWorkerFeed renders the transcript inline; one row open at a time.
 *  Done: the settled "Delivered …" row (no shimmer) and the peek button
 *     rendered ONLY when peekAvailable.
 */
import {
  buildMockCorpRunScript,
  CanvasProvider,
  initialSituation,
  MOCK_TASK_ID,
  reduceSituation,
  type SituationState,
} from '@pi-desktop/canvas';
import type {
  ChecklistItem,
  CoordinationEvent,
  OrgChartView,
  WorkerTranscriptView,
} from '@pi-desktop/coordination';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useChildAgentStore } from '../../state/child-agent-store';
import { CorpInlineTurn } from './CorpInlineTurn';

// React's act() warns unless this flag is set in a test environment.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface RenderResult {
  container: HTMLElement;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

/** Mount a React node into a jsdom container, flushing effects via act(). */
async function render(node: ReactNode): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    async rerender(next) {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Click an element and flush the resulting React work. */
async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('click: element not found');
  await act(async () => {
    element.click();
  });
}

/** Flush pending microtasks (resolved fetch promises) through act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function foldEvents(events: readonly CoordinationEvent[], taskId = 't1'): SituationState {
  let state = initialSituation(taskId);
  for (const event of events) state = reduceSituation(state, event);
  return state;
}

/** A mid-dispatch chart: leads coordinating, one builder live, the rest in
 * every other state — deterministic counts for exact label assertions. */
const CHART: OrgChartView = {
  taskId: 't1',
  nodes: [
    { id: 'ceo', role: 'ceo', name: 'Pi', state: 'working' },
    { id: 'mgr', role: 'manager', name: 'Build plan', parentId: 'ceo', state: 'working' },
    { id: 'eng-done', role: 'engineer', name: 'Game loop', parentId: 'mgr', state: 'done' },
    {
      id: 'eng-live',
      role: 'engineer',
      name: 'Emitter',
      parentId: 'mgr',
      state: 'working',
      currentAction: 'writing emitter.ts',
    },
    { id: 'eng-idle', role: 'engineer', name: 'HUD', parentId: 'mgr', state: 'idle' },
    { id: 'eng-gone', role: 'engineer', name: 'Docs', parentId: 'mgr', state: 'retired' },
  ],
  edges: [],
};

const ITEMS: readonly ChecklistItem[] = [
  { id: 'c1', label: 'Renderer core', state: 'done' },
  { id: 'c2', label: 'Game loop', state: 'done' },
  { id: 'c3', label: 'Particle emitter', state: 'in-progress' },
  { id: 'c4', label: 'HUD', state: 'queued' },
  { id: 'c5', label: 'Docs', state: 'queued' },
];

/** 2 of 5 tasks done; ceo + mgr + one engineer working (workingCount = 3). */
const RUNNING_STATE = foldEvents([
  { type: 'status', status: 'working' },
  { type: 'org-chart', chart: CHART },
  { type: 'checklist', items: ITEMS },
]);

/** The full scripted mock run folded to its terminal state (48 tasks, done). */
const DONE_STATE = (() => {
  let state = initialSituation(MOCK_TASK_ID);
  for (const timed of buildMockCorpRunScript()) state = reduceSituation(state, timed.event);
  return state;
})();

const EMITTER_TRANSCRIPT: WorkerTranscriptView = {
  nodeId: 'eng-live',
  role: 'engineer',
  briefing: {
    workerName: 'Emitter',
    roleLine: 'Builder · Core Engine',
    title: 'Build the particle emitter',
    goal: 'Deliver src/engine/emitter.ts against its contract.',
    deliverables: ['src/engine/emitter.ts'],
  },
  lines: [
    { at: 0, kind: 'message', text: 'Starting on the emitter now.' },
    { at: 1200, kind: 'tool-call', text: 'read', label: 'Reading', detail: 'src/engine/state.ts' },
  ],
  currentAction: 'writing emitter.ts',
};

const fetchNone = (): Promise<WorkerTranscriptView | null> => Promise.resolve(null);

// ---------------------------------------------------------------------------

describe('CorpInlineTurn — State A (collapsed)', () => {
  it('shows the waiting label with live counts and an honest progressbar', async () => {
    const { container, unmount } = await render(
      <CorpInlineTurn
        taskId="t1"
        state={RUNNING_STATE}
        fetchTranscript={fetchNone}
        peekAvailable={false}
      />,
    );
    expect(container.textContent).toContain('Waiting for 3 of 5 tasks to finish · 3 in progress');
    // The leading label shimmers while running.
    expect(container.querySelector('.pd-corpturn-summary .pd-shimmer')).not.toBeNull();
    // The progress rail is filled to done/total (2/5).
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuenow')).toBe('2');
    expect(bar?.getAttribute('aria-valuemax')).toBe('5');
    const fill = container.querySelector('.pd-corpturn-rail-fill') as HTMLElement;
    expect(fill.style.width).toBe('40%');
    // Collapsed by default: no subagent rows, and no peek affordance mid-run.
    expect(container.querySelector('[data-testid="corp-inline-rows"]')).toBeNull();
    expect(container.querySelector('[data-testid="corp-inline-peek"]')).toBeNull();
    await unmount();
  });
});

describe('CorpInlineTurn — State B (expanded)', () => {
  it('expands to per-node rows: active on top, honest status lines, spinners only while working', async () => {
    const { container, unmount } = await render(
      <CorpInlineTurn
        taskId="t1"
        state={RUNNING_STATE}
        fetchTranscript={fetchNone}
        peekAvailable={false}
      />,
    );
    await click(container.querySelector('[data-testid="corp-inline-summary"]'));

    const rows = [...container.querySelectorAll('.pd-corpturn-row')];
    expect(rows).toHaveLength(6);
    // Active rows on top (chart order within a rank), settled ones at the bottom.
    expect(rows.map((r) => r.getAttribute('data-node-id'))).toEqual([
      'ceo',
      'mgr',
      'eng-live',
      'eng-idle',
      'eng-done',
      'eng-gone',
    ]);

    const statusOf = (id: string) =>
      container.querySelector(`[data-node-id="${id}"] .pd-corpturn-row-status`)?.textContent;
    // Leads that are working wait on their team; a builder shows its action.
    expect(statusOf('ceo')).toBe('waiting for other subagents to finish');
    expect(statusOf('mgr')).toBe('waiting for other subagents to finish');
    expect(statusOf('eng-live')).toBe('writing emitter.ts');
    expect(statusOf('eng-idle')).toBe('queued');
    expect(statusOf('eng-done')).toBe('done');
    expect(statusOf('eng-gone')).toBe('stopped');

    // Spinner ONLY on the three working rows; the rail is still there.
    expect(container.querySelectorAll('.pd-corpturn-row .pd-loader')).toHaveLength(3);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    await unmount();
  });
});

describe('CorpInlineTurn — clicking a row selects that agent', () => {
  /*
   * This used to expand a small transcript feed INSIDE the panel, while the
   * sidebar's row for the same agent opened it as a full chat. Two viewers, two
   * selections, neither aware of the other. the user: "the buttons in the situation
   * room to check on a subagent and the buttons in the left sidebar showing
   * subagents as 'subchats' don't do the same thing?? why don't they?"
   *
   * One selection now, in the child-agent store, keyed `corp:<nodeId>` — the id
   * the bridge already mirrors every role under. Both places drive it and both
   * reflect it.
   */
  it('drives the same child selection the sidebar does', async () => {
    useChildAgentStore.getState().setViewedChild(null);
    const { container, unmount } = await render(
      <CanvasProvider>
        <CorpInlineTurn taskId="t1" state={RUNNING_STATE} peekAvailable={false} />
      </CanvasProvider>,
    );
    await click(container.querySelector('[data-testid="corp-inline-summary"]'));
    await click(container.querySelector('[data-node-id="eng-live"]'));
    await flush();

    expect(useChildAgentStore.getState().viewedChildId).toBe('corp:eng-live');
    expect(container.querySelector('[data-node-id="eng-live"]')?.getAttribute('data-selected')).toBe(
      'true',
    );

    // Selecting another moves the selection; it never opens a second viewer.
    await click(container.querySelector('[data-node-id="mgr"]'));
    await flush();
    expect(useChildAgentStore.getState().viewedChildId).toBe('corp:mgr');
    expect(container.querySelectorAll('[data-testid="corp-inline-feed"]')).toHaveLength(0);
    await unmount();
  });
});

describe('CorpInlineTurn — done state', () => {
  it('settles to the Delivered row (no shimmer, no spinner), full rail', async () => {
    expect(DONE_STATE.status).toBe('done');
    const { container, unmount } = await render(
      <CorpInlineTurn
        taskId={MOCK_TASK_ID}
        state={DONE_STATE}
        fetchTranscript={fetchNone}
        peekAvailable={false}
      />,
    );
    expect(container.textContent).toContain(
      `Delivered 48 tasks with a team of ${DONE_STATE.chart.nodes.length}`,
    );
    expect(container.querySelector('.pd-corpturn-summary .pd-shimmer')).toBeNull();
    expect(container.querySelector('.pd-loader')).toBeNull();
    const fill = container.querySelector('.pd-corpturn-rail-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    // peekAvailable=false → NO clickable peek, ever.
    expect(container.querySelector('[data-testid="corp-inline-peek"]')).toBeNull();
    await unmount();
  });

  it('shows the Build snapshot button only when peekAvailable, and routes it', async () => {
    const onPeek = vi.fn();
    const { container, unmount } = await render(
      <CorpInlineTurn
        taskId={MOCK_TASK_ID}
        state={DONE_STATE}
        fetchTranscript={fetchNone}
        peekAvailable={true}
        onPeek={onPeek}
      />,
    );
    const peek = container.querySelector('[data-testid="corp-inline-peek"]');
    expect(peek).not.toBeNull();
    expect(peek?.textContent).toContain('Build snapshot');
    await click(peek);
    expect(onPeek).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe('the summary counts who worked, not who was hired', () => {
  /* the user, seeing "Stopped, with a team of 18" after a CEO wrote 19 files alone:
   * "how can the contracts have been written if talk_to_manager … wasn't
   * called." They had not been. The chart lists the whole roster; every agent
   * shows until something moves it off `idle`. */
  it('says the lead worked alone when nobody else ran', () => {
    const nodes = [
      { id: 'ceo', role: 'ceo', name: 'CEO', state: 'done' },
      ...Array.from({ length: 17 }, (_, i) => ({
        id: `x${i}`,
        role: 'engineer',
        name: `X${i}`,
        state: 'idle',
      })),
    ];
    const worked = nodes.filter((n) => n.state !== 'idle').length;
    expect(worked).toBe(1);
    const phrase = worked <= 1 ? 'the lead working alone' : `a team of ${nodes.length}`;
    expect(phrase).toBe('the lead working alone');
  });

  it('names the fraction when only part of the roster ran', () => {
    const nodes = [
      { state: 'done' },
      { state: 'done' },
      { state: 'done' },
      { state: 'idle' },
      { state: 'idle' },
    ];
    const worked = nodes.filter((n) => n.state !== 'idle').length;
    const phrase =
      worked <= 1
        ? 'the lead working alone'
        : worked < nodes.length
          ? `${worked} of a team of ${nodes.length}`
          : `a team of ${nodes.length}`;
    expect(phrase).toBe('3 of a team of 5');
  });
});
