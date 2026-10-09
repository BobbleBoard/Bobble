/**
 * MAY THE QUICK PANEL HAND THIS APP TO COMPUTER USE?
 *
 * "Do X in this app" from the panel goes to the same background computer use
 * the chat has, aimed at the app that was in front — so it answers to the same
 * standing choice the person made in Settings › Computer use:
 *
 *   off      computer use is switched off: say so, offer to turn it on.
 *   never    Bobble itself, Keychain Access and System Settings can never be
 *            driven, whatever the settings say.
 *   allowed  the app is on the "use without asking" list.
 *   ask      anything else: the request goes ahead and the consent gate asks
 *            in the panel, once, as it would in a chat.
 *
 * The extension's own gate enforces all of this again on every action; this is
 * the panel saying it up front, in words, instead of letting a turn start that
 * can only be refused.
 *
 * Pure (the policy and denylist modules are pure too).
 */
import { checkDenylist } from '@pi-desktop/mac-computer-use/permissions';
import { type ComputerUsePolicy, policyVerdict } from '@pi-desktop/mac-computer-use/policy';

export type ComputerUseGate = 'off' | 'never' | 'allowed' | 'ask';

export function computerUseGate(
  policy: ComputerUsePolicy,
  app: { readonly name: string; readonly bundleId?: string },
): ComputerUseGate {
  if (checkDenylist(app.name) !== null || checkDenylist(app.bundleId) !== null) return 'never';
  if (!policy.enabled) return 'off';
  const byName = policyVerdict(policy, app.name);
  if (byName === 'allowed') return 'allowed';
  if (app.bundleId !== undefined && policyVerdict(policy, app.bundleId) === 'allowed') {
    return 'allowed';
  }
  return 'ask';
}
