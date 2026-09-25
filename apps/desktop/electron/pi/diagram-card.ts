/**
 * A DIAGRAM'S CARD, read off disk — shared by main (a presented .svg,
 * present-inline.ts) and the renderer (a chat reopened after a restart,
 * state/present-store.ts rehydratePresented), so both read the diagram tool's
 * files one way. Pure over an injected reader: no fs, no Buffer, so the
 * renderer can import it.
 *
 * The `diagram` tool (packages/harness diagram-tool.ts) writes `<stem>.svg`
 * (the light drawing), `<stem>.diagram.mmd` (the source) and
 * `<stem>.diagram.json` (this card's sidecar: title, kind, kit, the source as
 * drawn, both sizes and the dark drawing).
 */

/** The `diagram` tool's card sidecar: `<stem>.svg` + `<stem>.diagram.json`. */
export const DIAGRAM_SIDECAR_SUFFIX = '.diagram.json';

/** Both drawings travel inline up to this many characters together — far above any real diagram. */
export const INLINE_DIAGRAM_MAX_CHARS = 2 * 1024 * 1024;

/**
 * A diagram's card: both drawings (the .svg on disk is the light one, the
 * sidecar carries the dark) and the Mermaid behind them, for the card's
 * source view.
 */
export interface DiagramCardPayload {
  readonly title: string;
  readonly subtitle?: string;
  readonly kind: string;
  readonly kit: string;
  readonly source: string;
  readonly light: DiagramDrawingCard;
  readonly dark: DiagramDrawingCard;
}

export interface DiagramDrawingCard {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  /** The drawing's paper, so the card around it can wear the same ground. */
  readonly paper?: string;
}

const size = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/**
 * The card for a diagram's .svg (`markup` is that file), or null when there is
 * no readable sidecar beside it — a plain SVG, which the caller treats as one.
 */
export async function readDiagramCard(
  svgPath: string,
  markup: string,
  read: (p: string) => Promise<string>,
): Promise<DiagramCardPayload | null> {
  if (!/\.svg$/i.test(svgPath) || !/<svg[\s>]/i.test(markup)) return null;
  let side: Record<string, unknown>;
  try {
    const parsed = JSON.parse(
      await read(`${svgPath.slice(0, -4)}${DIAGRAM_SIDECAR_SUFFIX}`),
    ) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    side = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const dark = side.dark as
    | { svg?: unknown; width?: unknown; height?: unknown; paper?: unknown }
    | undefined;
  const light = side.light as { width?: unknown; height?: unknown; paper?: unknown } | undefined;
  const paper = (v: unknown): { paper?: string } =>
    typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? { paper: v } : {};
  const lw = size(light?.width);
  const lh = size(light?.height);
  const dw = size(dark?.width);
  const dh = size(dark?.height);
  if (lw === null || lh === null || dw === null || dh === null) return null;
  if (typeof dark?.svg !== 'string' || !/<svg[\s>]/i.test(dark.svg)) return null;
  if (markup.length + dark.svg.length > INLINE_DIAGRAM_MAX_CHARS) return null;
  return {
    title: typeof side.title === 'string' ? side.title : '',
    ...(typeof side.subtitle === 'string' && side.subtitle !== ''
      ? { subtitle: side.subtitle }
      : {}),
    kind: typeof side.kind === 'string' && side.kind !== '' ? side.kind : 'diagram',
    kit: typeof side.kit === 'string' ? side.kit : '',
    source: typeof side.source === 'string' ? side.source : '',
    light: { svg: markup, width: lw, height: lh, ...paper(light?.paper) },
    dark: { svg: dark.svg, width: dw, height: dh, ...paper(dark?.paper) },
  };
}
