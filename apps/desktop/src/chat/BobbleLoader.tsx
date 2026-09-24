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
import {
  BOARD,
  EXIT_MS,
  exitReveal,
  exitSceneAt,
  type Field,
  fieldFor,
  type LoaderVariant,
  NO_FIELD,
  sceneAt,
} from './bobble-anim';

/** Camera distance for the 3D act, in board units. Far enough that the
 * perspective reads as depth rather than as a fisheye. */
const CAMERA = 78;

/**
 * How much of a filled frame's short side the square board takes — a range,
 * read off the scene's `spread`. Compressed (0.82) while the four tiles slide
 * and enlarge, out past the edges (1.12) for the dot field and the cascade,
 * whose wave then runs off the card instead of stopping short of it (the user,
 * 2026-09-17: "the cascade especially needs to seem to go off of it"). The
 * frame clips what goes over; that is the point.
 */
const BOARD_FILL_TIGHT = 0.82;
const BOARD_FILL_WIDE = 1.04;

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
  /**
   * Take the whole box instead of a fixed square.
   *
   * the user: "just that part that does all the animations … but scaled to a rounded
   * corner large square/rect". The card the result will occupy is the frame, and
   * the mark plays at card scale inside it rather than as a stamp in the middle
   * of an empty plate. The MARK stays square whatever shape the box is — the
   * mark is the app's icon and a stretched icon is a broken icon — but the grid
   * it splits into is a field generated for the box (`fieldFor`), so on a 16:9
   * frame the dots, the wave and the film run edge to edge (the user, 2026-09-23:
   * "not locked to a square aspect ratio or anything").
   */
  fill?: boolean;
  /**
   * The result exists: play the closing sweep and then stop.
   *
   * Flipping this is what ends the loader. It does not unmount and get replaced
   * by the picture; it uncovers the picture (see `exitSceneAt`) and tells the
   * card when it has finished doing so.
   */
  exit?: boolean;
  /** Called once, when the sweep has cleared the board. */
  onExitDone?: () => void;
  /**
   * The sweep's position, 0..1, every frame of the exit.
   *
   * The thing being uncovered is a SIBLING, not a descendant, so a custom
   * property set on this host would never reach it. Handing the number up means
   * the card can put it on the box they share — and it is the same number the
   * blocks are fading on, so the two edges cannot drift apart.
   */
  onSweep?: (reveal: number) => void;
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
  fill = false,
  exit = false,
  onExitDone,
  onSweep,
}: BobbleLoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /* The exit is driven from a ref, not from state: the effect that draws must
     not be torn down and rebuilt at the exact moment the sweep begins, or the
     scene jumps. `exit` flipping only has to reach the running loop. */
  const exitRef = useRef(false);
  const doneRef = useRef(onExitDone);
  doneRef.current = onExitDone;
  const sweepRef = useRef(onSweep);
  sweepRef.current = onSweep;
  exitRef.current = exit;

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
    /* The box: fixed for a stamp, measured for a card. Measured rather than read
       once, because the frame it fills is `fit-content` and settles a beat after
       mount — sized once, every card would draw at whatever width the frame had
       before its own min-width applied. */
    let boxW = size;
    let boxH = size;
    /* The grid acts fill the whole box, whatever its shape (the user, 2026-09-23:
       "not locked to a square aspect ratio"). A stamp keeps the icon's board. */
    let field: Field = NO_FIELD;
    const resize = (): void => {
      canvas.width = Math.max(1, Math.round(boxW * dpr));
      canvas.height = Math.max(1, Math.round(boxH * dpr));
      canvas.style.width = `${boxW}px`;
      canvas.style.height = `${boxH}px`;
    };
    let ro: ResizeObserver | undefined;
    if (fill) {
      const measure = (): void => {
        const r = host.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        boxW = r.width;
        boxH = r.height;
        field = fieldFor(boxW, boxH, BOARD_FILL_WIDE);
        resize();
      };
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(host);
    } else {
      resize();
    }

    const ink = getComputedStyle(host).getPropertyValue('--pd-bobble-ink').trim() || '#ffffff';

    let raf = 0;
    let running = true;
    const started = performance.now();

    /* Set when the sweep begins, so its clock is its own and starts at zero
       wherever in the loop the result happened to land. */
    let exitStarted: number | undefined;
    let finished = false;

    const draw = (now: number) => {
      if (exitStarted === undefined && exitRef.current) exitStarted = now;
      let scene = sceneAt(reduced ? 0 : now - started, variant, field);
      if (exitStarted !== undefined) {
        const p = reduced ? 1 : Math.min(1, (now - exitStarted) / EXIT_MS);
        scene = exitSceneAt(p, field);
        // The card masks the finished media with this same number — see
        // `exitReveal`. One value, so the blocks and the picture cannot
        // disagree about where the edge of the sweep is.
        const reveal = exitReveal(p);
        host.style.setProperty('--pd-bobble-sweep', reveal.toFixed(4));
        sweepRef.current?.(reveal);
        if (p >= 1 && !finished) {
          finished = true;
          running = false;
          doneRef.current?.();
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      /* One transform for the whole scene: board units in, device pixels out.
         The board is square and centred, so a wide frame gets a large centred
         mark rather than a stretched one — and the field's cells, laid out
         around it on the same pitch, carry the grid acts out to every edge. */
      const fillNow = fill
        ? BOARD_FILL_TIGHT + (BOARD_FILL_WIDE - BOARD_FILL_TIGHT) * scene.spread
        : 1;
      const board = Math.min(boxW, boxH) * fillNow;
      const k = (board * dpr) / BOARD;
      ctx.setTransform(k, 0, 0, k, ((boxW - board) / 2) * dpr, ((boxH - board) / 2) * dpr);
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
      // The sweep runs even under reduced motion — it is how the card hands over,
      // and skipping it would leave the blocks sitting on top of the result.
      if (running && (!reduced || exitStarted !== undefined)) raf = requestAnimationFrame(draw);
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
      ro?.disconnect();
    };
  }, [size, variant, fill]);

  const pct =
    progress === undefined ? undefined : Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <div
      ref={hostRef}
      className="pd-bobble-loader-host"
      data-variant={variant}
      data-fill={fill ? 'true' : undefined}
      data-exiting={exit ? 'true' : undefined}
      data-testid="bobble-loader"
      style={{ '--pd-bobble-size': `${size}px` } as CSSProperties}
    >
      <canvas
        ref={canvasRef}
        className="pd-bobble-canvas"
        role="img"
        aria-label={label}
        /* In fill mode the effect owns the element's size, because only it has
           measured the box. */
        style={fill ? undefined : { width: size, height: size }}
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
