/**
 * The corp run rendered INSIDE the chat as a normal assistant turn (the
 * "you never left your conversation" reframe): the CEO — the model the user was
 * already talking to — is answering the question; it just happens to be waiting
 * on a pile of subagents. The delegation reads as a familiar in-progress tool
 * call (the ActivityChain collapsed-summary interaction), clean by default and
 * expandable when the user is curious:
 *
 *  - State A (collapsed): a shimmering "Waiting for N of M tasks to finish ·
 *    K in progress" summary over the honest progress rail. When the run is
 *    done it settles to "✓ Delivered N tasks with a team of A" (no shimmer,
 *    no spinner) plus a "Build snapshot" button — ONLY when there is actually
 *    a snapshot to open (`peekAvailable`).
 *  - State B (expanded): one row per org-chart node — status glyph, name, a
 *    live status line, and a spinner only while that node is working. Active
 *    rows sort to the top (working → blocked → queued → done → stopped). A
 *    lead (`ceo`/`manager`) that is working reads "waiting for other
 *    subagents to finish"; a builder shows its real `currentAction`.
 *  - State C (a row expanded): that node's REAL live stream, rendered through
 *    the same {@link CorpWorkerFeed} the worker pane uses, fetched via the
 *    injected `fetchTranscript` and polled while the node is still working
 *    (the worker pane's cadence). One row open at a time.
 *
 * Pure/props-driven: renders a folded {@link SituationState}; transcripts
 * arrive via `fetchTranscript` (IPC in the app, the scripted mock in demos and
 * tests). Nothing here talks to stores or the engine directly.
 */
import { contractProgress, formatEta, type SituationState, workingCount } from '@pi-desktop/canvas';
import type { OrgNodeView, WorkerTranscriptView } from '@pi-desktop/coordination';
import { Button, IconCheck, IconChevronRight, IconEye, ShimmerText, Spinner } from '@pi-desktop/ui';
import { useEffect, useState } from 'react';
import { useChildAgentStore } from '../../state/child-agent-store';
import { corpChildId } from '../../state/corp-child-bridge';
import './CorpInlineTurn.css';

export interface CorpInlineTurnProps {
  taskId: string;
  /** The folded corp event stream (reduceSituation output). */
  state: SituationState;
  /** One node's live transcript (IPC in the app; the mock in demos/tests). */
  /** RETAINED, not read here. Drilling into an agent now opens its real chat
   * (the same one the sidebar opens), so this component no longer fetches or
   * renders a transcript itself; the situation-room canvas panel still does.
   * Kept on the props so existing callers are unaffected. */
  fetchTranscript?: (nodeId: string) => Promise<WorkerTranscriptView | null>;
  /** There is a build snapshot to open — the peek button only renders then. */
  peekAvailable: boolean;
  /** Open the Build snapshot. */
  onPeek?: () => void;
  /**
   * Re-focus the situation-room canvas panel (Point 3). When wired, THIS is the
   * primary click target of the "waiting" summary — the CEO's turn is a jump-back
   * to the team view, since drill-in now lives in the situation room, not the
   * inline rows. Absent (demo/tests): the summary toggles the inline rows as before.
   */
  onFocusSituation?: () => void;
}

/** The engine's raw "thinking" action reads as a live "thinking…" to a person. */
function actionText(action: string): string {
  return action === 'thinking' ? 'thinking…' : action;
}

/**
 * The one-line status a subagent row shows for its node's live state.
 *
 * `anyoneElseWorking` decides whether a lead is coordinating or building. It
 * used to be assumed: a working CEO always read "waiting for other subagents to
 * finish", so the user watched a CEO write nineteen files alone under a label
 * claiming it was waiting for a team that had never been sent a single message.
 * A lead with nobody working IS the one doing the work, and should say so.
 */
function rowStatusLine(node: OrgNodeView, anyoneElseWorking: boolean): string {
  switch (node.state) {
    case 'working':
      // A lead's "work" is coordination — but only when somebody else is actually
      // going. Otherwise it is building, like anyone else.
      if ((node.role === 'ceo' || node.role === 'manager') && anyoneElseWorking) {
        return 'waiting for other subagents to finish';
      }
      return node.currentAction !== undefined ? actionText(node.currentAction) : 'working…';
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

/** The root of the hierarchy — the chat model itself, which has no mesh seat
 * and therefore no mirrored child chat. Selecting it means "back to the
 * conversation", not "open a subagent". */
function isRoot(n: OrgNodeView): boolean {
  return n.parentId === undefined && (n.role === 'ceo' || n.role === 'solo');
}

/** Active rows on top: working → blocked → queued → done → stopped. */
const STATE_RANK: Record<OrgNodeView['state'], number> = {
  working: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  retired: 4,
};

/** Stable ordering: rank by state, keep the chart's order within a rank. */
function orderRows(nodes: readonly OrgNodeView[]): readonly OrgNodeView[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => STATE_RANK[a.node.state] - STATE_RANK[b.node.state] || a.index - b.index)
    .map((entry) => entry.node);
}

/** The row's status glyph: the sitroom gem while live, a check when done,
 * a hollow ring when queued/stopped — the situation room's design language. */
function RowGlyph({ state }: { state: OrgNodeView['state'] }) {
  if (state === 'done') {
    return (
      <span className="pd-corpturn-glyph" data-state="done" aria-hidden>
        <IconCheck size={11} />
      </span>
    );
  }
  if (state === 'working' || state === 'blocked') {
    return (
      <span className="pd-corpturn-glyph pd-sitroom-gem" data-state={state} aria-hidden>
        <span className="pd-sitroom-gem-glow" />
        <span className="pd-sitroom-gem-ring" />
        <span className="pd-sitroom-gem-core" />
      </span>
    );
  }
  return (
    <span className="pd-corpturn-glyph" data-state={state} aria-hidden>
      <span className="pd-corpturn-glyph-hollow" />
    </span>
  );
}

export function CorpInlineTurn({
  taskId,
  state,
  peekAvailable,
  onPeek,
  onFocusSituation,
}: CorpInlineTurnProps) {
  const [expanded, setExpanded] = useState(false);
  /*
   * The selection lives in the CHILD-AGENT STORE, not here. A local
   * `openNodeId` was the whole reason this panel and the sidebar disagreed:
   * two independent notions of "which agent am I looking at", neither aware of
   * the other. There is one now, and both read it.
   */
  const viewedChildId = useChildAgentStore((s) => s.viewedChildId);
  const setViewedChild = useChildAgentStore((s) => s.setViewedChild);

  const progress = contractProgress(state);
  const busy = workingCount(state.chart);
  const terminal =
    state.status === 'done' || state.status === 'aborted' || state.status === 'error';
  const delivered = state.status === 'done';
  const eta = terminal ? '' : formatEta(state.eta);
  const agentCount = state.chart.nodes.length;
  /*
   * HOW MANY ACTUALLY WORKED, not how many were hired.
   *
   * The chart lists the whole ROSTER — eighteen agents built up front by
   * buildCorpRoster — and every one of them shows until something moves it off
   * `idle`. So "Finished with a team of 18" was true of the configuration and
   * false about the work: the user watched a CEO write nineteen files alone and
   * asked, reasonably, how contracts could have been written when `talk_to`
   * appeared nowhere in the tool history. They had not been. Nobody was hired;
   * a roster was printed.
   */
  const workedCount = state.chart.nodes.filter((n) => n.state !== 'idle').length;
  /** "a team of 18" / "the CEO alone" — whichever is true. */
  const teamPhrase =
    workedCount <= 1
      ? 'the lead working alone'
      : workedCount < agentCount
        ? `${workedCount} of a team of ${agentCount}`
        : `a team of ${agentCount}`;
  const remaining = Math.max(0, progress.total - progress.done);

  // Honest pre-plan fallback (no checklist yet): the surface's plain phrasing.
  const waitLabel =
    progress.total > 0
      ? `Waiting for ${remaining} of ${progress.total} tasks to finish · ${busy} in progress`
      : (state.statusDetail ??
        (state.status === 'starting' ? 'Getting started' : 'Forming a plan'));

  /*
   * A COUNT WE DO NOT HAVE IS NOT REPORTED AS ZERO.
   *
   * "Delivered 0 tasks with a team of 14" is what this said after a run in which
   * fourteen agents worked for a quarter of an hour and left a source tree, an
   * app bundle and converted files on disk. `progress.total` comes from the plan
   * checklist, which the mesh never emits — so the number was not "nothing was
   * delivered", it was "nobody counted", and the screen stated it as fact.
   *
   * the user, reading it: "it said that 0/14 tasks were done but everyone finished?"
   * — which is exactly the confusion a false zero causes. With no checklist we
   * say what we actually know: the team finished, and here is how many worked.
   */
  const counted = progress.total > 0;
  const terminalLabel = delivered
    ? counted
      ? `Delivered ${progress.total} tasks with ${teamPhrase}`
      : `Finished with ${teamPhrase} — see what they built below`
    : state.status === 'aborted'
      ? counted
        ? `Stopped after ${progress.done} of ${progress.total} tasks`
        : `Stopped, with ${teamPhrase}`
      : (state.result?.error ?? 'Something went wrong');

  return (
    <div
      className="pd-corpturn"
      data-testid="corp-inline-turn"
      data-status={state.status}
      data-task-id={taskId}
    >
      {/* The assistant gem: this is Pi answering, not a separate panel. */}
      <span
        className="pd-corpturn-gem pd-sitroom-gem"
        data-state={terminal ? (delivered ? 'done' : 'idle') : 'working'}
        aria-hidden
      >
        {delivered ? (
          <IconCheck size={11} />
        ) : (
          <>
            <span className="pd-sitroom-gem-glow" />
            <span className="pd-sitroom-gem-ring" />
            <span className="pd-sitroom-gem-core" />
          </>
        )}
      </span>

      <div className="pd-corpturn-main">
        <div className="pd-corpturn-headrow">
          <button
            type="button"
            className="pd-corpturn-summary pd-focusable"
            aria-expanded={onFocusSituation ? undefined : expanded}
            data-testid="corp-inline-summary"
            onClick={() => {
              // Wired in the live thread: the CEO-waiting indicator jumps the user
              // back to the situation-room canvas (Point 3). Standalone: toggle rows.
              if (onFocusSituation) {
                onFocusSituation();
                return;
              }
              setExpanded((v) => !v);
            }}
          >
            {/* One tick, not two: the gem to the left already turns into a check
                when the run lands, and a second one beside the label read as
                "✓ ✓ Finished with a team of 14". */}
            {terminal ? (
              <span className="pd-corpturn-summary-text" data-testid="corp-inline-done">
                {terminalLabel}
              </span>
            ) : (
              <span className="pd-corpturn-summary-text">
                <ShimmerText>{waitLabel}</ShimmerText>
              </span>
            )}
            {eta !== '' ? (
              <span className="pd-corpturn-eta" data-confidence={state.eta?.confidence ?? 'low'}>
                {eta}
              </span>
            ) : null}
            <span className="pd-corpturn-chevron" data-expanded={expanded}>
              <IconChevronRight size={14} />
            </span>
          </button>
          {delivered && peekAvailable ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="corp-inline-peek"
              onClick={() => onPeek?.()}
            >
              <IconEye size={13} />
              Build snapshot
            </Button>
          ) : null}
        </div>

        {/* The honest progress rail (the situation room's): fill exists only
            once tasks do. */}
        <div
          className="pd-corpturn-rail"
          role="progressbar"
          aria-valuenow={progress.done}
          aria-valuemin={0}
          aria-valuemax={progress.total > 0 ? progress.total : undefined}
          aria-label="Tasks finished"
        >
          <span
            className="pd-corpturn-rail-fill"
            style={
              progress.total > 0
                ? { width: `${(progress.done / progress.total) * 100}%` }
                : undefined
            }
          />
        </div>

        {expanded ? (
          <ul className="pd-corpturn-rows" data-testid="corp-inline-rows">
            {orderRows(state.chart.nodes).map((node) => {
              // Is anyone OTHER than this row actually going? That is the
              // difference between a lead coordinating and a lead building.
              const anyoneElseWorking = state.chart.nodes.some(
                (n) => n.id !== node.id && n.state === 'working',
              );
              return (
                <li key={node.id} className="pd-corpturn-rowwrap">
                  <button
                    type="button"
                    className="pd-corpturn-row pd-focusable"
                    data-state={node.state}
                    data-node-id={node.id}
                    /*
                     * ONE ENTITY, ONE SELECTION. This row and the sidebar's
                     * subchat row are the same agent, and they used to do
                     * completely different things: the sidebar opened the agent
                     * as a chat, while this expanded a little feed inside the
                     * panel. the user: "the buttons in the situation room to check on
                     * a subagent and the buttons in the left sidebar showing
                     * subagents as 'subchats' don't do the same thing?? why don't
                     * they? ... clicking in the situation room should also put
                     * the chat just like that left sidebar does."
                     *
                     * So both now drive `setViewedChild` on the SAME id — the
                     * bridge already mirrors every corp role into the child store
                     * as `corp:<nodeId>`, which is what made two selections
                     * possible in the first place. Selecting from either place
                     * now lights up both.
                     */
                    /*
                     * The root row IS the chat. It has no mirrored child (there
                     * is no ceo seat in the mesh), so selecting it means going
                     * back to the top-level conversation — `viewedChild = null` —
                     * which is exactly what the sidebar's own chat row does.
                     */
                    data-selected={
                      (isRoot(node)
                        ? viewedChildId === null
                        : viewedChildId === corpChildId(node.id)) || undefined
                    }
                    onClick={() => setViewedChild(isRoot(node) ? null : corpChildId(node.id))}
                  >
                    <RowGlyph state={node.state} />
                    <span className="pd-corpturn-row-name">{node.name}</span>
                    <span className="pd-corpturn-row-status" data-state={node.state}>
                      {rowStatusLine(node, anyoneElseWorking)}
                    </span>
                    {node.state === 'working' ? (
                      <Spinner size={11} className="pd-corpturn-row-spinner" />
                    ) : null}
                  </button>
                  {/* The inline RowFeed is gone. It was a SECOND, smaller way to
                   * read an agent — a cramped feed inside a panel, showing the
                   * same transcript the sidebar shows properly as a chat. Two
                   * viewers for one thing is what made this confusing; the row
                   * now opens the real one. */}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
