/**
 * The panel's conversation — the same pi store the chat reads, drawn small:
 * your messages as bubbles, each answer as its activity (the chat's own
 * activity chain) and its words, and under the last answer what you can do with
 * it: copy it, put it where your selection was, or open the thread in Bobble.
 */
import type { AssistantMsg, ToolResultMsg } from '@pi-desktop/engine';
import {
  ActivityChain,
  type ActivityStepData,
  Button,
  IconCopy,
  IconExternal,
  IconReplace,
  ShimmerText,
} from '@pi-desktop/ui';
import { type JSX, useEffect, useMemo, useRef } from 'react';
import {
  type ActivityBlock,
  chainRunningFlags,
  mapThinkingStep,
  mapToolStep,
  segmentGroup,
} from '../chat/activity-mapping';
import { Markdown } from '../chat/markdown';
import { TurnProblemCard } from '../chat/TurnProblemCard';
import { describeTurnProblem } from '../chat/turn-problem';
import { usePiStore } from '../state/pi-slice';
import { copyText, openThreadInBobble, replaceSelectionWith } from './quick-panel';
import { useQuickStore } from './quick-store';
import { quickTurns, replyText } from './thread-model';

function chainSteps(
  blocks: ActivityBlock[],
  results: ReadonlyMap<string, ToolResultMsg>,
  streaming: boolean,
  running: readonly string[],
): ActivityStepData[] {
  const flags = chainRunningFlags(blocks, {
    streaming,
    hasResult: (id) => results.has(id),
    runningToolCalls: running,
  });
  return blocks.map((b, i) =>
    b.type === 'thinking'
      ? mapThinkingStep(b, flags[i] === true).data
      : mapToolStep(b, results.get(b.id), flags[i] === true).data,
  );
}

function Reply({
  group,
  results,
  streaming,
  last,
  answers,
}: {
  group: AssistantMsg[];
  results: ReadonlyMap<string, ToolResultMsg>;
  streaming: boolean;
  last: boolean;
  answers: string | null;
}): JSX.Element {
  const running = usePiStore((s) => s.runningToolCalls);
  const meta = useQuickStore((s) => (answers === null ? undefined : s.turnMeta[answers]));
  const segments = useMemo(() => segmentGroup(group), [group]);
  const text = replyText(group);
  const problem = describeTurnProblem(
    group.find((m) => m.errorMessage !== undefined)?.errorMessage,
  );
  const lastIndex = segments.length - 1;
  return (
    <div
      className="qp-reply"
      data-testid="quick-reply"
      data-streaming={streaming ? 'true' : 'false'}
    >
      {segments.map((seg, i) => {
        const key = `${group[0]?.id ?? 'g'}-${i}`;
        if (seg.kind === 'text') {
          return <Markdown key={key} text={seg.text} streaming={streaming && i === lastIndex} />;
        }
        if (seg.kind === 'artifact') {
          return (
            <p key={key} className="qp-artifact-note">
              A drawing is in this answer. Open the thread in Bobble to see it.
            </p>
          );
        }
        const steps = chainSteps(seg.blocks, results, streaming && i === lastIndex, running);
        return (
          <ActivityChain
            key={key}
            steps={steps}
            active={streaming && i === lastIndex}
            complete={!streaming}
          />
        );
      })}
      {streaming && text === '' && segments.length === 0 ? (
        <ShimmerText className="qp-thinking">Thinking</ShimmerText>
      ) : null}
      {problem !== null ? <TurnProblemCard problem={problem} /> : null}
      {last && !streaming && text !== '' ? (
        <div className="qp-reply-actions" data-testid="quick-reply-actions">
          {meta?.editableSelection === true ? (
            <Button
              size="sm"
              variant={meta.replaces ? 'accent' : 'secondary'}
              data-testid="quick-replace-selection"
              onClick={() => void replaceSelectionWith(text)}
            >
              <IconReplace size={14} />
              Replace selection{meta.app !== undefined ? ` in ${meta.app}` : ''}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            data-testid="quick-copy"
            onClick={() => void copyText(text)}
          >
            <IconCopy size={14} />
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="quick-open-in-bobble"
            onClick={() => void openThreadInBobble('')}
          >
            <IconExternal size={14} />
            Open in Bobble
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function QuickThread(): JSX.Element {
  const messages = usePiStore((s) => s.messages);
  const streaming = usePiStore((s) => s.agent.isStreaming || s.promptInFlight);
  const turns = useMemo(() => quickTurns(messages), [messages]);
  const endRef = useRef<HTMLDivElement>(null);
  const lastAssistant = turns.map((t) => t.kind).lastIndexOf('assistant');
  const lastUser = turns.map((t) => t.kind).lastIndexOf('user');
  const waiting = streaming && lastUser > lastAssistant;

  // Follow the answer as it arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every change to the thread
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  return (
    <div className="qp-thread" data-testid="quick-thread">
      {turns.map((turn, i) => {
        if (turn.kind === 'user') {
          return (
            <div key={turn.msg.id} className="qp-user" data-testid="quick-user">
              {turn.msg.images !== undefined && turn.msg.images.length > 0 ? (
                <div className="qp-user-images">
                  {turn.msg.images.map((src) => (
                    <img key={src.slice(-48)} src={src} alt="" />
                  ))}
                </div>
              ) : null}
              {turn.msg.text !== '' ? <div className="qp-user-text">{turn.msg.text}</div> : null}
            </div>
          );
        }
        if (turn.kind === 'notice') {
          return (
            <p key={turn.msg.id} className="qp-artifact-note">
              {turn.msg.text}
            </p>
          );
        }
        return (
          <Reply
            key={turn.id}
            group={turn.group}
            results={turn.results}
            streaming={streaming && i === lastAssistant && lastAssistant > lastUser}
            last={i === lastAssistant}
            answers={turn.answers}
          />
        );
      })}
      {waiting ? (
        <ShimmerText className="qp-thinking" data-testid="quick-thinking">
          Thinking
        </ShimmerText>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
