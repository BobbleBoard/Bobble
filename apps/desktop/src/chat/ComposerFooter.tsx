/**
 * Composer footer cluster: current-model chip (with a menu that switches pi
 * models and downloads/starts local ones) and a turn-stats info popover. The
 * download progress that used to sit here lives in the task tray now (its
 * "Downloads" group, state/tray-transfers.ts) — the user: "remove all progressbar and
 * such from the input area". When nothing is set up it shows
 * a tasteful "pick a model" affordance that kicks off a download (full model
 * manager is W10).
 *
 * Round-A: the live tok/s readout moved off the input bar to the per-message
 * action bar (#2); the context-fullness ring moved to the sticking-out ComposerBar
 * (#5). The info popover was once hidden in power mode (#1) and no longer is —
 * see the note at the popover itself. Blind-test #1: ALL run
 * status (the harness stage/timer/repair cluster, the "switching…" pill) left the
 * footer for the ONE thread indicator, so the input bar shows no run state.
 */
import type { ChatMsg, Model, Usage } from '@pi-desktop/engine';
import { Button, IconButton, IconChevronDown, IconInfo, Tooltip } from '@pi-desktop/ui';
import { useLlmStore } from '../state/llm-store';
import { usePiStore } from '../state/pi-slice';
import { useModelSelection, useUserMode } from '../state/settings-store';
import { AutoDownloadPrompt } from './AutoDownloadPrompt';
import { chipLabel } from './footer-models';
import { TierPickerMenu } from './TierPickerMenu';

/** 73000 → "73,000"; small numbers pass through. */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtPct(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  return `${Math.round((part / whole) * 100)}%`;
}

function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

interface TurnStats {
  usage: Usage | undefined;
  toolCalls: number;
  /** Wall-clock span of the last turn, derived from message timestamps. */
  elapsedMs: number | undefined;
}

/**
 * Derive the current/last turn's stats from the store messages. "Last turn" is
 * everything from the most recent user message to the end (its assistant
 * response + interleaved tool results). Usage/tokens are the engine's real
 * numbers; the tool-call count is exact; the elapsed span is derived from
 * client-side message timestamps (labelled as such in the popover).
 */
function deriveTurnStats(messages: ChatMsg[]): TurnStats {
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'user') {
      userIdx = i;
      break;
    }
  }
  const turn = userIdx >= 0 ? messages.slice(userIdx) : messages;
  let usage: Usage | undefined;
  let toolCalls = 0;
  let startTs: number | undefined;
  let endTs: number | undefined;
  for (const m of turn) {
    if (startTs === undefined || m.timestamp < startTs) startTs = m.timestamp;
    if (endTs === undefined || m.timestamp > endTs) endTs = m.timestamp;
    if (m.kind === 'assistant') {
      if (m.usage !== undefined) usage = m.usage;
      for (const b of m.blocks) if (b.type === 'toolCall') toolCalls++;
    }
  }
  const elapsedMs =
    startTs !== undefined && endTs !== undefined ? Math.max(0, endTs - startTs) : undefined;
  return { usage, toolCalls, elapsedMs };
}

/** A labelled row in the stats popover. */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center justify-between gap-6">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary tabular-nums">{value}</span>
    </span>
  );
}

export function ComposerFooter({
  piModels,
  onOpenModels,
}: {
  piModels: Model[];
  onOpenModels?: () => void;
}) {
  const agentModel = usePiStore((s) => s.agent.model);
  const messages = usePiStore((s) => s.messages);
  const status = useLlmStore((s) => s.status);
  const catalog = useLlmStore((s) => s.catalog);
  // Round-12 (W3): the model chip + its picker are mode-aware. The picker itself
  // (Auto + the three capability tiers) is the shared TierPickerMenu; here we
  // only decide the CHIP LABEL from the mode + selection.
  const userMode = useUserMode();
  const selection = useModelSelection();

  // Round-A (#3): the chip names the model ACTUALLY RESIDENT in the inference
  // server right now — "Auto · <loaded model>" under Auto (never the tier). Prefer
  // the local supervisor's loaded model (status.model), falling back to pi's active
  // provider model name. Falls back to a "pick a model" affordance when nothing is
  // named yet.
  const loadedModelName = status.model?.displayName ?? agentModel?.name ?? null;
  /* The PINNED model's own name, from the same catalog the picker's rows and
     its checkmark come from — so the chip and the menu cannot disagree. */
  const pinnedModelName =
    selection.mode === 'model'
      ? (catalog.find((e) => e.id === selection.modelId)?.displayName ?? null)
      : null;
  const label =
    chipLabel(userMode, selection, loadedModelName, pinnedModelName) ??
    (piModels.length > 0 ? 'Choose model' : 'Pick a model');

  // Context window used by the info popover's input/output percentages (the
  // context-fullness ring itself moved to the sticking-out ComposerBar, round-A #5).
  const contextWindow = status.model?.contextWindow ?? 0;

  // Current/last-turn stats for the info popover (round-5 #25).
  const stats = deriveTurnStats(messages);
  const modelName = agentModel?.name ?? status.model?.displayName ?? null;
  const usage = stats.usage;
  const inputPct = usage !== undefined ? fmtPct(usage.input, contextWindow) : null;
  const outputPct = usage !== undefined ? fmtPct(usage.output, contextWindow) : null;

  return (
    <>
      {/* No download bar here any more. The user (2026-09-13): "remove all
          progressbar and such from the input area, move it up to the top bar"
          — the task tray's "Downloads" group (top-left) is the one place. */}
      {/* Anchor for the friendly auto-download card, which floats just above the
          model chip when Auto resolves to an un-downloaded tier. */}
      <span className="relative flex items-center">
        <AutoDownloadPrompt />
        {/* The shared tier picker (Auto + the three capability tiers, + a power-mode
            "More models" deep-link). The chip is its trigger. */}
        <TierPickerMenu
          align="start"
          side="top"
          onOpenManager={onOpenModels}
          menuTestId="footer-model-menu"
        >
          <Button variant="ghost" size="sm" className="gap-1" data-testid="footer-model-chip">
            <span className="max-w-[180px] truncate">{label}</span>
            <IconChevronDown size={16} />
          </Button>
        </TierPickerMenu>
      </span>

      {/* Info popover: current/last-turn stats. Tokens are real (engine usage);
          the tool-call count is exact; elapsed is derived from message
          timestamps (labelled estimated). Hover to reveal (round-5 #25).
          It used to be hidden for power users, who "read the raw numbers
          elsewhere". With the mode toggle removed there is no such distinction,
          and hiding the only inline stats readout from everyone is the worse of
          the two options — so it stays. */}
      <Tooltip
        side="top"
        align="end"
        delayDuration={100}
        className="pd-context-tooltip"
        label={
          <span
            className="flex min-w-[220px] flex-col gap-1.5 text-footnote"
            data-testid="turn-stats"
          >
            <span className="font-medium text-text-primary">Last turn</span>
            {modelName !== null ? <StatRow label="Model" value={modelName} /> : null}
            {usage !== undefined ? (
              <>
                <StatRow
                  label="Input ↓"
                  value={`${fmtInt(usage.input)}${inputPct !== null ? ` · ${inputPct}` : ''}`}
                />
                <StatRow
                  label="Output ↑"
                  value={`${fmtInt(usage.output)}${outputPct !== null ? ` · ${outputPct}` : ''}`}
                />
                <StatRow label="Total" value={fmtInt(usage.totalTokens)} />
              </>
            ) : (
              <StatRow label="Tokens" value="None yet" />
            )}
            <StatRow label="Tool calls" value={String(stats.toolCalls)} />
            {stats.elapsedMs !== undefined ? (
              <StatRow label="Elapsed*" value={fmtElapsed(stats.elapsedMs)} />
            ) : null}
            <span className="text-text-muted">* estimated from message timestamps</span>
          </span>
        }
      >
        <IconButton size="sm" aria-label="Turn stats" data-testid="footer-info">
          <IconInfo size={16} />
        </IconButton>
      </Tooltip>
    </>
  );
}
