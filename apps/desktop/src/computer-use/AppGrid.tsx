/**
 * THE APP CHOOSER — a grid of the Mac's real app icons with names under them,
 * each a tile you tick to let Bobble use that app without asking.
 *
 * the user (2026-09-15): "a UI on onboarding for computer use on/off and then if
 * on choose what apps to allow control of, show this as a grid of real app
 * icons w/ names below, this is editable later in settings via a similar UI."
 *
 * ONE component for both places: onboarding's step and Settings → Computer
 * use render this with the same value shape the setting stores
 * (`{ id, name }[]`), so what a person picked on day one is exactly what they
 * see and edit later. The icons are the ones Finder draws — the `pi-mac`
 * helper renders them at 128 px (see electron/mac/mac-apps.ts) and they
 * arrive as data URLs.
 *
 * A hundred apps is normal, so there is a filter box; the familiar apps come
 * first (Safari, Chrome, Finder, Notes …) and the rest follow by name. The
 * grid scrolls inside its own box: a hundred tiles must never push the
 * step's Next button, or a settings row, off the screen.
 */
import { IconCheck, IconSearch } from '@pi-desktop/ui';
import { useEffect, useMemo, useState } from 'react';
import type { ComputerUseApp } from '../../electron/settings/settings-contract';
import { cx } from '../onboarding/cx';

export interface InstalledApp {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly icon: string | null;
}

/* One listing per renderer: the helper walks /Applications once, and the
   chooser can be opened from onboarding, closed, and opened again from
   Settings without paying for it twice. */
let cached: Promise<readonly InstalledApp[]> | null = null;
export function loadInstalledApps(refresh = false): Promise<readonly InstalledApp[]> {
  if (cached === null || refresh) {
    cached = window.piDesktop
      .invoke('mac:list-apps', refresh ? { refresh: true } : undefined)
      .then((r) => r.apps)
      .catch(() => {
        cached = null;
        return [];
      });
  }
  return cached;
}

/** Test seam: a probe can hand the grid a list without a helper on the machine. */
export function primeInstalledApps(apps: readonly InstalledApp[]): void {
  cached = Promise.resolve(apps);
}

export interface AppGridProps {
  readonly selected: readonly ComputerUseApp[];
  readonly onChange: (next: ComputerUseApp[]) => void;
  /** Greyed and inert — the grid stays visible under an "off" switch so the
   * choice is not lost, but nothing in it can be pressed. */
  readonly disabled?: boolean;
  /** Tile size: onboarding has the room for the larger one. */
  readonly size?: 'md' | 'lg';
  /** The grid's own scroll box height (CSS length). */
  readonly maxHeight?: string;
  readonly testid?: string;
}

export function AppGrid({
  selected,
  onChange,
  disabled = false,
  size = 'md',
  maxHeight = '340px',
  testid,
}: AppGridProps) {
  const [apps, setApps] = useState<readonly InstalledApp[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let live = true;
    void loadInstalledApps().then((list) => {
      if (live) setApps(list);
    });
    return () => {
      live = false;
    };
  }, []);

  const picked = useMemo(() => new Set(selected.map((a) => a.id.toLowerCase())), [selected]);
  const shown = useMemo(() => {
    if (apps === null) return [];
    const q = query.trim().toLowerCase();
    return q === '' ? apps : apps.filter((a) => a.name.toLowerCase().includes(q));
  }, [apps, query]);

  const toggle = (app: InstalledApp) => {
    if (disabled) return;
    const key = app.id.toLowerCase();
    if (picked.has(key)) {
      onChange(selected.filter((a) => a.id.toLowerCase() !== key));
    } else {
      onChange([...selected, { id: app.id, name: app.name }]);
    }
  };

  // Fixed class strings: Tailwind only emits what it can read in the source.
  const columns =
    size === 'lg'
      ? 'grid-cols-[repeat(auto-fill,minmax(104px,1fr))]'
      : 'grid-cols-[repeat(auto-fill,minmax(92px,1fr))]';
  const iconPx = size === 'lg' ? 64 : 52;

  return (
    <div
      className={cx('flex flex-col gap-3', disabled && 'pointer-events-none opacity-45')}
      data-testid={testid}
      aria-disabled={disabled}
    >
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted">
            <IconSearch />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an app"
            aria-label="Find an app"
            data-testid="app-grid-filter"
            className="h-9 w-full rounded-lg border border-border-default bg-bg-inset pl-9 pr-3 text-body text-text-primary placeholder:text-text-muted focus:border-border-focus focus:outline-none"
          />
        </label>
        <span className="shrink-0 text-footnote text-text-muted" data-testid="app-grid-count">
          {selected.length === 0
            ? 'None chosen'
            : `${selected.length} ${selected.length === 1 ? 'app' : 'apps'}`}
        </span>
      </div>
      <div
        className="pd-scroll overflow-y-auto rounded-lg border border-border-subtle p-1.5"
        style={{ maxHeight }}
      >
        {apps === null ? (
          <div className={cx('grid gap-2', columns)} data-testid="app-grid-loading">
            {Array.from({ length: 12 }, (_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholders, nothing to identify
                key={i}
                className="flex h-[108px] animate-pulse flex-col items-center justify-center gap-2 rounded-lg bg-bg-inset"
              >
                <div className="rounded-xl bg-bg-hover" style={{ width: iconPx, height: iconPx }} />
                <div className="h-2 w-12 rounded bg-bg-hover" />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p
            className="py-6 text-center text-footnote text-text-muted"
            data-testid="app-grid-empty"
          >
            {apps.length === 0
              ? 'No apps could be listed on this Mac.'
              : `Nothing matches “${query}”.`}
          </p>
        ) : (
          <fieldset className={cx('m-0 grid gap-2 border-0 p-0', columns)}>
            <legend className="sr-only">Apps Bobble may use</legend>
            {shown.map((app) => {
              const on = picked.has(app.id.toLowerCase());
              return (
                <button
                  key={app.id}
                  type="button"
                  aria-pressed={on}
                  data-testid={`app-tile-${app.id}`}
                  data-selected={on}
                  title={app.name}
                  onClick={() => toggle(app)}
                  className={cx(
                    'group relative flex flex-col items-center gap-1.5 rounded-lg border px-1.5 pb-2 pt-3 text-center transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                    on
                      ? 'border-border-focus bg-accent-subtle'
                      : 'border-transparent hover:border-border-default hover:bg-bg-hover',
                  )}
                >
                  {on ? (
                    <span
                      className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent-primary text-text-on-accent"
                      aria-hidden="true"
                    >
                      <IconCheck size={12} />
                    </span>
                  ) : null}
                  {app.icon !== null ? (
                    <img
                      src={app.icon}
                      alt=""
                      width={iconPx}
                      height={iconPx}
                      draggable={false}
                      className="select-none"
                      style={{ width: iconPx, height: iconPx }}
                    />
                  ) : (
                    <span
                      className="flex items-center justify-center rounded-xl bg-bg-inset text-heading text-text-muted"
                      style={{ width: iconPx, height: iconPx }}
                    >
                      {app.name.slice(0, 1)}
                    </span>
                  )}
                  <span className="line-clamp-2 w-full text-footnote leading-tight text-text-primary">
                    {app.name}
                  </span>
                </button>
              );
            })}
          </fieldset>
        )}
      </div>
    </div>
  );
}
