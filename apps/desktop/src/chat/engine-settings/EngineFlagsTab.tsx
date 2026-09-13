/**
 * Every flag the engine has, organised: a search box, the popular ones on
 * top, then the categories (collapsible, counted). Nothing here is a curated
 * subset — the list is the engine's own `--help`, which is the only way the
 * panel can honestly claim "absolutely everything".
 */
import { groupFlags, MANAGED_LLAMA_FLAGS } from '@pi-desktop/inference/engine-flags';
import { useMemo, useState } from 'react';
import type { LlmStatus } from '../../../electron/ipc-contract';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';
import type { EngineFlagsView } from '../../state/llm-store';
import {
  type FlagValues,
  flagMatches,
  POPULAR_LLAMA_FLAGS,
  runningValue,
} from './engine-settings-logic';
import { FlagRow, type FlagSpec, type PathSource } from './FlagRow';

export function EngineFlagsTab({
  engine,
  help,
  values,
  status,
  onChange,
  onPath,
}: {
  engine: string;
  help: EngineFlagsView | null;
  values: FlagValues;
  status: LlmStatus;
  onChange: (key: string, value: EngineFlagValue | null) => void;
  onPath: (flag: FlagSpec, source: PathSource) => Promise<string | null>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const flags = help?.flags ?? [];
  const managed = engine === 'llamacpp' ? MANAGED_LLAMA_FLAGS : {};
  const q = query.trim();
  const filtered = useMemo(() => flags.filter((f) => flagMatches(f, q)), [flags, q]);
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

  if (help === null) {
    return <p className="pd-engine-note">Reading {engine}’s own --help…</p>;
  }
  if (help.error !== undefined && flags.length === 0) {
    return <p className="pd-engine-note">{help.error}</p>;
  }
  const row = (f: (typeof flags)[number]) => (
    <FlagRow
      key={f.key}
      flag={f}
      value={values[f.key]}
      running={runningValue(status, f.aliases)}
      managed={managed[f.key]}
      onChange={(v) => onChange(f.key, v)}
      onPath={onPath}
    />
  );
  return (
    <div className="pd-flags" data-testid="engine-flags-tab">
      <div className="pd-flags-toolbar">
        <input
          type="search"
          className="pd-input pd-focusable pd-flags-search"
          placeholder={`Search ${flags.length} flags…`}
          aria-label="Search flags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="engine-flags-search"
        />
        <span className="pd-flags-count" data-testid="engine-flags-set-count">
          {setCount === 0 ? 'engine defaults' : `${setCount} set`}
        </span>
      </div>
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
      {filtered.length === 0 ? <p className="pd-engine-note">No flag matches “{q}”.</p> : null}
    </div>
  );
}
