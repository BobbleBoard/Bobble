/**
 * Corp roles must be REAL children — the same store, the same rows, the same
 * click path as a spawn_subagent child.
 *
 * the user: "the corp things need to appear as subagents (subchats in the left
 * sidebar just like regular subagents do...) and they don't." They rendered as
 * rows that looked identical and did not open a chat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChildAgentStore } from './child-agent-store';
import { corpChildId, resetCorpChildren, syncCorpChildren } from './corp-child-bridge';
import { useCorpStore } from './corp-store';

const PARENT = '/Users/user/.pi/sessions/chat-1.jsonl';

function seedChart(nodes: Array<{ id: string; name: string; state: string }>): void {
  useCorpStore.setState({
    situation: {
      status: 'running',
      chart: {
        taskId: 't1',
        nodes: nodes.map((n) => ({
          id: n.id,
          role: n.id === 'manager' ? 'manager' : 'engineer',
          name: n.name,
          state: n.state,
        })),
        edges: [],
      },
      activities: [],
      activityCount: 0,
      artifacts: [],
      checklist: [],
    },
  } as never);
}

beforeEach(() => {
  resetCorpChildren();
  useChildAgentStore.setState({ children: {}, viewedChildId: null, unread: {} });
  useCorpStore.setState({ situation: null, workerBlocks: {} } as never);
});

describe('corp roles become sidebar children', () => {
  it('registers every charted role under the hosting chat', () => {
    seedChart([
      { id: 'manager', name: 'Manager', state: 'working' },
      { id: 'engineer:1', name: 'Engineer 1', state: 'idle' },
    ]);
    syncCorpChildren(PARENT);

    const kids = useChildAgentStore.getState().children;
    expect(Object.keys(kids).sort()).toEqual([corpChildId('engineer:1'), corpChildId('manager')]);
    // Nested under the CHAT that hosts the run — that is what the sidebar keys on.
    expect(kids[corpChildId('manager')]?.parentId).toBe(PARENT);
    expect(kids[corpChildId('manager')]?.title).toBe('Manager');
  });

  it('only the working role spins', () => {
    seedChart([
      { id: 'manager', name: 'Manager', state: 'working' },
      { id: 'engineer:1', name: 'Engineer 1', state: 'idle' },
    ]);
    syncCorpChildren(PARENT);
    const kids = useChildAgentStore.getState().children;
    expect(kids[corpChildId('manager')]?.running).toBe(true);
    expect(kids[corpChildId('engineer:1')]?.running).toBe(false);
  });

  it("projects a role's blocks into a readable transcript", () => {
    seedChart([{ id: 'engineer:1', name: 'Engineer 1', state: 'working' }]);
    useCorpStore.setState({
      workerBlocks: {
        'engineer:1': [
          { kind: 'thinking', text: 'I need a scene file.', streaming: false },
          { kind: 'text', text: 'Writing the player.', streaming: true },
          { kind: 'tool', toolName: 'bash', detail: 'godot --headless', output: 'Parse Error' },
          { kind: 'file', path: 'player.gd', addedLines: 12, removedLines: 0, content: 'extends' },
        ],
      },
    } as never);
    syncCorpChildren(PARENT);

    const msgs = useChildAgentStore.getState().children[corpChildId('engineer:1')]?.messages ?? [];
    const assistant = msgs.find((m) => m.kind === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant?.kind !== 'assistant') throw new Error('expected an assistant turn');
    expect(assistant.blocks.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'toolCall',
      'toolCall',
    ]);
    // A live role is still streaming, so its chat shows as in-flight.
    expect(assistant.isStreaming).toBe(true);
    // THE OUTPUT IS THE HALF THAT MATTERS. A transcript showing what was run and
    // never what came back is useless exactly when a build is failing.
    const results = msgs.filter((m) => m.kind === 'toolResult');
    expect(results.map((r) => (r.kind === 'toolResult' ? r.text : ''))).toEqual([
      'Parse Error',
      'extends',
    ]);
  });

  it('is idempotent — re-syncing unchanged blocks does not churn the transcript', () => {
    seedChart([{ id: 'manager', name: 'Manager', state: 'working' }]);
    const blocks = [{ kind: 'text', text: 'Splitting the work.', streaming: false }];
    useCorpStore.setState({ workerBlocks: { manager: blocks } } as never);
    syncCorpChildren(PARENT);
    const first = useChildAgentStore.getState().children[corpChildId('manager')]?.messages;
    syncCorpChildren(PARENT);
    const second = useChildAgentStore.getState().children[corpChildId('manager')]?.messages;
    expect(second).toBe(first);
  });

  it('a corp child id can never collide with a real subagent id', () => {
    expect(corpChildId('manager')).toBe('corp:manager');
    expect(corpChildId('manager')).not.toBe('manager');
  });
});
