/**
 * Corp roles ARE subagents — one implementation for viewing both.
 *
 * The user: "the corp things need to appear as subagents (subchats in the left
 * sidebar just like regular subagents do...) and they don't."
 *
 * They half did. The sidebar rendered a `pd-child-row` per org-chart node, so
 * they LOOKED like subagent rows, but clicking one called `selectCorpNode` — it
 * pinned the node in the situation room's worker pane instead of replacing the
 * main thread with that role's chat, which is what selecting a real subagent
 * does. A row that looks like a chat and does not open one is worse than no row.
 *
 * Rather than a third viewing surface, this mirrors each role into the
 * child-agent store the subagent path already uses: `ensureChild` puts it in the
 * sidebar under the hosting chat, and its transcript is derived from the blocks
 * the corp store is ALREADY accumulating per node (`workerBlocks`). Clicking a
 * role then goes through `setViewedChild` like every other child, and
 * `ChildChatView` renders it — no new component, no second copy of the streaming
 * logic, and the corp store stays the single owner of what each role said.
 */

import type { OrgNodeView } from '@pi-desktop/coordination';
import type { ChatMsg, ContentBlock } from '@pi-desktop/engine';
import { useChildAgentStore } from './child-agent-store';
import { type CorpBlock, useCorpStore } from './corp-store';

/** A corp role's child id. Namespaced so it can never collide with a real
 * subagent's id, and so the corp rows can be recognised for cleanup. */
/** The one prefix that ties a corp node to its mirrored child chat. Exported so
 * the canvas router can read a selection back the other way without re-deriving
 * the convention. */
export const CORP_CHILD_PREFIX = 'corp:';

export const corpChildId = (nodeId: string): string => `${CORP_CHILD_PREFIX}${nodeId}`;

/**
 * One role's accumulated blocks → the single streaming assistant turn the child
 * chat renders. The corp store's block list is already settled/merged (text and
 * thinking carry their own `streaming` flag), so this is a straight projection.
 */
function blocksToMessages(childId: string, run: string, blocks: readonly CorpBlock[]): ChatMsg[] {
  const content: ContentBlock[] = [];
  const results: ChatMsg[] = [];
  /*
   * THE SECOND RENDERER. A role's chat is drawn two ways — the inline corp view
   * (CorpChatStream) and THIS, the sidebar chat you get by clicking the role —
   * and only the first learned to show briefings. So the manager's own chat still
   * opened straight into "Thought, edited a file" with the instruction that
   * caused it nowhere on screen. The user: "the top of this chat should show the blue
   * bubble on the left. RIGHT THERE… WHERES THE MESSAGE BUBBLE."
   *
   * Same shape as transcriptToAssistantView: a brief closes the current assistant
   * turn and becomes a user message, so the transcript reads as a conversation.
   */
  const out: ChatMsg[] = [];
  /*
   * THE RUN IS PART OF THE ID. A running step's clock is remembered by its id
   * for the life of the renderer (activity-chain's STEP_FIRST_SEEN), and every
   * production starts a role's transcript over (setTask clears workerBlocks) —
   * so with ids built from the role alone, the manager's first thought in the
   * second run WAS its first thought in the first run, and opened reading
   * "Thinking for 30m" (review of the 2026-09-23 wave). Tool-call ids derive
   * from this one, so a running command's clock is covered too.
   */
  const assistantId = `${childId}:${run}:turn`;
  let turn = 0;
  const flush = (streaming: boolean): void => {
    if (content.length === 0) return;
    out.push({
      kind: 'assistant',
      id: turn === 0 ? assistantId : `${assistantId}:${turn}`,
      blocks: [...content],
      isStreaming: streaming,
      timestamp: 0,
    });
    content.length = 0;
    turn += 1;
  };
  let call = 0;
  for (const b of blocks) {
    if (b.kind === 'briefing') {
      flush(false); // an earlier run is, by definition, finished
      out.push({ kind: 'user', id: `${childId}:brief:${out.length}`, text: b.text, timestamp: 0 });
      continue;
    }
    switch (b.kind) {
      case 'text':
        content.push({ type: 'text', text: b.text });
        break;
      case 'thinking':
        content.push({ type: 'thinking', thinking: b.text });
        break;
      case 'tool': {
        call += 1;
        const id = `${assistantId}:c${call}`;
        content.push({
          type: 'toolCall',
          id,
          name: b.toolName,
          arguments: {
            ...(b.detail !== undefined ? { detail: b.detail } : {}),
            ...(b.path !== undefined ? { path: b.path } : {}),
          },
        });
        // A captured command output is the tool's RESULT — the thing worth
        // reading. Without this a role's chat shows what it ran and never what
        // came back, which is the half that matters when a build fails.
        if (b.output !== undefined && b.output !== '') {
          results.push({
            kind: 'toolResult',
            id: `tr-${id}`,
            toolCallId: id,
            assistantId,
            toolName: b.toolName,
            text: b.output,
            isError: false,
            timestamp: 0,
          });
        }
        break;
      }
      case 'file': {
        call += 1;
        const id = `${assistantId}:c${call}`;
        content.push({
          type: 'toolCall',
          id,
          name: 'write',
          arguments: { path: b.path, addedLines: b.addedLines, removedLines: b.removedLines },
        });
        if (b.content !== undefined && b.content !== '') {
          results.push({
            kind: 'toolResult',
            id: `tr-${id}`,
            toolCallId: id,
            assistantId,
            toolName: 'write',
            text: b.content,
            isError: false,
            timestamp: 0,
          });
        }
        break;
      }
    }
  }
  const streaming = blocks.some((b) => (b.kind === 'text' || b.kind === 'thinking') && b.streaming);
  flush(streaming);
  return [...out, ...results];
}

/**
 * Mirror the live org chart + per-node blocks into the child-agent store.
 *
 * Called on every corp store change while a run is bound. Cheap and idempotent:
 * `ensureChild` no-ops once a role exists, and the transcript is only replaced
 * when that role's block list actually changed identity (the corp store copies
 * on write, so a reference check is exact).
 */
export function syncCorpChildren(parentId: string): void {
  const corp = useCorpStore.getState();
  const nodes: readonly OrgNodeView[] = corp.situation?.chart.nodes ?? [];
  if (nodes.length === 0) return;
  const child = useChildAgentStore.getState();
  for (const node of nodes) {
    const id = corpChildId(node.id);
    // The role's brief seeds the opening user bubble, exactly as a subagent's
    // goal does — so a role's chat reads as a chat rather than a bare monologue.
    child.ensureChild(id, parentId, node.name, undefined);
    const blocks = corp.workerBlocks[node.id];
    if (blocks !== undefined && blocks !== lastBlocks.get(node.id)) {
      lastBlocks.set(node.id, blocks);
      useChildAgentStore
        .getState()
        .replaceMessages(id, blocksToMessages(id, corp.taskId ?? '', blocks));
    }
    /*
     * A ROLE CANNOT BE RUNNING AFTER THE RUN HAS ENDED.
     *
     * `working` is the only live node state, but it is the CHART's opinion, and
     * the chart settles from state pulses that stop arriving when a run
     * finishes. A node left mid-`working` at that moment kept its spinner
     * forever — the user, on an engineer that had already posted "Deliverables
     * Complete": "the model seems to have submitted for a final time, or
     * otherwise be finished, but it still shows a loading spinner."
     *
     * `corpRunning` is the run's own terminal signal (set false on the
     * `done`/`status` event), so it is the authority over a stale node state.
     * Same rule as everywhere else here: when two sources disagree, prefer the
     * one that observed the end.
     */
    const running = corp.corpRunning && node.state === 'working';
    child.setRunning(id, running);
    /*
     * The SAME lifecycle word the situation room shows, on the sidebar row.
     * The user had a run where the sidebar showed a blue dot and the situation room
     * showed "queued" for the same agent — two panes describing one thing in two
     * vocabularies, so neither could be trusted. Once the run is over the chart's
     * `working` is stale (see above), so a still-`working` node reads as the run
     * left it, not as live.
     */
    child.setStatusLabel(id, nodeStatusWord(node.state, corp.corpRunning));

    /*
     * WALK THE USER INTO THE MANAGER'S CHAT when the hand-off happens.
     *
     * The CEO calling talk_to_manager is the moment the run becomes a team, and
     * the user was left in the main conversation looking at a card ABOUT the
     * manager instead of at the manager. The user: "act as if the user clicked onto
     * the newly created manager chat instead, route away from the main
     * conversation automatically."
     *
     * Once per run, and only if the user has not already chosen a chat to look
     * at — an automatic navigation that overrides a deliberate one is a worse
     * bug than the card ever was.
     */
    if (node.role === 'manager' && !routedToManager) {
      routedToManager = true;
      if (useChildAgentStore.getState().viewedChildId === null) child.setViewedChild(id);
    }
  }
}

/** Whether this run has already walked the user into the manager's chat. */
let routedToManager = false;

/** One word per org-chart state — the sidebar's mirror of the situation room. */
export function nodeStatusWord(state: OrgNodeView['state'], runLive: boolean): string {
  switch (state) {
    case 'working':
      return runLive ? 'working' : 'stopped';
    case 'waiting':
      return 'waiting';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'retired':
      return 'stopped';
    default:
      return 'queued';
  }
}

/** Per-node block identity from the last sync — the corp store copies on write,
 * so an unchanged reference means nothing new was said. */
const lastBlocks = new Map<string, readonly CorpBlock[]>();

/** Forget the mirror between runs so a new production starts clean. */
export function resetCorpChildren(): void {
  lastBlocks.clear();
  // A new production gets its own walk-in; otherwise the second run of a session
  // would leave the user wherever the first one put them.
  routedToManager = false;
}
