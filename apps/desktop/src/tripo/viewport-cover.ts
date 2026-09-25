/**
 * HOW MUCH OF THE VIEWPORT THE FLOATING CARD COVERS.
 *
 * The tool panel (.tp-genpanel) floats over the left of the viewport, so the
 * middle of the viewport is not the middle of what can be seen. The camera has
 * allowed for it since 2026-09-16 (Viewer3D's view offset); what is drawn OVER
 * the canvas had not: the "Building your model" stage centred on the whole
 * viewport and its 560px row ran under the card, across the Generate panel's
 * Finish row (found by the studio track, 2026-09-24). Both now read the same
 * measure — the camera directly, the overlays as `--tp-covered-left` on the
 * viewport.
 */
import { type RefObject, useLayoutEffect } from 'react';

/** The floating card, wherever the studio's layout puts it. It is a SIBLING
 * of the viewport (.tp-body > Rail, GenPanel, Viewport), not a child of the
 * canvas host's parent — looking for it under the parent found nothing, and
 * the camera's offset silently never applied (see Viewer3D's resize()). */
export function floatingPanel(host: HTMLElement): HTMLElement | null {
  const root = host.closest<HTMLElement>('.tp-body') ?? host.parentElement;
  return root?.querySelector<HTMLElement>('.tp-genpanel') ?? null;
}

/** How much of `host`'s left the floating card covers, in px (0 when it is not
 * there — the studio gated, or a window too narrow for it). */
export function coveredLeft(host: HTMLElement): number {
  const panel = floatingPanel(host);
  if (panel === null) return 0;
  const a = host.getBoundingClientRect();
  const b = panel.getBoundingClientRect();
  return Math.max(0, Math.min(b.right, a.right) - a.left);
}

/**
 * How much of the viewport's RIGHT the floating view controls take (the light /
 * snapshot / grid and help / history pills, .tp-float-tools) — the stage centred
 * in the clear part ran its Texturing bars under them.
 */
export function coveredRight(viewport: HTMLElement): number {
  const tools = viewport.querySelector<HTMLElement>('.tp-float-tools');
  if (tools === null) return 0;
  const a = viewport.getBoundingClientRect();
  const b = tools.getBoundingClientRect();
  return b.width === 0 ? 0 : Math.max(0, a.right - Math.max(b.left, a.left));
}

/**
 * Keep `--tp-covered-left` / `--tp-covered-right` on the viewport current: on
 * mount, whenever it, the card or the controls change size, and when the card
 * comes or goes (switching tools mounts a different panel).
 */
export function useCoveredLeft(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const apply = (): void => {
      el.style.setProperty('--tp-covered-left', `${Math.round(coveredLeft(el))}px`);
      el.style.setProperty('--tp-covered-right', `${Math.round(coveredRight(el))}px`);
    };
    apply();
    const sizes = new ResizeObserver(apply);
    sizes.observe(el);
    const tools = el.querySelector<HTMLElement>('.tp-float-tools');
    if (tools !== null) sizes.observe(tools);
    let watched = floatingPanel(el);
    if (watched !== null) sizes.observe(watched);
    const body = el.closest<HTMLElement>('.tp-body');
    const comings = new MutationObserver(() => {
      const panel = floatingPanel(el);
      if (panel !== watched) {
        if (watched !== null) sizes.unobserve(watched);
        if (panel !== null) sizes.observe(panel);
        watched = panel;
      }
      apply();
    });
    if (body !== null) comings.observe(body, { childList: true });
    return () => {
      sizes.disconnect();
      comings.disconnect();
    };
  }, [ref]);
}
