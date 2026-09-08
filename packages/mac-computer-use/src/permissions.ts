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

/**
 * What one app being driven can COST, said on the prompt itself.
 *
 * The denylist is all-or-nothing: eleven fragments are refused and everything
 * else gets unrestricted typing. But "let Bobble use TextEdit" and "let Bobble
 * use Terminal" are not the same question, and the second one is shell access.
 * A yes/no with no stakes on it is not consent, so the stakes are on it — the
 * label, not a tier, because refusing to type into an IDE or a terminal would
 * break real work daily and the user is the right one to make that call.
 */
const RISK_LABELS: readonly (readonly [readonly string[], string])[] = [
  [
    ['terminal', 'iterm', 'warp', 'ghostty', 'alacritty', 'kitty', 'tmux', 'hyper'],
    'Anything typed here runs as a shell command.',
  ],
  [
    ['xcode', 'code', 'cursor', 'zed', 'sublime', 'jetbrains', 'intellij', 'pycharm', 'webstorm'],
    'It can read or write any file this app can, and run its build and test commands.',
  ],
  [['finder', 'com.apple.finder'], 'It can move, rename and delete files.'],
  [
    ['mail', 'messages', 'slack', 'discord', 'whatsapp', 'telegram', 'com.apple.mail'],
    'It can read your conversations here and send messages as you.',
  ],
  [
    ['safari', 'chrome', 'firefox', 'arc', 'brave', 'edge'],
    'It can act on any site you are signed in to here.',
  ],
  [
    ['1password', 'bitwarden', 'dashlane', 'lastpass', 'keeper'],
    'It can see whatever this app shows, including credentials.',
  ],
];

/** The risk sentence for an app, or null when it is an ordinary one. */
export function riskLabel(app: string | undefined): string | null {
  const name = app?.trim().toLowerCase() ?? '';
  if (name === '') return null;
  for (const [fragments, label] of RISK_LABELS) {
    // Whole-word-ish: "code" must not match "Xcode"'s neighbours or "Barcode".
    if (fragments.some((f) => name === f || name.includes(f))) return label;
  }
  return null;
}

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
export function consentCopy(app: string | undefined): { title: string; message: string } {
  const name = app?.trim() ?? '';
  if (name === '') return { title: DEFAULT_TITLE, message: DEFAULT_MESSAGE };
  const risk = riskLabel(name);
  return {
    title: `Let Bobble use ${name}?`,
    message:
      `Bobble will click and type in ${name} for you.${risk === null ? '' : ` ${risk}`} It works ` +
      'in the background, so you can keep using your Mac — and you can watch it in the Computer ' +
      `use tab and stop it at any time. Asked once per app, until you close Bobble.`,
  };
}

export interface MacConsentGate {
  /** Gate one mac_* action. `targetApp` (when known) is denylist-checked. */
  ensure(ctx: ExtensionContext, targetApp?: string): Promise<ConsentDecision>;
  /** Whether ANY app has been allowed this session (status/tests). */
  isConsented(): boolean;
  /** The apps allowed so far, lower-cased — what a "granted" chip would list. */
  allowedApps(): readonly string[];
}

/** Build a session consent gate. State (the one-time consent) lives in a closure
 * so each pi session gets a fresh gate. */
export function createMacConsentGate(opts: MacConsentOptions = {}): MacConsentGate {
  const denylist = opts.denylist ?? DEFAULT_MAC_DENYLIST;
  /*
   * PER APP, NOT PER SESSION.
   *
   * One yes used to allow every app on the Mac for the rest of the session — so
   * agreeing to "let Bobble use TextEdit" silently agreed to Terminal, Mail and
   * 1Password too. The question names an app now, so the answer is about that
   * app: a second app asks again. `anyApp` is the pre-consented / already-said-
   * yes-to-everything escape, which is what the e2e seam and a future explicit
   * "allow any app" would set.
   */
  const allowed = new Set<string>();
  let anyApp = opts.preConsented === true;

  const key = (app: string | undefined): string | null => {
    const name = app?.trim().toLowerCase() ?? '';
    return name === '' ? null : name;
  };

  return {
    isConsented: () => anyApp || allowed.size > 0,
    allowedApps: () => [...allowed],
    async ensure(ctx: ExtensionContext, targetApp?: string): Promise<ConsentDecision> {
      const denied = checkDenylist(targetApp, denylist);
      if (denied !== null) return { ok: false, reason: denied };
      const app = key(targetApp);
      if (anyApp) return { ok: true };
      if (app !== null && allowed.has(app)) return { ok: true };
      // An act with no app named at all is covered by any grant already given —
      // it is aimed at the app already under control, which was asked about.
      if (app === null && allowed.size > 0) return { ok: true };
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
      if (!ok) {
        return {
          ok: false,
          reason:
            targetApp === undefined
              ? 'user declined Mac control for this session'
              : `user declined Mac control for ${targetApp}`,
        };
      }
      if (app === null) anyApp = true;
      else allowed.add(app);
      return { ok: true };
    },
  };
}
