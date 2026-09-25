/**
 * THE LIVE DIAGRAM, HANDED TO ITS FINISHED CARD.
 *
 * The live card (PendingDiagramCard) stands where the tool's card will stand,
 * and its last frame is drawn exactly as the tool's drawing (diagram-live.ts)
 * — so at the hand-over the two are the same picture, and the swap is
 * invisible. When they are not quite (the call's last line landed with the
 * tool's answer, before a frame of it could be drawn), the finished card
 * starts from the live card's last frame and MOVES into its own, the way one
 * live frame moves into the next.
 *
 * The frame is kept here by call id — the live card writes it on every frame,
 * the finished card beneath the same call reads it through
 * DiagramCallContext (AssistantGroup puts the call id around each card it
 * draws beneath a call) — and forgotten after a minute.
 */
import { createContext } from 'react';

/** The call a presented card was handed over by, when it is drawn beneath one. */
export const DiagramCallContext = createContext<string | null>(null);

interface LiveFrame {
  readonly svg: string;
  readonly mode: 'light' | 'dark';
  readonly at: number;
}

const frames = new Map<string, LiveFrame>();
const KEEP_MS = 60_000;

/** The live card's frame on screen now, for its call. */
export function keepLiveFrame(callId: string, svg: string, mode: 'light' | 'dark'): void {
  const now = Date.now();
  for (const [id, f] of frames) if (now - f.at > KEEP_MS) frames.delete(id);
  frames.set(callId, { svg, mode, at: now });
}

/**
 * The live card's last frame for this call, in this mode, while it is fresh.
 * Not taken away on reading: a card mounted twice (React's development
 * double-render, a chat switched away and back within the minute) starts
 * from the same frame — and when that frame IS the finished drawing, nothing
 * moves at all.
 */
export function liveFrameFor(callId: string | null, mode: 'light' | 'dark'): string | null {
  if (callId === null) return null;
  const f = frames.get(callId);
  if (f === undefined || f.mode !== mode || Date.now() - f.at > KEEP_MS) return null;
  return f.svg;
}
