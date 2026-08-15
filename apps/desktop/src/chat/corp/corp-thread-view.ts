/**
 * What the LIVE chat thread renders for the corp run right now — the single
 * source of truth for the "you never left your conversation" reframe (Points
 * 1/3/6). Pure so ChatThread's branch is trivially testable:
 *
 *  - `stream`   — a node's live feed (CorpChatStream): a PINNED subagent the user
 *                 drilled into, or (pre-promotion) the solo CEO/root streaming.
 *  - `waiting`  — the CEO "Waiting for N subagents to finish" indicator
 *                 (CorpInlineTurn): the DEFAULT promoted view when nothing is
 *                 pinned. Explicit drill-in, never an auto-followed leaf.
 *  - `starting` — the gap between submit and the first agent (never blank).
 *  - `none`     — no corp task; the thread is a normal chat.
 */
import type { SituationState } from '@pi-desktop/canvas';
import type { OrgNodeView } from '@pi-desktop/coordination';

export type CorpChatView =
  | { readonly kind: 'stream'; readonly node: OrgNodeView }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'none' };

export interface CorpChatViewInput {
  readonly taskId: string | null;
  readonly situation: SituationState | null;
  /**
   * The node currently mid-turn. DELIBERATELY NOT CONSULTED by `corpChatView`
   * any more — following the live agent is what put somebody else's
   * conversation under the user's own. Kept on the input because the store
   * supplies it and other surfaces (the canvas tab panel) still route by it.
   */
  readonly liveNode: OrgNodeView | null;
  readonly pinnedNode: OrgNodeView | null;
}

/**
 * Decide the thread's corp view. A PIN always wins (the user drilled into that
 * subagent). With no pin, a PROMOTED run (a team formed: > 1 chart node) shows
 * the CEO-waiting indicator — NOT an auto-followed worker (the owner wants
 * explicit drill-in). A pre-promotion run streams the solo CEO/root so the
 * original model is on screen from the first event.
 */
export function corpChatView(input: CorpChatViewInput): CorpChatView {
  const { taskId, situation, pinnedNode } = input;
  if (taskId === null) return { kind: 'none' };
  if (pinnedNode !== null) return { kind: 'stream', node: pinnedNode };
  /*
   * AN UNPINNED ROLE IS NEVER STREAMED INTO THE USER'S OWN THREAD.
   *
   * This used to stream `chart.nodes[0]` whenever the run had only one node,
   * on the reasoning that the single node was the solo CEO and the user should
   * see their own model working. That reasoning expired when the mesh moved its
   * entry point to the MANAGER: there is no CEO in the mesh at all, so node[0]
   * is the manager, and the branch quietly rendered the CEO↔manager
   * conversation directly beneath the user's messages.
   *
   * the user, twice: "no ceo-manager chat embedded into the ceo-user chat?
   * ceo-manager is shown when clicked on the manager subchat just as
   * manager-subagent chat is shown when any subagent is clicked on" — and again
   * after run 6: "The ceo-manager chat is still embedded and shown right below
   * the user chat that's not supposed to be there."
   *
   * A pin is the ONLY way a role's feed reaches this thread. Unpinned, the user
   * gets the waiting indicator, which is a summary of their own turn rather than
   * somebody else's conversation.
   */
  if ((situation?.chart.nodes.length ?? 0) > 0) return { kind: 'waiting' };
  return { kind: 'starting' };
}

/** True when the run has a build snapshot to open (drives the inline peek button). */
export function corpPeekAvailable(situation: SituationState | null): boolean {
  if (situation === null) return false;
  return situation.artifacts.length > 0 || (situation.result?.artifacts?.length ?? 0) > 0;
}
