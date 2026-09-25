/**
 * A LIVE CARD, HANDED TO ITS FINISHED CARD.
 *
 * A chart's and a diagram's card build live beneath the chain while the call
 * is written (PendingChartCard, PendingDiagramCard), in the slot the finished
 * card then takes. Two things make that take-over invisible, and they are
 * kept here, by the call that made the card:
 *
 *   - a DIAGRAM's live card draws its last frame exactly as the tool's drawing
 *     (diagram-live.ts), so the two are the same picture; when they are not
 *     quite (the call's last line landed with the tool's answer, before a
 *     frame of it could be drawn), the finished card starts from the live
 *     card's last frame and MOVES into its own, the way one live frame moves
 *     into the next;
 *   - a CHART's live card has already grown its bars; the finished card must
 *     not grow them again from nothing (its entrance is for a chart the
 *     reader has not seen yet — chart-build-film.mjs, BEFORE: every bar
 *     dropped to the axis and rose again at the hand-over).
 *
 * The finished card learns its call through PresentedCallContext (AssistantGroup
 * puts the call id around each card it draws beneath a call). Kept a minute.
 */
import { createContext } from 'react';

/** The call a presented card was handed over by, when it is drawn beneath one. */
export const PresentedCallContext = createContext<string | null>(null);

const KEEP_MS = 60_000;

interface LiveFrame {
  readonly svg: string;
  readonly mode: 'light' | 'dark';
  readonly at: number;
}

const frames = new Map<string, LiveFrame>();
const charts = new Map<string, number>();

function sweep(now: number): void {
  for (const [id, f] of frames) if (now - f.at > KEEP_MS) frames.delete(id);
  for (const [id, at] of charts) if (now - at > KEEP_MS) charts.delete(id);
}

/** The live diagram card's frame on screen now, for its call. */
export function keepLiveFrame(callId: string, svg: string, mode: 'light' | 'dark'): void {
  const now = Date.now();
  sweep(now);
  frames.set(callId, { svg, mode, at: now });
}

/**
 * The live diagram card's last frame for this call, in this mode, while it is
 * fresh. Not taken away on reading: a card mounted twice (React's development
 * double-render, a chat switched away and back within the minute) starts from
 * the same frame — and when that frame IS the finished drawing, nothing moves.
 */
export function liveFrameFor(callId: string | null, mode: 'light' | 'dark'): string | null {
  if (callId === null) return null;
  const f = frames.get(callId);
  if (f === undefined || f.mode !== mode || Date.now() - f.at > KEEP_MS) return null;
  return f.svg;
}

/** A card that arrived this long ago (or less) still builds itself in. */
export const ARRIVAL_MS = 4_000;

/** When each card first built in (the same mount asking twice — React's development double render — is still its first). */
const arrived = new Map<string, number>();

/**
 * Whether a card should build itself in now: it was handed over moments ago
 * in this run (`shownAt`), and has not built in before — a card mounted again
 * (a chat switched back to, a record moved to its saved chat) is simply there.
 */
export function firstArrival(key: string, shownAt: number | undefined): boolean {
  const now = Date.now();
  if (shownAt === undefined || now - shownAt > ARRIVAL_MS) return false;
  // Past ARRIVAL_MS a card's answer no longer depends on its entry.
  for (const [k, at] of arrived) if (now - at > ARRIVAL_MS) arrived.delete(k);
  const first = arrived.get(key);
  if (first === undefined) {
    arrived.set(key, now);
    return true;
  }
  return now - first < 150;
}

/** The live chart card has drawn this call's chart. */
export function markLiveChart(callId: string): void {
  const now = Date.now();
  sweep(now);
  charts.set(callId, now);
}

/** Whether this call's chart was already on screen, drawn live, before its card took over. */
export function hadLiveChart(callId: string | null): boolean {
  if (callId === null) return false;
  const at = charts.get(callId);
  return at !== undefined && Date.now() - at <= KEEP_MS;
}
