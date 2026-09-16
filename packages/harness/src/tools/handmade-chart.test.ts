import { describe, expect, it } from 'vitest';
import {
  handmadeChartRefusal,
  isHandmadeChart,
  isPlottingScript,
  looksLikeChartSvg,
} from './handmade-chart.js';

const MPL = `python3 - <<'EOF'
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
years = ["2021", "2022", "2023", "2024"]
units = [12, 19, 15, 22]
plt.bar(years, units)
plt.savefig("units.png")
EOF`;

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
<rect x="10" y="100" width="40" height="120"/><rect x="60" y="60" width="40" height="160"/>
<rect x="110" y="90" width="40" height="130"/><rect x="160" y="40" width="40" height="180"/>
<text x="10" y="240">12</text><text x="60" y="240">19</text><text x="110" y="240">15</text><text x="160" y="240">22</text>
</svg>`;

describe('a chart drawn by hand', () => {
  it('a matplotlib script that draws and saves a figure is a plotting script', () => {
    expect(isPlottingScript(MPL)).toBe(true);
    expect(isHandmadeChart({ content: MPL, chartAvailable: true })).toBe('script');
  });

  it('pandas reading a CSV, or matplotlib merely imported, is not', () => {
    expect(
      isPlottingScript('import pandas as pd\ndf = pd.read_csv("x.csv")\nprint(df.head())'),
    ).toBe(false);
    expect(isPlottingScript('import matplotlib\nprint(matplotlib.__version__)')).toBe(false);
  });

  it('installing the library is the first step of the same road', () => {
    expect(isPlottingScript('pip install matplotlib && python3 plot.py')).toBe(true);
  });

  it('an SVG with bars and numeric labels is a chart; a logo of three rectangles is not', () => {
    expect(looksLikeChartSvg(CHART_SVG)).toBe(true);
    expect(isHandmadeChart({ path: 'units.svg', content: CHART_SVG, chartAvailable: true })).toBe(
      'svg',
    );
    const logo =
      '<svg><rect x="0" y="0" width="10" height="10"/><rect x="12" y="0" width="10" height="10"/><rect x="24" y="0" width="10" height="10"/><text x="0" y="30">ACME</text></svg>';
    expect(looksLikeChartSvg(logo)).toBe(false);
  });

  it('a line chart drawn as a polyline with tick labels is a chart too', () => {
    const line =
      '<svg><polyline points="0,10 20,5 40,8"/><text>10</text><text>20</text><text>30</text></svg>';
    expect(looksLikeChartSvg(line)).toBe(true);
  });

  it('with no chart tool there is nothing to point at', () => {
    expect(isHandmadeChart({ content: MPL, chartAvailable: false })).toBeNull();
  });

  it('the refusal names the command in the shape this mode uses, and the exit', () => {
    const cli = handmadeChartRefusal('script', { cli: true });
    expect(cli).toContain('chart bar "Units Sold by Year" --labels');
    expect(cli).toContain('run it again UNCHANGED');
    const schema = handmadeChartRefusal('svg', { cli: false, path: 'units.svg' });
    expect(schema).toContain('chart { type: "bar"');
    expect(schema).toContain('units.svg is a chart drawn by hand');
    expect(schema).toContain('write the same file again UNCHANGED');
  });
});
