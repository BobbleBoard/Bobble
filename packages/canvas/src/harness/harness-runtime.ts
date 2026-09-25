import { applyHtmlPatch } from './patcher.ts';
import { type FrameToHostMessage, isHostToFrameMessage, PD_CANVAS_CHANNEL } from './protocol.ts';

export interface StartHarnessOptions {
  /** Where patched content is mounted. Defaults to `win.document.body`. */
  root?: HTMLElement;
}

/**
 * Boot the in-iframe harness runtime against a window. Wires the `pd-canvas`
 * postMessage protocol to the morphdom patcher and announces readiness.
 *
 * Security: the frame runs sandboxed (`allow-scripts`, NO `allow-same-origin`)
 * so it has an opaque origin and cannot name the host origin; we therefore
 * accept messages only when `event.source === win.parent` (the embedder) rather
 * than by origin, and post replies with `targetOrigin: '*'`.
 *
 * Returns a disposer that removes the message listener.
 */
export function startHarness(win: Window, options: StartHarnessOptions = {}): () => void {
  const root = options.root ?? win.document.body;

  const post = (message: FrameToHostMessage): void => {
    win.parent.postMessage(message, '*');
  };

  /*
   * HOW TALL THE PAGE IS — for a host that fits the frame to it (a widget in
   * the chat). The harness page's body is height:100%, so the body's own
   * height is the FRAME's, and a scrollHeight can grow but never shrink; the
   * content's extent is the lowest bottom among what the page put there, plus
   * the body's padding (a widget's own `body { padding }` lands on this body).
   * Measured after each patch, when the page's scripts change its shape, and
   * when anything in it resizes — one report per frame, only on a change.
   */
  let lastHeight = -1;
  let queued = false;
  const measure = (): number => {
    const body = win.document.body;
    if (body === null) return 0;
    let bottom = 0;
    for (const el of Array.from(body.children)) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const r = el.getBoundingClientRect();
      const margin = Number.parseFloat(win.getComputedStyle(el).marginBottom) || 0;
      bottom = Math.max(bottom, r.bottom + margin + win.scrollY);
    }
    const pad = Number.parseFloat(win.getComputedStyle(body).paddingBottom) || 0;
    return Math.ceil(bottom + pad);
  };
  const report = (): void => {
    queued = false;
    const height = measure();
    if (height <= 0 || Math.abs(height - lastHeight) < 1) return;
    lastHeight = height;
    post({ channel: PD_CANVAS_CHANNEL, type: 'resize', height });
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    const raf = win.requestAnimationFrame?.bind(win);
    if (raf) raf(report);
    else win.setTimeout(report, 16);
  };
  // The frame's own constructors (the window the harness runs in), when it has them.
  const ctors = win as unknown as {
    ResizeObserver?: typeof ResizeObserver;
    MutationObserver?: typeof MutationObserver;
  };
  const sizes =
    typeof ctors.ResizeObserver === 'function' ? new ctors.ResizeObserver(schedule) : null;
  const watch = (): void => {
    if (sizes === null || win.document.body === null) return;
    sizes.disconnect();
    for (const el of Array.from(win.document.body.children)) sizes.observe(el);
  };
  const shape =
    typeof ctors.MutationObserver === 'function'
      ? new ctors.MutationObserver(() => {
          watch();
          schedule();
        })
      : null;
  if (win.document.body !== null) {
    shape?.observe(win.document.body, { childList: true, subtree: true, attributes: true });
  }
  win.addEventListener('load', schedule);

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win.parent) return;
    const data: unknown = event.data;
    if (!isHostToFrameMessage(data)) return;

    if (data.type === 'ping') {
      post({ channel: PD_CANVAS_CHANNEL, type: 'ready' });
      return;
    }
    if (data.type === 'reset') {
      root.replaceChildren();
      post({ channel: PD_CANVAS_CHANNEL, type: 'applied', seq: -1 });
      return;
    }
    // data.type === 'patch'
    try {
      applyHtmlPatch(root, data.html);
      post({ channel: PD_CANVAS_CHANNEL, type: 'applied', seq: data.seq });
      watch();
      schedule();
    } catch (error) {
      post({
        channel: PD_CANVAS_CHANNEL,
        type: 'error',
        seq: data.seq,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  win.addEventListener('message', onMessage);
  // Announce readiness so the host can flush any patches queued before boot.
  post({ channel: PD_CANVAS_CHANNEL, type: 'ready' });

  return () => {
    win.removeEventListener('message', onMessage);
    win.removeEventListener('load', schedule);
    sizes?.disconnect();
    shape?.disconnect();
  };
}
