/**
 * WHAT A TURN MADE, SHOWN IN THE TURN THAT MADE IT.
 *
 * the user: "all are delivered and embedded cleanly and in full quality into the
 * chat aswell as with a file presentation card(s) to export/reveal."
 *
 * This is now a thin arrangement layer. Everything about how one file LOOKS —
 * the frame, the hover controls, the expanded view, the video transport, the
 * turntable — lives in {@link MediaCard}, because the user asked for the same card
 * in the studios and in chat: "these will all be reused from the same reference
 * for drawing in regular chat". A picture you asked for in a conversation and
 * the same picture made in the Image Studio are the same object, and were two
 * different-looking things for as long as each place drew its own.
 *
 * What is left here is the only thing that genuinely differs between the two:
 * how MANY are on screen and how they are laid out.
 */
import type { JSX } from 'react';
import { MediaCard } from '../media/MediaCard';
import type { ThreadMediaItem } from './thread-media';

/**
 * Every file a generate turn produced, mounted under the activity chain that
 * produced it.
 */
export function ThreadMedia({
  items,
  layout = 'single',
}: {
  items: readonly ThreadMediaItem[];
  /*
   * SEVERAL CANDIDATES ARE A SET. Four pictures from one description exist to
   * be compared, and a column of full-width images makes that impossible: one
   * fills the window and the second is below the fold, so the knob whose entire
   * purpose is "generate four and keep the best" could not be acted on. A grid
   * puts them side by side.
   */
  layout?: 'single' | 'grid';
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="pd-thread-media" data-layout={layout} data-testid="thread-media">
      {items.map((item) => (
        <MediaCard key={item.path} item={item} />
      ))}
    </div>
  );
}
