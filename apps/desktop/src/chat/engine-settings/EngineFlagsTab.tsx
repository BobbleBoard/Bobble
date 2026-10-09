/**
 * THE FLAGS TAB: every flag the engine has, organised — the search on top
 * (The user: "make a separate tab for Flags with the search bar at the top"),
 * which engine beside it, the popular ones first, then the categories
 * (collapsible, counted). Nothing here is a curated subset — the list is the
 * engine's own `--help`, which is the only way the panel can honestly claim
 * "absolutely everything". Each row is a setting with a real name; the flag
 * itself is in its ⓘ.
 */
import { groupFlags, MANAGED_LLAMA_FLAGS } from '@pi-desktop/inference/engine-flags';
import { sayIfRaw } from '@pi-desktop/shared';
import { useMemo, useState } from 'react';
import { EngineSelect } from './EngineSelect';
import { flagMatches, POPULAR_LLAMA_FLAGS, runningValue } from './engine-settings-logic';
import { FlagRow } from './FlagRow';
import { flagLabel } from './flag-names';
import type { EngineDraft } from './use-engine-draft';

export function EngineFlagsTab({ d }: { d: EngineDraft }) {
  const { engine, help, status } = d;
  const values = d.draft.flags;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const flags = help?.flags ?? [];
  const managed = engine === 'llamacpp' ? MANAGED_LLAMA_FLAGS : {};
  const q = query.trim();
  // A search matches the name people see as well as the flag they may know.
  const filtered = useMemo(
    () =>
      flags.filter(
        (f) => flagMatches(f, q) || flagLabel(f).toLowerCase().includes(q.toLowerCase()),
      ),
    [flags, q],
  );
  const groups = useMemo(() => groupFlags(filtered), [filtered]);
  const popular = useMemo(
    () =>
      engine === 'llamacpp' && q.length === 0
        ? POPULAR_LLAMA_FLAGS.map((k) => flags.find((f) => f.key === k)).filter(
            (f): f is NonNullable<typeof f> => f !== undefined,
          )
        : [],
    [engine, flags, q],
  );
  const setCount = Object.keys(values).length;

  const row = (f: (typeof flags)[number]) => (
    <FlagRow
      key={f.key}
      flag={f}
      value={values[f.key]}
      running={runningValue(status, f.aliases)}
      managed={managed[f.key]}
      onChange={(v) => d.setFlagValue(f.key, v)}
      onPath={d.resolvePath}
    />
  );
  return (
    <div className="pd-flags" data-testid="engine-flags-tab">
      <div className="pd-flags-toolbar">
        <input
          type="search"
          className="pd-input pd-focusable pd-flags-search"
          placeholder={flags.length > 0 ? `Search ${flags.length} settings…` : 'Search…'}
          aria-label="Search flags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="engine-flags-search"
        />
        <span className="pd-flags-count" data-testid="engine-flags-set-count">
          {setCount === 0 ? 'engine defaults' : `${setCount} set`}
        </span>
        <EngineSelect
          engine={engine}
          choices={d.choices}
          runningEngine={d.runningEngine}
          serverRunning={status.serverRunning}
          onChange={d.setEngine}
          testId="engine-flags-engine"
        />
      </div>
      {help === null ? (
        <p className="pd-engine-note">Reading {engine}’s own --help…</p>
      ) : help.error !== undefined && flags.length === 0 ? (
        <p className="pd-engine-note">{sayIfRaw(help.error, 'engine')}</p>
      ) : null}
      {popular.length > 0 ? (
        <section className="pd-flags-group" data-testid="engine-flags-popular">
          <h4 className="pd-flags-group-title">Popular</h4>
          <div className="pd-flags-list">{popular.map(row)}</div>
        </section>
      ) : null}
      {groups.map((g) => {
        const expanded = q.length > 0 || open[g.category] === true;
        return (
          <section
            key={g.category}
            className="pd-flags-group"
            data-testid={`engine-flags-group-${g.category}`}
          >
            <button
              type="button"
              className="pd-flags-group-toggle"
              aria-expanded={expanded}
              onClick={() => setOpen((o) => ({ ...o, [g.category]: !expanded }))}
            >
              <span className="pd-flags-group-title">{g.category}</span>
              <span className="pd-flags-group-count">
                {g.flags.filter((f) => values[f.key] !== undefined).length > 0
                  ? `${g.flags.filter((f) => values[f.key] !== undefined).length} set · `
                  : ''}
                {g.flags.length}
              </span>
              <span className="pd-flags-group-chevron" aria-hidden>
                {expanded ? '▾' : '▸'}
              </span>
            </button>
            {expanded ? <div className="pd-flags-list">{g.flags.map(row)}</div> : null}
          </section>
        );
      })}
      {help !== null && filtered.length === 0 && flags.length > 0 ? (
        <p className="pd-engine-note">No setting matches “{q}”.</p>
      ) : null}
    </div>
  );
}
