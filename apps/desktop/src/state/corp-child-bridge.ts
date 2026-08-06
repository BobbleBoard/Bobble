/**
 * Corp roles ARE subagents — one implementation for viewing both.
 *
 * the user: "the corp things need to appear as subagents (subchats in the left
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
export const corpChildId = (nodeId: string): string => `corp:${nodeId}`;

/**
 * One role's accumulated blocks → the single streaming assistant turn the child
 * chat renders. The corp store's block list is already settled/merged (text and
 * thinking carry their own `streaming` flag), so this is a straight projection.
 */
function blocksToMessages(childId: string, blocks: readonly CorpBlock[]): ChatMsg[] {
  const content: ContentBlock[] = [];
  const results: ChatMsg[] = [];
  const assistantId = `${childId}:turn`;
  let call = 0;
  for (const b of blocks) {
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
  return [
    {
      kind: 'assistant',
      id: assistantId,
      blocks: content,
      isStreaming: streaming,
      timestamp: 0,
    },
    ...results,
  ];
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
      useChildAgentStore.getState().replaceMessages(id, blocksToMessages(id, blocks));
    }
    // `working` is the only live state; everything else is a finished role.
    child.setRunning(id, node.state === 'working');
  }
}

/** Per-node block identity from the last sync — the corp store copies on write,
 * so an unchanged reference means nothing new was said. */
const lastBlocks = new Map<string, readonly CorpBlock[]>();

/** Forget the mirror between runs so a new production starts clean. */
export function resetCorpChildren(): void {
  lastBlocks.clear();
}
