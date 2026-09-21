import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { FileGlyph } from './file-glyph.tsx';
import {
  IconChart,
  IconClock,
  IconCode,
  IconCompass,
  IconConnector,
  IconCursor,
  IconExternal,
  IconEye,
  IconFile,
  IconFolderOpen,
  IconGateOpen,
  IconGears,
  IconGlobe,
  IconHandoff,
  IconKeyboard,
  IconOrg,
  IconPencil,
  IconPuzzle,
  IconSearch,
  IconSparkles,
  IconSubmit,
  IconTerminal,
} from './icons.tsx';

/*
 * Individualized tool-step icons (THEME 3 / spec-tool-call-row). Claude's
 * signature is a per-tool glyph plus, for file steps, a small file-extension
 * badge tucked under a generic file sheet ("PY", "PNG", …). One helper —
 * toolIcon(kind, filename?) — picks the glyph so the chain, the app, and the
 * canvas all read files the same way.
 */

/** The kinds a tool/thinking step can be. Mirrors ActivityStepKind. */
export type ToolIconKind =
  | 'thinking'
  | 'bash'
  // A code-execution tool (python_run / run_python): the code brackets glyph,
  // distinct from bash's terminal caret.
  | 'python'
  | 'edit'
  | 'read'
  // A directory LISTING — an OPEN folder glyph, never the file sheet, and never
  // the closed folder either: listing is the act of looking inside one.
  | 'folder'
  /*
   * THE COORDINATION STEPS. A corp run's most important rows are who was asked
   * and what for, and they were rendering as the neutral puzzle glyph because
   * they had no kind of their own. Each gets a distinct mark so a hand-off is
   * recognisable at a glance in a chain of forty rows.
   */
  | 'talk'
  // The CEO→manager hand-off. Distinct from `talk` (peer to peer): this one
  // starts the team, so it reads as an org branching rather than a message.
  | 'manager'
  | 'commission'
  | 'delegate'
  | 'toolkit'
  | 'submit'
  | 'search'
  // The `tool_search` builtin: a magnifier over the TOOL registry (not the web),
  // so it reads "Searched tools" with the search-glass glyph, never the web globe.
  | 'tool-search'
  /*
   * THE GENERATE FAMILY. Each names what it produced rather than sharing one
   * "image" bucket: a row that says "Made a sound effect" beside a waveform is
   * doing work, and "Used a tool" beside the same waveform is not.
   */
  | 'video'
  | 'speech'
  | 'music'
  | 'sfx'
  // A 3D model built or refined by the Bobble 3D connector (generate_3d /
  // refine_3d): the GLB badge, "Built a 3D model" — never "Used a tool"
  // beside a mesh the user can turn.
  | 'model3d'
  // …and a pass over one that exists (refine_3d: texture / segment / rig /
  // retopo), so the collapsed line says "Refined", not "Built", about a rig.
  | 'model3d-refine'
  | 'file'
  // A SKILL / tool-instructions read (a SKILL.md under the pi skills dir):
  // reads distinctly as "Read a skill" with its own sparkle glyph — NOT the
  // generic file sheet — because its content is instructions, not a plain file.
  | 'skill'
  | 'image'
  /* A drawing the svg tool made — the vector-file mark, and rows that say
     "Drew an SVG" rather than "Generated an image" (the user, 2026-09-21). */
  | 'svg'
  | 'pdf'
  // A chart drawn by the `chart` tool (or `chart_edit`): the data-visuals
  // mark, and a label that names the kind of chart — the user (2026-09-17):
  // "'<Datavisualization connector icon> Rendering <type> Chart'", not four
  // rows that all said "Chart" beside a spinner.
  | 'chart'
  | 'canvas-open'
  // Browser-action steps (round-10 #17): each carries its own glyph.
  | 'browser-navigate'
  | 'browser-click'
  | 'browser-type'
  | 'browser-read'
  // A connector / MCP call (calendar / mail / reminders / a branded MCP server):
  // renders the connector's own inline brand SVG (`iconSvg`), falling back to the
  // neutral plug glyph. "Used <connector icon> <connector name>".
  | 'connector'
  // The NEUTRAL generic fallback for any tool we don't specifically recognize —
  // a puzzle-piece glyph + the humanized tool name. NEVER the file sheet + "Read
  // a file", which used to be the catch-all and mislabeled every unknown tool.
  | 'tool';

/** Extract a short (<=4 char) uppercase extension from a filename/path. */
export function fileExt(filename: string | undefined): string {
  if (!filename) return '';
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base
    .slice(dot + 1)
    .slice(0, 4)
    .toUpperCase();
}

export interface FileExtIconProps extends HTMLAttributes<HTMLSpanElement> {
  /** Extension text (with or without leading dot); shown as an uppercase badge. */
  ext?: string;
  /** Glyph diameter in px. */
  size?: number;
}

/**
 * The page with the extension written on it (`FileExtIcon ext="py"`) — the
 * letters are strokes on the page (file-glyph.tsx), not a text badge, so they
 * take the icon stroke like everything else. A plain page without one.
 */
export const FileExtIcon = forwardRef<HTMLSpanElement, FileExtIconProps>(function FileExtIcon(
  { ext, size = 20, className, style, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx('pd-file-ext-icon', className)}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
      {...rest}
    >
      <FileGlyph ext={ext} size={size} />
    </span>
  );
});

/**
 * A connector's own inline brand SVG mark (from the mcp-lite connector-icons
 * catalog, injected by the caller — packages/ui never imports mcp-lite). The
 * markup is trusted: it originates from the in-repo connector catalog, never
 * user input or the network (same seam the connectors gallery's ConnectorIcon
 * uses). Falls back to the neutral plug glyph when no mark was resolved.
 */
function ConnectorGlyph({ iconSvg, size }: { iconSvg?: string; size: number }): ReactNode {
  if (iconSvg !== undefined && iconSvg.length > 0) {
    return (
      <span
        className="pd-connector-icon pd-chain-connector-icon"
        style={{ width: size, height: size, display: 'inline-flex' }}
        aria-hidden="true"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, self-contained brand SVG from the in-repo connector catalog (no user/network input)
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
    );
  }
  return <IconConnector size={size} />;
}

/**
 * Pick a step glyph by kind (+ filename for the ext badge, + `iconSvg` for a
 * connector's brand mark). Media kinds (image/pdf) and file kinds carry the
 * badge; a connector renders its injected brand SVG; the rest get a bare glyph.
 */
export function toolIcon(
  kind: ToolIconKind,
  filename?: string,
  size = 16,
  iconSvg?: string,
): ReactNode {
  switch (kind) {
    case 'thinking':
      return <IconClock size={size} />;
    case 'bash':
      return <IconTerminal size={size} />;
    case 'python':
      return <IconCode size={size} />;
    case 'search':
      return <IconGlobe size={size} />;
    case 'tool-search':
      return <IconSearch size={size} />;
    case 'connector':
      return <ConnectorGlyph iconSvg={iconSvg} size={size} />;
    case 'tool':
      return <IconPuzzle size={size} />;
    case 'chart':
      return <IconChart size={size} />;
    case 'skill':
      // The sparkle is the app's established "skills" mark (the add-menu Skills
      // entry uses it), so a skill read reads as a skill everywhere.
      return <IconSparkles size={size} />;
    case 'browser-navigate':
      return <IconCompass size={size} />;
    case 'browser-click':
      return <IconCursor size={size} />;
    case 'browser-type':
      return <IconKeyboard size={size} />;
    case 'browser-read':
      return <IconEye size={size} />;
    case 'canvas-open':
      return <IconExternal size={size} />;
    case 'edit':
      return filename ? (
        <FileExtIcon ext={fileExt(filename)} size={size + 4} />
      ) : (
        <IconPencil size={size} />
      );
    case 'folder':
      return <IconFolderOpen size={size} />;
    case 'talk':
      return <IconHandoff size={size} />;
    case 'manager':
      return <IconOrg size={size} />;
    case 'commission':
      return <IconSparkles size={size} />;
    case 'delegate':
      return <IconGateOpen size={size} />;
    case 'toolkit':
      return <IconGears size={size} />;
    case 'submit':
      return <IconSubmit size={size} />;
    case 'read':
    case 'file':
      return filename ? (
        <FileExtIcon ext={fileExt(filename)} size={size + 4} />
      ) : (
        <IconFile size={size} />
      );
    case 'image':
      return <FileExtIcon ext={fileExt(filename) || 'PNG'} size={size + 4} />;
    case 'svg':
      return <FileExtIcon ext="SVG" size={size + 4} />;
    case 'video':
      return <FileExtIcon ext={fileExt(filename) || 'MP4'} size={size + 4} />;
    case 'speech':
    case 'music':
    case 'sfx':
      return <FileExtIcon ext={fileExt(filename) || 'WAV'} size={size + 4} />;
    case 'model3d':
    case 'model3d-refine':
      return <FileExtIcon ext={fileExt(filename) || 'GLB'} size={size + 4} />;
    case 'pdf':
      return <FileExtIcon ext={fileExt(filename) || 'PDF'} size={size + 4} />;
    default:
      // Unknown kind → the neutral generic-tool glyph, NEVER the file sheet.
      return <IconPuzzle size={size} />;
  }
}

export interface ToolIconProps {
  kind: ToolIconKind;
  filename?: string;
  size?: number;
  /** A connector's inline brand SVG (only read for the `connector` kind). */
  iconSvg?: string;
}

/** Component wrapper around {@link toolIcon} for JSX ergonomics. */
export function ToolIcon({ kind, filename, size, iconSvg }: ToolIconProps) {
  return <>{toolIcon(kind, filename, size, iconSvg)}</>;
}
