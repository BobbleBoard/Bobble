/**
 * The consent + denylist gate for the mac_* tools.
 *
 * Driving ANY Mac app is powerful, so — on top of the harness permission MODE
 * (bypass/reviewer/review-all still applies to every tool via the harness's
 * tool_call gate) — this adds two extra, self-contained guards each tool routes
 * through before it acts:
 *
 *   1. Per-session CONSENT. The first mac_* action asks the user once ("Allow Pi
 *      to control your Mac?"); a yes is remembered for the session. With no UI
 *      (print mode / a spawned subagent) consent can't be obtained, so we BLOCK
 *      rather than silently act (same fail-safe as registerPermissions).
 *   2. An app DENYLIST. Pi Desktop must never drive itself (self-loops), nor the
 *      login Keychain, nor the System Settings security/privacy panes, nor the
 *      TCC prompt — those are permission-escalation surfaces. A denied target is
 *      refused regardless of consent.
 *
 * The gate is a pure-ish factory (state in a closure) so it unit-tests without a
 * real UI: `ensure(ctx, target)` returns allow / a structured refusal reason.
 */
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';

/** Case-insensitive app name / bundle-id fragments Pi refuses to drive. */
export const DEFAULT_MAC_DENYLIST: readonly string[] = [
  'pi desktop',
  'app.pidesktop.desktop',
  'keychain access',
  'com.apple.keychainaccess',
  'system settings',
  'system preferences',
  'com.apple.systempreferences',
  'securityagent',
  'com.apple.securityagent',
  'loginwindow',
  'tccd',
  'universalcontrol',
];

/** Returns a refusal reason if `app` is denylisted, else null. */
export function checkDenylist(
  app: string | undefined,
  denylist: readonly string[] = DEFAULT_MAC_DENYLIST,
): string | null {
  if (app === undefined || app.trim() === '') return null;
  const a = app.toLowerCase();
  for (const entry of denylist) {
    if (a.includes(entry)) {
      return `refusing to control "${app}" — it is on the Mac computer-use denylist (self-control / credential / permission surfaces are blocked)`;
    }
  }
  return null;
}

export type ConsentDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface MacConsentOptions {
  readonly denylist?: readonly string[];
  /** Start already-consented (test seam / a future persisted opt-in). */
  readonly preConsented?: boolean;
  readonly promptTitle?: string;
  readonly promptMessage?: string;
}

/*
 * THE MOST IMPORTANT MOMENT IN THE FEATURE, AND IT USED TO GET THREE THINGS WRONG.
 *
 * It said "Pi" (a codename the user has never seen), it said "synthetic
 * clicks/keystrokes via Accessibility" (engineer voice, at the exact moment the
 * user is deciding whether to trust this), and it said the product would act on
 * "whatever app is in front" — which stopped being true the moment this round
 * made it drive one named app in the BACKGROUND. The user should be told what
 * happens, in their words: which app, that they keep their computer, where to
 * watch, and how long the answer lasts.
 */
const DEFAULT_TITLE = 'Let Bobble use your Mac?';
const DEFAULT_MESSAGE =
  'Bobble will click and type in the app for you. It works in the background, so you can ' +
  'keep using your Mac — and you can watch it in the Computer use tab and stop it at any ' +
  'time. This lasts until you close Bobble.';

/** The same question when the app is already known, which is the usual case:
 * naming it is the difference between "control my Mac" and "use TextEdit". */
function consentCopy(app: string | undefined): { title: string; message: string } {
  const name = app?.trim() ?? '';
  if (name === '') return { title: DEFAULT_TITLE, message: DEFAULT_MESSAGE };
  return {
    title: `Let Bobble use ${name}?`,
    message:
      `Bobble will click and type in ${name} for you. It works in the background, so you can ` +
      'keep using your Mac — and you can watch it in the Computer use tab and stop it at any ' +
      'time. This lasts until you close Bobble.',
  };
}

export interface MacConsentGate {
  /** Gate one mac_* action. `targetApp` (when known) is denylist-checked. */
  ensure(ctx: ExtensionContext, targetApp?: string): Promise<ConsentDecision>;
  /** Current session-consent state (for status/tests). */
  isConsented(): boolean;
}

/** Build a session consent gate. State (the one-time consent) lives in a closure
 * so each pi session gets a fresh gate. */
export function createMacConsentGate(opts: MacConsentOptions = {}): MacConsentGate {
  const denylist = opts.denylist ?? DEFAULT_MAC_DENYLIST;
  let consented = opts.preConsented === true;

  return {
    isConsented: () => consented,
    async ensure(ctx: ExtensionContext, targetApp?: string): Promise<ConsentDecision> {
      const denied = checkDenylist(targetApp, denylist);
      if (denied !== null) return { ok: false, reason: denied };
      if (consented) return { ok: true };
      // No human to answer (print mode / subagent) → fail safe, never silently act.
      if (!ctx.hasUI) {
        return {
          ok: false,
          reason: 'Mac control needs a one-time consent, but there is no UI to confirm it here.',
        };
      }
      const copy = consentCopy(targetApp);
      let ok = false;
      try {
        ok = await ctx.ui.confirm(
          opts.promptTitle ?? copy.title,
          opts.promptMessage ?? copy.message,
        );
      } catch {
        ok = false;
      }
      if (!ok) return { ok: false, reason: 'user declined Mac control for this session' };
      consented = true;
      return { ok: true };
    },
  };
}
