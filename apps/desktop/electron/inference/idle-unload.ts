/**
 * UNLOAD WHAT NOBODY IS USING; LOAD IT BACK THE MOMENT SOMEONE STARTS TO TYPE.
 *
 * The user (2026-10-09), on the guardian parking the 27B between turns: "unload
 * the 27b (and really anything for that matter) if there's more than 5 minutes
 * without interaction (5 minutes without typing into the input bar or preparing
 * input otherwise) the instant the user starts inputting, the load starts
 * prefill starts, to the user, it should still be instant and snappy so long as
 * they take enough time typing their message or more as it takes to load the
 * model and prefill."
 *
 * So:
 * - "Interaction" is input being prepared: typing, a paste, a file dropped or
 *   attached, the microphone, focusing the input. The renderer reports it
 *   (`llm:input-activity`), throttled.
 * - Work in flight is interaction too. A chat turn, a subagent, a scheduled run
 *   or a generation keeps everything loaded however long it runs — an agent
 *   turn spends minutes between model calls while its tools run, and unloading
 *   under it would leave its next call waiting on a model nobody is bringing
 *   back. The clock starts again when the work ends.
 * - Unloading parks the chat server (its process stops, its URL stays, so pi
 *   never notices) and stops ComfyUI, which keeps its models in memory between
 *   jobs. Generation models load per job, and dictation has its own idle timer.
 * - The first input after an unload resumes the chat server. The composer's
 *   prime then reads the whole conversation into the model again (it re-primes
 *   when `parked` clears — attachment-prefill.ts), so by the time Enter is
 *   pressed only the new message is left to read.
 *
 * The decision is the pure `createIdleUnloader`; `startIdleUnload` is the timer.
 */

/** Five minutes, the user's number. `PI_IDLE_UNLOAD_MS` shortens it for a probe. */
export const IDLE_UNLOAD_MS = 5 * 60_000;
/** How often to look. A minute late on a five-minute clock costs nothing. */
export const IDLE_CHECK_MS = 15_000;

export interface IdleUnloaderDeps {
  readonly now: () => number;
  readonly idleMs: number;
  /** Is anything using a model right now (a turn, a run, a generation)? */
  readonly busy: () => boolean;
  /** Unload everything idle. Resolves true when something was unloaded. */
  readonly unload: () => Promise<boolean>;
  /** Bring back what `unload` put away. */
  readonly reload: () => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface IdleUnloader {
  /** Input is being prepared: restart the clock, and load back what was unloaded. */
  noteInput(): void;
  /** Look once: unload if the clock has run out and nothing is running. */
  tick(): Promise<void>;
  /** For diagnostics and the probe. */
  state(): { readonly unloaded: boolean; readonly idleForMs: number; readonly reloading: boolean };
}

export function createIdleUnloader(deps: IdleUnloaderDeps): IdleUnloader {
  const log = deps.log ?? (() => {});
  let lastActive = deps.now();
  let unloaded = false;
  let unloading: Promise<void> | null = null;
  let reloading: Promise<void> | null = null;

  const startReload = (): void => {
    if (reloading !== null) return;
    unloaded = false;
    log('input after an idle unload — loading back');
    reloading = deps
      .reload()
      .catch((error: unknown) => log(`reload failed: ${String(error)}`))
      .finally(() => {
        reloading = null;
      });
  };

  return {
    noteInput() {
      lastActive = deps.now();
      if (unloaded) startReload();
      // Typing while the unload is still going through: load back once it lands.
      else if (unloading !== null)
        void unloading.then(() => (unloaded ? startReload() : undefined));
    },
    async tick() {
      if (deps.busy()) {
        lastActive = deps.now();
        return;
      }
      if (unloaded || unloading !== null || reloading !== null) return;
      const idleFor = deps.now() - lastActive;
      if (idleFor < deps.idleMs) return;
      unloading = deps
        .unload()
        .then((did) => {
          unloaded = did;
          if (did) log(`unloaded after ${Math.round(idleFor / 1000)}s without input`);
        })
        .catch((error: unknown) => log(`unload failed: ${String(error)}`))
        .finally(() => {
          unloading = null;
        });
      await unloading;
    },
    state() {
      return {
        unloaded,
        idleForMs: Math.max(0, deps.now() - lastActive),
        reloading: reloading !== null,
      };
    },
  };
}

/** The idle window: the user's five minutes unless a probe set its own. */
export function idleUnloadMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_IDLE_UNLOAD_MS);
  return Number.isFinite(n) && n > 0 ? n : IDLE_UNLOAD_MS;
}

/** Run the unloader on a timer. Returns it, with a stop for app quit. */
export function startIdleUnload(
  deps: Omit<IdleUnloaderDeps, 'now' | 'idleMs'> & { readonly checkMs?: number },
): IdleUnloader & { stop(): void } {
  const idleMs = idleUnloadMs();
  const unloader = createIdleUnloader({ ...deps, now: () => Date.now(), idleMs });
  const checkMs = deps.checkMs ?? Math.min(IDLE_CHECK_MS, Math.max(1_000, Math.floor(idleMs / 4)));
  const timer = setInterval(() => void unloader.tick(), checkMs);
  timer.unref?.();
  return { ...unloader, stop: () => clearInterval(timer) };
}
