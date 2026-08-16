/**
 * MODEL MANAGEMENT AS ITS OWN SURFACE.
 *
 * the user: "the actual overhaul of the model management window that I wanted to
 * 1. not be in the settings area, it's just a separate thing replacing the chat
 * area. and we totally copy the layout of unsloth studio and how they show it,
 * it's familiar, similar to lmstudio also."
 *
 * So this replaces the chat area rather than living inside the (now floating)
 * settings panel. Two consequences drive the layout:
 *
 *   - It gets the FULL window width. The old panel was capped at 760px because
 *     it shared a scroll column with checkbox-shaped settings; a model browser
 *     wants the width for a list + detail, which is exactly what Unsloth Studio
 *     and LM Studio do.
 *   - It owns a header. A settings section inherits its title from the nav; a
 *     view has to say what it is and how to leave.
 *
 * The catalog/HF-search/favorites/quant-fit logic is NOT rewritten here — it is
 * the tested content of ModelManagerPanel (and model-manager-logic.ts, which
 * owns the Unsloth-style three-key quant sort and the RAM fit verdicts). This
 * file is the surface those render into, so moving the window did not put any
 * of that behaviour at risk.
 */
import { IconChevronLeft } from '@pi-desktop/ui';
import { ModelManagerPanel } from '../settings/ModelManagerPanel';

export function ModelsView({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full flex-col bg-bg-base" data-testid="models-view">
      {/* Draggable strip clearing the macOS traffic lights; the button opts out
          so it stays clickable inside a drag region. */}
      <div className="flex h-11 shrink-0 items-center gap-3 pr-4 pl-[80px] [-webkit-app-region:drag]">
        <button
          type="button"
          data-testid="models-back"
          onClick={onClose}
          className="[-webkit-app-region:no-drag] flex items-center gap-1.5 rounded-lg px-2 py-1 text-footnote text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pd-focusable"
        >
          <IconChevronLeft size={15} />
          Back to chat
        </button>
      </div>

      <div className="shrink-0 px-8 pb-2">
        <h1 className="text-title text-text-primary">Models</h1>
        <p className="mt-0.5 text-footnote text-text-muted">
          Download, compare and switch the models Bobble runs locally.
        </p>
      </div>

      {/* ModelManagerPanel brings its own tabs + scrolling; it just needs room. */}
      <div className="min-h-0 flex-1 px-8 pb-8">
        <ModelManagerPanel />
      </div>
    </div>
  );
}
