/**
 * THE GENERATION LOADER — the app's own mark, in white, on a canvas.
 *
 * All the motion lives in bobble-anim.ts, which is pure and tested. This file
 * does one job: given a clock, draw whatever `sceneAt` hands it, and stop when
 * nobody is looking.
 *
 * ## Why a canvas and not SVG/CSS
 * The mark's first loader was three `<rect>`s driven by CSS keyframes, which is
 * exactly right for three rects. This scene is 64 blocks that change size,
 * roundness and height every frame, and for the 3D act each one becomes three
 * painted faces sorted by depth — ~200 elements mutating at 60fps. In the DOM
 * that is a style recalculation per element per frame, inside a card that is
 * already decoding preview images (see ThreadImagePlaceholder's note on why
 * frames are kept out of React). One canvas is one composited layer, and the
 * whole scene is a few hundred fills.
 *
 * ## White, because the user asked for white
 * "change the app icon's squares to be totally white". The mark's teal/yellow/
 * pink belong to the icon at rest; a loader is not the icon at rest, and three
 * brand colours tumbling around a card compete with the picture arriving beside
 * them. The ink is a token (`--pd-bobble-ink`) so a light surface can override
 * it, but the default and the intent are white.
 *
 * ## It stops
 * `prefers-reduced-motion` freezes it on the mark's resting frame (the CSS
 * loader did the same). Off-screen or hidden, the rAF loop is cancelled: a
 * permanent 60fps loop behind a collapsed panel is a real cost and buys nothing.
 */

import { type CSSProperties, useEffect, useRef } from 'react';
import { BOARD, type LoaderVariant, sceneAt } from './bobble-anim';

/** Camera distance for the 3D act, in board units. Far enough that the
 * perspective reads as depth rather than as a fisheye. */
const CAMERA = 78;

export interface BobbleLoaderProps {
  /** Rendered size in CSS px. */
  size?: number;
  /** Which closing act to play — the modality being generated. */
  variant?: LoaderVariant;
  /** 0..1 when the engine reports real progress. Undefined → indeterminate,
   * and the bar says so by sweeping instead of filling. */
  progress?: number;
  /** Shown under the bar. The engine's own words beat any guess. */
  note?: string;
  /** Announced to screen readers. */
  label?: string;
  /** Hide the bar entirely (small inline placements). */
  bare?: boolean;
}

/** Draw one rounded square, flat. The 2D path and the 3D top face share it. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  radius: number,
): void {
  const half = size / 2;
  const r = Math.max(0, Math.min(radius, half));
  ctx.beginPath();
  ctx.roundRect(cx - half, cy - half, size, size, r);
}

/**
 * Project a point on the board (0..BOARD) plus a height into screen space.
 *
 * The board is rotated about its own centre — yaw about the vertical axis,
 * pitch toward the viewer — and then divided through by depth. At yaw 0 and
 * pitch 0 this is the identity, which is the whole reason the 3D act can begin
 * without a cut: the first frame of the reveal projects to exactly the pixels
 * the flat act drew.
 */
function project(
  x: number,
  y: number,
  lift: number,
  yaw: number,
  pitch: number,
): { x: number; y: number; scale: number } {
  const ox = x - BOARD / 2;
  const oy = y - BOARD / 2;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Yaw about the vertical axis: x and depth mix.
  const rx = ox * cosY;
  const rz = ox * sinY;
  // Pitch lays the board back; the lift comes up out of it toward the viewer.
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const ry = oy * cosP - lift * sinP;
  const depth = rz + oy * sinP + lift * cosP;
  const scale = CAMERA / (CAMERA - depth);
  return { x: BOARD / 2 + rx * scale, y: BOARD / 2 + ry * scale, scale };
}

export function BobbleLoader({
  size = 46,
  variant = 'image',
  progress,
  note,
  label = 'Working',
  bare = false,
}: BobbleLoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Device pixels, so the rounded corners are not soft on a retina panel.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const ink = getComputedStyle(host).getPropertyValue('--pd-bobble-ink').trim() || '#ffffff';

    let raf = 0;
    let running = true;
    const started = performance.now();

    const draw = (now: number) => {
      const scene = sceneAt(reduced ? 0 : now - started, variant);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // One transform for the whole scene: board units in, device pixels out.
      const k = (size * dpr) / BOARD;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.fillStyle = ink;

      const flat = scene.solidity <= 0.001;
      if (flat) {
        for (const b of scene.blocks) {
          if (b.alpha <= 0.001 || b.size <= 0.001) continue;
          ctx.globalAlpha = b.alpha;
          roundRect(ctx, b.cx, b.cy, b.size, b.radius);
          ctx.fill();
        }
      } else {
        /*
         * THE SOLID ACT. Each block is a slab: a top face at its own height and
         * two side walls down to the board. Painted back to front — the cheapest
         * correct answer for convex boxes that never intersect, and the only one
         * that does not need a depth buffer.
         *
         * The walls are drawn darker than the top by compositing the ink at a
         * lower alpha, so the solid reads as lit without introducing a second
         * colour: still "totally white", just less of it on the sides.
         */
        const drawn = scene.blocks
          .map((b) => {
            const top = project(b.cx, b.cy, b.lift, scene.yaw, scene.pitch);
            const base = project(b.cx, b.cy, 0, scene.yaw, scene.pitch);
            return { b, top, base, depth: top.scale };
          })
          .sort((p, q) => p.depth - q.depth);

        for (const { b, top, base } of drawn) {
          if (b.alpha <= 0.001 || b.size <= 0.001) continue;
          const topSize = b.size * top.scale;
          const baseSize = b.size * base.scale;
          // The wall: a quad from the base square's top edge to the top face's.
          if (b.lift > 0.02) {
            ctx.globalAlpha = b.alpha * 0.34;
            ctx.beginPath();
            ctx.moveTo(base.x - baseSize / 2, base.y);
            ctx.lineTo(base.x + baseSize / 2, base.y);
            ctx.lineTo(top.x + topSize / 2, top.y);
            ctx.lineTo(top.x - topSize / 2, top.y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.globalAlpha = b.alpha;
          roundRect(ctx, top.x, top.y, topSize, b.radius * top.scale);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (running && !reduced) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    /* Nobody is looking → stop. A loader inside a collapsed panel or a
       scrolled-away card should not hold a 60fps loop open. */
    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (visible && !running) {
        running = true;
        raf = requestAnimationFrame(draw);
      } else if (!visible && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(host);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [size, variant]);

  const pct =
    progress === undefined ? undefined : Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <div
      ref={hostRef}
      className="pd-bobble-loader-host"
      data-variant={variant}
      data-testid="bobble-loader"
      style={{ '--pd-bobble-size': `${size}px` } as CSSProperties}
    >
      <canvas
        ref={canvasRef}
        className="pd-bobble-canvas"
        role="img"
        aria-label={label}
        style={{ width: size, height: size }}
      />
      {bare ? null : (
        <div className="pd-bobble-progress" data-testid="bobble-progress">
          <div
            className="pd-bobble-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(pct === undefined ? {} : { 'aria-valuenow': pct })}
          >
            <div
              className="pd-bobble-fill"
              data-indeterminate={pct === undefined ? 'true' : undefined}
              style={pct === undefined ? undefined : { width: `${pct}%` }}
            />
          </div>
          {/* The number, when there is an honest one. "Loading" otherwise —
              the user: "show a progressbar at the bottom with % otherwise loading". */}
          <span className="pd-bobble-pct" data-testid="bobble-pct">
            {pct === undefined ? (note ?? 'Loading') : `${pct}%`}
          </span>
        </div>
      )}
    </div>
  );
}
