/**
 * REAL APP ICONS, fetched once and kept.
 *
 * The user: "you can get the real app icon of any program being used right? so just
 * use that no emoji." macOS has the icon for every bundle, so a row that says
 * "Snapshotted Google Chrome" can show Chrome rather than a glyph that looks
 * the same for every app.
 *
 * Main answers over `mac:app-icon` (electron/mac/app-icon-source.ts). This used
 * to ask the probes' `mac:debug` channel, which has no handler outside a test
 * run — so in the shipped app every ask failed and no row ever had its icon.
 *
 * A module cache plus a version counter, because the icon arrives long after
 * the row that wants it is first rendered: the chain asks synchronously, gets
 * `undefined`, and the store's bump re-renders it with the picture. Failures
 * are remembered too — an app with no icon must not be asked on every frame.
 */
import { create } from 'zustand';

interface AppIconState {
  readonly icons: Readonly<Record<string, string | null>>;
  ensure(app: string): void;
}

const inFlight = new Set<string>();

export const useAppIconStore = create<AppIconState>((set, get) => ({
  icons: {},
  ensure(app: string): void {
    const key = app.trim();
    if (key === '' || key in get().icons || inFlight.has(key)) return;
    inFlight.add(key);
    void (async () => {
      try {
        const res = await window.piDesktop.invoke('mac:app-icon', { app: key });
        const src = typeof res?.icon === 'string' && res.icon !== '' ? res.icon : null;
        set((s) => ({ icons: { ...s.icons, [key]: src } }));
      } catch {
        set((s) => ({ icons: { ...s.icons, [key]: null } }));
      } finally {
        inFlight.delete(key);
      }
    })();
  },
}));

/** The icon for `app`, asking for it the first time it is wanted. */
export function appIconSrc(app: string | undefined): string | undefined {
  const key = app?.trim() ?? '';
  if (key === '') return undefined;
  const store = useAppIconStore.getState();
  store.ensure(key);
  return store.icons[key] ?? undefined;
}
