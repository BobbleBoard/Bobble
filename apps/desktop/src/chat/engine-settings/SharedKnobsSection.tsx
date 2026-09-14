/**
 * SHARED ACROSS ENGINES — the knobs that mean the same thing everywhere, set
 * once, spelled per engine at launch (portable-knobs.ts).
 *
 * the user: "ensure settings and such transfer between engines as seamlessly as
 * possible and are removed/greyed out if unsupported by engine, keeping
 * preferences saved."
 *
 * Each row: the knob's name, an ⓘ with what it does and which flag THIS
 * engine gets for it, the value — yours, the one read out of another
 * engine's flags ("from llama.cpp"), or the engine's own default sitting in
 * the control to edit — and the engines that have the setting. A knob the
 * current engine cannot spell is greyed with a plain "not on <engine>" and
 * stays editable, because the value is kept for the engines that can.
 */
import {
  type KnobEngine,
  knobEngines,
  PORTABLE_KNOBS,
  type PortableKnob,
  resolveKnob,
} from '@pi-desktop/inference/portable-knobs';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@pi-desktop/ui';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';
import { ENGINES } from '../../settings/engine-catalog';
import { defaultShown } from './engine-settings-logic';
import { InfoDot } from './InfoDot';

function engineName(id: string): string {
  return ENGINES.find((e) => e.id === id)?.name ?? (id === 'llamacpp' ? 'llama.cpp' : id);
}

export function SharedKnobsSection({
  engine,
  knobs,
  engineLaunch,
  defaultFor,
  onChange,
}: {
  engine: string;
  knobs: Readonly<Record<string, EngineFlagValue>>;
  engineLaunch: Readonly<
    Record<string, { readonly flags: Readonly<Record<string, EngineFlagValue>> }>
  >;
  /** The engine's own default for a flag spelling (from its --help), if it says. */
  defaultFor: (flagNames: readonly string[]) => string | undefined;
  onChange: (id: string, value: EngineFlagValue | null) => void;
}) {
  const row = (knob: PortableKnob) => {
    const spelling = knob.per[engine as KnobEngine];
    const supported = spelling !== undefined;
    const resolved = resolveKnob(knob, { knobs, engineLaunch, engine });
    const set = knobs[knob.id] !== undefined && knobs[knob.id] !== '';
    // The engine's own explicit flag for the same thing outranks the knob.
    const overridden =
      spelling?.flags.some((f) => engineLaunch[engine]?.flags[f] !== undefined) === true;
    // The engine's stated default, read INTO the knob's own domain through the
    // spelling's `read` (llama.cpp says `f16` for the KV cache; the knob says "off").
    const stated = spelling === undefined ? undefined : defaultFor(spelling.flags);
    const statedShown = defaultShown(stated, knob.control.kind);
    const readBack =
      spelling !== undefined && statedShown !== ''
        ? spelling.read(Object.fromEntries(spelling.flags.map((f) => [f, statedShown])))
        : undefined;
    const engineDefault =
      readBack !== undefined && readBack !== '' ? String(readBack) : statedShown || undefined;
    const value = resolved?.value;
    // What sits in the control: your value, an inherited one, else the engine's own.
    const shown =
      value === undefined || value === ''
        ? (engineDefault ?? '')
        : typeof value === 'boolean'
          ? String(value)
          : String(value);
    const commit = (raw: string) => {
      if (raw === '' || raw === engineDefault) onChange(knob.id, null);
      else if (knob.control.kind === 'select') onChange(knob.id, raw);
      else if (Number.isFinite(Number(raw))) onChange(knob.id, Number(raw));
    };
    return (
      <div
        key={knob.id}
        className="pd-flag-row pd-knob-row"
        data-set={set ? 'yes' : 'no'}
        data-supported={supported ? 'yes' : 'no'}
        data-flag={spelling?.flags[0]}
        data-testid={`engine-knob-${knob.id}`}
      >
        <div className="pd-flag-main">
          <div className="pd-flag-head">
            <span className="pd-flag-name pd-knob-label">{knob.label}</span>
            <InfoDot label={knob.label} testId={`engine-knob-info-${knob.id}`}>
              <p>{knob.blurb}</p>
              {spelling?.note !== undefined ? <p>{spelling.note}.</p> : null}
              <p className="pd-info-tip-flag">
                {supported ? (
                  <>
                    <code>{spelling.flags.join(', ')}</code>
                    {stated !== undefined ? ` · ${engineName(engine)} default ${stated}` : ''}
                  </>
                ) : (
                  `${engineName(engine)} has no flag for this; the value is kept for the engines that do.`
                )}
              </p>
            </InfoDot>
            {supported ? null : (
              <span
                className="pd-flag-chip pd-flag-chip--muted"
                data-testid="engine-knob-unsupported"
              >
                not on {engineName(engine)}
              </span>
            )}
            {resolved !== null && resolved.source !== 'shared' && resolved.source !== engine ? (
              <span className="pd-flag-chip" data-testid="engine-knob-inherited">
                from {engineName(resolved.source)}
              </span>
            ) : null}
            {overridden ? (
              <span
                className="pd-flag-chip pd-flag-chip--warn"
                title="Set explicitly in Flags; that wins"
              >
                overridden by{' '}
                {spelling.flags.find((f) => engineLaunch[engine]?.flags[f] !== undefined)}
              </span>
            ) : null}
          </div>
          <span className="pd-knob-engines" title="Engines with this setting">
            {knobEngines(knob).map((e) => (
              <span
                key={e}
                className="pd-knob-engine"
                data-here={e === engine ? 'yes' : 'no'}
                title={knob.per[e]?.flags.join(', ')}
              >
                {engineName(e)}
              </span>
            ))}
          </span>
        </div>
        <div className="pd-flag-control">
          {knob.control.kind === 'select' ? (
            <Select value={shown} onValueChange={commit}>
              <SelectTrigger
                className="pd-btn--sm pd-flag-select"
                aria-label={knob.label}
                placeholder="—"
                data-testid={`engine-knob-input-${knob.id}`}
              >
                {knob.control.options.find((o) => o.value === shown)?.label ?? (shown || '—')}
              </SelectTrigger>
              <SelectContent align="end">
                {knob.control.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                    {o.value === engineDefault ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <>
              <input
                type="number"
                className="pd-input pd-focusable pd-flag-input"
                aria-label={knob.label}
                value={shown}
                min={knob.control.min}
                step={knob.control.step}
                onChange={(e) => commit(e.target.value.trim())}
                data-testid={`engine-knob-input-${knob.id}`}
              />
              {knob.control.unit !== undefined ? (
                <span className="pd-flag-unit">{knob.control.unit}</span>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <section className="pd-flags-group" data-testid="engine-knobs">
      <h4 className="pd-flags-group-title">Shared across engines</h4>
      <p className="pd-engine-row-sub pd-knobs-sub">
        Set once; each engine gets it in its own flag. An engine without the setting skips it and
        keeps your value for the ones that have it.
      </p>
      <div className="pd-flags-list">{PORTABLE_KNOBS.map(row)}</div>
    </section>
  );
}
