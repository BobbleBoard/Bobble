/**
 * IS SOMEONE USING THE MODEL RIGHT NOW? — the one signal every background job
 * asks before it touches the single decoding slot.
 *
 * There is ONE slot (memory `pi-desktop-ttft-regression`): while any background
 * call is on it, the user's next message queues behind it. Five tracks designed
 * the same guard independently — memory's LLM gate, the workflows yield rule,
 * pictures inside documents, help's waiting line, training's chat parking — so
 * it is built once, here (deliverables/research/PLAN.md F3, §1.3 item 1).
 *
 * SKELETON from the W0-A pre-wire: the API and a minimal, correct registry —
 * sources report busy/idle, listeners hear transitions and preempts. ACT-01
 * (lane MEM, W1) adds the taps (pi-sessions, child-agents, prefill-main, the gen
 * queue through GEN-SEAM) and the policy on top: per-source quiet windows, the
 * post-turn delay, the <50 ms preempt budget, the battery rule via power-gate.ts.
 * The shape below is what those consumers are written against.
 */

/** What can make the app busy. */
export type ActivitySourceKind =
  /** A chat turn in flight (agent_start → agent_end). */
  | 'chat'
  /** A subagent or a corp role running. */
  | 'subagent'
  /** A scheduled run. */
  | 'scheduled'
  /** A composer prime (predictive prefill) on the slot. */
  | 'prime'
  /** A generation job. */
  | 'gen'
  /** A Bobble help turn. */
  | 'help'
  /** A workflow step that is using the model. */
  | 'workflow';

/** Why the slot is wanted NOW — what a preempt carries to its listeners. */
export type PreemptReason = 'user-prompt' | 'prefill' | 'gen-job' | 'help-turn';

export interface ActivityMark {
  readonly kind: ActivitySourceKind;
  /** Per instance: a session file, a child id, a job id. */
  readonly id: string;
  /** ms since the epoch when it went busy. */
  readonly since: number;
}

export interface ActivitySnapshot {
  readonly busy: boolean;
  readonly active: readonly ActivityMark[];
  /** When the app last became idle (ms since the epoch), or null while busy / never busy. */
  readonly idleSince: number | null;
}

export type ActivityListener = (snapshot: ActivitySnapshot) => void;
export type PreemptListener = (reason: PreemptReason) => void;

export interface ChatActivity {
  /** A source went busy; call the returned function when it is done (idempotent). */
  begin(kind: ActivitySourceKind, id: string): () => void;
  /** Someone needs the slot now: every preempt listener runs synchronously. */
  preempt(reason: PreemptReason): void;
  snapshot(): ActivitySnapshot;
  /** Busy right now? */
  busy(): boolean;
  /** Idle for at least `ms` (false while busy). */
  quietFor(ms: number): boolean;
  /** Busy/idle transitions (not every begin/end). Returns unsubscribe. */
  onChange(listener: ActivityListener): () => void;
  onPreempt(listener: PreemptListener): () => void;
}

/** Create an activity registry. `now` is injectable for tests. */
export function createChatActivity(now: () => number = Date.now): ChatActivity {
  const active = new Map<string, ActivityMark>();
  const changeListeners = new Set<ActivityListener>();
  const preemptListeners = new Set<PreemptListener>();
  // Never busy yet: idle since the registry existed.
  let idleSince: number | null = now();

  const snapshot = (): ActivitySnapshot => ({
    busy: active.size > 0,
    active: [...active.values()],
    idleSince: active.size > 0 ? null : idleSince,
  });
  const notify = (): void => {
    const snap = snapshot();
    for (const l of changeListeners) {
      try {
        l(snap);
      } catch {
        // A listener's failure is its own; the registry keeps going.
      }
    }
  };

  return {
    begin(kind, id) {
      const key = `${kind}:${id}`;
      const wasBusy = active.size > 0;
      active.set(key, { kind, id, since: now() });
      if (!wasBusy) {
        idleSince = null;
        notify();
      }
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        if (!active.delete(key)) return;
        if (active.size === 0) {
          idleSince = now();
          notify();
        }
      };
    },
    preempt(reason) {
      for (const l of preemptListeners) {
        try {
          l(reason);
        } catch {
          // Same rule as change listeners.
        }
      }
    },
    snapshot,
    busy: () => active.size > 0,
    quietFor(ms) {
      if (active.size > 0 || idleSince === null) return false;
      return now() - idleSince >= ms;
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onPreempt(listener) {
      preemptListeners.add(listener);
      return () => preemptListeners.delete(listener);
    },
  };
}

/** The app's one instance. Taps (ACT-01) report into it; gates read it. */
export const chatActivity: ChatActivity = createChatActivity();
