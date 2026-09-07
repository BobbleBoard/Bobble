/**
 * How a {@link PillNode} draws: a blue pill, an icon, its words, and an X.
 *
 * Registered once from the composer rather than imported by the node, so the
 * node stays a small serializable thing and the icon set does not end up in its
 * import graph.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  IconClose,
  IconFile,
  IconGlobe,
  IconImage,
  IconPencil,
  IconSparkles,
  IconVideo,
} from '@pi-desktop/ui';
import { $getNodeByKey, type NodeKey } from 'lexical';
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
};

function Pill({ data, nodeKey }: { data: PillData; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const Icon = ICONS[data.icon] ?? IconFile;
  /*
   * Removing a node is only legal inside `editor.update()`, and only a component
   * inside the Lexical context can open one. The first cut closed over a bare
   * `node.remove()` from the node itself and the X silently did nothing.
   */
  const remove = () => {
    editor.update(() => {
      $getNodeByKey(nodeKey)?.remove();
    });
    editor.focus();
  };
  return (
    <span className="pd-pill" data-testid="composer-pill" title={data.payload}>
      <Icon size={12} />
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
