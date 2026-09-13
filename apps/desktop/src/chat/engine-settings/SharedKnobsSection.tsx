/**
 * SHARED ACROSS ENGINES — the knobs that mean the same thing everywhere, set
 * once, spelled per engine at launch (portable-knobs.ts).
 *
 * the user: "ensure settings and such transfer between engines as seamlessly as
 * possible and are removed/greyed out if unsupported by engine, keeping
 * preferences saved."
 *
 * Each row: the knob, its value (or the engine's default when unset), which
 * flag THIS engine will get for it, and where the value comes from when it was
 * not set here — "from llama.cpp" means the same meaning was read out of the
 * flags the user set on that engine. A knob the current engine cannot spell
 * is greyed with a plain "not on <engine>" and stays editable, because the
 * value is kept for the engines that can.
 */
import {
  type KnobEngine,
  knobEngines,
  PORTABLE_KNOBS,
  type PortableKnob,
  resolveKnob,
} from '@pi-desktop/inference/portable-knobs';
import type { EngineFlagValue } from '../../../electron/settings/settings-contract';
import { ENGINES } from '../../settings/engine-catalog';

function engineName(id: string): string {
  return ENGINES.find((e) => e.id === id)?.name ?? (id === 'llamacpp' ? 'llama.cpp' : id);
}

export function SharedKnobsSection({
  engine,
  knobs,
  engineLaunch,
  onChange,
}: {
  engine: string;
  knobs: Readonly<Record<string, EngineFlagValue>>;
  engineLaunch: Readonly<
    Record<string, { readonly flags: Readonly<Record<string, EngineFlagValue>> }>
  >;
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
    const value = resolved?.value ?? '';
    const shown = typeof value === 'boolean' ? String(value) : value;
    return (
      <div
        key={knob.id}
        className="pd-flag-row pd-knob-row"
        data-set={set ? 'yes' : 'no'}
        data-supported={supported ? 'yes' : 'no'}
        data-testid={`engine-knob-${knob.id}`}
      >
        <div className="pd-flag-main">
          <div className="pd-flag-head">
            <span className="pd-flag-key pd-knob-label">{knob.label}</span>
            {supported ? (
              <span className="pd-flag-alias" title={`What ${engineName(engine)} is passed`}>
                {spelling.flags[0]}
              </span>
            ) : (
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
                title="Set explicitly below; that wins"
              >
                overridden by{' '}
                {spelling.flags.find((f) => engineLaunch[engine]?.flags[f] !== undefined)}
              </span>
            ) : null}
          </div>
          <span className="pd-flag-desc">
            {knob.blurb}
            {spelling?.note !== undefined ? ` — ${spelling.note}.` : ''}
          </span>
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
            <select
              className="pd-input pd-focusable pd-flag-select"
              aria-label={knob.label}
              value={String(shown)}
              onChange={(e) => onChange(knob.id, e.target.value === '' ? null : e.target.value)}
              data-testid={`engine-knob-input-${knob.id}`}
            >
              <option value="">engine default</option>
              {knob.control.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                type="number"
                className="pd-input pd-focusable pd-flag-input"
                aria-label={knob.label}
                placeholder="engine default"
                value={shown === '' ? '' : String(shown)}
                min={knob.control.min}
                step={knob.control.step}
                onChange={(e) => {
                  const t = e.target.value.trim();
                  onChange(knob.id, t === '' ? null : Number(t));
                }}
                data-testid={`engine-knob-input-${knob.id}`}
              />
              {knob.control.unit !== undefined ? (
                <span className="pd-flag-desc">{knob.control.unit}</span>
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
