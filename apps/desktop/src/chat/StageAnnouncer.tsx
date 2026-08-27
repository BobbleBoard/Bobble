/**
 * What a screen reader hears while the model works.
 *
 * The whole run was silent to assistive tech: the ring spins, tokens stream,
 * tool rows appear, and none of it is announced — so the app was either "doing
 * nothing" or, worse, indistinguishable from broken.
 *
 * STAGE TRANSITIONS ONLY, NEVER TOKENS. A live region fed by streaming text is
 * a region that talks over itself continuously, and the first thing anyone does
 * with one is switch it off. So: it said the stage it entered, once, and then
 * stopped — "thinking", "running a tool", "done".
 *
 * `polite`, not `assertive`: none of this should interrupt what the reader is
 * already hearing. The transitions are informative, not urgent.
 */

import { type JSX, useEffect, useRef, useState } from 'react';
import { usePiStore } from '../state/pi-slice';

export type Stage = 'idle' | 'working' | 'thinking' | 'tool' | 'compacting' | 'done';

/**
 * The sentence for a stage, or null for one not worth saying.
 *
 * `idle` is the resting state — announcing it on every settle would make the
 * end of every turn two utterances instead of one.
 */
export function announcementFor(stage: Stage): string | null {
  switch (stage) {
    case 'working':
      return 'Working';
    case 'thinking':
      return 'Thinking';
    case 'tool':
      return 'Running a tool';
    case 'compacting':
      return 'Compacting the conversation';
    case 'done':
      return 'Done';
    default:
      return null;
  }
}

/** Derive the stage from what the store says, in priority order. */
export function stageOf(s: {
  isCompacting: boolean;
  isStreaming: boolean;
  promptInFlight: boolean;
  hasRunningTool: boolean;
  isThinking: boolean;
}): Stage {
  if (s.isCompacting) return 'compacting';
  if (s.hasRunningTool) return 'tool';
  if (s.isThinking) return 'thinking';
  if (s.isStreaming || s.promptInFlight) return 'working';
  return 'idle';
}

export function StageAnnouncer(): JSX.Element {
  const isCompacting = usePiStore((s) => s.agent.isCompacting);
  const isStreaming = usePiStore((s) => s.agent.isStreaming);
  const promptInFlight = usePiStore((s) => s.promptInFlight);
  const messages = usePiStore((s) => s.messages);

  /* A tool block on a STREAMING message: the call is out and its result has not
     landed, which is the state worth naming. There is no per-block status to
     read, and matching every call to its result to be more precise would say
     the same thing a beat later. */
  const hasRunningTool = messages.some(
    (m) =>
      m.kind === 'assistant' &&
      m.isStreaming === true &&
      m.blocks.some((b) => b.type === 'toolCall'),
  );
  const isThinking = messages.some(
    (m) =>
      m.kind === 'assistant' &&
      m.isStreaming === true &&
      m.blocks.some((b) => b.type === 'thinking'),
  );

  const stage = stageOf({ isCompacting, isStreaming, promptInFlight, hasRunningTool, isThinking });
  const [message, setMessage] = useState('');
  const previous = useRef<Stage>('idle');

  useEffect(() => {
    if (stage === previous.current) return;
    // Settling back to idle after work is the one transition worth naming, and
    // it is named "Done" rather than "Idle" — the reader wants the outcome.
    const spoken = stage === 'idle' && previous.current !== 'idle' ? 'done' : stage;
    previous.current = stage;
    const text = announcementFor(spoken as Stage);
    if (text !== null) setMessage(text);
  }, [stage]);

  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="stage-announcer"
    >
      {message}
    </div>
  );
}
