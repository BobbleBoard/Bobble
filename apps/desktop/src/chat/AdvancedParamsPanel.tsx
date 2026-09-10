/**
 * Power-user "advanced parameters" panel (the brain/gear entry). Two things:
 *
 *   1. GROUND TRUTH (read-only) — the exact system prompt + tool defs + message
 *      list the pi child last sent to llama-server, pushed out of the child by
 *      its provider hook (see {@link useGroundTruth}). This is what the model
 *      actually reads, not a reconstruction.
 *   2. KNOBS — sampling params applied to the NEXT request (no relaunch) and
 *      reasoning params applied on the next server relaunch. Persisted to
 *      settings.json via the advanced store; a fresh install is byte-identical
 *      until a control is touched.
 *
 * Rendered only for power users (userMode === 'power'); the trigger icon lives
 * in the chat top bar (see ChatApp).
 *
 * It is drawn with the SAME parts as the Settings panels — DialogHeader/Body
 * for the chrome, SettingSection/SettingGroup/SettingSlider for the contents.
 * It used to hand-roll all of them, which is how it ended up as the one dialog
 * in the app with no padding: content ran flush into the rounded corners
 * because nothing was ever telling it not to.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SegmentedControl,
} from '@pi-desktop/ui';
import { type ReactNode, useState } from 'react';
import { DEFAULT_ADVANCED } from '../../electron/settings/settings-contract';
import { SettingGroup, SettingRow, SettingSection, SettingSlider } from '../settings/parts';
import { useGroundTruth } from '../state/advanced-store';
import { setAdvanced, useAdvancedSettings } from '../state/settings-store';

/** The section-level "Reset", in the app's small ghost-button idiom. */
function ResetButton({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <Button variant="ghost" className="pd-btn--sm shrink-0" onClick={onClick}>
      Reset
    </Button>
  );
}

/** The read-only "what the model actually got" view. */
function GroundTruthView(): ReactNode {
  const gt = useGroundTruth();
  const [tab, setTab] = useState<'prompt' | 'tools' | 'raw'>('prompt');
  if (gt === null) {
    /* Was a DASHED box on --pd-bg-raised, which in light mode is a bright white
       card with a cut-out border — the two loudest things a surface can do, for
       the quietest state the panel has. An inset well says "nothing here yet"
       without asking to be looked at. */
    return (
      <p className="pd-adv-well px-4 py-8 text-center text-footnote text-text-muted">
        Send a message. The exact system prompt, tool definitions, and context the model receives
        will appear here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        aria-label="Ground-truth view"
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        options={[
          { value: 'prompt', label: 'System prompt' },
          { value: 'tools', label: `Tools (${gt.tools.length})` },
          { value: 'raw', label: 'Raw context' },
        ]}
      />
      {tab === 'prompt' ? (
        <pre className="pd-adv-well pd-scroll max-h-[36vh] overflow-auto whitespace-pre-wrap p-3.5 font-mono text-caption text-text-secondary">
          {gt.systemPrompt || '(empty system prompt)'}
        </pre>
      ) : null}
      {tab === 'tools' ? (
        <div className="pd-adv-well pd-scroll max-h-[36vh] overflow-auto p-1.5">
          {gt.tools.length === 0 ? (
            <p className="px-2 py-2 text-caption text-text-muted">No tools were sent this turn.</p>
          ) : (
            <ul className="flex flex-col">
              {gt.tools.map((t) => (
                <li key={t.name} className="rounded-sm px-2 py-1.5 hover:bg-bg-hover">
                  <span className="font-mono text-caption text-text-primary">{t.name}</span>
                  {t.description ? (
                    <span className="mt-0.5 block text-caption text-text-muted">
                      {t.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {tab === 'raw' ? (
        <pre className="pd-adv-well pd-scroll max-h-[36vh] overflow-auto whitespace-pre-wrap p-3.5 font-mono text-caption text-text-secondary">
          {JSON.stringify({ model: gt.model, messages: gt.messages, tools: gt.tools }, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function AdvancedParamsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const adv = useAdvancedSettings();
  const s = adv.sampling;
  const r = adv.reasoning;

  const patchSampling = (p: Partial<typeof s>): void =>
    void setAdvanced({ sampling: { ...s, ...p } });
  const patchReasoning = (p: Partial<typeof r>): void =>
    void setAdvanced({ reasoning: { ...r, ...p } });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Advanced parameters" className="pd-adv-panel">
        <DialogHeader>
          <div className="min-w-0 pr-8">
            <DialogTitle>Advanced parameters</DialogTitle>
            <DialogDescription className="mt-1 text-footnote">
              Power-user knobs and the live context sent to the local model.
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-8">
          {/* GROUND TRUTH ---------------------------------------------------- */}
          <SettingSection
            title="Live context"
            description="The exact prompt, tools, and messages of the last turn."
          >
            <GroundTruthView />
          </SettingSection>

          {/* SAMPLING (per-request) ----------------------------------------- */}
          <SettingSection
            title="Sampling"
            description="Applied to the next request. No restart."
            action={<ResetButton onClick={() => patchSampling(DEFAULT_ADVANCED.sampling)} />}
          >
            <SettingGroup testId="advanced-sampling">
              <SettingSlider
                label="Temperature"
                value={s.temperature}
                min={0}
                max={2}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => patchSampling({ temperature: v })}
              />
              <SettingSlider
                label="Top P"
                value={s.topP}
                min={0}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => patchSampling({ topP: v })}
              />
              <SettingSlider
                label="Top K"
                value={s.topK}
                min={0}
                max={200}
                step={1}
                format={(v) => (v === 0 ? 'Off' : String(v))}
                onChange={(v) => patchSampling({ topK: v })}
              />
              <SettingSlider
                label="Min P"
                value={s.minP}
                min={0}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => patchSampling({ minP: v })}
              />
              <SettingSlider
                label="Repetition penalty"
                hint="1.00 = off. DRY handles anti-looping; a flat penalty here hurts code."
                value={s.repetitionPenalty}
                min={0.8}
                max={1.5}
                step={0.01}
                format={(v) => (v === 1 ? 'Off (1.00)' : v.toFixed(2))}
                onChange={(v) => patchSampling({ repetitionPenalty: v })}
              />
              <SettingSlider
                label="Presence penalty"
                value={s.presencePenalty}
                min={-2}
                max={2}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => patchSampling({ presencePenalty: v })}
              />
              <SettingSlider
                label="Max tokens"
                hint="Per-request output cap. 0 = model default."
                value={s.maxTokens}
                min={0}
                max={32768}
                step={256}
                format={(v) => (v === 0 ? 'Model default' : String(v))}
                onChange={(v) => patchSampling({ maxTokens: v })}
              />
            </SettingGroup>
          </SettingSection>

          {/* REASONING (launch-time) ---------------------------------------- */}
          <SettingSection
            title="Reasoning"
            description="Applied on the next server relaunch."
            action={<ResetButton onClick={() => patchReasoning(DEFAULT_ADVANCED.reasoning)} />}
          >
            <SettingGroup testId="advanced-reasoning">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col">
                  <span className="text-body font-medium text-text-primary">Preserve thinking</span>
                  <span className="mt-0.5 text-footnote text-text-muted">
                    Keep &lt;think&gt; across the whole history, not just the last turn.
                  </span>
                </div>
                <SegmentedControl
                  className="shrink-0"
                  aria-label="Preserve thinking"
                  value={r.preserve ? 'on' : 'off'}
                  onValueChange={(v) => patchReasoning({ preserve: v === 'on' })}
                  options={[
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                  ]}
                />
              </div>
              <SettingSlider
                label="Reasoning budget"
                hint="Token cap on thinking. -1 = unrestricted; 0 = no thinking."
                value={r.budget}
                min={-1}
                max={8192}
                step={128}
                format={(v) => (v === -1 ? 'Unrestricted' : v === 0 ? 'Off' : `${v} tokens`)}
                onChange={(v) => patchReasoning({ budget: v })}
              />
            </SettingGroup>

            <SettingRow
              label="Budget-reached message"
              hint="Injected before the end-of-thinking tag when the budget runs out."
            >
              <input
                type="text"
                aria-label="Budget-reached message"
                className="pd-input pd-focusable w-full"
                value={r.budgetMessage}
                onChange={(e) => patchReasoning({ budgetMessage: e.target.value })}
              />
            </SettingRow>
          </SettingSection>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
