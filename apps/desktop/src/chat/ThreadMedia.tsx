/**
 * WHAT A TURN MADE, SHOWN IN THE TURN THAT MADE IT.
 *
 * the user: "all are delivered and embedded cleanly and in full quality into the
 * chat aswell as with a file presentation card(s) to export/reveal."
 *
 * FULL QUALITY IS THE SPECIFIC ASK, and the reason this exists rather than
 * reusing what was there. Generated images reached the thread as a markdown
 * embed capped to 414px, because they were competing with a canvas row showing
 * the same picture; video and audio reached it as a file path in prose. Here the
 * image renders at its natural size bounded only by the column, the video is a
 * real player, and the sound has a waveform.
 *
 * THE CARD IS NOT DECORATION. A generated file that only exists as a player is a
 * file you cannot find again — the card is the part that says what it is called,
 * how big it is, and gives you Reveal, which is how it leaves the app.
 */
import type React from 'react';
import { type JSX, useEffect, useState } from 'react';
/*
 * The canonical builder, NOT a hand-rolled template.
 *
 * MEASURED: `pd-file://${path}` returns 404 "not found" — nine bytes, which is
 * what the file card cheerfully displayed as the file's size. The scheme's URL
 * shape is `pd-file://f` + the percent-encoded absolute path, and writing it by
 * hand puts the first path segment in the HOST position, where it fails the very
 * first check in the protocol handler. The same mistake is in StudioView.
 */
import { pdFileUrl as url } from './canvas/file-preview';
import { ThreadAudio } from './ThreadAudio';
import { ThreadImage } from './ThreadImage';
import { humanSize, type ThreadMediaItem } from './thread-media';

function KindGlyph({ kind }: { kind: ThreadMediaItem['kind'] }): JSX.Element {
  const d =
    kind === 'audio'
      ? 'M9 3.5v6.2a2.2 2.2 0 1 1-1.4-2V5.4L12.5 4v4.6a2.2 2.2 0 1 1-1.4-2V3z'
      : kind === 'video'
        ? 'M2.5 4.5h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Zm9 2.2 3-1.7v6l-3-1.7z'
        : 'M2.5 3.5h11v9h-11zM5 9.5l2-2 2.5 2.5 1.5-1.2 2 1.7';
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <title>{kind}</title>
      <path
        d={d}
        fill={kind === 'image' ? 'none' : 'currentColor'}
        stroke={kind === 'image' ? 'currentColor' : 'none'}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The presentation card: identity plus the two things you do with a file.
 *
 * Size is read lazily from the served response rather than passed in, because
 * the tool result only ever named the path — and a card that says "204 KB" is
 * doing the job a card exists for, while one that says nothing is a filename
 * with buttons.
 */
function FileCard({ item }: { item: ThreadMediaItem }): JSX.Element {
  const [bytes, setBytes] = useState<number | undefined>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    // HEAD would be cheaper but the custom scheme does not implement it; the
    // body is already in the page cache from the player above.
    fetch(url(item.path), { signal: ac.signal })
      .then((r) => r.blob())
      .then((b) => setBytes(b.size))
      .catch(() => undefined);
    return () => ac.abort();
  }, [item.path]);

  const reveal = (): void => {
    void window.piDesktop.invoke('canvas:reveal', { path: item.path }).catch(() => undefined);
  };
  const saveAs = (): void => {
    void window.piDesktop
      .invoke('canvas:save-as', { path: item.path, suggestedName: item.name })
      .catch(() => undefined);
  };
  /*
   * DRAG THE CARD INTO FINDER.
   *
   * The file is already real and already at a real path, so this is the gesture
   * people expect and the one a browser tab cannot offer. `preventDefault`
   * stops the HTML5 drag (which would carry text) so the OS drag started in
   * main is the only one running.
   */
  const onDragStart = (e: React.DragEvent): void => {
    e.preventDefault();
    void window.piDesktop.invoke('canvas:start-drag', { path: item.path }).catch(() => undefined);
  };

  return (
    /*
     * Drag is a mouse-only affordance by nature, which is what the a11y rule is
     * warning about — so the same action has a keyboard-and-screen-reader path
     * beside it: the Save button, which is why it is there.
     */
    // biome-ignore lint/a11y/noStaticElementInteractions: Save is the accessible equivalent.
    <div
      className="pd-file-card"
      data-testid="thread-file-card"
      draggable
      onDragStart={onDragStart}
      title={`${item.path} — drag me anywhere`}
    >
      <span className="pd-file-card-icon">
        <KindGlyph kind={item.kind} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="pd-file-card-name" title={item.path}>
          {item.name}
        </span>
        <span className="pd-file-card-meta">
          {item.kind}
          {bytes !== undefined ? ` · ${humanSize(bytes)}` : ''}
        </span>
      </span>
      <button
        type="button"
        className="pd-file-card-action pd-focusable"
        data-testid="thread-file-save"
        onClick={saveAs}
      >
        Save
      </button>
      <button
        type="button"
        className="pd-file-card-action pd-focusable"
        data-testid="thread-file-reveal"
        onClick={reveal}
      >
        Reveal
      </button>
    </div>
  );
}

function One({ item }: { item: ThreadMediaItem }): JSX.Element {
  return (
    <div className="pd-thread-media-item">
      {item.kind === 'image' ? (
        <ThreadImage src={url(item.path)} alt={item.name} />
      ) : item.kind === 'video' ? (
        // Native controls here, unlike audio: a video already shows its own
        // content, so the transport has nothing to add beyond scrubbing — and
        // the platform's is better at fullscreen and picture-in-picture.
        <video
          className="pd-thread-video"
          data-testid="thread-video"
          src={url(item.path)}
          controls
          preload="metadata"
          playsInline
        >
          <track kind="captions" />
        </video>
      ) : (
        <ThreadAudio src={url(item.path)} name={item.name} />
      )}
      <FileCard item={item} />
    </div>
  );
}

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
        <One key={item.path} item={item} />
      ))}
    </div>
  );
}
