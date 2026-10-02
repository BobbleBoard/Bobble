import { useContext, useEffect, useRef, useState } from 'react';
import { CanvasConfigContext } from '../context.ts';
import {
  type FrameToHostMessage,
  type HostToFrameMessage,
  isFrameToHostMessage,
  PD_CANVAS_CHANNEL,
} from '../harness/protocol.ts';
import type { SurfaceProps } from '../registry.ts';

/** How the controller talks to its frame — abstracted so it is unit-testable. */
export interface FrameGate {
  postToFrame: (message: HostToFrameMessage) => void;
}

/**
 * Host-side patch dispatcher. Buffers the latest HTML until the harness reports
 * `ready`, coalesces bursts to the newest snapshot, and stamps a monotonic seq.
 * A frame that reports `ready` again has started over (the harness restarts
 * itself when a page's scripts would not survive a patch) and is empty, so it
 * gets the newest snapshot again. Pure and framework-free so the
 * buffer/ready/seq contract is unit-tested without a real iframe (which jsdom
 * cannot script).
 */
export class HtmlSurfaceController {
  #seq = 0;
  #ready = false;
  #pending: string | null = null;
  #latest: string | null = null;
  readonly #gate: FrameGate;

  constructor(gate: FrameGate) {
    this.#gate = gate;
  }

  /** Feed an inbound message from the frame (already source-validated). */
  handleFrameMessage(data: unknown): void {
    if (!isFrameToHostMessage(data)) return;
    const message: FrameToHostMessage = data;
    if (message.type === 'ready') {
      this.#ready = true;
      if (this.#pending === null) this.#pending = this.#latest;
      this.#flush();
    }
  }

  /** Set the current HTML snapshot; sends immediately if the frame is ready. */
  setHtml(html: string): void {
    this.#pending = html;
    this.#latest = html;
    this.#flush();
  }

  reset(): void {
    this.#pending = null;
    this.#latest = null;
    this.#gate.postToFrame({ channel: PD_CANVAS_CHANNEL, type: 'reset' });
  }

  #flush(): void {
    if (!this.#ready || this.#pending === null) return;
    const html = this.#pending;
    this.#pending = null;
    this.#seq += 1;
    this.#gate.postToFrame({ channel: PD_CANVAS_CHANNEL, type: 'patch', seq: this.#seq, html });
  }

  get isReady(): boolean {
    return this.#ready;
  }

  get lastSeq(): number {
    return this.#seq;
  }
}

export interface HtmlSurfaceProps extends SurfaceProps {
  /** Override the harness URL (else from CanvasConfigContext). For tests. */
  harnessUrl?: string;
  /**
   * Fit the frame to what the page reports it needs, up to this many px (a
   * widget in the chat); past it the page scrolls inside. Unset, the frame
   * fills its box (the canvas).
   */
  fitMax?: number;
}

/** A fitted frame's height before the page has said how tall it is. */
const FIT_FIRST_PX = 180;

/**
 * HTML surface — the differentiating "no reload while streaming" surface.
 *
 * Threat model / trust boundary: the LLM-generated HTML is UNTRUSTED and scripts
 * are INTENTIONALLY allowed (interactive HTML/games are the point). Containment
 * is the frame sandbox, NOT DOMPurify: `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin` gives the frame an opaque origin — it cannot touch the app
 * origin, its storage/cookies, or the preload/IPC bridge. The app additionally
 * gates network via CSP `frame-src`. HTML is therefore NOT script-stripped here
 * (that would kill interactivity); it flows to the harness, which morphdom-
 * patches it in place so running scripts, focus, input values and scroll survive
 * each streaming delta — no reload.
 */
export function HtmlSurface({ content, harnessUrl, fitMax }: HtmlSurfaceProps) {
  const config = useContext(CanvasConfigContext);
  const url = harnessUrl ?? config.harnessUrl;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const controllerRef = useRef<HtmlSurfaceController | null>(null);
  const [fitted, setFitted] = useState<number | null>(null);
  const fitRef = useRef(fitMax);
  fitRef.current = fitMax;

  useEffect(() => {
    const controller = new HtmlSurfaceController({
      postToFrame: (message) => {
        // targetOrigin '*' is required: a sandboxed opaque origin cannot be named.
        iframeRef.current?.contentWindow?.postMessage(message, '*');
      },
    });
    controllerRef.current = controller;

    const onMessage = (event: MessageEvent): void => {
      // Accept only messages from OUR frame's window.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown };
      const max = fitRef.current;
      if (max !== undefined && isFrameToHostMessage(data) && data.type === 'resize') {
        const h = typeof data.height === 'number' && Number.isFinite(data.height) ? data.height : 0;
        if (h > 0) setFitted(Math.min(max, Math.ceil(h)));
      }
      controller.handleFrameMessage(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setHtml(content.text);
  }, [content.text]);

  return (
    <iframe
      ref={iframeRef}
      className="pd-canvas-html"
      title="Interactive HTML preview"
      // No allow-same-origin: opaque origin is the containment boundary.
      sandbox="allow-scripts"
      src={url}
      {...(fitMax !== undefined
        ? {
            'data-fit': 'true',
            style: { height: `${fitted ?? Math.min(FIT_FIRST_PX, fitMax)}px` },
          }
        : {})}
    />
  );
}
