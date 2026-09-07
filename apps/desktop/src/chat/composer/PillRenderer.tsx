/**
 * How a {@link PillNode} draws: a blue pill, a mark, and its words.
 *
 * Registered once from the composer rather than imported by the node, so the
 * node stays a small serializable thing and the icon set does not end up in its
 * import graph.
 *
 * There is no X and no click handler here on purpose — see the note at the foot
 * of the component. Backspace beside a pill removes it whole (pill-delete.ts),
 * which is the key everybody already presses for a word.
 */

import {
  IconConnector,
  IconFile,
  IconGlobe,
  IconImage,
  IconPencil,
  IconSparkles,
  IconVideo,
} from '@pi-desktop/ui';
import type { NodeKey } from 'lexical';
import type { ComponentType } from 'react';
import { type PillData, type PillIcon, setPillRenderer } from './pill-node';

const ICONS: Record<PillIcon, ComponentType<{ size?: number }>> = {
  file: IconFile,
  image: IconImage,
  video: IconVideo,
  motion: IconSparkles,
  search: IconGlobe,
  write: IconPencil,
  sparkle: IconSparkles,
  connector: IconConnector,
};

/** `nodeKey` is accepted and unused: the renderer signature is the node's, and
 * a pill that needed to edit the document would need it back. */
function Pill({ data }: { data: PillData; nodeKey: NodeKey }) {
  const Icon = ICONS[data.icon] ?? IconFile;
  return (
    <span className="pd-pill" data-testid="composer-pill" title={data.payload}>
      {/*
        The REAL mark when the thing has one (a connector), the generic glyph
        otherwise. The SVG is in-repo catalog markup — see PillData.iconSvg.
      */}
      {data.iconSvg !== undefined && data.iconSvg.length > 0 ? (
        <span
          className="pd-pill-brand"
          aria-hidden
          data-testid="composer-pill-brand"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, self-contained brand SVG from the in-repo connector catalog (no user/network input)
          dangerouslySetInnerHTML={{ __html: data.iconSvg }}
        />
      ) : (
        <Icon size={12} />
      )}
      <span className="pd-pill-label">{data.label}</span>
      {/*
        NO X. the user: "these pills: no border, no X … clicking on any and clicking
        delete should remove them." A pill is a word in a sentence — an X on each
        one turns a typed line into a row of controls, and the key that removes a
        word is the one everybody already presses.
      */}
    </span>
  );
}

/** Call once, at module load, before any pill can be created. */
export function registerPillRenderer(): void {
  setPillRenderer((data, nodeKey) => <Pill data={data} nodeKey={nodeKey} />);
}
