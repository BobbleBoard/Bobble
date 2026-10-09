/**
 * REAL APP ICONS, fetched once and kept.
 *
 * The user: "you can get the real app icon of any program being used right? so just
 * use that no emoji." macOS has the icon for every bundle, so a row that says
 * "Snapshotted Google Chrome" can show Chrome rather than a glyph that looks
 * the same for every app.
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
        const res = await window.piDesktop.invoke('mac:debug', {
          op: 'app-icon',
          params: { app: key },
        });
        const r = (res as { result?: { base64?: string; mimeType?: string } } | undefined)?.result;
        const src =
          r?.base64 === undefined ? null : `data:${r.mimeType ?? 'image/png'};base64,${r.base64}`;
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
  if (app === undefined || app === '') return undefined;
  const store = useAppIconStore.getState();
  store.ensure(app);
  return store.icons[app] ?? undefined;
}
