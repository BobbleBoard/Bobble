/**
 * THE MODEL IS BACK FROM AN IDLE UNLOAD — make its prompt cache warm again.
 *
 * The app unloads a model after five idle minutes by stopping its process and
 * keeping its address (electron/inference/idle-unload.ts), and loads it back
 * the moment the user starts typing. Back, its prompt cache is empty:
 * - the system prompt and tools are warmed by the harness, which still thinks
 *   they are resident — `/harness rewarm` tells it they are not;
 * - a chat's history is re-primed by the composer, which re-primes when
 *   `parked` clears (composer/attachment-prefill.ts).
 * Both run while the message is still being typed.
 */
import type { LlmStatus } from '../../electron/ipc-contract';
import { useLlmStore } from './llm-store';

/** Did this status change end an idle unload? Pure, for the test. */
export function endedIdleUnload(prev: LlmStatus, next: LlmStatus): boolean {
  return prev.parkedReason === 'idle' && next.parked === undefined && next.serverRunning;
}

let started = false;

export function startIdleReturnWatch(): void {
  if (started) return;
  started = true;
  useLlmStore.subscribe((state, prev) => {
    if (!endedIdleUnload(prev.status, state.status)) return;
    void window.piDesktop.invoke('pi:prompt', { message: '/harness rewarm' }).catch(() => {});
  });
}
