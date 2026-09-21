/**
 * Injected page scripts the browser-agent bridge runs (via the WebContentsView's
 * `executeJavaScript`) to ACT on and VISUALISE the model's browsing. These live
 * app-side because they are inseparable from the app-owned concerns they serve:
 * the virtual cursor overlay + live-typing indicator, and coordinate/DOM input.
 *
 * They pair with the extension's perception snapshot only through one shared
 * contract: the `data-pi-idx` attribute the snapshot stamps on each indexed
 * element (see @pi-desktop/browser-use `DATA_IDX_ATTR`). Resolving `index →
 * element` by that stamp means acting never trusts stale coordinates — a missing
 * stamp is exactly the stale-index signal the tools re-snapshot on.
 *
 * Each builder returns a self-contained IIFE string (no app globals) that is
 * cleared on navigation and idempotently re-created here, so injection survives
 * page changes. All are defensive: they never throw across executeJavaScript.
 */
import {
  AGENT_CURSOR_EASE,
  AGENT_CURSOR_HEIGHT,
  AGENT_CURSOR_PRESS,
  AGENT_CURSOR_TRAVEL_MS,
  AGENT_PILL_FILL,
  AGENT_PILL_FLIP_MARGIN,
  AGENT_PILL_OFFSET,
  AGENT_PILL_RADIUS,
  agentCursorSize,
  agentCursorSvg,
} from '@pi-desktop/shared';

/** The stamp shared with the perception snapshot. Keep in sync with
 * @pi-desktop/browser-use `DATA_IDX_ATTR`. */
export const DATA_IDX_ATTR = 'data-pi-idx';

const IDX = DATA_IDX_ATTR;

/*
 * THE SAME CURSOR AS ON THE SCREEN. the user: "cursor is an old version not the
 * computer use cursor it should be in the inbuilt browser these should be
 * linked and the same, current computer use one is correct." The glyph, its
 * size, its press and its pill all come from @pi-desktop/shared's agent-cursor
 * — the one definition the native overlay is the reference for — so a page in
 * the built-in browser shows the phantom the desktop shows, at the size it is
 * on the desktop (a CSS px is a point).
 */
const CURSOR = agentCursorSize(AGENT_CURSOR_HEIGHT);
const CURSOR_W = +CURSOR.w.toFixed(2);
const CURSOR_H = +CURSOR.h.toFixed(2);
/** The pointing tip within the rendered glyph (px). A negative margin shifts
 * the element so its tip sits at the div's (left, top) — then positioning at
 * (op.x, op.y) lands the tip on the target while pill math stays target-relative. */
const TIP_X = +CURSOR.tip.x.toFixed(2);
const TIP_Y = +CURSOR.tip.y.toFixed(2);
const TIP_ORIGIN = `${TIP_X}px ${TIP_Y}px`;
const EASE = `cubic-bezier(${AGENT_CURSOR_EASE.join(',')})`;

/** A cursor overlay command. */
export type CursorOp =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'typing'; active: boolean; text?: string }
  | { kind: 'hide' };

/**
 * Ensure the virtual cursor + typing pill exist and apply one command. The
 * overlay sits at the top of the page (pointer-events: none) so it never
 * intercepts real input; movement respects prefers-reduced-motion.
 */
export function cursorCommand(op: CursorOp): string {
  return `(function(){
  try {
    var op = ${JSON.stringify(op)};
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    var CID = 'pi-agent-cursor', TID = 'pi-agent-typing';
    var cur = document.getElementById(CID);
    if (!cur) {
      cur = document.createElement('div');
      cur.id = CID;
      cur.setAttribute('aria-hidden', 'true');
      cur.style.cssText = 'position:fixed;left:-100px;top:-100px;width:${CURSOR_W}px;height:${CURSOR_H}px;z-index:2147483647;pointer-events:none;margin:${-TIP_Y}px 0 0 ${-TIP_X}px;padding:0;opacity:0;transform-origin:${TIP_ORIGIN};will-change:left,top,transform,opacity;';
      cur.innerHTML = ${JSON.stringify(agentCursorSvg(AGENT_CURSOR_HEIGHT))};
      (document.body || document.documentElement).appendChild(cur);
    }
    // Glide to the target on the overlay's own curve and time, and fade in.
    cur.style.transition = reduce ? 'none' : 'left ${AGENT_CURSOR_TRAVEL_MS}ms ${EASE}, top ${AGENT_CURSOR_TRAVEL_MS}ms ${EASE}, opacity 0.2s ease-out';
    cur.style.display = 'block';
    cur.style.opacity = '1';

    function pill() {
      var t = document.getElementById(TID);
      if (!t) {
        t = document.createElement('div');
        t.id = TID;
        t.setAttribute('aria-hidden', 'true');
        // The overlay's pill: its blue, its radius, white 600 type. Nothing purple.
        t.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 12px -apple-system,system-ui,sans-serif;line-height:1.2;color:#fff;background:${AGENT_PILL_FILL};border-radius:${AGENT_PILL_RADIUS}px;padding:6px 12px;box-shadow:0 4px 14px rgba(6,8,14,0.35);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;display:none;';
        (document.body || document.documentElement).appendChild(t);
      }
      return t;
    }
    // Park the pill the way the overlay does: below-right of the tip, flipped
    // to the other side near the viewport's edge, never off it.
    function parkPill(t, x, y) {
      var w = t.offsetWidth || 120, h = t.offsetHeight || 26;
      var vw = window.innerWidth, vh = window.innerHeight;
      var dx = ${AGENT_PILL_OFFSET.x}, dy = ${AGENT_PILL_OFFSET.y}, m = ${AGENT_PILL_FLIP_MARGIN};
      var px = (x + dx + w > vw - m) ? x - dx - w : x + dx;
      var py = (y + dy + h > vh - m) ? y - dy - h : y + dy;
      px = Math.max(4, Math.min(px, vw - 4 - w));
      py = Math.max(4, Math.min(py, vh - 4 - h));
      t.style.left = px + 'px'; t.style.top = py + 'px';
    }

    if (op.kind === 'hide') {
      cur.style.display = 'none';
      var th = document.getElementById(TID); if (th) th.style.display = 'none';
      return true;
    }
    if (op.kind === 'move' || op.kind === 'click') {
      cur.style.left = op.x + 'px';
      cur.style.top = op.y + 'px';
      var tp = document.getElementById(TID);
      if (tp && tp.style.display !== 'none') parkPill(tp, op.x, op.y);
    }
    if (op.kind === 'click') {
      // The overlay's press: the glyph squeezes about its tip and springs
      // back, ${AGENT_CURSOR_PRESS.ms} ms in all. No ring — the overlay has none.
      if (!reduce && typeof cur.animate === 'function') {
        cur.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(${AGENT_CURSOR_PRESS.scale})', offset: 0.45 }, { transform: 'scale(1)' }],
          { duration: ${AGENT_CURSOR_PRESS.ms}, easing: 'ease-in-out' }
        );
      }
    }
    if (op.kind === 'typing') {
      var p = pill();
      if (op.active) {
        // The pill says the action, not its contents (the overlay's rule).
        p.textContent = 'Typing';
        p.style.display = 'block';
        var cl = parseFloat(cur.style.left) || 0, ct = parseFloat(cur.style.top) || 0;
        parkPill(p, cl, ct);
      } else {
        p.style.display = 'none';
      }
    }
    return true;
  } catch (e) { return false; }
})()`;
}

/** Resolve an index to its element, scroll it into view, and return the
 * viewport-centre coordinates (for cursor targeting). `found:false` = stale. */
export function resolveByIndex(index: number): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  } catch (e) { return { found: false }; }
})()`;
}

/** Click an element by index via real DOM events (reliable, no coord math). */
export function domClickByIndex(index: number): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousemove', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
    try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
    try { el.click(); } catch (e) {}
    return { found: true };
  } catch (e) { return { found: false }; }
})()`;
}

/**
 * Focus an element by index for typing and return its centre coordinates.
 *
 * `native` says whether it is a field whose VALUE can be set — an input, a
 * textarea, a select, a contenteditable. Anything else that can take focus is
 * still a place to type: Desmos's expression line, a CodeMirror or Monaco
 * editor, Google Docs — widgets that draw their own caret and listen for
 * keystrokes on a hidden textarea. SEEN 2026-09-21: `browser type` refused
 * Desmos's expression field eleven times as "not an editable field", and the
 * graph was never drawn. The caller types into a non-native field the way a
 * person does: a real click on it, then real keystrokes to whatever took focus.
 */
export function focusByIndex(index: number): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    var tag = (el.tagName || '').toLowerCase();
    var native = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    // A wrapper around a real field (a role=textbox span over a textarea) is
    // typed into through the field.
    if (!native) {
      var inner = el.querySelector('textarea, input:not([type=hidden]), [contenteditable="true"]');
      if (inner) {
        try { inner.focus(); } catch (e) {}
      }
    }
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    if (native) { try { el.focus(); } catch (e) {} }
    var r = el.getBoundingClientRect();
    return { found: true, native: native, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  } catch (e) { return { found: false }; }
})()`;
}

/**
 * Set an editable element's value to `text` and dispatch `input` (and `change`
 * on the final chunk) using the native value setter so React-controlled inputs
 * update. Called repeatedly with growing substrings for a live-typing effect.
 */
export function setValueByIndex(index: number, text: string, final: boolean): string {
  return `(function(){
  try {
    var el = document.querySelector('[${IDX}="' + ${JSON.stringify(index)} + '"]');
    if (!el) return { found: false };
    var v = ${JSON.stringify(text)};
    if (el.isContentEditable === true) {
      el.textContent = v;
    } else {
      var proto = (el.tagName || '').toLowerCase() === 'textarea'
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype;
      var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    if (${final ? 'true' : 'false'}) {
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    }
    return { found: true };
  } catch (e) { return { found: false }; }
})()`;
}

/** Detect the page's reduced-motion preference (best-effort). */
export const REDUCED_MOTION_SCRIPT =
  "(function(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } })()";
