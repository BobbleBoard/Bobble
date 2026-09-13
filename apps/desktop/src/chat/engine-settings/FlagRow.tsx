/**
 * One engine flag as a control. The control is decided by what the engine's
 * own `--help` said the flag takes: nothing → a switch; `N` → a number;
 * `<0|1>` / `[on|off|auto]` / an "allowed values" list → a select; a file
 * placeholder → a path with a Choose… button; anything else → text.
 *
 * Unset is a real state ("the engine's default"), shown as the default value
 * in the placeholder and a dimmed row — a user should be able to see at a
 * glance which of 250 flags they have touched.
 */
import { IconClose } from '@pi-desktop/ui';
import type { LlmInvokeMap } from '../../../electron/ipc-contract';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';

export type FlagSpec = LlmInvokeMap['llm:engine-flags']['response']['flags'][number];

export function FlagRow({
  flag,
  value,
  running,
  managed,
  onChange,
  onPickPath,
}: {
  flag: FlagSpec;
  /** The user's value, or undefined for "engine default". */
  value: EngineFlagValue | undefined;
  /** What the running server has for it right now (off its argv), if anything. */
  running: string | null;
  managed?: 'refused' | 'override';
  onChange: (value: EngineFlagValue | null) => void;
  onPickPath?: () => Promise<string | null>;
}) {
  const set = value !== undefined;
  const control = flag.control;
  const placeholder = flag.defaultValue !== undefined ? `default: ${flag.defaultValue}` : '';
  return (
    <div
      className="pd-flag-row"
      data-testid={`flag-${flag.key}`}
      data-set={set ? 'yes' : 'no'}
      data-managed={managed ?? 'no'}
    >
      <div className="pd-flag-main">
        <div className="pd-flag-head">
          <code className="pd-flag-key">{flag.key}</code>
          {flag.aliases
            .filter((a) => a !== flag.key)
            .map((a) => (
              <code key={a} className="pd-flag-alias">
                {a}
              </code>
            ))}
          {managed === 'refused' ? (
            <span className="pd-flag-chip pd-flag-chip--warn">set by Bobble</span>
          ) : managed === 'override' ? (
            <span className="pd-flag-chip" title="Bobble sets this itself; your value replaces it">
              Bobble default
            </span>
          ) : null}
          {running !== null ? (
            <span className="pd-flag-chip pd-flag-chip--running" title="On the running server">
              now: {running}
            </span>
          ) : null}
        </div>
        <div className="pd-flag-desc">{flag.description}</div>
      </div>
      <div className="pd-flag-control">
        {managed === 'refused' ? (
          <span className="pd-flag-locked">{running ?? '—'}</span>
        ) : control.kind === 'switch' ? (
          <label className="pd-flag-switch">
            <input
              type="checkbox"
              aria-label={flag.key}
              checked={value === true}
              onChange={(e) => onChange(e.target.checked ? true : null)}
            />
            <span>{value === true ? 'on' : 'default'}</span>
          </label>
        ) : control.kind === 'select' ? (
          <select
            className="pd-input pd-focusable pd-flag-select"
            aria-label={flag.key}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">
              {flag.defaultValue !== undefined ? `default (${flag.defaultValue})` : 'default'}
            </option>
            {control.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : control.kind === 'number' ? (
          <input
            type="number"
            className="pd-input pd-focusable pd-flag-input"
            aria-label={flag.key}
            placeholder={placeholder}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') onChange(null);
              else if (Number.isFinite(Number(raw))) onChange(Number(raw));
            }}
          />
        ) : (
          <input
            type="text"
            className="pd-input pd-focusable pd-flag-input"
            aria-label={flag.key}
            placeholder={placeholder}
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
          />
        )}
        {control.kind === 'path' && onPickPath !== undefined && managed !== 'refused' ? (
          <button
            type="button"
            className="pd-flag-pick"
            onClick={() => void onPickPath().then((p) => p !== null && onChange(p))}
          >
            Choose…
          </button>
        ) : null}
        {set && managed !== 'refused' ? (
          <button
            type="button"
            className="pd-flag-clear"
            aria-label={`Clear ${flag.key}`}
            title="Back to the engine default"
            onClick={() => onChange(null)}
          >
            <IconClose size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
