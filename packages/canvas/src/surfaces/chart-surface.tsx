/**
 * The interactive chart — Claude-parity data visuals, in the chat and in the
 * canvas.
 *
 * the user (2026-09-16), Claude's inline card beside Bobble's static picture: "we
 * need parity on these datavisuals … this was way quicker and is a much
 * stronger result". What theirs has and a picture cannot: a hover band with
 * the value read out, a chart ⇄ table toggle in the corner, the app's own
 * type and colours, and a size that fits the thread. This renders a ChartSpec
 * (the same spec the `chart` tool wrote beside its SVG) from the shared
 * layout, so the bars here are the bars in the file.
 *
 * The same component serves the inline card (compact, capped height) and the
 * canvas tab (fills the tab); only the size differs. Colours are the app's
 * tokens so a dark chat gets a dark chart, and a highlight takes the warm
 * accent the office charts use.
 */
import {
  type ChartLayout,
  type ChartSpec,
  chartToSvg,
  formatValue,
  layoutChart,
  normalizeChartSpec,
} from '@pi-desktop/charts';
import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SurfaceProps } from '../registry.ts';
import { IconChart, type IconProps, IconTable } from '../tab-icons.tsx';

/** Series colours: the app's accent first, then a palette that reads on both grounds. */
const SERIES_COLOURS = [
  'var(--pd-accent-primary)',
  '#E8863A',
  '#3FB3AC',
  '#D9B44A',
  '#9AC05F',
  '#97A3AD',
];
const HIGHLIGHT = '#E8863A';

export interface ChartViewProps {
  readonly spec: ChartSpec;
  /** Fill the available box (canvas) rather than a capped inline height. */
  readonly fill?: boolean;
  /** Extra controls rendered in the header's corner (e.g. move to canvas). */
  readonly corner?: React.ReactNode;
  readonly className?: string;
}

interface Hover {
  readonly category: number | null;
  readonly series: number | null;
  readonly point: number | null;
}

const NO_HOVER: Hover = { category: null, series: null, point: null };

/** Parse a chart artifact's text (the JSON spec). */
export function specFromText(text: string): ChartSpec | { error: string } {
  try {
    return normalizeChartSpec(JSON.parse(text));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function ChartView({ spec, fill = false, corner, className }: ChartViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [boxHeight, setBoxHeight] = useState(0);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<Hover>(NO_HOVER);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measure = (): void => {
      setWidth(host.clientWidth);
      setBoxHeight(host.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Inline: a height that follows the width (a 16:9-ish card, capped); canvas:
  // whatever the box gives.
  const height = fill
    ? Math.max(200, boxHeight)
    : Math.max(220, Math.min(380, Math.round(width * 0.56)));
  const layout = useMemo<ChartLayout | null>(
    () => (width > 0 ? layoutChart(spec, { width, height, compact: !fill && width < 420 }) : null),
    [spec, width, height, fill],
  );
  // The larger view reads its values off the shapes, as the file does; the
  // inline card stays clean and reads them on hover (Claude's card does too).
  const valueLabels = fill;

  const colour = useCallback(
    (series: number, highlighted: boolean): string =>
      highlighted && spec.series.length === 1
        ? HIGHLIGHT
        : (SERIES_COLOURS[series % SERIES_COLOURS.length] ?? 'currentColor'),
    [spec.series.length],
  );

  const hoveredCategory = hover.category !== null ? layout?.categories[hover.category] : undefined;
  const tooltip = useMemo(() => {
    if (layout === null) return null;
    if (spec.type === 'donut') {
      if (hover.point === null) return null;
      const s = layout.slices[hover.point];
      if (s === undefined) return null;
      return {
        x: layout.donut !== undefined ? layout.donut.cx + layout.donut.r + 8 : 0,
        y: layout.donut !== undefined ? layout.donut.cy - 20 : 0,
        title: s.label,
        rows: [
          {
            colour: s.highlighted
              ? HIGHLIGHT
              : (SERIES_COLOURS[s.point % SERIES_COLOURS.length] ?? ''),
            value: `${formatValue(s.value, spec.unit)}${spec.unit === '%' ? '' : ` · ${Math.round(s.fraction * 100)}%`}`,
            name: spec.series[0]?.name ?? '',
          },
        ],
      };
    }
    if (spec.type === 'scatter') {
      if (hover.series === null || hover.point === null) return null;
      const m = layout.scatter.find((p) => p.series === hover.series && p.point === hover.point);
      if (m === undefined) return null;
      return {
        x: m.x + 10,
        y: m.y - 10,
        title: m.label,
        rows: [
          {
            colour: colour(m.series, m.highlighted),
            value: `${formatValue(spec.series[m.series]?.points[m.point]?.x ?? 0)} → ${formatValue(m.value, spec.unit)}`,
            name: spec.series[m.series]?.name ?? '',
          },
        ],
      };
    }
    if (hoveredCategory === undefined) return null;
    const i = hoveredCategory.index;
    const rows = spec.series
      .map((s, si) => ({ s, si, p: s.points[i] }))
      .filter((r) => r.p !== undefined)
      .map((r) => ({
        colour: colour(r.si, r.p?.label === spec.highlight),
        value: formatValue(r.p?.value ?? 0, spec.unit),
        // A lone unnamed series has nothing to add after the value.
        name: r.s.name || (spec.series.length > 1 ? spec.yLabel || 'Value' : spec.yLabel || ''),
      }));
    const horizontal = spec.type === 'hbar';
    return {
      x: horizontal
        ? layout.plot.x + layout.plot.w * 0.5
        : hoveredCategory.band.x + hoveredCategory.band.w + 6,
      y: horizontal ? hoveredCategory.band.y + hoveredCategory.band.h : layout.plot.y + 8,
      title: hoveredCategory.label,
      rows,
    };
  }, [layout, spec, hover, hoveredCategory, colour]);

  const style: CSSProperties = fill ? { height: '100%' } : { height };
  const tooltipStyle = (): CSSProperties => {
    if (tooltip === null || layout === null) return {};
    // Flip to the left of the band when the card would run off the right edge.
    const flip = tooltip.x + 170 > layout.width;
    return {
      left: flip ? Math.max(8, tooltip.x - 190) : tooltip.x,
      top: Math.max(4, Math.min(tooltip.y, layout.height - 70)),
    };
  };

  return (
    <div
      className={['pd-chart', fill ? 'pd-chart--fill' : 'pd-chart--inline', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="chart-view"
      data-chart-type={spec.type}
      data-chart-view={view}
    >
      <div className="pd-chart-head">
        <div className="pd-chart-titles">
          {spec.title !== '' ? <div className="pd-chart-title">{spec.title}</div> : null}
          {spec.subtitle !== undefined || spec.yLabel !== undefined ? (
            <div className="pd-chart-subtitle">{spec.subtitle ?? spec.yLabel}</div>
          ) : null}
        </div>
        <div className="pd-chart-controls">
          <fieldset className="pd-chart-toggle">
            <legend className="pd-chart-toggle-legend">View as</legend>
            <button
              type="button"
              className="pd-chart-toggle-btn"
              data-active={view === 'chart' || undefined}
              aria-label="Chart"
              title="Chart"
              onClick={() => setView('chart')}
            >
              <IconChart size={14} />
            </button>
            <button
              type="button"
              className="pd-chart-toggle-btn"
              data-active={view === 'table' || undefined}
              aria-label="Table"
              title="Table"
              onClick={() => setView('table')}
            >
              <IconTable size={14} />
            </button>
          </fieldset>
          {corner}
        </div>
      </div>
      {view === 'table' ? (
        <div
          className="pd-chart-table-wrap pd-scroll"
          style={fill ? { flex: 1 } : { maxHeight: height }}
        >
          <ChartTable spec={spec} />
        </div>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: hover is a read-out only; the table view carries every value for keyboard and screen-reader users
        <div
          ref={hostRef}
          className="pd-chart-box"
          style={style}
          onMouseLeave={() => setHover(NO_HOVER)}
        >
          {layout !== null ? (
            <svg
              className="pd-chart-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={spec.title || 'chart'}
            >
              <ChartShapes
                spec={spec}
                layout={layout}
                hover={hover}
                colour={colour}
                setHover={setHover}
                valueLabels={valueLabels}
              />
            </svg>
          ) : null}
          {tooltip !== null ? (
            <div className="pd-chart-tooltip" style={tooltipStyle()} data-testid="chart-tooltip">
              <div className="pd-chart-tooltip-title">{tooltip.title}</div>
              {tooltip.rows.map((r) => (
                <div className="pd-chart-tooltip-row" key={`${r.name}-${r.value}`}>
                  <span className="pd-chart-swatch" style={{ background: r.colour }} />
                  <span className="pd-chart-tooltip-value">{r.value}</span>
                  {r.name !== '' ? <span className="pd-chart-tooltip-name">{r.name}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {spec.note !== undefined ? <div className="pd-chart-note">{spec.note}</div> : null}
    </div>
  );
}

function ChartShapes({
  spec,
  layout: L,
  hover,
  colour,
  setHover,
  valueLabels = false,
}: {
  spec: ChartSpec;
  layout: ChartLayout;
  hover: Hover;
  colour: (series: number, highlighted: boolean) => string;
  setHover: (h: Hover) => void;
  /** Write each value on its bar / point (the canvas view; the same rule as the SVG). */
  valueLabels?: boolean;
}) {
  const horizontal = spec.type === 'hbar';
  const shapes: React.ReactNode[] = [];
  const barValues = valueLabels && spec.type !== 'stacked' && L.bars.length <= 24;
  const lineValues = valueLabels && L.lines.length === 1 && (L.lines[0]?.markers.length ?? 0) <= 16;

  if (L.legend.length > 0 && L.donut === undefined) {
    let lx = L.plot.x;
    for (const e of L.legend) {
      shapes.push(
        <g key={`legend-${e.series}`}>
          <rect
            x={lx}
            y={L.plot.y - 22}
            width={10}
            height={10}
            rx={2}
            fill={colour(e.series, false)}
          />
          <text x={lx + 15} y={L.plot.y - 13} className="pd-chart-text pd-chart-text--mute">
            {e.name}
          </text>
        </g>,
      );
      lx += 15 + 6.5 * e.name.length + 18;
    }
  }

  if (L.donut !== undefined) {
    const shades =
      spec.highlight !== undefined ? SERIES_COLOURS.filter((c) => c !== HIGHLIGHT) : SERIES_COLOURS;
    for (const s of L.slices) {
      const fill = s.highlighted ? HIGHLIGHT : (shades[s.point % shades.length] ?? 'currentColor');
      const dim = hover.point !== null && hover.point !== s.point;
      shapes.push(
        // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
        <path
          key={`slice-${s.point}`}
          d={s.d}
          fill={fill}
          opacity={dim ? 0.45 : 1}
          className="pd-chart-slice"
          onMouseEnter={() => setHover({ category: null, series: 0, point: s.point })}
        />,
      );
    }
    shapes.push(
      <g key="donut-centre">
        <text
          x={L.donut.cx}
          y={L.donut.cy + 7}
          textAnchor="middle"
          className="pd-chart-text pd-chart-text--big"
        >
          {L.donut.centre.big}
        </text>
        <text
          x={L.donut.cx}
          y={L.donut.cy + 24}
          textAnchor="middle"
          className="pd-chart-text pd-chart-text--mute"
        >
          {L.donut.centre.small}
        </text>
      </g>,
    );
    for (const c of L.categories) {
      const s = L.slices[c.index];
      if (s === undefined) continue;
      const fill = s.highlighted ? HIGHLIGHT : (shades[s.point % shades.length] ?? 'currentColor');
      const y = c.band.y + c.band.h / 2;
      shapes.push(
        // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
        <g
          key={`legend-${c.index}`}
          className="pd-chart-legend-row"
          onMouseEnter={() => setHover({ category: null, series: 0, point: s.point })}
        >
          <rect x={c.band.x} y={y - 6} width={12} height={12} rx={3} fill={fill} />
          <text
            x={c.band.x + 20}
            y={y + 4}
            className="pd-chart-text"
            fontWeight={s.highlighted ? 600 : 400}
          >
            {c.label}
          </text>
          <text
            x={L.width - 4}
            y={y + 4}
            textAnchor="end"
            className="pd-chart-text pd-chart-text--mute"
          >
            {spec.unit === '%'
              ? formatValue(s.value, '%')
              : `${formatValue(s.value, spec.unit)} · ${Math.round(s.fraction * 100)}%`}
          </text>
        </g>,
      );
    }
    return <>{shapes}</>;
  }

  // Hover bands (categorical charts): a translucent band behind the plot.
  if (spec.type !== 'scatter') {
    for (const c of L.categories) {
      shapes.push(
        // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
        <rect
          key={`band-${c.index}`}
          x={c.band.x}
          y={c.band.y}
          width={c.band.w}
          height={c.band.h}
          className="pd-chart-band"
          data-hover={hover.category === c.index || undefined}
          onMouseEnter={() => setHover({ category: c.index, series: null, point: null })}
        />,
      );
    }
  }
  for (const tick of L.ticks) {
    const zero = tick.value === 0;
    shapes.push(
      horizontal ? (
        <g key={`tick-${tick.value}`}>
          <line
            x1={tick.at}
            y1={L.plot.y}
            x2={tick.at}
            y2={L.plot.y + L.plot.h}
            className={zero ? 'pd-chart-axis' : 'pd-chart-grid'}
          />
          <text
            x={tick.at}
            y={L.plot.y + L.plot.h + 15}
            textAnchor="middle"
            className="pd-chart-text pd-chart-text--mute pd-chart-text--small"
          >
            {tick.label}
          </text>
        </g>
      ) : (
        <g key={`tick-${tick.value}`}>
          <line
            x1={L.plot.x}
            y1={tick.at}
            x2={L.plot.x + L.plot.w}
            y2={tick.at}
            className={zero ? 'pd-chart-axis' : 'pd-chart-grid'}
          />
          <text
            x={L.plot.x - 8}
            y={tick.at + 4}
            textAnchor="end"
            className="pd-chart-text pd-chart-text--mute pd-chart-text--small"
          >
            {tick.label}
          </text>
        </g>
      ),
    );
  }
  for (const tick of L.xTicks) {
    shapes.push(
      <g key={`xtick-${tick.value}`}>
        <line
          x1={tick.at}
          y1={L.plot.y}
          x2={tick.at}
          y2={L.plot.y + L.plot.h}
          className="pd-chart-grid"
        />
        <text
          x={tick.at}
          y={L.plot.y + L.plot.h + 15}
          textAnchor="middle"
          className="pd-chart-text pd-chart-text--mute pd-chart-text--small"
        >
          {tick.label}
        </text>
      </g>,
    );
  }
  if (spec.type !== 'scatter') {
    for (const c of L.categories) {
      shapes.push(
        horizontal ? (
          <text
            key={`cat-${c.index}`}
            x={L.plot.x - 10}
            y={c.at + 4}
            textAnchor="end"
            className="pd-chart-text"
          >
            {c.label}
          </text>
        ) : (
          <text
            key={`cat-${c.index}`}
            x={c.at}
            y={L.plot.y + L.plot.h + 16}
            textAnchor="middle"
            className="pd-chart-text pd-chart-text--mute pd-chart-text--small"
          >
            {c.label}
          </text>
        ),
      );
    }
  }
  for (const b of L.bars) {
    const dim = hover.category !== null && hover.category !== b.point;
    shapes.push(
      // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
      <rect
        key={`bar-${b.series}-${b.point}`}
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        rx={Math.min(3, b.w / 3)}
        fill={colour(b.series, b.highlighted)}
        opacity={dim ? 0.55 : 1}
        className="pd-chart-bar"
        onMouseEnter={() => setHover({ category: b.point, series: b.series, point: b.point })}
      />,
    );
    if (barValues) {
      shapes.push(
        horizontal ? (
          <text
            key={`barv-${b.series}-${b.point}`}
            x={b.x + b.w + 8}
            y={b.y + b.h / 2 + 4}
            className="pd-chart-text pd-chart-text--value"
          >
            {formatValue(b.value, spec.unit)}
          </text>
        ) : (
          <text
            key={`barv-${b.series}-${b.point}`}
            x={b.x + b.w / 2}
            y={b.value >= 0 ? b.y - 6 : b.y + b.h + 14}
            textAnchor="middle"
            className="pd-chart-text pd-chart-text--value"
          >
            {formatValue(b.value, spec.unit)}
          </text>
        ),
      );
    }
  }
  for (const l of L.lines) {
    const c = colour(l.series, false);
    if (spec.type === 'area' && l.area !== '') {
      shapes.push(<path key={`area-${l.series}`} d={l.area} fill={c} fillOpacity={0.14} />);
    }
    if (l.markers.length > 1) {
      shapes.push(
        <path
          key={`line-${l.series}`}
          d={l.d}
          fill="none"
          stroke={c}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      );
    }
    for (const m of l.markers) {
      const on = hover.category === m.point;
      shapes.push(
        // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
        <circle
          key={`marker-${l.series}-${m.point}`}
          cx={m.x}
          cy={m.y}
          r={on || m.highlighted ? 5.5 : 4}
          className="pd-chart-marker"
          stroke={m.highlighted ? HIGHLIGHT : c}
          strokeWidth={2.5}
          onMouseEnter={() => setHover({ category: m.point, series: l.series, point: m.point })}
        />,
      );
      if (lineValues) {
        shapes.push(
          <text
            key={`markerv-${l.series}-${m.point}`}
            x={m.x}
            y={m.y - 11}
            textAnchor="middle"
            className="pd-chart-text pd-chart-text--value"
          >
            {formatValue(m.value, spec.unit)}
          </text>,
        );
      }
    }
  }
  for (const m of L.scatter) {
    const on = hover.series === m.series && hover.point === m.point;
    shapes.push(
      // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
      <circle
        key={`pt-${m.series}-${m.point}`}
        cx={m.x}
        cy={m.y}
        r={on ? 7 : m.highlighted ? 6 : 4.5}
        fill={colour(m.series, m.highlighted)}
        fillOpacity={on ? 1 : 0.85}
        className="pd-chart-dot"
        onMouseEnter={() => setHover({ category: null, series: m.series, point: m.point })}
      />,
    );
  }
  if (spec.xLabel !== undefined) {
    shapes.push(
      <text
        key="xlabel"
        x={L.plot.x + L.plot.w / 2}
        y={L.height - 3}
        textAnchor="middle"
        className="pd-chart-text pd-chart-text--mute pd-chart-text--small"
      >
        {spec.xLabel}
      </text>,
    );
  }
  if (spec.yLabel !== undefined && !horizontal && L.plot.x > 30) {
    const cy = L.plot.y + L.plot.h / 2;
    shapes.push(
      <text
        key="ylabel"
        x={11}
        y={cy}
        textAnchor="middle"
        transform={`rotate(-90 11 ${cy})`}
        className="pd-chart-text pd-chart-text--mute pd-chart-text--small"
      >
        {spec.yLabel}
      </text>,
    );
  }
  return <>{shapes}</>;
}

/** The same data as rows — Claude's table toggle. */
export function ChartTable({ spec }: { spec: ChartSpec }) {
  const first = spec.series[0];
  const labels = first?.points.map((p) => p.label) ?? [];
  const scatter = spec.type === 'scatter';
  return (
    <table className="pd-chart-table" data-testid="chart-table">
      <thead>
        <tr>
          <th>{spec.xLabel ?? (scatter ? 'Point' : 'Category')}</th>
          {scatter ? <th>x</th> : null}
          {spec.series.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: series are positional (two may share a name)
            <th key={`h-${i}-${s.name}`}>{s.name || spec.yLabel || 'Value'}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((label, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a data row's identity IS its position (labels repeat)
          <tr key={`${i}-${label}`}>
            <td>{label}</td>
            {scatter ? <td>{formatValue(first?.points[i]?.x ?? 0)}</td> : null}
            {spec.series.map((s, si) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a cell's identity is its row and column
              <td key={`c-${si}-${i}`}>
                {s.points[i] !== undefined ? formatValue(s.points[i]?.value ?? 0, spec.unit) : ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Registry surface: a chart artifact's text is its JSON spec. */
export function ChartSurface({ content, onExport }: SurfaceProps) {
  const parsed = useMemo(() => specFromText(content.text), [content.text]);
  if ('error' in parsed) {
    return <div className="pd-canvas-empty">This chart could not be read: {parsed.error}</div>;
  }
  void onExport;
  return <ChartView spec={parsed} fill />;
}

/** The static SVG of a chart artifact — what Export hands out. */
export function chartArtifactSvg(text: string): string | null {
  const parsed = specFromText(text);
  return 'error' in parsed ? null : chartToSvg(parsed);
}

export type { IconProps };
