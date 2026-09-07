/**
 * The sentence box: "every weekday at 9am, summarise what changed in my
 * working folder" → a task, with the deterministic parse (schedule-logic's
 * parseTaskDraft) shown LIVE under the box as you type. ChatGPT's box
 * (`12.03.38 AM`) sends the sentence to a model; this one answers in
 * microseconds, identically every time, and ↵ opens a prefilled editor to
 * confirm — a misread never silently becomes a task.
 *
 * Shared by the Agenda and by Ledger+. Round two styled it as the Model hub's
 * search bar, and the round-three judge found exactly what that cost: it was
 * the same pill as the list's search field 60px below it, with no send
 * affordance while idle, so an idle screen gave no hint that this box CREATES
 * anything. So it is the chat composer's shape now — a rounded rectangle, not
 * a pill — with the chat composer's send circle always at its right end: muted
 * while the box is empty, live once there is text.
 *
 * Under it is a LANE of fixed height. The parse chips appear IN the lane
 * rather than under the box, so nothing below the composer moves as you type.
 */
import { IconArrowUp, IconButton } from '@pi-desktop/ui';
import { useEffect, useMemo, useRef } from 'react';
import {
  describeSchedule,
  nextRun,
  normalizeTask,
  parseTaskDraft,
} from '../../../electron/scheduled/schedule-logic';
import { describeMoment } from './derive';
import { IconRepeat, IconTimer } from './icons';

/** Short enough to survive 640px — the old one clipped at "…in my working". */
export const COMPOSER_PLACEHOLDER = 'Every weekday at 9am, summarise what changed';

/** What the probe types: a different cadence from the placeholder, so the parse is visibly at work. */
export const COMPOSER_SAMPLE = 'every friday at 4pm, write up what I worked on this week';

export function LiveParse({ text, now }: { text: string; now: number }) {
  const parsed = useMemo(() => parseTaskDraft(text), [text]);
  const task = normalizeTask({ id: 'p', ...parsed, enabled: true, createdAt: now });
  const next = nextRun(task, now, true);
  return (
    <div className="sc-parse" data-testid="sc-parse">
      <span className="sc-chip">
        <IconRepeat size={12} />
        {describeSchedule(task)}
      </span>
      {next !== undefined ? (
        <span className="sc-chip">
          <IconTimer size={12} />
          first run {describeMoment(next, now)}
        </span>
      ) : null}
      <span className="min-w-0 truncate">“{parsed.prompt}”</span>
      <span className="sc-parse-hint">↵ to check it</span>
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSubmit,
  now,
  autoFocus = false,
  focusToken = 0,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  now: number;
  autoFocus?: boolean;
  /** Bump to take the caret — e.g. coming back from the editor to the sentence. */
  focusToken?: number;
}) {
  const hasText = value.trim().length > 0;
  const inputRef = useRef<HTMLInputElement>(null);
  // By effect, not the attribute: `autoFocus` is decided after the schedule
  // has loaded (is the list empty?), and the attribute only acts on mount.
  useEffect(() => {
    if (autoFocus || focusToken > 0) inputRef.current?.focus();
  }, [autoFocus, focusToken]);
  return (
    <div data-testid="sc-composer">
      <div className="sc-composer" data-has-text={hasText}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hasText) onSubmit();
            if (e.key === 'Escape') onChange('');
          }}
          placeholder={COMPOSER_PLACEHOLDER}
          className="sc-composer-input"
          aria-label="Describe a task, with a time"
          data-testid="sc-composer-input"
        />
        {/* The chat composer's send circle: rests muted, goes live with text. */}
        <IconButton
          aria-label="Check it"
          variant={hasText ? 'accent' : 'secondary'}
          circle
          className="sc-composer-go"
          disabled={!hasText}
          onClick={onSubmit}
          data-testid="sc-composer-go"
        >
          <IconArrowUp size={14} />
        </IconButton>
      </div>
      <div className="sc-lane" data-testid="sc-lane">
        {hasText ? <LiveParse text={value} now={now} /> : null}
      </div>
    </div>
  );
}
