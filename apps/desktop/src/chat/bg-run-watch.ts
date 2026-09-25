/**
 * WHEN A BACKGROUND CHAT FINISHES — the sidebar's rule, pure, so it can be
 * tested without mounting the sidebar.
 *
 * A chat running behind the one on screen going from streaming to not is a
 * finish: its row gets a dot, and — if it ran long enough to be worth
 * interrupting someone for (the caller's duration floor) — a notification.
 * A deleted chat's finish is neither.
 */

export interface BgRunWatch {
  /** When the run now streaming in the background started, or null. */
  readonly startedAt: number | null;
  readonly wasStreaming: boolean;
}

export const BG_RUN_IDLE: BgRunWatch = { startedAt: null, wasStreaming: false };

export interface BgRunFinish {
  readonly sessionFile: string;
  readonly title: string | null;
  /** How long it ran, for the notification's duration floor. */
  readonly ranFor: number;
}

/** One look at the background run: the next watch, and a finish if one just happened. */
export function watchBgRun(
  watch: BgRunWatch,
  bgRun: {
    readonly sessionFile: string;
    readonly streaming: boolean;
    readonly title: string | null;
  } | null,
  now: number,
  deleted: (file: string) => boolean,
): { watch: BgRunWatch; finished: BgRunFinish | null } {
  const streaming = bgRun?.streaming === true;
  let startedAt = watch.startedAt;
  if (streaming && startedAt === null) startedAt = now;
  let finished: BgRunFinish | null = null;
  if (watch.wasStreaming && !streaming && bgRun !== null && !deleted(bgRun.sessionFile)) {
    finished = {
      sessionFile: bgRun.sessionFile,
      title: bgRun.title,
      ranFor: now - (startedAt ?? now),
    };
  }
  /*
   * A run that is not streaming has no start time, however it stopped. It was
   * cleared only on a finish, so a run that ended without one — its chat
   * deleted, or brought back on screen — left it behind, and the next
   * background run inherited it: a three-second reply "finished while you were
   * away" after half an hour.
   */
  if (!streaming) startedAt = null;
  return { watch: { startedAt, wasStreaming: streaming }, finished };
}
