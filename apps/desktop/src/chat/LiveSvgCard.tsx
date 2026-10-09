/**
 * THE DRAWING, WHILE IT IS DRAWN.
 *
 * the user (2026-09-21): "svgs created with the svg plugin don't show the model
 * streaming the svg into an svg code block that'll render live as drawing".
 * This is that block: the same inline SVG card a presented drawing gets — the
 * rendered ⇄ raw toggle in its head, so the markup can be watched growing as
 * readily as the picture — fed by the svg-live store a few times a second
 * while OmniSVG's ids stream in. Under it, the white bar every generating card
 * has, and one line: which sample, how many shapes so far.
 *
 * It stands in the chain that started the work and leaves when the job does:
 * the finished file arrives as a presented card (gen-stream → presentFromMain)
 * in the same place, so the drawing settles rather than blinks.
 */
import { InlineWidget } from '@pi-desktop/canvas';
import { sayIfRaw } from '@pi-desktop/shared';
import { useSvgLive } from '../state/svg-live';

/** An empty page in OmniSVG's own frame, for the moment before the first shape. */
const BLANK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"></svg>';

export function LiveSvgCard({ callId }: { callId: string }) {
  const status = useSvgLive((s) => s.status);
  const svg = useSvgLive((s) => s.svg);
  const paths = useSvgLive((s) => s.paths);
  const candidate = useSvgLive((s) => s.candidate);
  const candidates = useSvgLive((s) => s.candidates);
  const error = useSvgLive((s) => s.error);
  // The finished drawing is presented as its own card; this one is done.
  if (status === 'done') return null;
  const drawing = status === 'drawing' && svg !== '';
  const note =
    status === 'error'
      ? (error ?? 'The drawing failed')
      : !drawing
        ? 'Starting the drawing model'
        : `${candidates > 1 ? `Take ${candidate} of ${candidates} · ` : ''}${paths} shape${paths === 1 ? '' : 's'} so far`;
  return (
    <figure className="pd-live-svg" data-testid="live-svg" data-status={status}>
      <InlineWidget
        artifact={{
          id: `live-svg-${callId}`,
          title: 'Drawing',
          filename: 'drawing.svg',
          content: { kind: 'svg', text: drawing ? svg : BLANK },
        }}
      />
      {status === 'error' ? null : (
        <div className="pd-pending-bar" role="progressbar" aria-label="Drawing the SVG">
          <div className="pd-pending-fill" data-indeterminate="true" />
        </div>
      )}
      <span className="pd-pending-pct" data-testid="live-svg-note" aria-live="polite">
        {sayIfRaw(note, 'generate')}
      </span>
    </figure>
  );
}
