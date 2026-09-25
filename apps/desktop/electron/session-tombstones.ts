/**
 * DELETED MEANS GONE — even when pi writes one more line.
 *
 * the user (2026-09-23): "clicking delete on a chat should instantly terminate any
 * generation of any kind happening and immediately remove it from the user
 * interface". Deleting a chat that is RUNNING races the pi child: the file is
 * removed, the turn is aborted, and pi appends the aborted reply to its session
 * file a moment later — `appendFileSync` creates the file again, holding just
 * that tail, and the next listing shows a chat the user deleted.
 *
 * So a deleted file is remembered. Anything that comes back under that name is
 * removed again: on every listing, and on two timed sweeps after the delete.
 * The record is small, persisted (an app quit inside the race must not bring
 * the chat back on the next launch), and forgets an entry after a week — by
 * then no process could still be holding the file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** How long a deletion is remembered. */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionTombstones {
  /** Remember these files as deleted (absolute paths). */
  add(files: readonly string[]): void;
  /** Forget these files — a delete that failed left them where they were. */
  forget(files: readonly string[]): void;
  /** Was this file deleted? */
  has(file: string): boolean;
  /** Remove every remembered file that has come back. Returns how many. */
  sweep(): number;
}

export interface TombstoneDeps {
  /** Where the record lives. */
  readonly storePath: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export function createSessionTombstones(deps: TombstoneDeps): SessionTombstones {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? TOMBSTONE_TTL_MS;
  let loaded: Map<string, number> | null = null;

  const load = (): Map<string, number> => {
    if (loaded !== null) return loaded;
    loaded = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(deps.storePath, 'utf8')) as unknown;
      if (raw !== null && typeof raw === 'object') {
        for (const [file, at] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof at === 'number' && now() - at < ttl) loaded.set(file, at);
        }
      }
    } catch {
      /* no record yet, or an unreadable one: start empty */
    }
    return loaded;
  };

  const save = (map: Map<string, number>): void => {
    try {
      fs.mkdirSync(path.dirname(deps.storePath), { recursive: true });
      const tmp = `${deps.storePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), 'utf8');
      fs.renameSync(tmp, deps.storePath);
    } catch {
      /* the in-memory record still guards this run */
    }
  };

  return {
    add(files) {
      const map = load();
      const at = now();
      for (const f of files) map.set(path.resolve(f), at);
      // Expired entries go on every write, so the record never grows unbounded.
      for (const [f, t] of map) if (at - t >= ttl) map.delete(f);
      save(map);
    },
    forget(files) {
      const map = load();
      let changed = false;
      for (const f of files) changed = map.delete(path.resolve(f)) || changed;
      if (changed) save(map);
    },
    has(file) {
      const map = load();
      const at = map.get(path.resolve(file));
      return at !== undefined && now() - at < ttl;
    },
    sweep() {
      let removed = 0;
      for (const [f, t] of load()) {
        if (now() - t >= ttl) continue;
        try {
          if (fs.existsSync(f)) {
            fs.rmSync(f, { force: true });
            removed += 1;
          }
        } catch {
          /* try again on the next sweep */
        }
      }
      return removed;
    },
  };
}
