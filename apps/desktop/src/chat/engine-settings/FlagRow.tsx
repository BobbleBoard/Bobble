/**
 * One engine flag as a control. The control is decided by what the engine's
 * own `--help` said the flag takes: nothing → a switch; `N` → a number;
 * `<0|1>` / `[on|off|auto]` / an "allowed values" list → a select; a file
 * placeholder → a path with a Choose… button; anything else → text.
 *
 * The row reads as a SETTING, not a flag: a real name (flag-names.ts), the
 * engine's default sitting IN the control as the value to edit, and an ⓘ
 * that says what it does and which flag is passed. the user (2026-09-13): "show
 * the defaults, don't write 'default' … so the user can edit rather than
 * showing them as placeholder text", "don't show … their literal flag names".
 * Unset is still a real state ("the engine's default"): a row lights up only
 * once its value differs from that, and × puts it back.
 *
 * A path flag's whole row is a drop target: drop the file on it and the path
 * is filled in (the user: "have a drag and drop or upload custom chat template").
 * The chat-template row says Upload rather than Choose because the file is
 * copied into Bobble's storage on the way (see `llm:import-chat-template`).
 */
import { IconClose, Select, SelectContent, SelectItem, SelectTrigger } from '@pi-desktop/ui';
import { useState } from 'react';
import type { LlmInvokeMap } from '../../../electron/ipc-contract';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';
import { defaultShown } from './engine-settings-logic';
import { flagLabel } from './flag-names';
import { InfoDot } from './InfoDot';

export type FlagSpec = LlmInvokeMap['llm:engine-flags']['response']['flags'][number];

/** Where a path came from: the native picker, or a file dropped on the row. */
export type PathSource = { kind: 'pick' } | { kind: 'drop'; path: string };

export const CHAT_TEMPLATE_FLAG = '--chat-template-file';

/** The ⓘ contents for a flag: what it does, then the flag itself. */
export function FlagInfo({ flag, extra }: { flag: FlagSpec; extra?: string }) {
  return (
    <>
      <p>{flag.description}</p>
      {extra !== undefined ? <p>{extra}</p> : null}
      <p className="pd-info-tip-flag">
        <code>{flag.aliases.length > 0 ? flag.aliases.join(', ') : flag.key}</code>
        {flag.defaultValue !== undefined ? ` · default ${flag.defaultValue}` : ''}
      </p>
    </>
  );
}

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
  const label = flagLabel(flag);
  // The engine's default sits in the control as the value to edit.
  const engineDefault = defaultShown(flag.defaultValue, control.kind);
  const shown = value !== undefined ? String(value) : engineDefault;
  const [dragging, setDragging] = useState(false);
  const isTemplate = flag.key === CHAT_TEMPLATE_FLAG;
  const droppable = control.kind === 'path' && onPath !== undefined && managed !== 'refused';
  const resolve = (source: PathSource) => {
    if (onPath === undefined) return;
    void onPath(flag, source).then((p) => {
      if (p !== null) onChange(p);
    });
  };
  /* Typing the default back in is the same as clearing: the row is "set" only
     when its value differs from the engine's own. */
  const commit = (raw: string) => {
    if (raw === '' || raw === engineDefault) onChange(null);
    else if (control.kind === 'number') {
      if (Number.isFinite(Number(raw))) onChange(Number(raw));
    } else onChange(raw);
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
          <span className="pd-flag-name" data-testid={`flag-name-${flag.key}`}>
            {label}
          </span>
          <InfoDot label={label} testId={`flag-info-${flag.key}`}>
            <FlagInfo
              flag={flag}
              extra={
                droppable
                  ? isTemplate
                    ? 'Drop a .jinja template on this row or Upload… — Bobble keeps its own copy.'
                    : 'Drop a file on this row, or Choose…'
                  : undefined
              }
            />
          </InfoDot>
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
      </div>
      <div className="pd-flag-control">
        {managed === 'refused' ? (
          <span className="pd-flag-locked">{running ?? '—'}</span>
        ) : control.kind === 'switch' ? (
          <label className="pd-flag-switch">
            <input
              type="checkbox"
              aria-label={label}
              checked={value === true}
              onChange={(e) => onChange(e.target.checked ? true : null)}
            />
            <span>{value === true ? 'on' : 'off'}</span>
          </label>
        ) : control.kind === 'select' ? (
          <Select value={shown} onValueChange={(v) => commit(v)}>
            <SelectTrigger
              className="pd-btn--sm pd-flag-select"
              aria-label={label}
              placeholder="—"
              data-testid={`flag-select-${flag.key}`}
            >
              {shown === '' ? '—' : shown}
            </SelectTrigger>
            <SelectContent align="end">
              {(control.options.includes(shown) || shown === ''
                ? control.options
                : [shown, ...control.options]
              ).map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                  {o === engineDefault ? ' (default)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : control.kind === 'number' ? (
          <input
            type="number"
            className="pd-input pd-focusable pd-flag-input"
            aria-label={label}
            value={shown}
            onChange={(e) => commit(e.target.value)}
          />
        ) : (
          <input
            type="text"
            className="pd-input pd-focusable pd-flag-input"
            aria-label={label}
            value={shown}
            onChange={(e) => commit(e.target.value)}
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
            aria-label={`Clear ${label}`}
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
