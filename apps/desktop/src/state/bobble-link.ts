/**
 * `bobble:` LINKS — where in the app a link may take you, and nothing else.
 *
 * Bobble help answers "where is that setting?" with a link that goes there
 * (deliverables/research/bobble-help.md §4.7), guide pages link to each other,
 * and a workflow card links to its settings. So the app gets a link scheme:
 *
 *   bobble://settings/<section>#<setting-id>   Settings, open at a section
 *   bobble://view/<view>?tab=<tab>             a workspace screen (Model management…)
 *   bobble://studio/<studio>                   a studio
 *   bobble://guide/<page>                      a guide page
 *   bobble://chat                              back to the chat
 *
 * A LINK CAN ONLY NAVIGATE. It never changes a setting, never starts anything,
 * and anything not on the allow-list is refused — parsing returns null, the
 * caller does nothing. The allow-list is data (`NavAllowList`), so a section or
 * a screen that ships later becomes linkable by being listed there, not by an
 * edit to this parser. Pure: no React, no store — unit-tested.
 *
 * The short form a probe or a registry entry writes — `settings:appearance#theme.mode`,
 * `view:models?tab=storage` — is the same address without the `bobble://`.
 */

export type StudioId = 'image' | 'video' | 'audio' | '3d';

export type NavTarget =
  | { readonly kind: 'settings'; readonly section: string; readonly settingId?: string }
  | { readonly kind: 'view'; readonly view: string; readonly tab?: string }
  | { readonly kind: 'studio'; readonly studio: StudioId }
  | { readonly kind: 'guide'; readonly id: string }
  | { readonly kind: 'chat' };

export interface NavAllowList {
  /** Settings sections a link may open. */
  readonly settingsSections: readonly string[];
  /** Workspace screens a link may open, each with the tabs it accepts. */
  readonly views: Readonly<Record<string, readonly string[]>>;
  readonly studios: readonly StudioId[];
}

const SETTING_ID = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/;
const GUIDE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LINK = 256;

/**
 * Parse a `bobble://…` link (or its short form) against an allow-list.
 * Returns the target, or null for anything it does not recognise exactly.
 */
export function parseBobbleLink(link: string, allow: NavAllowList): NavTarget | null {
  if (typeof link !== 'string' || link.length === 0 || link.length > MAX_LINK) return null;
  let rest: string;
  if (link.startsWith('bobble://')) {
    rest = link.slice('bobble://'.length);
  } else {
    // The short form: `<kind>:<path>` → `<kind>/<path>`.
    const m = /^(settings|view|studio|guide|chat)(?::(.*))?$/.exec(link);
    if (m === null) return null;
    rest = m[2] === undefined ? (m[1] as string) : `${m[1]}/${m[2]}`;
  }
  // Nothing that could smuggle a second location or an escape in.
  if (/[\s\\%<>"'`]/.test(rest) || rest.includes('..') || rest.includes('//')) return null;

  const hashAt = rest.indexOf('#');
  const hash = hashAt === -1 ? undefined : rest.slice(hashAt + 1);
  const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const query = queryAt === -1 ? undefined : beforeHash.slice(queryAt + 1);
  const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const segments = pathPart.split('/');
  const [kind, target, ...extra] = segments;
  if (extra.length > 0) return null;

  switch (kind) {
    case 'chat':
      return target === undefined && query === undefined && hash === undefined
        ? { kind: 'chat' }
        : null;
    case 'settings': {
      if (target === undefined || query !== undefined) return null;
      if (!allow.settingsSections.includes(target)) return null;
      if (hash === undefined || hash === '') return { kind: 'settings', section: target };
      return SETTING_ID.test(hash) && hash.length <= 64
        ? { kind: 'settings', section: target, settingId: hash }
        : null;
    }
    case 'view': {
      if (target === undefined || hash !== undefined) return null;
      const tabs = allow.views[target];
      if (tabs === undefined) return null;
      if (query === undefined || query === '') return { kind: 'view', view: target };
      const m = /^tab=([a-z0-9-]+)$/.exec(query);
      if (m === null || !tabs.includes(m[1] as string)) return null;
      return { kind: 'view', view: target, tab: m[1] as string };
    }
    case 'studio': {
      if (target === undefined || query !== undefined || hash !== undefined) return null;
      return (allow.studios as readonly string[]).includes(target)
        ? { kind: 'studio', studio: target as StudioId }
        : null;
    }
    case 'guide': {
      if (target === undefined || query !== undefined || hash !== undefined) return null;
      return GUIDE_ID.test(target) && target.length <= 48 ? { kind: 'guide', id: target } : null;
    }
    default:
      return null;
  }
}

/** The link that addresses a target — the inverse of {@link parseBobbleLink}. */
export function bobbleLink(target: NavTarget): string {
  switch (target.kind) {
    case 'chat':
      return 'bobble://chat';
    case 'settings':
      return `bobble://settings/${target.section}${target.settingId === undefined ? '' : `#${target.settingId}`}`;
    case 'view':
      return `bobble://view/${target.view}${target.tab === undefined ? '' : `?tab=${target.tab}`}`;
    case 'studio':
      return `bobble://studio/${target.studio}`;
    case 'guide':
      return `bobble://guide/${target.id}`;
  }
}
