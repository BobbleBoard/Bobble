/**
 * TierPickerMenu (round-14 keystone) — the ONE tier picker, extracted from the
 * footer model chip so it can be shared by both the footer chip (issue 4) and
 * the composer-bar "[Auto] · [<tier>]" control (issue 3). Renders a dropdown of
 * Auto + the three capability tiers (fast / balanced / intelligent) backed by
 * `selectAuto` / `selectTier`, plus a "More models" deep-link in power mode.
 *
 * Self-contained: it reads its own state (recommendation catalog, user mode,
 * current selection) so a consumer only supplies the trigger element (children)
 * and, optionally, an `onOpenManager` callback. Both consumers therefore stay in
 * lock-step — one fix here propagates to the bar AND the footer.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  IconCheck,
  IconChevronRight,
  IconPin,
} from '@pi-desktop/ui';
import type { ReactNode } from 'react';
import type { ModelTier } from '../../../../packages/harness/src/model/tier.ts';
import { DownloadBar } from '../models/DownloadBar';
import { compactBytes } from '../models/models-layout';
import { downloadFraction, type LlmDownloadState, useLlmStore } from '../state/llm-store';
import { selectionTier } from '../state/model-selection';
import { usePiStore } from '../state/pi-slice';
import { useModelSelection, useQuickMenu, useSettingsStore } from '../state/settings-store';
import { selectAuto, selectModel, selectTier } from './auto-router';
import { buildTierRows } from './footer-models';
import { riskBadge, worthWarning } from './prefill-risk';
import { prefillSeconds } from './prefill-speed';
import { QuickMenuPanel } from './QuickMenuPanel';
import {
  DEFAULT_QUICK_MENU,
  type MenuModel,
  orgOf,
  type QuickMenuConfig,
  quickMenuRows,
} from './quick-menu';
import { conversationTokens } from './use-reprefill-warning';

/*
 * NO GLYPHS ON THESE ROWS. the user: "model picker doesn't have to have icons."
 *
 * He is right and it took three passes to see why: every icon here was a
 * decoration on a row whose LABEL already said the whole thing. "Fast" does not
 * need a speedometer; the reason I kept reaching for one is that the row looked
 * bare without it, which is a want of the designer, not of the reader.
 */

/**
 * THE DOWNLOAD CONTROL FOR ONE MENU ROW — the app's blue button, and the bar it
 * becomes.
 *
 * the user: "instead of the little dot and download put the blue download button
 * that does the progressbar from the model manager." So this is the same
 * `DownloadBar` the Model hub uses, behind the same button, rather than a second
 * download affordance invented for a menu.
 *
 * IT MUST NOT SELECT THE ROW, and the row itself is what enforces that: a slot
 * whose model is not on disk cancels its own `onSelect` (see below), because
 * picking it would be asking to run something there is nothing to run. That one
 * rule also keeps the menu OPEN while you press Download, which is what lets you
 * watch the bar you just started.
 */
function RowDownload({
  modelId,
  label,
  download,
  onStart,
  onCancel,
}: {
  modelId: string | null;
  label: string;
  download: LlmDownloadState | null;
  onStart: (id: string) => Promise<void>;
  onCancel: () => Promise<void>;
}): ReactNode {
  if (modelId === null) return undefined;
  const mine = download !== null && download.modelId === modelId;
  if (mine) {
    return (
      <span>
        <DownloadBar
          fraction={downloadFraction(download)}
          received={download.jobReceived ?? download.received}
          total={download.jobTotal ?? download.total}
          label={`Cancel ${label}`}
          testid={`tier-progress-${modelId}`}
          onCancel={() => void onCancel()}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={`tier-download-${modelId}`}
      onClick={() => void onStart(modelId)}
      /* The app's one download button: blue ground, white text. Same rule the
         Model hub follows — a user does not care which of two blues matters,
         only which thing is the button. */
      className="pd-focusable h-7 shrink-0 rounded-full bg-accent-primary px-3 text-caption font-medium text-text-on-accent transition-opacity hover:opacity-90"
    >
      Download
    </button>
  );
}

export interface TierPickerMenuProps {
  /** The trigger element (the footer chip, or a bar `.pd-tier-seg` button). */
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** Power-mode "More models" deep-link into the full manager (omit to hide). */
  onOpenManager?: (() => void) | undefined;
  /** Optional `data-testid` for the menu surface (e.g. the footer's). */
  menuTestId?: string;
}

/** The shared Auto + tiers picker. Opens instantly (no animation, round-10 #11). */
export function TierPickerMenu({
  children,
  side = 'top',
  align = 'start',
  onOpenManager,
  menuTestId,
}: TierPickerMenuProps) {
  const recommendation = useLlmStore((s) => s.recommendation);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);
  const catalog = useLlmStore((s) => s.catalog);
  /* The download in flight, and the two actions the row's button drives. One
     download runs at a time, so a single state is all the menu needs to know
     whether THIS row is the one transferring. */
  const download = useLlmStore((s) => s.download);
  const downloadError = useLlmStore((s) => s.downloadError);
  const downloadModel = useLlmStore((s) => s.downloadModel);
  const cancelDownload = useLlmStore((s) => s.cancelDownload);
  const quickMenu = useQuickMenu();
  const updateSettings = useSettingsStore((s) => s.update);
  const selection = useModelSelection();
  const isAuto = selection.mode === 'auto';
  const activeTier = selectionTier(selection);
  /*
   * WHAT A SWITCH FROM HERE WOULD COST. `conversationTokens` is the engine's own
   * prompt count for the last turn, so this is the real size of what a different
   * model would have to read — not an estimate from message lengths.
   */
  const liveModelId = useLlmStore((s) => s.status.model?.id ?? null);
  const chatTokens = conversationTokens(usePiStore((st) => st.messages));
  const describeRow = (
    secondary: string | undefined,
    rowModelId: string | null,
  ): string | undefined => {
    if (rowModelId === null || rowModelId === liveModelId || !worthWarning(chatTokens)) {
      return secondary;
    }
    const badge = riskBadge({
      tokens: chatTokens,
      cause: 'model-switch',
      seconds: prefillSeconds(rowModelId, chatTokens),
    });
    return secondary === undefined ? badge : `${secondary} · ${badge}`;
  };
  /*
   * NO MODE GATE. The User / Power-user toggle is gone (the user), and the honest
   * consequence is that everyone gets what Power showed: leaving the persisted
   * 'user' default in charge with no way to change it would have hidden the
   * Model hub, which is reached from this very menu.
   */
  const tierRows = buildTierRows(recommendation?.tierModels, 'power');
  const showManager = onOpenManager !== undefined;

  /* The catalog in the shape the menu logic reads. `bytesOnDisk` is what the
     model actually occupies, which is the number the size-ordered list is
     sorting on — `quants` describes what COULD be fetched. */
  const menuModels: MenuModel[] = catalog.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    bytes: entry.downloadedBytes ?? 0,
    org: orgOf(entry.id, entry.hfRepo),
    downloaded: entry.downloaded,
  }));

  /* Favourites first, then the slots — see quick-menu.ts for why that order. */
  /* The app's own pick per tier, read from the RECOMMENDATION rather than from
     the rendered rows. `buildTierRows` in power mode puts the model name in
     `primary` and the tier label in `secondary`, so taking `secondary` as the
     model name labelled every slot with its own tier — "Fast · Fast". The
     recommendation is where the model actually lives. */
  const tierPicks = Object.fromEntries(
    tierRows.map((r) => {
      const pick = recommendation?.tierModels?.[r.tier];
      return [
        r.tier,
        {
          displayName: pick?.displayName ?? r.primary,
          downloaded: r.downloaded,
          bytes: r.bytes,
        },
      ];
    }),
  );
  const rows = quickMenuRows(quickMenu, menuModels, tierPicks);
  /* WHICH model a row would fetch. A slot pinned to a model names it directly;
     one still following the app's choice has to ask the recommendation, because
     the row itself only knows the tier. */
  const downloadIdFor = (row: { modelId: string | null; tier?: ModelTier }): string | null =>
    row.modelId ??
    (row.tier === undefined ? null : (recommendation?.tierModels?.[row.tier]?.modelId ?? null));
  /*
   * APPLY AGAINST THE LATEST CONFIG, NOT THE RENDERED ONE.
   *
   * The panel builds its next config from the `config` it was rendered with,
   * and settings round-trip through IPC — so two edits in quick succession both
   * started from the pre-edit value and the second silently undid the first.
   * MEASURED: pin a model, rename a slot a second later, and the favourite was
   * gone from settings.json. Reading the store at apply time closes that
   * window; the panel keeps its simple `(next) => …` shape.
   */
  const applyQuickMenu = (next: QuickMenuConfig): void => {
    const live = useSettingsStore.getState().settings.modelQuickMenu ?? DEFAULT_QUICK_MENU;
    void updateSettings({
      modelQuickMenu: {
        // Whichever half this edit did not touch keeps the live value.
        favourites: [
          ...(next.favourites === quickMenu.favourites ? live.favourites : next.favourites),
        ],
        slots: (next.slots === quickMenu.slots ? live.slots : next.slots).map((sl) => ({ ...sl })),
      },
    });
  };

  const favourites = rows.filter((r) => r.kind === 'favourite');
  const slotRows = rows.filter((r) => r.kind === 'slot');

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Refresh the catalog so tierModels + downloaded flags are current.
        if (open) void refreshCatalog();
      }}
    >
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      {/* Mode-aware model picker: both modes list Auto (top, default) + the three
          capability tiers; USER mode leads each tier with its friendly label
          (real model name grey underneath), POWER mode leads with the real model
          name (tier label grey) and keeps a "More models" path to the full
          manager. Opens instantly (no animation, round-10 #11). */}
      <DropdownMenuContent
        className="pd-menu--instant"
        align={align}
        side={side}
        data-testid={menuTestId}
      >
        <DropdownMenuItem
          data-testid="footer-auto"
          description="Picks the best model for each task"
          hint={isAuto ? <IconCheck size={14} /> : undefined}
          onSelect={() => void selectAuto()}
        >
          Auto
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {favourites.length > 0 ? (
          <>
            {favourites.map((fav) => (
              <DropdownMenuItem
                key={fav.key}
                data-testid="footer-favourite"
                description={fav.bytes > 0 ? compactBytes(fav.bytes) : undefined}
                hint={
                  selection.mode === 'model' && selection.modelId === fav.modelId ? (
                    <IconCheck size={14} />
                  ) : undefined
                }
                onSelect={() => {
                  if (fav.modelId !== null) void selectModel(fav.modelId);
                }}
              >
                <span className="flex items-center gap-1.5">
                  <IconPin size={13} />
                  {fav.label}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}

        {/* THE SLOT ROWS COME FROM THE USER'S CONFIG, not the fixed tier list.
            They rendered from `tierRows` — the app's own three tiers — so a
            renamed slot kept showing its old name and an added one never
            appeared at all, even though both were correctly persisted. The
            label is the user's word for the row; the model underneath is the
            grey secondary, so renaming never hides which model runs. */}
        {slotRows.map((row) => (
          <DropdownMenuItem
            key={row.key}
            data-testid="footer-tier"
            /*
             * The model's name, and nothing else. It used to read
             * "qwen3.6 27b · download" — a word dressed as a link, in a grey
             * caption, which is the least button-like place in the row. the user:
             * "instead of the little dot and download put the blue download
             * button that does the progressbar from the model manager." The
             * control moved to the hint slot below, where the checkmark for a
             * downloaded row already lives.
             */
            /*
             * ...AND WHAT SWITCHING WOULD COST, when it would cost something.
             *
             * the user: "flagged to the user to my face right there whenever
             * anything threatens to cause a full re prefill (including model
             * switches) at over 16k context." The moment of choice is the
             * honest place for it — a warning that arrives after the click is
             * an apology, not a warning. Below the threshold it says nothing,
             * because at that size the re-read reads as the model thinking.
             */
            description={
              /* The refusal, where the button was pressed. the user: "clicking
                 download on the model picker … does not download them or show
                 any user indication … that there's not enough disk space". The
                 bar flashed and vanished; the reason stayed in a log. */
              downloadError !== null && downloadError.modelId === downloadIdFor(row) ? (
                <span className="pd-tier-download-error" data-testid="tier-download-error">
                  {downloadError.error}
                </span>
              ) : (
                describeRow(row.secondary ?? undefined, row.modelId)
              )
            }
            // Only a DOWNLOADED row can read as the active model (the user #4): one
            // whose model isn't on disk never shows a selected checkmark —
            // picking it opens the download flow instead of pretending it's
            // active.
            hint={
              row.downloaded ? (
                (
                  row.modelId !== null
                    ? selection.mode === 'model' && selection.modelId === row.modelId
                    : row.tier !== undefined && activeTier === row.tier
                ) ? (
                  <IconCheck size={14} />
                ) : undefined
              ) : (
                <RowDownload
                  modelId={downloadIdFor(row)}
                  label={row.secondary ?? row.label}
                  download={download}
                  onStart={downloadModel}
                  onCancel={cancelDownload}
                />
              )
            }
            // No preventDefault: the menu MUST close on selection (the user #3). A
            // slot the user pinned to a model selects that model; one still
            // following the app's choice selects the tier, as before.
            onSelect={(e) => {
              /* A row whose model is not downloaded selects NOTHING and keeps
                 the menu open — its Download button is the only thing in it
                 that does anything, and closing the menu on the press would
                 hide the bar that press just started. */
              if (!row.downloaded) {
                e.preventDefault();
                return;
              }
              if (row.modelId !== null) void selectModel(row.modelId);
              else if (row.tier !== undefined) void selectTier(row.tier);
            }}
          >
            {row.label}
          </DropdownMenuItem>
        ))}

        {showManager ? (
          <>
            <DropdownMenuSeparator />
            {/*
             * "More models" FLIES OUT TO THE SIDE. the user: "I need to hover on
             * the more models > and then have the stuff popup on the right
             * side, not click and have a menu within a menu."
             *
             * It used to toggle the list open INSIDE this menu, which pushed
             * every row below it down and grew the dropdown past the height of
             * what it was covering. A submenu is the shape the chevron was
             * already promising: hover to open, alongside rather than within,
             * and the short chosen list stays exactly where it was while you
             * browse the long one.
             *
             * The list still opens in the chat rather than jumping to the
             * manager — the common case is picking something already
             * downloaded, and leaving the chat for that is a bigger
             * interruption than the choice deserves. The manager is one click
             * further on.
             */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="footer-more-models">
                More models
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                data-testid="footer-more-models-panel"
                alignOffset={-4}
                /* The panel carries a search field, and Radix's menu typeahead
                   would otherwise eat the keystrokes and jump focus to whatever
                   row started with that letter. */
                onKeyDown={(e) => e.stopPropagation()}
              >
                <QuickMenuPanel
                  models={menuModels}
                  config={quickMenu}
                  activeModelId={selection.mode === 'model' ? selection.modelId : null}
                  onConfigChange={applyQuickMenu}
                  onPick={(id) => void selectModel(id)}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              data-testid="footer-open-manager"
              hint={<IconChevronRight size={14} />}
              onSelect={() => onOpenManager?.()}
            >
              Manage models…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
