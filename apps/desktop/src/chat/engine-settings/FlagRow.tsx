/**
 * One engine flag as a control. The control is decided by what the engine's
 * own `--help` said the flag takes: nothing → a switch; `N` → a number;
 * `<0|1>` / `[on|off|auto]` / an "allowed values" list → a select; a file
 * placeholder → a path with a Choose… button; anything else → text.
 *
 * Unset is a real state ("the engine's default"), shown as the default value
 * in the placeholder and a dimmed row — a user should be able to see at a
 * glance which of 250 flags they have touched.
 *
 * A path flag's whole row is a drop target: drop the file on it and the path
 * is filled in (the user: "have a drag and drop or upload custom chat template").
 * The chat-template row says Upload rather than Choose because the file is
 * copied into Bobble's storage on the way (see `llm:import-chat-template`).
 */
import { IconClose } from '@pi-desktop/ui';
import { useState } from 'react';
import type { LlmInvokeMap } from '../../../electron/ipc-contract';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';

export type FlagSpec = LlmInvokeMap['llm:engine-flags']['response']['flags'][number];

/** Where a path came from: the native picker, or a file dropped on the row. */
export type PathSource = { kind: 'pick' } | { kind: 'drop'; path: string };

export const CHAT_TEMPLATE_FLAG = '--chat-template-file';

export function FlagRow({
  flag,
  value,
  running,
  managed,
  onChange,
  onPath,
}: {
  flag: FlagSpec;
  /** The user's value, or undefined for "engine default". */
  value: EngineFlagValue | undefined;
  /** What the running server has for it right now (off its argv), if anything. */
  running: string | null;
  managed?: 'refused' | 'override';
  onChange: (value: EngineFlagValue | null) => void;
  /** Resolve a path for a path-kind flag (picker or drop); null when nothing came of it. */
  onPath?: (flag: FlagSpec, source: PathSource) => Promise<string | null>;
}) {
  const set = value !== undefined;
  const control = flag.control;
  const placeholder = flag.defaultValue !== undefined ? `default: ${flag.defaultValue}` : '';
  const [dragging, setDragging] = useState(false);
  const isTemplate = flag.key === CHAT_TEMPLATE_FLAG;
  const droppable = control.kind === 'path' && onPath !== undefined && managed !== 'refused';
  const resolve = (source: PathSource) => {
    if (onPath === undefined) return;
    void onPath(flag, source).then((p) => {
      if (p !== null) onChange(p);
    });
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target is the row; the controls inside it are real controls
    <div
      className={`pd-flag-row${dragging ? ' pd-flag-row--drop' : ''}`}
      data-testid={`flag-${flag.key}`}
      data-set={set ? 'yes' : 'no'}
      data-managed={managed ?? 'no'}
      data-droppable={droppable ? 'yes' : 'no'}
      onDragOver={
        droppable
          ? (e) => {
              e.preventDefault();
              setDragging(true);
            }
          : undefined
      }
      onDragLeave={droppable ? () => setDragging(false) : undefined}
      onDrop={
        droppable
          ? (e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file === undefined) return;
              const p = window.piDesktop.pathForFile(file);
              if (p.length > 0) resolve({ kind: 'drop', path: p });
            }
          : undefined
      }
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
        {droppable ? (
          <div className="pd-flag-drop-hint" data-testid={`flag-drop-hint-${flag.key}`}>
            {isTemplate
              ? 'Drop a .jinja template on this row or Upload… — Bobble keeps its own copy.'
              : 'Drop a file on this row, or Choose…'}
          </div>
        ) : null}
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
        {droppable ? (
          <button
            type="button"
            className="pd-flag-pick"
            onClick={() => resolve({ kind: 'pick' })}
            data-testid={`flag-pick-${flag.key}`}
          >
            {isTemplate ? 'Upload…' : 'Choose…'}
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
