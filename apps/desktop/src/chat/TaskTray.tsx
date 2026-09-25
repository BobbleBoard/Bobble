/**
 * THE TASK TRAY — the button beside the sidebar toggle, and its card.
 *
 * the user (2026-09-24): "implement a little notifications button in the top left
 * within the left sidebar or always simply to the right of the collapse sidebar
 * button, this only appears when you leave a running task, eg. chat,
 * generation etc. and clicking on it has a quick little card, examples shown,
 * examples are of course plagued by the similar design problems we have been
 * talking about."
 *
 * His example was a stack of task cards — a big title each, a status PILL, the
 * same status again as text with a duration, a blue "View" link, flat dark
 * panels. What this does instead, point for point:
 *   - status said ONCE: the loader for running, otherwise a 5px dot in the
 *     sidebar's own vocabulary (blue done, orange needs you, red failed),
 *     beside one word. The time follows in the muted ink.
 *   - type sized for a list, not a poster: 13px title, 12px meta.
 *   - an ink ladder: title primary, state secondary, time muted and tabular.
 *   - the whole row is the way there — no separate "View".
 *   - one firm sheet (the shared .pd-menu surface: overlay fill, drawn edge,
 *     contact + cast shadow) rather than cards floating on nothing.
 *   - compact: a two-line row is 40px (our controls ran ~1.5× Claude's).
 *
 * What is listed and when it clears is decided in state/task-tray.ts; this
 * file only draws it.
 */
import {
  formatDuration,
  Glyph,
  type GlyphName,
  IconClose,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from '@pi-desktop/ui';
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useModalityStore } from '../state/modality-store';
import {
  type TaskPlace,
  type TaskState,
  type TrayTask,
  trayRows,
  trayTone,
  useTaskTray,
} from '../state/task-tray';

const WORD: Record<TaskState, string> = {
  running: 'Running',
  'needs-input': 'Needs your input',
  done: 'Done',
  failed: 'Failed',
};

const STUDIO_NAME: Record<'image' | 'video' | 'audio' | '3d', string> = {
  image: 'Image Studio',
  video: 'Video Studio',
  audio: 'Audio Studio',
  '3d': '3D Studio',
};

/** The same glyph the sidebar puts on the place, so the row and the way there match. */
function glyphFor(place: TaskPlace): GlyphName {
  if (place.kind === 'chat') return 'chat';
  return place.modality === '3d' ? 'studio3d' : place.modality;
}

function placeName(place: TaskPlace): string {
  return place.kind === 'chat' ? 'Chat' : STUDIO_NAME[place.modality];
}

/** "just now" / "4m ago" / "2h ago" — when a finished task finished. */
export function agoText(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.max(1, Math.round(secs / 60));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What follows the state word: how long it has been going while it runs; for
 * a failure, WHY (the part you can act on — "not enough memory" says close
 * something and try again, "2m ago" says nothing); when it ended otherwise.
 * Nothing for a question waiting on you — the word is the whole message there.
 */
export function detailText(task: TrayTask, now: number): string {
  if (task.state === 'running') return formatDuration(now - task.startedAt);
  if (task.state === 'needs-input') return '';
  if (task.state === 'failed' && task.error !== undefined && task.error.trim() !== '') {
    return task.error.trim();
  }
  return agoText(now - (task.endedAt ?? now));
}

/**
 * The time the card reads from: taken fresh whenever the card opens, and ticking
 * once a second while it is open with a clock on it — never while it is shut.
 */
function useNow(open: boolean, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, ticking]);
  return now;
}

function StateMark({ state }: { state: TaskState }): JSX.Element {
  if (state === 'running') return <Spinner size={10} className="pd-task-row-spinner" />;
  return <span className="pd-task-dot" data-tone={state} aria-hidden="true" />;
}

function TaskRow({
  task,
  now,
  onOpen,
  onDismiss,
}: {
  task: TrayTask;
  now: number;
  onOpen: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const finished = task.state === 'done' || task.state === 'failed';
  const time = detailText(task, now);
  return (
    <li className="pd-task-row" data-state={task.state} data-testid="task-row" data-key={task.key}>
      <button
        type="button"
        /* No `pd-focusable` ring: the sheet would clip it. Keyboard focus is the
           row highlight instead (global.css). */
        className="pd-task-row-open"
        onClick={onOpen}
        aria-label={`${placeName(task.place)}: ${task.title}. ${WORD[task.state]}${time !== '' ? `, ${time}` : ''}.`}
        {...(task.error !== undefined ? { title: task.error } : {})}
      >
        <span className="pd-task-row-glyph" aria-hidden="true">
          <Glyph name={glyphFor(task.place)} size={16} />
        </span>
        <span className="pd-task-row-text">
          <span className="pd-task-row-title" data-testid="task-row-title">
            {task.title}
          </span>
          <span className="pd-task-row-meta" data-testid="task-row-meta">
            <StateMark state={task.state} />
            <span className="pd-task-row-word">{WORD[task.state]}</span>
            {time !== '' ? (
              <>
                <span className="pd-task-row-sep" aria-hidden="true">
                  ·
                </span>
                <span
                  className="pd-task-row-time"
                  data-kind={task.state === 'failed' && task.error !== undefined ? 'why' : 'time'}
                >
                  {time}
                </span>
              </>
            ) : null}
          </span>
        </span>
      </button>
      {finished ? (
        <button
          type="button"
          className="pd-task-row-x pd-focusable"
          aria-label={`Dismiss ${task.title}`}
          data-testid="task-row-dismiss"
          onClick={onDismiss}
        >
          <IconClose size={10} />
        </button>
      ) : null}
    </li>
  );
}

/** "2 tasks — 1 running, 1 done", for the button's label. */
function summary(rows: readonly TrayTask[]): string {
  const counts = new Map<TaskState, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const parts = (['needs-input', 'running', 'failed', 'done'] as const)
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)} ${WORD[s].toLowerCase()}`);
  return `${rows.length === 1 ? '1 task' : `${rows.length} tasks`} you left — ${parts.join(', ')}`;
}

export function TaskTray({
  onOpenChat,
}: {
  /** Take the person to a chat (whatever route is up at the time). */
  onOpenChat: (sessionFile: string) => void;
}): JSX.Element {
  const live = useTaskTray((s) => s.live);
  const ended = useTaskTray((s) => s.ended);
  const surface = useTaskTray((s) => s.surface);
  const dismiss = useTaskTray((s) => s.dismiss);
  const clearFinished = useTaskTray((s) => s.clearFinished);
  const rows = useMemo(() => trayRows({ live, ended, surface }), [live, ended, surface]);
  const tone = trayTone(rows);
  const [open, setOpen] = useState(false);
  // Nothing left to show closes the card rather than leaving an empty sheet up.
  useEffect(() => {
    if (rows.length === 0) setOpen(false);
  }, [rows.length]);
  const now = useNow(
    open,
    rows.some((r) => r.state === 'running' || r.state === 'done'),
  );
  const finishedCount = rows.filter((r) => r.state === 'done' || r.state === 'failed').length;

  const go = (task: TrayTask): void => {
    setOpen(false);
    if (task.place.kind === 'chat') onOpenChat(task.place.sessionFile);
    else useModalityStore.getState().setView(task.place.modality);
  };

  return (
    /*
     * THE SLOT IS ALWAYS THERE; the button only sometimes. The corner cluster
     * is measured (chrome-corner.ts) and the collapsed top bar's title starts
     * after it — a button that brought its own width would shove the title
     * sideways every time a task was left. The slot pays that width once.
     */
    <div className="pd-task-tray-slot" data-testid="task-tray-slot">
      {rows.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="[-webkit-app-region:no-drag] pd-focusable pd-task-tray-button"
              data-testid="task-tray"
              data-tone={tone ?? 'running'}
              aria-label={summary(rows)}
              title="Tasks you left"
            >
              <Glyph name="notifications" size={16} />
              {tone !== null ? (
                <span className="pd-task-tray-dot" data-tone={tone} aria-hidden="true" />
              ) : null}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="pd-task-tray"
            side="bottom"
            align="start"
            sideOffset={6}
            data-testid="task-tray-panel"
            aria-label="Tasks you left"
          >
            <ul className="pd-task-tray-list">
              {rows.map((task) => (
                <TaskRow
                  key={task.key}
                  task={task}
                  now={now}
                  onOpen={() => go(task)}
                  onDismiss={() => dismiss(task.key)}
                />
              ))}
            </ul>
            {finishedCount > 0 ? (
              <div className="pd-task-tray-foot">
                <button
                  type="button"
                  className="pd-task-tray-clear pd-focusable"
                  data-testid="task-tray-clear"
                  onClick={clearFinished}
                >
                  {finishedCount === rows.length ? 'Clear all' : 'Clear finished'}
                </button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
