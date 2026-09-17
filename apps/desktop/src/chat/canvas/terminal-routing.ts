/**
 * Route long-running / interactive bash tool calls to a LIVE terminal view in
 * the canvas (round-7). A conservative heuristic classifies a bash command as
 * interactive/long-running (dev servers, watchers, REPLs, `tail -f`, …); such a
 * call opens a read-only "mirror" terminal tab that streams the tool's command +
 * output into an xterm (native-surfaces renders it). Ordinary one-shot commands
 * (`ls`, `pwd`, …) stay in the thread's activity chain and never open a tab.
 *
 * The mirror tab is keyed by the tool-call id; the user can still open their own
 * interactive terminal via the top-bar "New terminal" control (real PTY).
 * Detection is pure/unit-testable; the hook does the canvas side effects.
 */
import { type CanvasTab, useCanvasTabs } from '@pi-desktop/canvas';
import type { ChatMsg, ContentBlock } from '@pi-desktop/engine';
import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../state/canvas-store';
import { usePiStore } from '../../state/pi-slice';
import { toolStepKind } from '../activity-mapping';
import { isInteractiveCommand, mirrorCommandText, shortCommandTitle } from './agent-surfaces';

export { isInteractiveCommand };

type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>;

/** One bash tool call mirrored into a terminal tab. */
export interface BashTerminalEvent {
  callId: string;
  command: string;
  output: string;
  running: boolean;
  /** The arguments have all arrived and the tool is running the command — the
   * mirror presses Enter (see mirrorCommandText). */
  executing: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function commandOf(block: ToolCallBlock): string | undefined {
  if (toolStepKind(block.name) !== 'bash') return undefined;
  return str(block.arguments?.command);
}

/** Detect the interactive bash calls in the thread, newest-state per call id. */
export function detectBashTerminals(
  messages: ChatMsg[],
  /*
   * Output streamed by commands that have not returned. A mirror terminal for a
   * dev server or a `tail -f` is the one surface where waiting for the result is
   * the same as never showing anything — those commands are chosen for this view
   * precisely because they do not finish.
   */
  partials: Readonly<Record<string, string>> = {},
  /** Call ids the harness reports as executing (the store's runningToolCalls). */
  executing: ReadonlyArray<string> = [],
): BashTerminalEvent[] {
  const executingIds = new Set(executing);
  const resultByCall = new Map<string, string>();
  for (const m of messages) {
    if (m.kind === 'toolResult') resultByCall.set(m.toolCallId, m.text);
  }
  const events: BashTerminalEvent[] = [];
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    for (const block of m.blocks) {
      if (block.type !== 'toolCall') continue;
      const command = commandOf(block);
      if (command === undefined || !isInteractiveCommand(command)) continue;
      const output = resultByCall.get(block.id);
      events.push({
        callId: block.id,
        command,
        output: output ?? partials[block.id] ?? '',
        running: output === undefined,
        executing: output === undefined && executingIds.has(block.id),
      });
    }
  }
  return events;
}

const terminalTabKey = (callId: string): string => `term:${callId}`;

/** The xterm text for a mirror terminal: the command prompt + its output. */
/* `cwd` is passed IN rather than read from the project store here: this module
 * is imported by node-environment tests, and pulling the store in drags
 * browser-only code to module scope ("window is not defined"). The hook below
 * reads it, where a browser is guaranteed. */
function mirrorText(ev: BashTerminalEvent, cwd?: string): string {
  return mirrorCommandText(ev.command, ev.output, ev.running, cwd, { executing: ev.executing });
}

/**
 * Watch the stream and mirror interactive bash calls into live terminal tabs.
 * Opens each once (a user-closed tab is not reopened) and refreshes its text as
 * output arrives; native-surfaces reconciles the xterm from `data.mirrorText`.
 */
export function useBashTerminalCanvasRouting(): void {
  // The workspace the commands actually ran in, so the mirror's prompt line
  // reads `bobble buggyapp $ …` instead of a bare `$`.
  const cwd = usePiStore((s) => s.session?.cwd) ?? undefined;
  const { controller } = useCanvasTabs();
  const messages = usePiStore((s) => s.messages) as ChatMsg[];
  const partials = usePiStore((s) => s.toolOutputPartials);
  const executing = usePiStore((s) => s.runningToolCalls);
  const opened = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const ev of detectBashTerminals(messages, partials, executing)) {
      const key = terminalTabKey(ev.callId);
      const data: CanvasTab['data'] = { mirror: true, mirrorText: mirrorText(ev, cwd) };
      const existing = controller.getState().tabs.find((t) => t.key === key);
      if (existing === undefined) {
        if (opened.current.has(key)) continue;
        opened.current.add(key);
        controller.upsertTab(key, {
          kind: 'terminal',
          key,
          title: shortCommandTitle(ev.command),
          data,
        });
        /*
         * ...AND REVEAL THE PANEL. the user: "the canvas sidebar should just be
         * opened itself on any of these tool calls, and it hasn't been for this
         * terminal command."
         *
         * `upsertTab` already FOCUSES the new tab, so the intent was always that
         * the user sees it — it was just being focused behind a closed drawer.
         * file-tabs.ts records the identical fix for the media path: every other
         * route that puts something in the canvas on the user's behalf opens it
         * too, and this was the remaining exception. Only on CREATE, never on a
         * text update, so a running command does not keep prising the panel back
         * open while the user is reading something else.
         */
        useCanvasStore.getState().setCanvasOpen(true);
      } else if ((existing.data?.mirrorText as string | undefined) !== data.mirrorText) {
        controller.updateTab(existing.id, { data });
      }
    }
  }, [messages, partials, executing, controller, cwd]);
}
