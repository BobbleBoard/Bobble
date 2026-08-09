import { IconDoc } from '../tab-icons.tsx';
import { type ContentSlotOptions, useContentSlot } from './content-slot.ts';

export interface OfficeSurfaceProps extends ContentSlotOptions {
  /** Absolute path of the document being edited; drives the empty state. */
  filePath?: string;
  /** Shown while the editor's first paint is still pending. */
  label?: string;
  className?: string;
}

/**
 * OfficeSurface — the CONTENT for a live office-editor tab (docx / xlsx / pptx
 * / pdf), backed by the vendored GenOffice editors.
 *
 * Structurally identical to {@link BrowserSurface}, and for the same reason:
 * the editor is a native WebContentsView the APP mounts and positions over this
 * slot. `onMount(el)` hands over the slot element and `onRectChange(rect)`
 * streams its viewport rect; both null on unmount, which hides the view rather
 * than destroying it.
 *
 * The slot always renders so a rect exists before the editor has painted — a
 * view positioned against a zero rect is invisible, which reads as "the
 * document failed to load" rather than "the layout has not settled yet".
 *
 * There is no toolbar here on purpose. The editor draws its own ribbon inside
 * the native view, so any chrome we added would sit above a second, real one.
 */
export function OfficeSurface({
  filePath,
  label,
  onMount,
  onRectChange,
  className,
}: OfficeSurfaceProps) {
  const slotRef = useContentSlot({ onMount, onRectChange });
  const rootClass = ['pd-office', className].filter(Boolean).join(' ');
  return (
    <div className={rootClass}>
      <div className="pd-office-content">
        <div ref={slotRef} className="pd-office-slot" data-native-slot="office" />
        {filePath ? null : (
          <div className="pd-office-empty" aria-hidden="true">
            <IconDoc size={48} />
            <p className="pd-office-empty-title">{label ?? 'No document'}</p>
            <p className="pd-office-empty-sub">Open a .docx, .xlsx, .pptx or .pdf</p>
          </div>
        )}
      </div>
    </div>
  );
}
