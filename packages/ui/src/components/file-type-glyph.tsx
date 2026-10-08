/**
 * One white mark per file family, drawn on the family's colour tile.
 *
 * Inline SVG, stroke-based, 24-unit box — the same discipline as the rest of
 * the card's glyphs (no icon dependency in the design system's leaf). Each
 * shape is the thing itself: a slide with a bar chart, a page of lines, a grid,
 * a picture, a film frame, a waveform — so a row of cards reads at a glance.
 */
import type { ReactNode } from 'react';
import { FileGlyph, fileLabel } from './file-glyph.tsx';
import type { FileFamily } from './file-type.ts';

/** The 24-unit box every family shape is drawn in; decorative, so hidden from assistive tech. */
function Mark({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * the user (2026-09-20): "all files with specific types" carry the page with the
 * extension written on it (file-glyph.tsx) — so given an extension the tile
 * shows that, on the family's colour; the family shapes below remain for a
 * folder and for anything without an extension the alphabet can set.
 */
export function FileTypeGlyph({
  family,
  ext,
  size = 22,
}: {
  family: FileFamily;
  ext?: string;
  size?: number;
}) {
  if (family !== 'folder' && fileLabel(ext).length > 0) {
    return <FileGlyph ext={ext} size={size} />;
  }
  switch (family) {
    case 'slides':
      return (
        <Mark size={size}>
          <rect x="3" y="5" width="18" height="12" rx="2" />
          <path d="M8 13.5v-3M12 13.5v-5M16 13.5v-2M12 17v3M9 20h6" />
        </Mark>
      );
    case 'document':
      return (
        <Mark size={size}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M8.5 12h7M8.5 15.5h7M8.5 19h4" />
        </Mark>
      );
    case 'sheet':
      return (
        <Mark size={size}>
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M3.5 9.5h17M3.5 15h17M9.5 4v16M15 4v16" />
        </Mark>
      );
    case 'pdf':
      return (
        <Mark size={size}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M8 17c1.5-4.5 2.5-7.5 2.5-9 0-1 1.2-1 1.2 0 0 2.5-2 5.5-3.7 9m0 0c2.5-1 6-2 8-1.5" />
        </Mark>
      );
    case 'image':
      return (
        <Mark size={size}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.6" />
          <path d="M21 16.5l-5.5-5.5-8.5 8.5" />
        </Mark>
      );
    case 'vector':
      return (
        <Mark size={size}>
          <path d="M5 19C5 9 19 15 19 5" />
          <rect x="3" y="17" width="4" height="4" rx="1" />
          <rect x="17" y="3" width="4" height="4" rx="1" />
        </Mark>
      );
    case 'video':
      return (
        <Mark size={size}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18M3 15h18M7 5v14M17 5v14" />
        </Mark>
      );
    case 'audio':
      return (
        <Mark size={size}>
          <path d="M4 12v1M7.5 8.5v7M11 5v14M14.5 9v6M18 7v10M21.5 11v2" />
        </Mark>
      );
    case 'page':
      return (
        <Mark size={size}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
          <path d="M9.5 13l-2 2 2 2M14.5 13l2 2-2 2" />
        </Mark>
      );
    case 'code':
      return (
        <Mark size={size}>
          <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
        </Mark>
      );
    case 'text':
      return (
        <Mark size={size}>
          <path d="M5 6h14M5 10h14M5 14h10M5 18h7" />
        </Mark>
      );
    case 'model3d':
      return (
        <Mark size={size}>
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
          <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" />
        </Mark>
      );
    case 'archive':
      return (
        <Mark size={size}>
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <path d="M10 5v3h4V5M12 11v5M10.5 14.5h3" />
        </Mark>
      );
    case 'folder':
      return (
        <Mark size={size}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </Mark>
      );
    default:
      return (
        <Mark size={size}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </Mark>
      );
  }
}
