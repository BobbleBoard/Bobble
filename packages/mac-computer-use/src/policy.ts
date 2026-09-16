/**
 * THE PERSON'S STANDING ANSWER, read before any per-session question.
 *
 * the user (2026-09-15): "a UI on onboarding for computer use on/off and then if
 * on choose what apps to allow control of … editable later in settings via a
 * similar UI." The chooser writes a policy; the consent gate reads it here.
 *
 * Three outcomes, in order:
 *   off       every Mac-driving action is refused, and the refusal names the
 *             setting so the model can tell the person where to turn it on
 *             rather than trying another way in.
 *   allowed   the app is on the list: no question this session.
 *   ask       anything else falls through to the per-app question the gate
 *             already asks — the list is pre-approval, not a fence, because
 *             a one-off "yes, use Preview this once" is a real request and
 *             the question already names the stakes.
 *
 * Pure so it unit-tests without a bridge: the gate feeds it the policy it
 * fetched and the app the model named.
 */

export interface ComputerUsePolicyApp {
  /** Bundle identifier, e.g. `com.apple.TextEdit`. */
  readonly id: string;
  /** The name Finder shows — what a model usually names. */
  readonly name: string;
}

export interface ComputerUsePolicy {
  readonly enabled: boolean;
  readonly apps: readonly ComputerUsePolicyApp[];
}

export type PolicyVerdict = 'off' | 'allowed' | 'ask';

/** Refusal text when computer use is switched off. Names the setting. */
export const COMPUTER_USE_OFF_REASON =
  'Computer use is switched off in Settings → Computer use. Bobble will not click or type in ' +
  'any app until the person turns it on there — tell them that, and do not try another way in.';

/**
 * Whether `target` — an app as the model named it (a name like "TextEdit",
 * a bundle id like "com.apple.TextEdit", or a looser "Google Chrome browser")
 * — is pre-approved by the policy.
 *
 * Matching is case-insensitive and forgiving of the ways a model spells an
 * app: an exact name or id, or the target containing the listed name as a
 * whole word ("the Notes app"). A listed name shorter than three characters
 * is only matched exactly, so "Go" cannot approve "Google Chrome".
 */
export function policyVerdict(
  policy: ComputerUsePolicy | null | undefined,
  target: string | undefined,
): PolicyVerdict {
  if (policy === null || policy === undefined) return 'ask';
  if (!policy.enabled) return 'off';
  const t = target?.trim().toLowerCase() ?? '';
  if (t === '') return 'ask';
  for (const app of policy.apps) {
    const id = app.id.trim().toLowerCase();
    const name = app.name.trim().toLowerCase();
    if (id !== '' && t === id) return 'allowed';
    if (name === '') continue;
    if (t === name) return 'allowed';
    if (name.length >= 3 && wordInside(t, name)) return 'allowed';
  }
  return 'ask';
}

/** `needle` appears in `hay` bounded by non-letters (or the ends). */
function wordInside(hay: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : (hay[i - 1] ?? '');
    const after = hay[i + needle.length] ?? '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = i + 1;
  }
}

function isWordChar(c: string): boolean {
  return c !== '' && /[\p{L}\p{N}]/u.test(c);
}
