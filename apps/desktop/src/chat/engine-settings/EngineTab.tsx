/**
 * THE ENGINE TAB of the advanced panel: which engine's settings (llama.cpp
 * first, then whatever else is installed) and three sub-tabs — Settings (the
 * knobs shared across engines), Speculative, Paste a command — plus the
 * running command line. The draft it edits lives in {@link useEngineDraft}
 * so the Flags tab and the dialog header's Reset / Apply share it.
 */
import { CommandTab } from './CommandTab';
import { EngineSelect } from './EngineSelect';
import { shellJoin } from './engine-settings-logic';
import { SharedKnobsSection } from './SharedKnobsSection';
import { SpeculativeTab } from './SpeculativeTab';
import type { EngineDraft } from './use-engine-draft';

export type EngineSubTab = 'settings' | 'speculative' | 'command' | 'running';

export function EngineTab({
  d,
  sub,
  onSub,
}: {
  d: EngineDraft;
  sub: EngineSubTab;
  onSub: (sub: EngineSubTab) => void;
}) {
  const { status, engine, runningEngine, runningHere, draft } = d;
  return (
    <div className="pd-engine-tab" data-testid="engine-settings-tab">
      <div className="pd-engine-tab-head">
        <div className="pd-engine-tab-select">
          <span className="pd-flags-group-title">Engine</span>
          <EngineSelect
            engine={engine}
            choices={d.choices}
            runningEngine={runningEngine}
            serverRunning={status.serverRunning}
            onChange={d.setEngine}
            testId="engine-settings-engine"
          />
        </div>
        <div className="pd-engine-subtabs" role="tablist">
          {(
            [
              ['settings', 'Settings'],
              ['speculative', 'Speculative'],
              ['command', 'Paste a command'],
              ['running', 'Running now'],
            ] as const
          )
            .filter(([id]) => id !== 'speculative' || engine === 'llamacpp')
            .map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sub === id}
                className={`pd-engine-subtab${sub === id ? ' pd-engine-subtab--on' : ''}`}
                onClick={() => onSub(id)}
                data-testid={`engine-subtab-${id}`}
              >
                {label}
              </button>
            ))}
        </div>
      </div>

      <div className="pd-engine-tab-body">
        {sub === 'settings' ? (
          <SharedKnobsSection
            engine={engine}
            knobs={d.cleanKnobs}
            engineLaunch={d.engineLaunch}
            defaultFor={d.defaultFor}
            onChange={d.setKnob}
          />
        ) : sub === 'speculative' ? (
          <SpeculativeTab
            entry={d.entry}
            status={status}
            choice={d.spec}
            onChoice={d.setSpec}
            help={d.help}
            values={draft.flags}
            onFlag={d.setFlagValue}
            onPath={d.resolvePath}
          />
        ) : sub === 'command' ? (
          <CommandTab
            engine={engine}
            help={d.help}
            onAdd={(flags, raw) => {
              d.setDraft((cur) => ({
                flags: { ...cur.flags, ...flags },
                rawArgs: [...cur.rawArgs, ...raw],
              }));
              onSub('settings');
            }}
          />
        ) : (
          <div className="pd-cmd" data-testid="running-tab">
            {status.launchCommand !== undefined && runningHere ? (
              <>
                <p className="pd-engine-row-sub">
                  The exact command line of the server that is up right now.
                </p>
                <pre className="pd-adv-well pd-scroll pd-cmd-running">
                  {shellJoin(status.launchCommand, status.launchArgs ?? [])}
                </pre>
              </>
            ) : (
              <p className="pd-engine-row-sub">
                {status.serverRunning
                  ? `The running server is ${runningEngine}, not ${engine}.`
                  : 'No server is running.'}
              </p>
            )}
            {draft.rawArgs.length > 0 ? (
              <div className="pd-cmd-raw">
                <span className="pd-flags-group-title">Raw arguments (passed as typed)</span>
                {draft.rawArgs.map((a, i) => (
                  // Raw tokens can repeat (`--flag v --flag v`); position is their identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: identical tokens at different positions are different arguments
                  <span key={`${i}:${a}`} className="pd-cmd-raw-chip">
                    <code>{a}</code>
                    <button
                      type="button"
                      aria-label={`Remove ${a}`}
                      onClick={() =>
                        d.setDraft((cur) => ({
                          ...cur,
                          rawArgs: cur.rawArgs.filter((_, j) => j !== i),
                        }))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
