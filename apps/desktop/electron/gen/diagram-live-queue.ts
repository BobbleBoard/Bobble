/**
 * The pure half of the live diagram card's main side (diagram-live.ts): the
 * request as it crosses IPC, checked; and the queue — one frame drawn at a
 * time, only the newest per call.
 */
import type { DiagramLiveReply, DiagramLiveRequest } from './diagram-contract';

/** Far above any diagram a model types; the rest is refused, not drawn. */
const MAX_SOURCE_CHARS = 60_000;

/** A request as it arrived over IPC — checked, never trusted. */
export function checkLiveRequest(raw: unknown): DiagramLiveRequest | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '' || r.id.length > 200) return null;
  if (typeof r.source !== 'string' || r.source.length > MAX_SOURCE_CHARS) return null;
  if (r.mode !== 'light' && r.mode !== 'dark') return null;
  const text = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length <= max ? v : undefined;
  const title = text(r.title, 400);
  const subtitle = text(r.subtitle, 400);
  const kit = text(r.kit, 80);
  const root = text(r.root, 4096);
  return {
    id: r.id,
    source: r.source,
    mode: r.mode,
    ...(title !== undefined ? { title } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(kit !== undefined ? { kit } : {}),
    ...(r.look === 'clean' || r.look === 'sketch' ? { look: r.look } : {}),
    ...(root !== undefined ? { root } : {}),
    ...(r.partial === true ? { partial: true } : {}),
  };
}

/**
 * Frames drawn one at a time, the newest per call only. `draw` is the real
 * work; a frame overtaken while it waited is answered without it.
 */
export function createLiveQueue(
  draw: (req: DiagramLiveRequest) => Promise<DiagramLiveReply>,
): (req: DiagramLiveRequest) => Promise<DiagramLiveReply> {
  let chain: Promise<unknown> = Promise.resolve();
  const newest = new Map<string, number>();
  let seq = 0;
  return (req) => {
    seq += 1;
    const mine = seq;
    newest.set(req.id, mine);
    const job = chain.then(async (): Promise<DiagramLiveReply> => {
      if (newest.get(req.id) !== mine) {
        return { ok: false, error: 'a newer frame was asked for', line: null, superseded: true };
      }
      try {
        return await draw(req);
      } finally {
        if (newest.get(req.id) === mine) newest.delete(req.id);
      }
    });
    chain = job.catch(() => undefined);
    return job;
  };
}
