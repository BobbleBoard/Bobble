/**
 * PASTE A COMMAND. The user: "there should be a tab for also just pasting args/a
 * llama-server command and have it parsed and flags and args added as the
 * user wants."
 *
 * The paste is tokenised like a shell, matched against the engine's own flag
 * list (any alias, `--flag=value` too), and shown as rows with a checkbox
 * each. Known flags land in the settings under their long name; unknown ones
 * are kept verbatim as raw arguments; the few Bobble sets itself are flagged
 * and unticked by default.
 */
import {
  MANAGED_LLAMA_FLAGS,
  type ParsedCommandFlag,
  parseCommandLine,
} from '@pi-desktop/inference/engine-flags';
import { useState } from 'react';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';
import type { EngineFlagsView } from '../../state/llm-store';

export function CommandTab({
  engine,
  help,
  onAdd,
}: {
  engine: string;
  help: EngineFlagsView | null;
  onAdd: (flags: Record<string, EngineFlagValue>, rawArgs: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Array<ParsedCommandFlag & { id: string }> | null>(null);
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const managed = engine === 'llamacpp' ? MANAGED_LLAMA_FLAGS : {};

  const parse = () => {
    // Ids are minted at parse time so React can key rows without their index.
    const parsed = parseCommandLine(text, help?.flags ?? [], managed).map((r, i) => ({
      ...r,
      id: `${r.flag}#${i}#${r.value ?? ''}`,
    }));
    setRows(parsed);
    setTicked(Object.fromEntries(parsed.map((r, i) => [i, r.managed !== 'refused'])));
  };
  const add = () => {
    if (rows === null) return;
    const flags: Record<string, EngineFlagValue> = {};
    const raw: string[] = [];
    rows.forEach((r, i) => {
      if (ticked[i] !== true || r.managed === 'refused') return;
      if (r.known !== undefined) {
        flags[r.flag] = r.value === null ? true : r.value;
      } else {
        raw.push(r.flag);
        if (r.value !== null) raw.push(r.value);
      }
    });
    onAdd(flags, raw);
    setRows(null);
    setText('');
  };

  return (
    <div className="pd-cmd" data-testid="command-tab">
      <textarea
        className="pd-input pd-focusable pd-cmd-text"
        rows={5}
        placeholder={
          engine === 'llamacpp'
            ? 'llama-server -m model.gguf -c 16384 --jinja --reasoning-budget 2048 -fa on …'
            : `${engine} serve … --flag value`
        }
        aria-label="Command line to parse"
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="command-text"
      />
      <div className="pd-cmd-actions">
        <button
          type="button"
          className="pd-engine-install"
          onClick={parse}
          data-testid="command-parse"
        >
          Parse
        </button>
        {rows !== null ? (
          <button
            type="button"
            className="pd-engine-calibrate"
            onClick={add}
            data-testid="command-add"
          >
            Add {Object.values(ticked).filter(Boolean).length} to settings
          </button>
        ) : null}
      </div>
      {rows !== null ? (
        <div className="pd-cmd-rows" data-testid="command-rows">
          {rows.length === 0 ? <p className="pd-engine-row-sub">No flags found in that.</p> : null}
          {rows.map((r, i) => (
            <label key={r.id} className="pd-cmd-row" data-managed={r.managed ?? 'no'}>
              <input
                type="checkbox"
                checked={ticked[i] === true}
                disabled={r.managed === 'refused'}
                onChange={(e) => setTicked((t) => ({ ...t, [i]: e.target.checked }))}
              />
              <code className="pd-flag-key">{r.flag}</code>
              {r.value !== null ? <code className="pd-cmd-value">{r.value}</code> : null}
              <span className="pd-engine-row-sub">
                {r.managed === 'refused'
                  ? 'Bobble sets this — cannot be changed here'
                  : r.managed === 'override'
                    ? 'replaces Bobble’s own value'
                    : r.known === undefined
                      ? 'not in this build’s --help; passed through as typed'
                      : r.known.description.slice(0, 90)}
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
