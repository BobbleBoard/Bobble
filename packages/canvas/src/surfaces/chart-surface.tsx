/**
 * The interactive chart — Claude-parity data visuals, in the chat and in the
 * canvas.
 *
 * The user (2026-09-16), Claude's inline card beside Bobble's static picture: "we
 * need parity on these datavisuals … this was way quicker and is a much
 * stronger result". What theirs has and a picture cannot: a hover band with
 * the value read out, a chart ⇄ table toggle in the corner, and a size that
 * fits the thread. This renders a ChartSpec (the same spec the `chart` tool
 * wrote beside its SVG) from the shared layout, so the bars here are the bars
 * in the file.
 *
 * …and then: "square not rounded looks bad. can it style them on its own? …
 * we CANNOT have 'all charts from bobble look the same generic'." So the card
 * wears the spec's LOOK (@pi-desktop/charts style.ts): its palette, its bar
 * radius and width, its grid, its line style, its type. A theme-following look
 * takes ink and grid from the app's tokens (a dark chat, a dark chart); a
 * fixed-ground look (slate, terminal, paper) paints its own ground inside the
 * card, in any theme, on purpose.
 *
 * The same component serves the inline card (compact, capped height) and the
 * canvas tab (fills the tab); only the size differs.
 */
import {
  barRadius,
  type ChartLayout,
  type ChartSpec,
  chartToSvg,
  formatValue,
  layoutChart,
  normalizeChartSpec,
  type ResolvedStyle,
  resolveStyle,
  roundedBarPath,
  seriesColour,
  sliceColour,
} from '@pi-desktop/charts';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SurfaceProps } from '../registry.ts';
import { IconChart, type IconProps, IconTable } from '../tab-icons.tsx';

export interface ChartViewProps {
  readonly spec: ChartSpec;
  /** Fill the available box (canvas) rather than a capped inline height. */
  readonly fill?: boolean;
  /** Extra controls rendered in the header's corner (e.g. move to canvas). */
  readonly corner?: React.ReactNode;
  readonly className?: string;
  /**
   * Whether the chart builds itself on arrival (the default). Off for a card
   * taking over from a live one that already drew it: growing every bar from
   * the axis again would read as the chart starting over.
   */
  readonly enter?: boolean;
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

/**
 * The app's theme, as the theme sheet keys it (`data-mode` on the root), so a
 * theme-following look can lift its darkest inks on a dark chat. Watched, so
 * a theme switch re-resolves the look without a remount.
 */
function readAppTheme(): 'light' | 'dark' {
  return typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-mode') === 'dark'
    ? 'dark'
    : 'light';
}

function useAppTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(readAppTheme);
  useLayoutEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setTheme(readAppTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/**
 * The look as CSS custom properties on the card's root. A fixed ground sets
 * the paper/ink/mute/grid the stylesheet otherwise takes from the app tokens;
 * the font and title weight always come from the look.
 */
function styleVars(style: ResolvedStyle): CSSProperties {
  const vars: Record<string, string> = {
    '--chart-font': style.fontFamily,
    '--chart-title-weight': String(style.titleWeight),
  };
  if (style.ground !== null) {
    vars['--chart-paper'] = style.ground.paper;
    vars['--chart-ink'] = style.ground.ink;
    vars['--chart-mute'] = style.ground.mute;
    vars['--chart-grid'] = style.ground.grid;
  }
  return vars as CSSProperties;
}

export function ChartView({ spec, fill = false, corner, className, enter = true }: ChartViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [boxHeight, setBoxHeight] = useState(0);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<Hover>(NO_HOVER);
  const gradientId = useId();
  const theme = useAppTheme();
  const style = useMemo(() => resolveStyle(spec.style, 'clean', { theme }), [spec.style, theme]);
  /*
   * THE CHART BUILDS ITSELF ON ARRIVAL. The user (2026-09-17): "bar ones have
   * bars go up, pie expand smoothly, radar charts show dots going out from
   * the center … all smooth live building." The first paint carries
   * `data-enter`, which the stylesheet reads to run the per-shape entrance
   * (bars scale up from the axis, slices grow from the centre, lines draw,
   * markers pop); it is dropped once the animation has had its second, so a
   * hover or a redraw never replays it. Reduced motion skips it (CSS).
   */
  /*
   * …BUT NOT WHEN IT IS MOVED. A chart that mounts during a view transition is
   * one that already existed, arriving in its new home — the card lifted into
   * the canvas, or the tab dropped back into the chat. Building it again from
   * the axis made the morph cross-fade a finished chart into an empty one that
   * then refilled: the jitter the user saw "both ways" (2026-10-08), SEEN frame by
   * frame in inline-move-film.mjs. `data-vt` is set for the length of the
   * transition (apps/desktop view-transition.ts).
   */
  const [entering, setEntering] = useState(
    () =>
      enter && !(typeof document !== 'undefined' && document.documentElement.dataset.vt === '1'),
  );
  useEffect(() => {
    const t = setTimeout(() => setEntering(false), 1100);
    return () => clearTimeout(t);
  }, []);

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
    () =>
      width > 0 ? layoutChart(spec, { width, height, compact: !fill && width < 420, style }) : null,
    [spec, width, height, fill, style],
  );
  // Values on the shapes: the look decides (on / off); `auto` means the larger
  // view only — the inline card stays clean and reads them on hover.
  const valueLabels = style.labels === 'on' || (style.labels === 'auto' && fill);

  const colour = useCallback(
    (series: number, highlighted: boolean): string =>
      seriesColour(style, series, highlighted, spec.series.length),
    [style, spec.series.length],
  );

  const hoveredCategory = hover.category !== null ? layout?.categories[hover.category] : undefined;
  const tooltip = useMemo(() => {
    if (layout === null) return null;
    if (spec.type === 'radar') {
      if (hover.series === null || hover.point === null || layout.radar === undefined) return null;
      const m = layout.radar.shapes[hover.series]?.points[hover.point];
      if (m === undefined) return null;
      return {
        x: m.x + 10,
        y: m.y - 10,
        title: m.label,
        rows: [
          {
            colour: colour(m.series, m.highlighted),
            value: formatValue(m.value, spec.unit),
            name: spec.series[m.series]?.name ?? '',
          },
        ],
      };
    }
    if (spec.type === 'donut' || spec.type === 'pie') {
      if (hover.point === null) return null;
      const s = layout.slices[hover.point];
      if (s === undefined) return null;
      return {
        x: layout.donut !== undefined ? layout.donut.cx + layout.donut.r + 8 : 0,
        y: layout.donut !== undefined ? layout.donut.cy - 20 : 0,
        title: s.label,
        rows: [
          {
            colour: sliceColour(
              style,
              s.point,
              layout.slices.length,
              s.highlighted,
              spec.highlight !== undefined,
              '',
            ),
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
  }, [layout, spec, hover, hoveredCategory, colour, style]);

  const boxStyle: CSSProperties = fill ? { height: '100%' } : { height };
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
      style={styleVars(style)}
      data-testid="chart-view"
      data-chart-type={spec.type}
      data-chart-view={view}
      data-chart-look={style.look}
      data-chart-ground={style.ground !== null || undefined}
      data-enter={entering || undefined}
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
          style={boxStyle}
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
                style={style}
                hover={hover}
                colour={colour}
                setHover={setHover}
                valueLabels={valueLabels}
                gradientId={gradientId}
                staggered={entering}
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
  style,
  hover,
  colour,
  setHover,
  valueLabels = false,
  gradientId,
  staggered = true,
}: {
  spec: ChartSpec;
  layout: ChartLayout;
  style: ResolvedStyle;
  hover: Hover;
  colour: (series: number, highlighted: boolean) => string;
  setHover: (h: Hover) => void;
  /** Write each value on its bar / point (the look, or the canvas view). */
  valueLabels?: boolean;
  gradientId: string;
  /**
   * The entrance's beat between bars. Only while it runs: a bar that lands
   * later in a chart still being written rises at once (styles.css,
   * .pd-chart--building), not after its place in a stagger long over.
   */
  staggered?: boolean;
}) {
  const horizontal = spec.type === 'hbar';
  const shapes: React.ReactNode[] = [];
  const defs: React.ReactNode[] = [];
  const barValues = valueLabels && spec.type !== 'stacked' && L.bars.length <= 24;
  const lineValues = valueLabels && L.lines.length === 1 && (L.lines[0]?.markers.length ?? 0) <= 16;
  const swatchRx = style.radius === 0 ? 0 : 2;
  const gridDash = style.grid === 'dots' ? '1 4' : undefined;

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
            rx={swatchRx}
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

  if (L.radar !== undefined) {
    const R = L.radar;
    // The web: rings, spokes, labels round the rim.
    shapes.push(
      <g key="radar-web" className="pd-chart-radar-web">
        {R.rings.map((d) => (
          <path key={d} d={d} className="pd-chart-grid" fill="none" />
        ))}
        {R.axes.map((ax) => (
          <line
            key={`spoke-${ax.index}`}
            x1={R.cx}
            y1={R.cy}
            x2={ax.x}
            y2={ax.y}
            className="pd-chart-grid"
          />
        ))}
        {R.axes.map((ax) => (
          <text
            key={`spoke-label-${ax.index}`}
            x={ax.labelX}
            y={ax.labelY}
            textAnchor={ax.anchor}
            className="pd-chart-text pd-chart-text--mute"
          >
            {ax.label}
          </text>
        ))}
      </g>,
    );
    // The series, each a polygon with a dot at every vertex — the group
    // scales out from the centre on arrival (the stylesheet's radar entrance).
    for (const sh of R.shapes) {
      const c = colour(sh.series, false);
      const dimmed = hover.series !== null && hover.series !== sh.series;
      shapes.push(
        <g
          key={`radar-${sh.series}`}
          className="pd-chart-radar-series"
          style={{ transformOrigin: `${R.cx}px ${R.cy}px` }}
          opacity={dimmed ? 0.35 : 1}
        >
          <path
            d={sh.d}
            fill={c}
            fillOpacity={0.18}
            stroke={c}
            strokeWidth={style.strokeWidth}
            strokeLinejoin="round"
          />
          {sh.points.map((p) => {
            const on = hover.series === sh.series && hover.point === p.point;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
              <circle
                key={`radar-pt-${sh.series}-${p.point}`}
                cx={p.x}
                cy={p.y}
                r={on || p.highlighted ? 5.5 : 3.5}
                className="pd-chart-marker pd-chart-radar-dot"
                style={{ fill: p.highlighted ? style.accent : c }}
                stroke={p.highlighted ? style.accent : c}
                strokeWidth={0}
                onMouseEnter={() => setHover({ category: null, series: sh.series, point: p.point })}
              />
            );
          })}
        </g>,
      );
    }
    return <>{shapes}</>;
  }

  if (L.donut !== undefined) {
    // The one slice rule the SVG and the sidecar share (charts style.ts).
    const sliceFill = (s: { highlighted: boolean; point: number }): string =>
      sliceColour(
        style,
        s.point,
        L.slices.length,
        s.highlighted,
        spec.highlight !== undefined,
        'currentColor',
      );
    for (const s of L.slices) {
      const dim = hover.point !== null && hover.point !== s.point;
      shapes.push(
        // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
        <path
          key={`slice-${s.point}`}
          d={s.d}
          fill={sliceFill(s)}
          opacity={dim ? 0.45 : 1}
          className="pd-chart-slice"
          style={{
            transformOrigin: `${L.donut.cx}px ${L.donut.cy}px`,
            animationDelay: `${s.point * 45}ms`,
          }}
          onMouseEnter={() => setHover({ category: null, series: 0, point: s.point })}
        />,
      );
    }
    if (L.donut.centre.big !== '')
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
      const y = c.band.y + c.band.h / 2;
      shapes.push(
        // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
        <g
          key={`legend-${c.index}`}
          className="pd-chart-legend-row"
          onMouseEnter={() => setHover({ category: null, series: 0, point: s.point })}
        >
          <rect
            x={c.band.x}
            y={y - 6}
            width={12}
            height={12}
            rx={swatchRx + 1}
            fill={sliceFill(s)}
          />
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
          rx={6}
          className="pd-chart-band"
          data-hover={hover.category === c.index || undefined}
          onMouseEnter={() => setHover({ category: c.index, series: null, point: null })}
        />,
      );
    }
  }
  for (const tick of L.ticks) {
    const zero = tick.value === 0;
    const drawLine = style.grid !== 'none' || zero;
    shapes.push(
      horizontal ? (
        <g key={`tick-${tick.value}`}>
          {drawLine ? (
            <line
              x1={tick.at}
              y1={L.plot.y}
              x2={tick.at}
              y2={L.plot.y + L.plot.h}
              className={zero ? 'pd-chart-axis' : 'pd-chart-grid'}
              strokeDasharray={zero ? undefined : gridDash}
              strokeLinecap={gridDash !== undefined ? 'round' : undefined}
            />
          ) : null}
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
          {drawLine ? (
            <line
              x1={L.plot.x}
              y1={tick.at}
              x2={L.plot.x + L.plot.w}
              y2={tick.at}
              className={zero ? 'pd-chart-axis' : 'pd-chart-grid'}
              strokeDasharray={zero ? undefined : gridDash}
              strokeLinecap={gridDash !== undefined ? 'round' : undefined}
            />
          ) : null}
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
        {style.grid !== 'none' ? (
          <line
            x1={tick.at}
            y1={L.plot.y}
            x2={tick.at}
            y2={L.plot.y + L.plot.h}
            className="pd-chart-grid"
            strokeDasharray={gridDash}
          />
        ) : null}
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
    const r = b.outer ? barRadius(style.radius, b.w, b.h) : 0;
    shapes.push(
      // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
      <path
        key={`bar-${b.series}-${b.point}`}
        d={roundedBarPath(b.x, b.y, b.w, b.h, r, b.side)}
        fill={colour(b.series, b.highlighted)}
        opacity={dim ? 0.55 : 1}
        className="pd-chart-bar"
        data-side={b.side}
        // The entrance grows the bar from its axis: the origin is the side
        // that touches it, and each bar starts a beat after the last.
        style={{
          transformOrigin:
            b.side === 'top'
              ? `${b.x + b.w / 2}px ${b.y + b.h}px`
              : b.side === 'bottom'
                ? `${b.x + b.w / 2}px ${b.y}px`
                : b.side === 'right'
                  ? `${b.x}px ${b.y + b.h / 2}px`
                  : `${b.x + b.w}px ${b.y + b.h / 2}px`,
          ...(staggered ? { animationDelay: `${Math.min(b.point, 24) * 35}ms` } : {}),
        }}
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
    if (spec.type === 'area' && l.area !== '' && style.area !== 'none') {
      if (style.area === 'gradient') {
        const id = `${gradientId}-area-${l.series}`;
        defs.push(
          <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c} stopOpacity={0.38} />
            <stop offset="1" stopColor={c} stopOpacity={0.02} />
          </linearGradient>,
        );
        shapes.push(
          <path
            key={`area-${l.series}`}
            d={l.area}
            fill={`url(#${id})`}
            className="pd-chart-area"
          />,
        );
      } else {
        shapes.push(
          <path
            key={`area-${l.series}`}
            d={l.area}
            fill={c}
            fillOpacity={0.14}
            className="pd-chart-area"
          />,
        );
      }
    }
    if (l.markers.length > 1) {
      shapes.push(
        <path
          key={`line-${l.series}`}
          d={l.d}
          fill="none"
          stroke={c}
          strokeWidth={style.strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="pd-chart-line"
          // pathLength=1 makes the drawing entrance one rule for every length.
          pathLength={1}
        />,
      );
    }
    for (const m of l.markers) {
      const on = hover.category === m.point;
      const ring = style.markers === 'ring';
      const visible = style.markers !== 'none' || on || m.highlighted;
      if (visible) {
        shapes.push(
          // biome-ignore lint/a11y/noStaticElementInteractions: hover read-out only — the table view carries the values
          <circle
            key={`marker-${l.series}-${m.point}`}
            cx={m.x}
            cy={m.y}
            r={on || m.highlighted ? 5.5 : ring ? 4 : 3.5}
            className="pd-chart-marker"
            // The stylesheet fills a marker with the paper (a ring); a dot's
            // fill is inline so it wins over that rule.
            style={{
              ...(ring ? {} : { fill: m.highlighted ? style.accent : c }),
              transformOrigin: `${m.x}px ${m.y}px`,
              animationDelay: `${Math.min(m.point, 30) * 30}ms`,
            }}
            stroke={m.highlighted ? style.accent : c}
            strokeWidth={ring ? 2.5 : 0}
            onMouseEnter={() => setHover({ category: m.point, series: l.series, point: m.point })}
          />,
        );
      }
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
        style={{
          transformOrigin: `${m.x}px ${m.y}px`,
          animationDelay: `${Math.min(m.point, 40) * 18}ms`,
        }}
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
  return (
    <>
      {defs.length > 0 ? <defs>{defs}</defs> : null}
      {shapes}
    </>
  );
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
    // The parser's own words are for the console, not the canvas.
    console.warn('[chart] unreadable spec:', parsed.error);
    return (
      <div className="pd-canvas-empty">
        This chart’s data could not be read. Asking for the chart again redraws it.
      </div>
    );
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
