/**
 * "TAKE ME THERE" — one way for anything in the app to navigate it.
 *
 * App.tsx owns where the app is (the view, Settings open or not, the studio),
 * and until now only its own children could move it, through props threaded
 * down the tree. Bobble help's deep links, a guide page, a workflow card's
 * "Open settings", a notification — none of them sit under App's props. So they
 * call {@link navigate} here, and App, which subscribes, does the moving with
 * the same handlers its own buttons use (deliverables/research/bobble-help.md
 * §4.7; the W0-A pre-wire).
 *
 * A target is a `NavTarget` or a link string — `bobble://settings/appearance#theme.mode`
 * or its short form `settings:appearance#theme.mode` — parsed against the
 * allow-list of what exists RIGHT NOW (listed Settings sections, routes with a
 * screen, the studios). Anything else is refused: `navigate` returns false and
 * nothing moves. A link can only navigate; it never changes anything.
 *
 * `focusSettingId` is the Settings row a link asked for. BH-2 reads it to
 * scroll the row into view and pulse it; until then it is carried, not used.
 */
import { create } from 'zustand';
import { type NavAllowList, type NavTarget, parseBobbleLink } from './bobble-link';

export type { NavTarget } from './bobble-link';

export interface NavRequest {
  readonly target: NavTarget;
  /** Increments per request, so the same target twice is two navigations. */
  readonly seq: number;
}

interface AppNavState {
  /** The latest request, until App takes it. */
  readonly pending: NavRequest | null;
  /** The Settings row the last settings link named, if any. */
  readonly focusSettingId: string | null;
  /** The tab the last view link named (`models?tab=storage`), if any. */
  readonly viewTab: string | null;
  /** Ask the app to go somewhere. False when the target is not allowed. */
  navigate: (target: NavTarget | string) => boolean;
  /** App: take the pending request (and clear it). */
  take: () => NavRequest | null;
  /** A screen that has used `focusSettingId` / `viewTab` clears it. */
  clearFocus: () => void;
}

/*
 * WHAT MAY BE LINKED TO is read from the registries themselves (listed Settings
 * sections, routes with a screen) — which import every panel and screen, so
 * this store does not: App installs the reader (src/nav-allow.ts) at boot, and
 * until it has, only the chat is a destination. A store that imported the
 * screens would be one import away from a cycle with any screen that navigates.
 */
const NOTHING_YET: NavAllowList = { settingsSections: [], views: {}, studios: [] };
let allowList: () => NavAllowList = () => NOTHING_YET;

/** App: install the reader of what exists (see src/nav-allow.ts). */
export function setNavAllowList(reader: () => NavAllowList): () => void {
  const previous = allowList;
  allowList = reader;
  return () => {
    allowList = previous;
  };
}

/** What may be linked to at this moment. */
export function currentAllowList(): NavAllowList {
  return allowList();
}

/** A target as given, or parsed from a link; null when not allowed. */
export function resolveNavTarget(target: NavTarget | string): NavTarget | null {
  if (typeof target === 'string') return parseBobbleLink(target, currentAllowList());
  // An object target is re-checked through the same allow-list as a link.
  const allow = currentAllowList();
  switch (target.kind) {
    case 'chat':
      return target;
    case 'settings':
      return allow.settingsSections.includes(target.section) ? target : null;
    case 'view':
      return allow.views[target.view] !== undefined &&
        (target.tab === undefined || (allow.views[target.view] ?? []).includes(target.tab))
        ? target
        : null;
    case 'studio':
      return allow.studios.includes(target.studio) ? target : null;
    case 'guide':
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.id) ? target : null;
  }
}

let seq = 0;

export const useAppNavStore = create<AppNavState>()((set, get) => ({
  pending: null,
  focusSettingId: null,
  viewTab: null,
  navigate: (raw) => {
    const target = resolveNavTarget(raw);
    if (target === null) return false;
    seq += 1;
    set({
      pending: { target, seq },
      focusSettingId: target.kind === 'settings' ? (target.settingId ?? null) : null,
      viewTab: target.kind === 'view' ? (target.tab ?? null) : null,
    });
    return true;
  },
  take: () => {
    const req = get().pending;
    if (req !== null) set({ pending: null });
    return req;
  },
  clearFocus: () => set({ focusSettingId: null, viewTab: null }),
}));

/** Navigate from anywhere (a link click, a card button). */
export function navigate(target: NavTarget | string): boolean {
  return useAppNavStore.getState().navigate(target);
}

/*
 * What App cannot do itself — a guide page opens in the canvas (BH-3/BH-7) —
 * is a handler a feature registers for that kind. Without one, such a target
 * is accepted and dropped, never a crash.
 */
type ExtraKind = 'guide';
const handlers = new Map<ExtraKind, (target: NavTarget) => void>();

export function registerNavHandler(
  kind: ExtraKind,
  handler: (target: NavTarget) => void,
): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

export function navHandler(kind: ExtraKind): ((target: NavTarget) => void) | undefined {
  return handlers.get(kind);
}
