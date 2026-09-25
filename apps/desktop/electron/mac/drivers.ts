/**
 * WHO IS DRIVING — so one session's turn ending does not end another's.
 *
 * There is one phantom overlay, one monitor session and one Stop brake, and
 * more than one session that can be driving at the same moment: a chat and the
 * subagent it spawned, a background chat, a corp role, a scheduled run. Each
 * one's turn end said `setDriving {driving:false}`, and mac-agent took that
 * globally — hid the overlay, cleared the monitor, lifted the brake — so the
 * first session to finish tore down the other's live run, and released a Stop
 * the user had pressed on it.
 *
 * Keyed by the session's own BRIDGE CONNECTION: every pi session activates the
 * extension afresh and holds its own connection, so the key costs the protocol
 * nothing and cannot be left off by a caller. And a connection CLOSES when its
 * session's process dies mid-run (a chat deleted, a child killed) — the one
 * case where no `driving:false` will ever come, and where a key that outlived
 * its session would otherwise keep the overlay up for good.
 *
 * Electron-free, so it unit-tests.
 */
import { MAC_DRIVING_METHODS, type MacAgentMethod } from '@pi-desktop/mac-computer-use/protocol';

/** A session: its bridge connection (or a fixed token for the e2e channel). */
export type DriverId = object | symbol;

/** The requests that put something on the user's screen — the same list the
 *  extension counts to know its turn drove. */
const DRIVING: ReadonlySet<MacAgentMethod> = new Set(MAC_DRIVING_METHODS);

export interface DriverRegistry {
  /** A request arrived from `who`; it drives when its method does. */
  noteRequest(who: DriverId, method: MacAgentMethod): void;
  /** `who` says its driving ended. True when no one drives any more — put the
   *  overlay away, clear the monitor, release the brake. */
  end(who: DriverId): boolean;
  /** `who`'s connection closed. True when it was driving and was the last. */
  gone(who: DriverId): boolean;
}

export function createDriverRegistry(): DriverRegistry {
  const driving = new Set<DriverId>();
  return {
    noteRequest(who: DriverId, method: MacAgentMethod): void {
      if (DRIVING.has(method)) driving.add(who);
    },
    end(who: DriverId): boolean {
      driving.delete(who);
      return driving.size === 0;
    },
    gone(who: DriverId): boolean {
      return driving.delete(who) && driving.size === 0;
    },
  };
}
