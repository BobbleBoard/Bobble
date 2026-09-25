/**
 * WHAT A LINK MAY OPEN, read from the registries (the W0-A pre-wire): the
 * Settings sections in the nav, the workspace screens that have a view, the
 * studios. A section or a screen that ships later becomes a destination by
 * being there — this list is never edited for it. App installs it into the
 * nav store at boot (state/app-nav-store.ts `setNavAllowList`).
 */
import { availableRoutes } from './routes';
import { SETTINGS_NAV } from './settings/sections';
import type { NavAllowList } from './state/bobble-link';

/** Tabs a view link may name (`bobble://view/models?tab=storage`). */
const VIEW_TABS: Readonly<Record<string, readonly string[]>> = {
  models: ['discover', 'device', 'storage'],
};

export function appNavAllowList(): NavAllowList {
  return {
    settingsSections: SETTINGS_NAV.map((s) => s.id),
    views: Object.fromEntries(availableRoutes().map((v) => [v, VIEW_TABS[v] ?? []])),
    studios: ['image', 'video', 'audio', '3d'],
  };
}
