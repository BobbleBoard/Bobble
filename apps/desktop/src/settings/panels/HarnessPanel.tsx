/**
 * Settings → Harness. Pick the coding agent, or connect an external one.
 *
 * the user: "add that harness swapping mechanism in full working easily… we want
 * codex, claude code, hermes, pi, opencode, or other I guess? ideally easily
 * support for other dropping in any custom pi config somehow. system pi detected
 * and put in also."
 *
 * The panel is split because the harnesses are, genuinely, two different things
 * (see harness-catalog.ts). Embedded ones can BE Bobble's chat and so get a
 * radio-style choice. External ones are separate clients that cannot render
 * inside our chat — what they can do is talk to the model Bobble is already
 * serving, so they get the exact shell lines that point them at it. Presenting
 * both as one list of interchangeable options would be the lie worth avoiding.
 */
import { SegmentedControl, Spinner, writeClipboardText } from '@pi-desktop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { HarnessDetected } from '../../../electron/ipc-contract';
import type { ToolInterface } from '../../../electron/settings/settings-contract';
import { cx } from '../../onboarding/cx';
import { useLlmStore } from '../../state/llm-store';
import {
  setHarnessChoice,
  useHarnessConfigPath,
  useHarnessId,
  useSettingsStore,
} from '../../state/settings-store';
import { HarnessIcon } from '../brand-icons';
import {
  canDriveChat,
  connectScript,
  HARNESSES,
  type HarnessSpec,
  isSelectable,
  orderHarnessesForDisplay,
} from '../harness-catalog';
import { SettingRow, SettingSection } from '../parts';

function CopyBox({ text, testid }: { text: string; testid: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-start gap-2">
      <pre
        data-testid={testid}
        className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border-default bg-bg-inset px-3 py-2 text-footnote text-text-primary"
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          void writeClipboardText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
        className="shrink-0 rounded-lg border border-border-default px-2.5 py-1.5 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function HarnessPanel() {
  const [found, setFound] = useState<Record<string, HarnessDetected>>({});
  const [loading, setLoading] = useState(true);
  /* The choice is PERSISTED, not component state: main reads it when it builds
     the next pi bridge, so a selection that lived only in React would look
     applied and do nothing. */
  const selected = useHarnessId();
  const savedConfigPath = useHarnessConfigPath();
  const [customPath, setCustomPath] = useState(savedConfigPath);
  const [expanded, setExpanded] = useState<string | null>(null);

  const status = useLlmStore((s) => s.status);
  const baseUrl = status?.baseUrl ?? 'http://127.0.0.1:8080/v1';
  const modelId = status?.model?.id ?? 'local-model';

  const detect = useCallback(async () => {
    const probes = HARNESSES.filter((h) => h.bin !== undefined).map((h) => ({
      id: h.id,
      bin: h.bin as string,
    }));
    const res = await window.piDesktop.invoke('harness:detect', { probes }).catch(() => null);
    if (res !== null) setFound(Object.fromEntries(res.found.map((f) => [f.id, f])));
    setLoading(false);
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const ordered = orderHarnessesForDisplay(found);
  const embedded = ordered.filter(canDriveChat);
  const external = ordered.filter((h) => !canDriveChat(h));

  const renderRow = (spec: HarnessSpec) => {
    const state = found[spec.id];
    const selectable = isSelectable(spec, state, customPath);
    const isSelected = selected === spec.id;
    const isOpen = expanded === spec.id;

    return (
      <div
        key={spec.id}
        data-testid={`harness-row-${spec.id}`}
        data-installed={spec.id === 'pi-bundled' || state?.installed === true ? 'yes' : 'no'}
        data-selectable={selectable ? 'yes' : 'no'}
        className={cx(
          'rounded-xl border px-4 py-3',
          isSelected && spec.attach === 'embedded'
            ? 'border-accent-primary bg-bg-raised'
            : 'border-border-default bg-bg-raised',
          !selectable && spec.attach === 'embedded' ? 'opacity-60' : '',
        )}
      >
        <div className="flex items-start gap-3">
          {/* The product's own mark, so the picker reads as a list of real
              tools rather than rows of text. */}
          <span className="mt-0.5">
            <HarnessIcon id={spec.id} size={32} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body text-text-primary">{spec.name}</span>
              {state?.installed === true ? (
                <span className="rounded-full bg-bg-active px-2 py-0.5 text-footnote text-text-primary">
                  Detected
                </span>
              ) : null}
              {state?.version !== undefined ? (
                <span className="text-footnote text-text-muted">{state.version}</span>
              ) : null}
            </div>
            <p className="mt-0.5 text-footnote text-text-secondary">{spec.blurb}</p>
            {state?.path !== undefined ? (
              <p className="mt-1 truncate text-footnote text-text-muted">{state.path}</p>
            ) : null}
            {spec.bin !== undefined && state?.installed !== true ? (
              <p className="mt-1 text-footnote text-text-muted">
                Not found. Install {spec.bin} to use it.
              </p>
            ) : null}
          </div>

          {spec.attach === 'embedded' ? (
            <button
              type="button"
              data-testid={`harness-select-${spec.id}`}
              disabled={!selectable}
              onClick={() =>
                void setHarnessChoice(spec.id, spec.id === 'pi-custom' ? customPath : undefined)
              }
              className={cx(
                'shrink-0 rounded-lg border px-3 py-1.5 text-footnote transition-colors pd-focusable',
                isSelected
                  ? 'border-transparent bg-accent-primary text-text-on-accent'
                  : selectable
                    ? 'border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    : 'cursor-default border-border-default text-text-muted',
              )}
            >
              {isSelected ? 'In use' : 'Use'}
            </button>
          ) : (
            <button
              type="button"
              data-testid={`harness-connect-${spec.id}`}
              onClick={() => setExpanded(isOpen ? null : spec.id)}
              className="shrink-0 rounded-lg border border-border-default px-3 py-1.5 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
            >
              {isOpen ? 'Hide' : 'Connect'}
            </button>
          )}
        </div>

        {/* Custom pi config: the path IS the selection, so it lives in the row. */}
        {spec.id === 'pi-custom' ? (
          <input
            data-testid="harness-custom-path"
            value={customPath}
            onChange={(e) => {
              setCustomPath(e.target.value);
              if (selected === 'pi-custom') void setHarnessChoice('pi-custom', e.target.value);
            }}
            placeholder="/path/to/your/pi/config.json"
            className="mt-2 w-full rounded-lg border border-border-default bg-bg-base px-2.5 py-1.5 text-footnote text-text-primary placeholder:text-text-muted pd-focusable"
          />
        ) : null}

        {isOpen && spec.attach === 'external' ? (
          <div className="mt-2 border-t border-border-default pt-2">
            <p className="text-footnote text-text-secondary">
              Bobble serves your local model on an OpenAI-compatible endpoint. Run these in your
              terminal to point {spec.name} at it. No internet, no API key.
            </p>
            <CopyBox
              testid={`harness-script-${spec.id}`}
              text={connectScript(spec, baseUrl, modelId)}
            />
            {status?.serverRunning !== true ? (
              <p className="mt-2 text-footnote text-text-muted">
                The local server isn’t running. Start a chat or load a model first, then these will
                connect.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-body text-text-muted">
        <Spinner size={16} /> Looking for installed agents…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="harness-panel">
      <ToolInterfaceSection />

      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-body text-text-primary">Bobble’s own agent</h3>
          <p className="text-footnote text-text-secondary">
            Drives the chat, its tools and its subagents. Only pi can do this: Bobble speaks its
            protocol directly.
          </p>
        </div>
        {embedded.map(renderRow)}
        <p className="text-footnote text-text-muted">
          Applies to your next chat. An open conversation keeps the pi it started with.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-body text-text-primary">Connect another agent</h3>
          <p className="text-footnote text-text-secondary">
            These run in your terminal with their own interface. Bobble serves them the model.
          </p>
        </div>
        {external.map(renderRow)}
      </section>

      <button
        type="button"
        onClick={() => {
          setLoading(true);
          void detect();
        }}
        className="self-start rounded-lg border border-border-default px-3 py-1.5 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
      >
        Re-scan
      </button>
    </div>
  );
}

/**
 * HOW TOOLS ARE OFFERED — the user's bash-CLI experiment, kept as an option.
 *
 * It lives here rather than under Connectors because it is not about
 * connectors: it changes how EVERY tool is reached — connectors, media
 * generation, the browser, all of it. Connectors keep their own mode switch for
 * their own three ways of being exposed.
 */
function ToolInterfaceSection() {
  const value = useSettingsStore((s) => s.settings.toolInterface ?? 'bash-cli');
  const update = useSettingsStore((s) => s.update);
  return (
    <SettingSection
      title="Tool interface"
      description="How the model reaches everything it can do."
    >
      <SettingRow
        label="Tools as"
        hint={
          value === 'bash-cli'
            ? 'Every tool is a command on PATH. One tool is advertised (bash) and the whole registry is discoverable with `tools`, `tools search` and `--help`. The default — it keeps the request far smaller.'
            : 'Each tool is a JSON schema in the request, chosen per turn. Heavier, but the model can only ever emit a tool that exists.'
        }
      >
        <SegmentedControl
          aria-label="Tool interface"
          data-testid="settings-tool-interface"
          value={value}
          onValueChange={(v) => void update({ toolInterface: v as ToolInterface })}
          options={[
            { value: 'schemas', label: 'Schemas' },
            { value: 'bash-cli', label: 'Bash CLI' },
          ]}
        />
      </SettingRow>
    </SettingSection>
  );
}
