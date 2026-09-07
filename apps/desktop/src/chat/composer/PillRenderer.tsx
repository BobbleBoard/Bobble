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

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  IconConnector,
  IconFile,
  IconGlobe,
  IconImage,
  IconPencil,
  IconSparkles,
  IconVideo,
} from '@pi-desktop/ui';
import {
  $createNodeSelection,
  $getSelection,
  $isNodeSelection,
  $setSelection,
  type NodeKey,
} from 'lexical';
import { type ComponentType, useEffect, useState } from 'react';
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

function Pill({ data, nodeKey }: { data: PillData; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const [selected, setSelected] = useState(false);
  const Icon = ICONS[data.icon] ?? IconFile;

  /*
   * CLICKING A PILL SELECTS IT. the user: "clicking on any and clicking delete
   * should remove them."
   *
   * Lexical does not do this for you: a decorator's DOM swallows the click, so
   * the editor's selection never moves onto the node and Delete has nothing to
   * act on — pressing it did precisely nothing. Setting a NodeSelection here is
   * what makes the pill the thing the next keystroke is about (pill-delete.ts
   * removes a selected pill on either key), and gives the click something to
   * show for itself.
   */
  useEffect(() => {
    // The highlight follows the editor's own selection, so clicking elsewhere
    // clears it without this component having to hear about it.
    return editor.registerUpdateListener(({ editorState }) => {
      setSelected(
        editorState.read(() => {
          const sel = $getSelection();
          return $isNodeSelection(sel) && sel.has(nodeKey);
        }),
      );
    });
  }, [editor, nodeKey]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer affordance on an inline token; the keyboard reaches it with Backspace/Delete beside it
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — there is no separate keyboard gesture for "select this word"
    <span
      className="pd-pill"
      data-testid="composer-pill"
      data-selected={selected ? '' : undefined}
      title={data.payload}
      onClick={() => {
        editor.update(() => {
          const sel = $createNodeSelection();
          sel.add(nodeKey);
          $setSelection(sel);
        });
      }}
    >
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
