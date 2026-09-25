/**
 * THE CHART, WHILE IT IS BEING MADE.
 *
 * the user (2026-09-17): "when a chart is generating show a skeleton card with
 * shimmering items as a preview that builds live like visual stuff in the
 * canvas builds live". A `chart` call is a few hundred bytes of arguments the
 * model types out — the type first, then the title, then the labels and the
 * values — and the card is drawn from exactly those, so it can show the chart
 * AS the call is written: a shimmering skeleton of the right shape the moment
 * the type is known, the real bars/lines/slices growing in as the numbers
 * arrive, and the finished card (PresentedInline) taking its place when the
 * tool answers. Same frame, same position, so nothing jumps.
 */
import { ChartView, IconChart } from '@pi-desktop/canvas';
import { type ChartSpec, normalizeChartSpec } from '@pi-desktop/charts';
import { useEffect, useMemo } from 'react';
import { markLiveChart } from './live-handover';
import { partialJsonString } from './partial-json';

/** What a chart call has said so far, whichever way it was written. */
export interface PendingChartArgs {
  /** The call this card stands in for (its key in the thread). */
  readonly id?: string;
  readonly type?: string;
  readonly title?: string;
  readonly labels?: string;
  readonly values?: string;
}

/**
 * Read the chart's arguments out of a call that may still be streaming: the
 * parsed arguments once the engine has finalised them, else whatever keys have
 * closed in the raw text so far — and, for the CLI form (`chart bar "Title"
 * --labels … --values …` through bash), the same four things out of the line.
 */
export function pendingChartArgs(block: {
  name: string;
  arguments?: Record<string, unknown>;
  argsText?: string;
}): PendingChartArgs | null {
  const args = block.arguments ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  if (block.name === 'chart') {
    const raw = block.argsText ?? '';
    const pick = (key: string): string | undefined =>
      str(args[key]) ?? partialJsonString(raw, [key])?.value;
    const type = pick('type');
    const title = pick('title');
    const labels = pick('labels');
    const values = pick('values');
    if (type === undefined && title === undefined && labels === undefined) return null;
    return {
      ...(type === undefined ? {} : { type }),
      ...(title === undefined ? {} : { title }),
      ...(labels === undefined ? {} : { labels }),
      ...(values === undefined ? {} : { values }),
    };
  }
  const command = str(args.command) ?? partialJsonString(block.argsText ?? '', ['command'])?.value;
  if (command === undefined || !/^\s*chart\s+(?!edit\b)/.test(command)) return null;
  // `--labels="a, b"` is one token, as is `"a, b"` on its own.
  const words = command.match(/(?:--[\w-]+=)?(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  const bare = words.map((w) => w.replace(/^["']|["']$/g, ''));
  const unquote = (w: string): string => w.replace(/^["']|["']$/g, '');
  const flag = (name: string): string | undefined => {
    const eq = bare.find((w) => w.startsWith(`--${name}=`));
    if (eq !== undefined) return unquote(eq.slice(name.length + 3));
    const at = bare.indexOf(`--${name}`);
    return at >= 0 ? bare[at + 1] : undefined;
  };
  const positional = bare.slice(1).filter((w, i, all) => {
    if (w.startsWith('--')) return false;
    const prev = all[i - 1];
    // A word after a bare `--flag` is that flag's value, not a positional.
    return !(prev?.startsWith('--') === true && !prev.includes('='));
  });
  const type = flag('type') ?? positional[0];
  const title = flag('title') ?? positional[1];
  const labels = flag('labels');
  const values = flag('values');
  if (type === undefined && title === undefined) return null;
  return {
    ...(type === undefined ? {} : { type }),
    ...(title === undefined ? {} : { title }),
    ...(labels === undefined ? {} : { labels }),
    ...(values === undefined ? {} : { values }),
  };
}

/** The chart these arguments already describe, when they describe one. */
export function pendingChartSpec(args: PendingChartArgs): ChartSpec | null {
  if (args.labels === undefined || args.values === undefined) return null;
  try {
    const spec = normalizeChartSpec({
      type: args.type ?? 'bar',
      title: args.title ?? '',
      labels: args.labels,
      values: args.values,
    });
    const points = spec.series.reduce((n, s) => n + s.points.length, 0);
    return points > 0 ? spec : null;
  } catch {
    return null;
  }
}

/** Which skeleton to draw for a type word the model may still be typing. */
export function skeletonShape(
  type: string | undefined,
): 'bars' | 'hbars' | 'line' | 'ring' | 'web' | 'dots' {
  const t = (type ?? '').toLowerCase().trim();
  // The word may be half typed ("lin") or longer than ours ("line chart"):
  // either prefix relation counts, from two letters on.
  const is = (...words: string[]): boolean =>
    t.length >= 2 && words.some((w) => w.startsWith(t) || t.startsWith(w));
  if (is('hbar', 'horizontal', 'ranked')) return 'hbars';
  if (is('line', 'area', 'trend')) return 'line';
  if (is('donut', 'doughnut', 'pie', 'ring')) return 'ring';
  if (is('radar', 'spider', 'web', 'polar')) return 'web';
  if (is('scatter', 'points', 'xy')) return 'dots';
  return 'bars';
}

/* Constant placeholder shapes; each entry is its own key (they never move). */
const BAR_HEIGHTS = [0.55, 0.8, 0.45, 0.95, 0.65, 0.75, 0.5];
const WEB_RINGS = [0.35, 0.7, 1];

function Skeleton({ shape }: { shape: ReturnType<typeof skeletonShape> }) {
  const w = 320;
  const h = 150;
  const cx = w / 2;
  const cy = h / 2;
  return (
    <svg
      className="pd-chart-skeleton-svg"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {shape === 'bars'
        ? BAR_HEIGHTS.map((k, i) => (
            <rect
              key={`b${k}`}
              className="pd-chart-skeleton-shape"
              x={14 + i * 44}
              y={h - 12 - (h - 30) * k}
              width={28}
              height={(h - 30) * k}
              rx={4}
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))
        : null}
      {shape === 'hbars'
        ? BAR_HEIGHTS.slice(0, 5).map((k, i) => (
            <rect
              key={`h${k}`}
              className="pd-chart-skeleton-shape"
              x={16}
              y={12 + i * 27}
              width={(w - 40) * k}
              height={16}
              rx={4}
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))
        : null}
      {shape === 'line' ? (
        <path
          className="pd-chart-skeleton-shape pd-chart-skeleton-line"
          d={`M16 ${h - 24} C 70 ${h - 90}, 110 ${h - 40}, 160 ${h - 70} S 250 ${h - 130}, ${w - 16} ${h - 96}`}
          fill="none"
        />
      ) : null}
      {shape === 'ring' ? (
        <circle
          className="pd-chart-skeleton-shape pd-chart-skeleton-ring"
          cx={cx}
          cy={cy}
          r={52}
          fill="none"
        />
      ) : null}
      {shape === 'web'
        ? WEB_RINGS.map((k, i) => {
            const pts = Array.from({ length: 5 }, (_v, j) => {
              const a = -Math.PI / 2 + (j / 5) * 2 * Math.PI;
              return `${cx + 60 * k * Math.cos(a)},${cy + 60 * k * Math.sin(a)}`;
            }).join(' ');
            return (
              <polygon
                key={`w${k}`}
                className="pd-chart-skeleton-shape pd-chart-skeleton-web"
                points={pts}
                fill="none"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            );
          })
        : null}
      {shape === 'dots'
        ? BAR_HEIGHTS.map((k, i) => (
            <circle
              key={`d${k}`}
              className="pd-chart-skeleton-shape"
              cx={30 + i * 44}
              cy={h - 20 - (h - 44) * k}
              r={6}
              style={{ animationDelay: `${i * 70}ms` }}
            />
          ))
        : null}
    </svg>
  );
}

export function PendingChartCard({ args }: { args: PendingChartArgs }) {
  const spec = useMemo(() => pendingChartSpec(args), [args]);
  const title = args.title ?? '';
  // Once its bars are on screen, the finished card must not grow them again
  // from the axis when it takes over (live-handover.ts).
  const drawn = spec !== null;
  useEffect(() => {
    if (drawn && args.id !== undefined) markLiveChart(args.id);
  }, [drawn, args.id]);
  return (
    <div
      className="pd-inline-chart pd-inline-chart--pending"
      data-testid="pending-chart"
      data-live={spec !== null || undefined}
    >
      {spec !== null ? (
        // Enough is known to draw: the real card, dimmed and shimmering over,
        // redrawn as each value lands — the chart building itself.
        <ChartView spec={spec} className="pd-chart--building" />
      ) : (
        <div className="pd-chart pd-chart--inline pd-chart--skeleton">
          <div className="pd-chart-head">
            <div className="pd-chart-titles">
              {title !== '' ? (
                <div className="pd-chart-title">{title}</div>
              ) : (
                <div className="pd-chart-skeleton-title" />
              )}
            </div>
            <span className="pd-chart-skeleton-mark">
              <IconChart size={14} />
            </span>
          </div>
          <div className="pd-chart-box pd-chart-skeleton-box">
            <Skeleton shape={skeletonShape(args.type)} />
          </div>
        </div>
      )}
      <div className="pd-chart-building-sheen" aria-hidden="true" />
    </div>
  );
}
