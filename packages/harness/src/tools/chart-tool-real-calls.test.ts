/**
 * VQ-02 — the chart tool, driven by the lines a real model wrote.
 *
 * "demo all your dataviz skills" (the user's session, 2026-09-17, qwen3.5-4b in
 * bash-CLI mode): 17 `chart` calls. Twelve had no title and were all written to
 * `bar-chart.svg`, each over the last; `--chart-type=line` was ignored four
 * times; a scatter of named categories drew every point at x = 0; a one-series
 * stack of shares drew plain bars. These tests replay those exact lines the way
 * the app runs them — `protectShimDollars`, then bash's word splitting, then
 * the harness's own CLI — into the registered tool.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import { registerChartTool } from './chart-tool.js';
import { buildCli, resolveCli } from './tool-cli.js';
import { protectShimDollars } from './tool-cli-bridge.js';

type Exec = (
  id: string,
  p: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const freshRoot = (): string => {
  const r = mkdtempSync(path.join(tmpdir(), 'chart-real-'));
  roots.push(r);
  return r;
};

const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
})();

/** A chart tool writing into `root`, and a runner for a command line. */
function toolAt(root: string) {
  const tools: Array<Record<string, unknown>> = [];
  registerChartTool({ registerTool: (t: never) => tools.push(t) } as never, {
    bridge: null,
    root: () => root,
  });
  const cap = CAPABILITIES.find((c) => c.name === 'chart');
  const cli = buildCli(
    cap === undefined ? [] : [cap],
    tools.map((t) => ({
      name: t.name as string,
      description: t.description as string,
      parameters: t.parameters as never,
    })),
  );
  const exec = (name: string) => tools.find((t) => t.name === name)?.execute as Exec;
  /** One line as the app runs it: dollars protected, bash splits, the CLI resolves. */
  const line = async (text: string, ctx?: unknown) => {
    const argv = execFileSync('bash', [
      '-c',
      `f(){ printf '%s\\0' "$@"; }; f ${protectShimDollars(text, ['chart'])}`,
    ])
      .toString()
      .split('\0')
      .slice(0, -1);
    const r = resolveCli(cli, argv);
    if (r.kind !== 'call') throw new Error(`${r.kind}: ${r.text}`);
    const res = await exec(r.tool)('c', r.args, undefined, undefined, ctx ?? { cwd: root });
    return { args: r.args, isError: res.isError === true, text: res.content[0]?.text ?? '' };
  };
  return { exec, line };
}

const wrote = (text: string): string | null => /: ([^\s(]+\.svg) \(/.exec(text)?.[1] ?? null;
const specAt = (root: string, svg: string) =>
  JSON.parse(readFileSync(path.join(root, svg.replace(/\.svg$/, '.chart.json')), 'utf8')) as {
    type: string;
    title: string;
    unit?: string;
    size?: string;
    style?: { look?: string };
    series: Array<{ name: string; points: Array<{ label: string; value: number }> }>;
  };

/** The 17 lines, verbatim, and the type each asked for. */
const REAL: ReadonlyArray<readonly [string, string]> = [
  [
    'chart "--labels=[\\"Q1\\",\\"Q2\\",\\"Q3\\",\\"Q4\\"]" "--values=[12500,28750,19600,31200]" --style=candy',
    'bar',
  ],
  [
    'chart "--labels=[\\"2020\\",\\"2021\\",\\"2022\\",\\"2023\\",\\"2024\\"]" "--values=[45000,52000,48000,61000,73000]" --style=terminal',
    'bar',
  ],
  [
    'chart "--labels=[\\"Engineering\\",\\"Design\\",\\"Product\\",\\"Marketing\\",\\"Sales\\"]" "--values=[35,28,22,15,20]" --style=ocean',
    'bar',
  ],
  [
    'chart "--labels=[\\"Low (<50)\\",\\"Moderate (50-100)\\",\\"High (100-150)\\",\\"Very High (>150)\\"]" "--values=[28,35,22,15]" --style=forest',
    'bar',
  ],
  [
    'chart "--labels=[\\"January\\",\\"February\\",\\"March\\",\\"April\\",\\"May\\",\\"June\\"]" "--values=[850,1200,1800,2100,2450,3200]" --style=sunset',
    'bar',
  ],
  [
    'chart "--labels=[\\"2020\\",\\"2021\\",\\"2022\\",\\"2023\\",\\"2024\\"]" "--values=[100,150,120,180,200]" --style=terminal',
    'bar',
  ],
  ['chart "--labels=[\\"X\\",\\"Y\\",\\"Z\\"]" "--values=[10,20,15]" --style=terminal', 'bar'],
  [
    'chart "--labels=[\\"Series A\\",\\"Series B\\",\\"Series C\\"]" "--values=[100,80,60]" --style=terminal',
    'bar',
  ],
  [
    'chart "--labels=[\\"Jan\\",\\"Feb\\",\\"Mar\\",\\"Apr\\",\\"May\\",\\"Jun\\"]" "--values=[100,150,120,180,200,160]" --style=terminal --chart-type=line',
    'line',
  ],
  [
    'chart "--labels=[\\"Jan\\",\\"Feb\\",\\"Mar\\",\\"Apr\\",\\"May\\",\\"Jun\\"]" "--values=[100,150,120,180,200,160]" --style=terminal --chart-type=area',
    'area',
  ],
  [
    'chart "--labels=[\\"Red\\",\\"Green\\",\\"Blue\\",\\"Yellow\\"]" "--values=[35,25,40,20]" --style=candy --chart-type=donut',
    'donut',
  ],
  [
    'chart "--labels=[\\"X\\",\\"Y\\",\\"Z\\",\\"W\\"]" "--values=[10,20,15,25]" --style=terminal --chart-type=scatter',
    'scatter',
  ],
  [
    'chart --title "Revenue Growth Trend" --labels "2020,2021,2022,2023,2024" --values "45000,52000,48000,61000,73000" --unit "$" --look=sunset --type=line',
    'line',
  ],
  [
    'chart --title "Market Share Distribution" --labels "Company A,Company B,Company C,Company D" --values "35,25,20,20" --unit "%" --look=clean --type=donut',
    'donut',
  ],
  [
    'chart --title "Features by Priority" --labels "Critical,High,Medium,Low" --values "4,8,12,6" --unit "features" --look=terminal --type=hbar',
    'hbar',
  ],
  [
    'chart --title "Product Mix" --labels "Electronics,Clothing,Home,Beauty" --values "30,25,20,25" --unit "%" --look=ocean --type=stacked',
    'stacked',
  ],
  [
    'chart --title "User Engagement Metrics" --labels "X,Y,Z,W" --values "10,20,15,25" --look=forest --type=scatter',
    'scatter',
  ],
];

describe.skipIf(!hasBash)('the 17 real calls of "demo all your dataviz skills"', () => {
  it('leave 17 files — twelve untitled charts are twelve files, not one drawn over twelve times', async () => {
    const root = freshRoot();
    const { line } = toolAt(root);
    const results = [];
    for (const [text] of REAL) results.push(await line(text));
    expect(results.filter((r) => r.isError)).toEqual([]);
    const files = readdirSync(root).filter((f) => f.endsWith('.svg'));
    expect(files.length).toBe(17);
    expect(new Set(results.map((r) => wrote(r.text))).size).toBe(17);
    // The untitled ones are named from their data, and say so.
    expect(results[0]?.text).toContain('Drew a bar chart "Q1–Q4"');
    expect(results[0]?.text).toContain('It had no title, so it is titled "Q1–Q4" from its data');
    // Calls 2 and 6 share their labels (2020–2024): the second is a different
    // chart, so it takes the next name and says why.
    expect(wrote(results[1]?.text ?? '')).toBe('2020-2024.svg');
    expect(wrote(results[5]?.text ?? '')).toBe('2020-2024-2.svg');
    expect(results[5]?.text).toContain(
      '2020-2024.svg already holds a different chart, so this one is 2020-2024-2.svg.',
    );
  });

  it('draw the type each asked for — or the one that can show it, saying so', async () => {
    const root = freshRoot();
    const { line } = toolAt(root);
    for (const [text, asked] of REAL) {
      const r = await line(text);
      const file = wrote(r.text);
      expect(file, text).not.toBeNull();
      const got = specAt(root, file as string).type;
      if (asked === 'scatter') {
        // X, Y, Z, W are names: bars, and the reason.
        expect(got, text).toBe('bar');
        expect(r.text).toContain(
          'Drawn as bars instead: a scatter needs a number for x on every point',
        );
      } else if (asked === 'stacked') {
        // Four shares adding up to 100%: a donut, and the reason.
        expect(got, text).toBe('donut');
        expect(r.text).toContain('Drawn as a donut instead: one series of shares adding up to 100');
      } else {
        expect(got, text).toBe(asked);
      }
    }
  });

  it('a look that does not exist is said, with the ones that do; the conversation keeps one look', async () => {
    const root = freshRoot();
    const { line } = toolAt(root);
    const first = await line(REAL[0]?.[0] ?? '');
    expect(specAt(root, wrote(first.text) as string).style?.look).toBe('candy');
    const second = await line(REAL[1]?.[0] ?? '');
    expect(second.text).toContain(
      'There is no look called "terminal" (the looks: clean, soft, bold',
    );
    // …and it wears the conversation's look rather than a random one.
    expect(second.text).toContain('it wears candy.');
    expect(specAt(root, wrote(second.text) as string).style?.look).toBe('candy');
  });
});

describe.skipIf(!hasBash)('values as a model writes them', () => {
  it('"22M, 3,100" is 22,000,000 and 3,100 (it drew Market 3, Today 100)', async () => {
    const root = freshRoot();
    const r = await toolAt(root).line(
      'chart bar "Market and today" --labels "Market, Today" --values "22M, 3,100" --unit units',
    );
    expect(r.isError).toBe(false);
    expect(specAt(root, wrote(r.text) as string).series[0]?.points.map((p) => p.value)).toEqual([
      22_000_000, 3_100,
    ]);
    expect(r.text).toContain('Data: Market 22,000,000 units, Today 3,100 units');
  });

  it('"$1.2M, $2.4M" is 1.2e6 and 2.4e6 in dollars (it was refused as "needs its data")', async () => {
    const root = freshRoot();
    const r = await toolAt(root).line(
      'chart bar "Raised" --labels "Seed, Series A" --values "$1.2M, $2.4M"',
    );
    expect(r.isError).toBe(false);
    const spec = specAt(root, wrote(r.text) as string);
    expect(spec.unit).toBe('$');
    expect(spec.series[0]?.points.map((p) => p.value)).toEqual([1_200_000, 2_400_000]);
    expect(r.text).toContain('Data: Seed $1,200,000, Series A $2,400,000');
  });

  it('"$M" survives the shell: bash would expand it as a variable nobody set', () => {
    expect(protectShimDollars('chart line T --unit "$M" --values "1, 2"', ['chart'])).toBe(
      'chart line T --unit "\\$M" --values "1, 2"',
    );
    expect(protectShimDollars('chart bar T --subtitle "in $bn, 2025"', ['chart'])).toBe(
      'chart bar T --subtitle "in \\$bn, 2025"',
    );
    // A real variable is still a variable, and another program's line is untouched.
    const own = 'chart bar T --out "$HOME/c.svg" --note "$MY_NOTE"';
    expect(protectShimDollars(own, ['chart'])).toBe(own);
    expect(protectShimDollars('echo "$M"', ['chart'])).toBe('echo "$M"');
  });

  it('"$M" on the axis and the labels is "$5.6M", not "5.6 $M"', async () => {
    const root = freshRoot();
    const r = await toolAt(root).line(
      'chart line "Revenue passed costs" --labels "2021, 2022" --values "Revenue: 1.2, 5.6; Costs: 1.5, 3.4" --unit "$M"',
    );
    expect(r.text).toContain('Revenue: 2021 $1.2M, 2022 $5.6M');
    const svg = readFileSync(path.join(root, wrote(r.text) as string), 'utf8');
    expect(svg).toContain('>$6M</text>');
    expect(svg).not.toContain('$M</text>');
  });

  it('a value that is not a number is named with the forms that work — nothing dropped or shifted', async () => {
    const root = freshRoot();
    const r = await toolAt(root).line('chart bar "T" --labels "a, b, c" --values "12, abc, 15"');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(
      /^chart: Could not read "abc" \(value 2 of 3\) as a number: a value may be written 3100, 3,100, 22M/,
    );
    expect(readdirSync(root)).toEqual([]);
  });

  it('a series that does not match its labels is said, not padded with zeros', async () => {
    const root = freshRoot();
    const r = await toolAt(root).line('chart bar "T" --labels "a, b, c" --values "1, 2"');
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'chart: The values have 2 numbers but there are 3 labels (a, b, c): give one value per label.',
    );
  });
});

describe.skipIf(!hasBash)('the flag a model reaches for', () => {
  it('`--chart-type` and `--kind` are `--type`', async () => {
    const root = freshRoot();
    const { line } = toolAt(root);
    const a = await line('chart --title A --labels "x, y" --values "1, 2" --chart-type=line');
    expect(a.args).toMatchObject({ type: 'line' });
    const b = await line('chart --title B --labels "x, y" --values "1, 2" --kind donut');
    expect(b.args).toMatchObject({ type: 'donut' });
    expect(specAt(root, wrote(b.text) as string).type).toBe('donut');
  });
});

describe('never over a different file', () => {
  it('the same chart made again replaces itself; a different one takes the next name', async () => {
    const root = freshRoot();
    const make = toolAt(root).exec('chart');
    const call = { type: 'bar', title: 'Units', labels: 'a, b', values: '1, 2' };
    const first = await make('1', call);
    const again = await make('2', { ...call, values: '1, 3' }); // same title and labels: a remake
    expect(wrote(first.content[0]?.text ?? '')).toBe('units.svg');
    expect(wrote(again.content[0]?.text ?? '')).toBe('units.svg');
    const other = await make('3', { ...call, labels: 'c, d' }); // same title, other categories
    expect(wrote(other.content[0]?.text ?? '')).toBe('units-2.svg');
  });

  it('a file the chart tool did not write is never overwritten', async () => {
    const root = freshRoot();
    writeFileSync(path.join(root, 'logo.svg'), '<svg>mine</svg>');
    const r = await toolAt(root).exec('chart')('1', {
      title: 'Logo',
      labels: 'a, b',
      values: '1, 2',
      out: 'logo.svg',
    });
    expect(readFileSync(path.join(root, 'logo.svg'), 'utf8')).toBe('<svg>mine</svg>');
    expect(r.content[0]?.text).toContain(
      'logo.svg already holds a different chart, so this one is logo-2.svg.',
    );
    expect(existsSync(path.join(root, 'logo-2.svg'))).toBe(true);
  });
});

describe('one look per conversation, unless a chart names its own', () => {
  const session = (id: string) => ({ cwd: '/x', sessionManager: { getSessionId: () => id } });

  it('the first chart’s look carries to the next ones; a named look is kept and becomes the look', async () => {
    const root = freshRoot();
    const make = toolAt(root).exec('chart');
    const look = async (p: Record<string, unknown>, ctx: unknown) => {
      const r = await make(
        '1',
        { labels: 'a, b', values: '1, 2', ...p },
        undefined,
        undefined,
        ctx,
      );
      return specAt(root, wrote(r.content[0]?.text ?? '') as string).style?.look;
    };
    expect(await look({ title: 'First', look: 'forest' }, session('s1'))).toBe('forest');
    expect(await look({ title: 'Second' }, session('s1'))).toBe('forest');
    expect(await look({ title: 'Third', look: 'editorial' }, session('s1'))).toBe('editorial');
    expect(await look({ title: 'Fourth' }, session('s1'))).toBe('editorial');
  });

  it('a new session in the same folder picks up the newest chart’s look (after a restart)', async () => {
    const root = freshRoot();
    const make = toolAt(root).exec('chart');
    await make(
      '1',
      { title: 'Earlier', labels: 'a, b', values: '1, 2', look: 'ocean' },
      undefined,
      undefined,
      session('before'),
    );
    const r = await make(
      '2',
      { title: 'Later', labels: 'a, b', values: '3, 4' },
      undefined,
      undefined,
      session('after-restart'),
    );
    expect(specAt(root, wrote(r.content[0]?.text ?? '') as string).style?.look).toBe('ocean');
  });
});

describe('sized for where it goes', () => {
  it('--size doc writes a 640×400 file, says so, and chart_edit keeps it', async () => {
    const root = freshRoot();
    const t = toolAt(root);
    const r = await t.exec('chart')('1', {
      title: 'For the report',
      labels: 'a, b',
      values: '1, 2',
      size: 'doc',
    });
    const svg = readFileSync(path.join(root, 'for-the-report.svg'), 'utf8');
    expect(svg).toContain('width="640" height="400"');
    expect(r.content[0]?.text).toContain('size doc (640×400)');
    await t.exec('chart_edit')('2', { file: 'for-the-report.svg', accent: 'coral' });
    expect(readFileSync(path.join(root, 'for-the-report.svg'), 'utf8')).toContain(
      'width="640" height="400"',
    );
    const slide = await t.exec('chart_edit')('3', { file: 'for-the-report.svg', size: 'slide' });
    expect(slide.content[0]?.text).toContain('the size (slide)');
    expect(readFileSync(path.join(root, 'for-the-report.svg'), 'utf8')).toContain(
      'width="1280" height="720"',
    );
  });

  it('a three-bar ranking is a short picture, not 560 px tall', async () => {
    const root = freshRoot();
    await toolAt(root).exec('chart')('1', {
      type: 'hbar',
      title: 'Tickets by team',
      labels: 'Billing, Accounts, Shipping',
      values: '412, 288, 97',
    });
    const h = Number(
      /height="(\d+)"/.exec(readFileSync(path.join(root, 'tickets-by-team.svg'), 'utf8'))?.[1],
    );
    expect(h).toBeGreaterThan(200);
    expect(h).toBeLessThan(320);
  });
});
