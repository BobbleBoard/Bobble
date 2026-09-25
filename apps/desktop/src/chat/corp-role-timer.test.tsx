// @vitest-environment jsdom
/**
 * "THINKING FOR 30m" ON A CORP ROLE'S FRESH THOUGHT.
 *
 * thinking-timer.test.tsx pins the chat half: a running step's clock lives in a
 * renderer-wide map keyed by the step's id, so the id must be unique to the
 * step. A corp role's chat is projected from the corp store with ids built from
 * the ROLE (`corp:manager:turn`), and the store starts every production's
 * transcript over — so the manager's first thought in the second run had the
 * id of its first thought in the first run, and inherited that start time
 * (review of the 2026-09-23 wave, renderer-ui).
 */
import { CanvasProvider } from '@pi-desktop/canvas';
import type { AssistantMsg } from '@pi-desktop/engine';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChildAgentStore } from '../state/child-agent-store';
import { corpChildId, resetCorpChildren, syncCorpChildren } from '../state/corp-child-bridge';
import { useCorpStore } from '../state/corp-store';
import { AssistantGroup } from './AssistantGroup';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PARENT = '/Users/j/.pi/sessions/chat-1.jsonl';

/** A production bound the way ChatApp's bindCorp binds one, with the manager thinking. */
function startRun(taskId: string, thought: string): void {
  resetCorpChildren();
  useCorpStore.getState().setTask(taskId);
  useCorpStore.setState({
    situation: {
      status: 'running',
      chart: {
        taskId,
        nodes: [{ id: 'manager', role: 'manager', name: 'Manager', state: 'working' }],
        edges: [],
      },
      activities: [],
      activityCount: 0,
      artifacts: [],
      checklist: [],
    },
    workerBlocks: { manager: [{ kind: 'thinking', text: thought, streaming: true }] },
  } as never);
  syncCorpChildren(PARENT);
}

/** The manager's chat as ChildChatView draws it — one live assistant turn. */
async function openManagerChat(): Promise<HTMLElement> {
  const msgs = useChildAgentStore.getState().children[corpChildId('manager')]?.messages ?? [];
  const group = msgs.filter((m): m is AssistantMsg => m.kind === 'assistant');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CanvasProvider>
        <AssistantGroup
          group={group}
          resultByCallId={new Map()}
          runningToolCalls={[]}
          tps={undefined}
          live
        />
      </CanvasProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  useChildAgentStore.setState({ children: {}, viewedChildId: null, unread: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a corp role’s chat, run after run', () => {
  it('the second run’s first thought starts at zero, not at the first run’s start', async () => {
    const t0 = 1_790_300_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    startRun('task-a', 'Split the engine into contracts.');
    const first = await openManagerChat();
    expect(first.querySelector('.pd-chain-step-elapsed')?.textContent ?? '').toBe('');

    now.mockReturnValue(t0 + 30 * 60_000);
    startRun('task-b', 'Split the level into rooms.');
    const later = await openManagerChat();
    expect(later.querySelector('.pd-chain-step-elapsed')?.textContent ?? '').toBe('');
  });

  it('a role’s messages are its own run’s: the same role, two productions, two ids', () => {
    startRun('task-a', 'one');
    const a = useChildAgentStore.getState().children[corpChildId('manager')]?.messages[0]?.id;
    startRun('task-b', 'two');
    const b = useChildAgentStore.getState().children[corpChildId('manager')]?.messages[0]?.id;
    expect(a).toBeDefined();
    expect(b).not.toBe(a);
  });
});
