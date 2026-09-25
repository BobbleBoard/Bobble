/**
 * @pi-desktop/mac-computer-use — a pi extension that gives the model a set of
 * `mac_*` tools to DRIVE any Mac app (snapshot/click/type/key/scroll/launch) via
 * the pi-mac Accessibility + CGEvent helper hosted in Electron main.
 *
 * The default export is the zero-config activation Pi Desktop loads via `-e`
 * (see apps/desktop/electron/pi/pi-main.ts). It builds the socket bridge from
 * the env the app injects before spawn (PI_MAC_SOCK / PI_MAC_TOKEN) and
 * registers the tools. Loaded outside Pi Desktop (no env) the tools still
 * register but report a clear "bridge unavailable" error, so this extension is
 * always safe to load.
 *
 * Powerful capability, so it is gated: a per-session consent + an app denylist
 * (see ./permissions.ts), on top of the harness's permission mode. The
 * architecture / the extension→helper seam is documented in ./protocol.ts.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { MacAgentClient, type MacBridge } from './bridge-client.js';
import { createMacConsentGate } from './permissions.js';
import type { ComputerUsePolicy } from './policy.js';
import { createMacSessionState } from './session-state.js';
import {
  type MacComputerUseOptions,
  registerChromeTools,
  registerMacComputerUseTools,
} from './tools.js';

export * from './bridge-client.js';
export * from './format.js';
export * from './permissions.js';
export * from './policy.js';
export * from './protocol.js';
export * from './session-state.js';
export * from './tools.js';

/** Register the mac tool set with an explicit bridge (test / app seam). */
export function registerMacComputerUse(pi: ExtensionAPI, options: MacComputerUseOptions): void {
  /* ONE controlled-app state for both sets, so work done through Chrome's own
     commands leaves Chrome as the app a bare `mac snapshot` looks at — and one
     recorder, so that take is remembered like any other. */
  const session = options.session ?? createMacSessionState();
  // One gate too: an app allowed once is allowed for both sets.
  const consent = options.consent ?? createMacConsentGate();
  const mac = registerMacComputerUseTools(pi, { ...options, session, consent });
  /* Chrome's own set. It prefers the real DOM over Apple Events and falls back
     to Accessibility when Chrome refuses those — which is the usual case — so
     it takes the bridge as well. */
  registerChromeTools(pi, options.bridge, {
    session,
    consent,
    recordControl: mac.recordControl,
    ...(options.isChromeRunning === undefined ? {} : { isChromeRunning: options.isChromeRunning }),
    ...(options.chromePid === undefined ? {} : { chromePid: options.chromePid }),
  });
}

/** pi extension factory (zero-config; reads the bridge socket from env).
 *
 * PI_MAC_PRECONSENT=1 skips the one-time in-UI consent prompt — an E2E seam
 * ONLY: the headless probes (tests/e2e/mac-computeruse-probe.mjs) have no
 * human to click the dialog. The app never sets it for real sessions. */
export default function activate(pi: ExtensionAPI): void {
  const bridge: MacBridge | null = MacAgentClient.fromEnv();
  const preConsented = process.env.PI_MAC_PRECONSENT === '1';
  // The person's standing policy lives in the app's settings; the app answers
  // `policy` over the bridge, so a change in Settings reaches the next action.
  const policy =
    bridge === null
      ? undefined
      : async () => bridge.request<ComputerUsePolicy | null>('policy').catch(() => null);
  registerMacComputerUse(pi, {
    bridge,
    lastControlFile:
      process.env.PI_MAC_LAST_CONTROL_FILE ??
      join(homedir(), '.pi', 'agent', 'mac-last-control.json'),
    consent: createMacConsentGate({ preConsented, ...(policy === undefined ? {} : { policy }) }),
  });
}
