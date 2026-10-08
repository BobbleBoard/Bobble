import { applyHtmlPatch, parseSnapshot, sameMarkup, scriptKey } from './patcher.ts';
import { type FrameToHostMessage, isHostToFrameMessage, PD_CANVAS_CHANNEL } from './protocol.ts';

export interface StartHarnessOptions {
  /** Where patched content is mounted. Defaults to `win.document.body`. */
  root?: HTMLElement;
  /** Start the frame over, in a fresh realm. Defaults to reloading the frame's page. */
  restart?: () => void;
  /** How long patches must pause (a write still streaming) before a restart. */
  settleMs?: number;
}

/** A write streams a patch every few hundred ms at most; past this it has settled. */
const SETTLE_MS = 600;

/**
 * Boot the in-iframe harness runtime against a window. Wires the `pd-canvas`
 * postMessage protocol to the morphdom patcher and announces readiness.
 *
 * Security: the frame runs sandboxed (`allow-scripts`, NO `allow-same-origin`)
 * so it has an opaque origin and cannot name the host origin; we therefore
 * accept messages only when `event.source === win.parent` (the embedder) rather
 * than by origin, and post replies with `targetOrigin: '*'`.
 *
 * Returns a disposer that removes the message listener and cancels anything queued.
 */
export function startHarness(win: Window, options: StartHarnessOptions = {}): () => void {
  const root = options.root ?? win.document.body;
  const restart =
    options.restart ??
    ((): void => {
      try {
        win.location.reload();
      } catch {
        // A frame that cannot reload keeps the page it has.
      }
    });
  const settleMs = options.settleMs ?? SETTLE_MS;

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
  /** Cancels the report `schedule` queued; dispose runs it, so nothing measures after. */
  let cancelReport: (() => void) | null = null;
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
    cancelReport = null;
    const height = measure();
    if (height <= 0 || Math.abs(height - lastHeight) < 1) return;
    lastHeight = height;
    post({ channel: PD_CANVAS_CHANNEL, type: 'resize', height });
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    const raf = win.requestAnimationFrame?.bind(win);
    if (raf) {
      const id = raf(report);
      cancelReport = () => win.cancelAnimationFrame?.(id);
    } else {
      const id = win.setTimeout(report, 16);
      cancelReport = () => win.clearTimeout(id);
    }
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

  /*
   * A PAGE WHOSE SCRIPTS HAVE RUN cannot always be patched in place. The morph
   * brings the markup back to the snapshot, and a script never runs twice: what
   * the script built — a figure it drew, the step it moved to — is undone and
   * nothing builds it again. (A maths page sent again after it had played sat on
   * its first step for good.) So once scripts have run, a patch that lands on
   * markup the page itself changed, or that changes or drops a script that ran,
   * marks the frame stale: its scripts stop running in this realm, and when the
   * patches settle the frame starts over — the host sends the newest snapshot
   * to the fresh one. The same snapshot again changes nothing.
   */
  let lastHtml: string | null = null;
  let pristine: HTMLElement | null = null;
  const ran: string[] = [];
  let stale = false;
  let settle: number | undefined;
  const startOver = (): void => {
    win.clearTimeout(settle);
    settle = win.setTimeout(restart, settleMs);
  };
  const applySnapshot = (html: string): void => {
    if (lastHtml !== null && html.trim() === lastHtml.trim()) return;
    const template = parseSnapshot(root, html);
    if (ran.length > 0) {
      // What the page changed itself is about to be undone.
      if (pristine !== null && !sameMarkup(root.childNodes, pristine.childNodes)) stale = true;
      // A script that ran and is no longer in the page, as it ran.
      const next = Array.from(template.querySelectorAll('script'), scriptKey);
      for (const key of ran) {
        const at = next.indexOf(key);
        if (at === -1) stale = true;
        else next.splice(at, 1);
      }
    }
    pristine = template.cloneNode(true) as HTMLElement;
    applyHtmlPatch(root, html, {
      template,
      runScripts: !stale,
      onScriptRun: (script) => {
        ran.push(scriptKey(script));
      },
    });
    lastHtml = html;
    if (stale) startOver();
  };

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
      lastHtml = null;
      pristine = null;
      // What ran is still running; an empty page starts in a fresh realm.
      if (ran.length > 0) {
        stale = true;
        win.clearTimeout(settle);
        restart();
      }
      return;
    }
    // data.type === 'patch'
    try {
      applySnapshot(data.html);
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
    // What is queued dies with the harness: a report a frame later, a restart
    // once the patches settle.
    cancelReport?.();
    cancelReport = null;
    queued = false;
    win.clearTimeout(settle);
  };
}
