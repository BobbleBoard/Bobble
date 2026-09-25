/**
 * Renderer → main: a live diagram card's next frame (diagram-live.ts).
 *
 * the user (2026-09-25): diagrams should "animate/build in real time smoothly".
 * While a `diagram` call's Mermaid is still arriving, the thread asks main to
 * draw the complete lines so far — with the same page, post-pass, kit and
 * roles the tool's own drawing gets (diagram-page.ts runDiagramLive), so the
 * last frame IS the finished card — and animates from one frame to the next.
 */

export interface DiagramLiveRequest {
  /**
   * The call the frames are for. Every frame of one call is drawn under one
   * render id, so the parts keep their names frame to frame; a newer frame
   * for the same call supersedes one still waiting.
   */
  readonly id: string;
  /** The Mermaid so far: whole lines, open blocks closed (diagram-stream.ts). */
  readonly source: string;
  readonly title?: string;
  readonly subtitle?: string;
  /** A kit the call names (its `kit` argument); else the project's. */
  readonly kit?: string;
  readonly look?: 'clean' | 'sketch';
  /** The chat's theme: one drawing, the one on screen. */
  readonly mode: 'light' | 'dark';
  /** The workspace root the tool resolves the project's brand.md against. */
  readonly root?: string;
  /** More lines are still coming: the flow's end is not known yet (runDiagramLive). */
  readonly partial?: boolean;
}

export type DiagramLiveReply =
  | {
      readonly ok: true;
      readonly svg: string;
      readonly width: number;
      readonly height: number;
      readonly kind: string;
      /** The kit it wears, and that kit's paper in this mode (the card's ground). */
      readonly kit: string;
      readonly paper: string;
      /** The Mermaid as drawn. */
      readonly source: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly line: number | null;
      /** A newer frame for the same call was asked for before this one was drawn. */
      readonly superseded?: boolean;
    };

export type DiagramInvokeMap = {
  'diagram:live': { request: DiagramLiveRequest; response: DiagramLiveReply };
};

export const DIAGRAM_INVOKE_CHANNELS = [
  'diagram:live',
] as const satisfies readonly (keyof DiagramInvokeMap)[];
