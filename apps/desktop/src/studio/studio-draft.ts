/**
 * A ROOM'S OWN INPUTS OUTLIVE THE ROOM — the line in the composer and the knobs.
 *
 * the user (2026-09-24): "leaving a studio with a generation running and then going
 * back doesn't keep it going, or maybe it does but the UI resets". With the job
 * kept outside the room (state/studio-jobs.ts), what was left of that reset was
 * the room's own state: the composer, the shape, the count, the model — each a
 * `useState` that came back as its default. SEEN in the leave-and-return probe:
 * back mid-job, an empty composer under your own running prompt, with the knobs
 * back at 1:1 and one picture; and a job that failed while you were out offered
 * "Try again" over a composer that no longer held the line it failed on.
 *
 * `useStudioDraft` is `useState` whose value is kept per room for the life of
 * the app. Deliberately not written to disk: a relaunch starting clean is what
 * a relaunch is for; stepping out of a room for a minute is not. (The media a
 * room was HANDED stays out of this — see use-handoff: a dropped file's preview
 * is an object URL that dies with the room.)
 */
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

const drafts = new Map<string, unknown>();

export function useStudioDraft<T>(
  room: string,
  name: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const key = `${room}:${name}`;
  const [value, setValue] = useState<T>(() => (drafts.has(key) ? (drafts.get(key) as T) : initial));
  useEffect(() => {
    drafts.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

/** What a room has kept, for tests and probes. */
export function studioDraft(room: string, name: string): unknown {
  return drafts.get(`${room}:${name}`);
}
