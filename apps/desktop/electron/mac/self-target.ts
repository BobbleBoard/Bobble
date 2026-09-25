/**
 * NEVER BOBBLE ITSELF.
 *
 * A look or an act that names no app goes to whatever is in FRONT — and while
 * the user is typing to Bobble, that is Bobble. A bare `mac snapshot` read the
 * user's own chat and took it as the controlled app, and the next act drove
 * it: an index-less type went into the composer, a Return sent it, ⌘Q quit.
 * The denylist refuses Bobble only when it is NAMED, and a dev build is named
 * "Electron", which is on no list at all.
 *
 * So the front-app path is resolved HERE, before the helper sees the request:
 * the helper's `frontmost`, skipping Bobble's own process, and the pid it
 * answers is stamped on the request. The helper then aims at exactly that app,
 * and the user switching to Bobble between the two calls cannot pull it back.
 * A pid that is Bobble's own is refused whichever way it arrived; a look that
 * named an app and still resolved to Bobble is refused on its way back
 * (`refuseSelf`), before anything is shown, cached, or taken as the target.
 *
 * Electron-free — the helper and our own pids are injected — so it unit-tests.
 */
import type { MacAgentMethod } from '@pi-desktop/mac-computer-use/protocol';

/** The verbs whose helper call picks a target app — the front one when the
 *  request names none (Serve.swift: targetFrom / actTargetPid). */
const AIMED: ReadonlySet<MacAgentMethod> = new Set<MacAgentMethod>([
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'menuClick',
  'tabs',
  'tabSelect',
  'tabNew',
  'tabClose',
  'windows',
  'bounds',
]);

/** User copy: the model quotes it. */
export const SELF_REFUSAL =
  'That is Bobble itself — the app this chat runs in, which computer use never looks at or ' +
  'drives. Name the app you mean (mac snapshot "<app>"), or launch it.';

/** The helper's `frontmost` answer. */
export interface FrontApp {
  readonly ok?: boolean;
  readonly pid?: number;
  readonly app?: string;
}

export interface SelfTargetDeps {
  /** Bobble's own processes — the one that owns its windows. */
  readonly ownPids: readonly number[];
  /** The frontmost app that is none of `excludePids` (an older helper ignores
   *  them and answers the frontmost, which is then refused if it is ours). */
  readonly frontmost: (excludePids: readonly number[]) => Promise<FrontApp>;
}

/** The request as it should go to the helper — or the refusal, thrown. */
export async function aimAwayFromSelf(
  method: MacAgentMethod,
  params: Record<string, unknown>,
  deps: SelfTargetDeps,
): Promise<Record<string, unknown>> {
  if (!AIMED.has(method)) return params;
  if (typeof params.pid === 'number') {
    if (deps.ownPids.includes(params.pid)) throw new Error(SELF_REFUSAL);
    return params;
  }
  // Named: the helper resolves it, and a look's answer is checked (refuseSelf).
  if (typeof params.app === 'string' && params.app.trim() !== '') return params;
  const front = await deps.frontmost(deps.ownPids);
  if (front.ok === false || typeof front.pid !== 'number' || deps.ownPids.includes(front.pid)) {
    throw new Error(SELF_REFUSAL);
  }
  return {
    ...params,
    pid: front.pid,
    ...(typeof front.app === 'string' && front.app !== '' ? { app: front.app } : {}),
  };
}

/** Refuse an answer that turned out to be Bobble (a look or a launch by name). */
export function refuseSelf(pid: unknown, ownPids: readonly number[]): void {
  if (typeof pid === 'number' && ownPids.includes(pid)) throw new Error(SELF_REFUSAL);
}
