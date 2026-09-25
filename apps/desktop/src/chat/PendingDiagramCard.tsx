/**
 * THE DIAGRAM, WHILE IT IS BEING MADE.
 *
 * the user (2026-09-25): "ensure those animate/build in real time smoothly". Until
 * this, a diagram arrived whole when the tool answered — seconds after the
 * model had started typing it — and nothing showed while it did. Now the card
 * stands beneath the chain from the call's first whole line: each time a new
 * line has arrived (at most every ~200 ms), main draws the lines so far with
 * the tool's own renderer (electron/gen/diagram-live.ts), and the drawing
 * moves into the new frame — new steps fading in, edges drawing themselves,
 * the rest gliding to their new places (DiagramDrawing / diagram-morph.ts). A
 * line Mermaid cannot read yet keeps the last frame that it could.
 *
 * It is the finished card's frame, in the finished card's place (the same
 * InlineWidget, the same paper, the same box), so when the tool answers and
 * the presented card takes over there is nothing to jump: the last frame IS
 * that drawing, and if it is not quite, the finished card moves on from it
 * (diagram-handover.ts).
 */
import { InlineWidget } from '@pi-desktop/canvas';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { DiagramLiveRequest } from '../../electron/gen/diagram-contract';
import { usePiStore } from '../state/pi-slice';
import { DiagramDrawing, useDataMode } from './DiagramDrawing';
import {
  liveSource,
  nextRender,
  type PendingDiagramArgs,
  type RenderState,
} from './diagram-stream';
import { keepLiveFrame } from './live-handover';

/**
 * How tall a diagram card grows before the fade and "Open in canvas" take over
 * — the live card's and the finished card's (PresentedInline). A drawing
 * scales to the card's WIDTH only, so height is what keeps it legible: the
 * research's flow drawn top-down (which the tool's guidance asks for — it fits
 * the chat's 700 px) is 394 × 910 px at its 16 px labels, and the 560 px every
 * other card uses cut it off at the second decision. The chat scrolls
 * vertically, so a diagram gets the height to be read whole.
 */
export const DIAGRAM_CARD_MAX_HEIGHT = 960;

/** A diagram's head label: "Flowchart", "Sequence diagram". */
export function kindLabel(kind: string): string {
  return kind === '' ? 'Diagram' : `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** What the source's first word says it is, before a frame does (diagram-page.ts DIAGRAM_TYPES). */
function kindOf(source: string | undefined): string {
  const word = /^\s*(?:%%[^\n]*\n\s*)*([A-Za-z][\w-]*)/.exec(source ?? '')?.[1] ?? '';
  if (/^(?:flowchart|graph)$/.test(word)) return 'flowchart';
  if (word === 'sequenceDiagram') return 'sequence diagram';
  if (word === 'classDiagram') return 'class diagram';
  if (/^stateDiagram/.test(word)) return 'state diagram';
  if (word === 'erDiagram') return 'entity-relationship diagram';
  if (word === 'mindmap') return 'mind map';
  if (word === 'timeline') return 'timeline';
  return '';
}

interface LiveFrame {
  readonly svg: string;
  readonly paper: string;
  readonly kind: string;
}

/** The workspace root the tool resolves the project's brand.md against. */
function useWorkspaceRoot(): string | undefined {
  const harness = usePiStore((s) => s.extensionStatus?.harness);
  const cwd = usePiStore((s) => s.session?.cwd ?? undefined);
  return useMemo(() => {
    try {
      const parsed =
        harness === undefined ? null : (JSON.parse(harness) as { workspaceRoot?: unknown });
      if (typeof parsed?.workspaceRoot === 'string' && parsed.workspaceRoot !== '') {
        return parsed.workspaceRoot;
      }
    } catch {
      /* the status is not ours to parse strictly */
    }
    return cwd;
  }, [harness, cwd]);
}

/**
 * The newest frame main has drawn for this call: asked for when a new whole
 * line arrives, never more than one in flight, never closer than FRAME_GAP_MS.
 */
function useLiveFrame(
  callId: string,
  args: PendingDiagramArgs,
  mode: 'light' | 'dark',
  root: string | undefined,
): LiveFrame | null {
  const source = useMemo(
    () => liveSource(args.source, args.sourceClosed),
    [args.source, args.sourceClosed],
  );
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const state = useRef<RenderState>({ lastKey: null, lastAt: 0, inFlight: false });
  const want = useRef<{ key: string; req: DiagramLiveRequest } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const pump = useRef<() => void>(() => undefined);
  pump.current = () => {
    const w = want.current;
    if (w === null) return;
    const now = performance.now();
    const next = nextRender(state.current, w.key, now);
    if (next.kind === 'skip') return;
    if (next.kind === 'later') {
      if (timer.current === undefined) {
        timer.current = setTimeout(() => {
          timer.current = undefined;
          pump.current();
        }, next.waitMs);
      }
      return;
    }
    state.current = { lastKey: w.key, lastAt: now, inFlight: true };
    void window.piDesktop
      .invoke('diagram:live', w.req)
      .then((reply) => {
        if (!alive.current || !reply.ok) return;
        setFrame({ svg: reply.svg, paper: reply.paper, kind: reply.kind });
        keepLiveFrame(callId, reply.svg, w.req.mode);
      })
      .catch(() => undefined)
      .finally(() => {
        state.current = { ...state.current, inFlight: false };
        if (alive.current) pump.current();
      });
  };
  const key =
    source === null
      ? null
      : JSON.stringify([
          source,
          args.sourceClosed,
          args.title,
          args.subtitle,
          args.kit,
          args.look,
          mode,
          root,
        ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is everything the frame is drawn from
  useEffect(() => {
    if (key === null || source === null) return;
    want.current = {
      key,
      req: {
        id: callId,
        source,
        mode,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.subtitle !== undefined ? { subtitle: args.subtitle } : {}),
        ...(args.kit !== undefined ? { kit: args.kit } : {}),
        ...(args.look !== undefined ? { look: args.look } : {}),
        ...(root !== undefined ? { root } : {}),
        ...(args.sourceClosed ? {} : { partial: true }),
      },
    };
    pump.current();
  }, [key]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, []);
  return frame;
}

export function PendingDiagramCard({ callId, args }: { callId: string; args: PendingDiagramArgs }) {
  const mode = useDataMode();
  const root = useWorkspaceRoot();
  const frame = useLiveFrame(callId, args, mode, root);
  const kind = frame?.kind ?? kindOf(args.source);
  const style = (frame !== null ? { '--pd-diagram-paper': frame.paper } : {}) as CSSProperties;
  return (
    <div
      className="flex flex-col gap-1 pd-inline-diagram pd-inline-diagram--building"
      data-testid="pending-diagram"
      data-mode={mode}
      data-drawn={frame !== null || undefined}
      style={style}
    >
      <InlineWidget
        artifact={{
          id: `pending-diagram-${callId}`,
          title: args.title ?? kindLabel(kind),
          filename: 'diagram.svg',
          content: { kind: 'svg', text: frame?.svg ?? '' },
        }}
        label={kindLabel(kind)}
        source={{ text: args.source ?? '' }}
        maxHeight={DIAGRAM_CARD_MAX_HEIGHT}
      >
        <DiagramDrawing svg={frame?.svg ?? null} live />
      </InlineWidget>
    </div>
  );
}
