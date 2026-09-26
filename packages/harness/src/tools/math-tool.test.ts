import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import { looseJson, MATH_TOOL, mathSlug, registerMathTool } from './math-tool.js';
import type { PresentBridge } from './present.js';
import { buildCli, resolveCli } from './tool-cli.js';

type Exec = (
  id: string,
  p: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: { cwd?: string },
) => Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }>;

const root = mkdtempSync(path.join(tmpdir(), 'math-tool-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup(bridge: PresentBridge | null = null, canSeeImages = true) {
  const tools: Array<Record<string, unknown>> = [];
  const pi = { registerTool: (d: never) => tools.push(d) } as never;
  registerMathTool(pi, { bridge, root: () => root, canSeeImages: () => canSeeImages });
  const tool = tools[0] as { name: string; description: string; parameters: never; execute: Exec };
  return { tool, run: (p: unknown) => tool.execute('id', p) };
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === 'text')?.text ?? '';

const GOOD = {
  title: 'Sine and cosine',
  params: ['a = 1 in -3..3'],
  plot: {
    x: '-pi..pi',
    curves: [
      { id: 's', expr: 'sin(x)', label: 'sin x' },
      { id: 'c', expr: 'cos(x)', label: 'cos x' },
    ],
    points: [{ id: 'p', x: 'a', on: 's', label: 'P' }],
  },
  steps: [
    { text: 'The {s} starts at zero.', highlight: ['s'], set: { a: 0 } },
    { text: 'The {c} is the same wave, a quarter turn ahead.', highlight: ['c'] },
  ],
};

describe('the math command, as a person types it', () => {
  const { tool } = setup();
  const spec = CAPABILITIES.find((c) => c.name === 'math');
  const cli = buildCli(spec === undefined ? [] : [spec], [
    { name: tool.name, description: tool.description, parameters: tool.parameters },
  ]);

  it('is the math capability, one command: `math`', () => {
    expect(tool.name).toBe(MATH_TOOL);
    expect(spec?.tools).toEqual([MATH_TOOL]);
  });

  it("`math lesson.math.json` and `math '{…}'` both fill the spec", () => {
    const a = resolveCli(cli, ['math', 'lesson.math.json']);
    expect(a).toMatchObject({ kind: 'call' });
    expect(a.kind === 'call' && a.tool).toBe(MATH_TOOL);
    expect(a.kind === 'call' && a.args).toMatchObject({ spec: 'lesson.math.json' });
    const b = resolveCli(cli, ['math', '{"title":"x"}']);
    expect(b.kind === 'call' && b.args).toMatchObject({ spec: '{"title":"x"}' });
  });
});

describe('drawing', () => {
  it('draws inline JSON into a page and writes the spec beside it', async () => {
    const { run } = setup();
    const r = await run({ spec: JSON.stringify(GOOD) });
    expect(r.isError).toBeUndefined();
    const page = path.join(root, 'sine-and-cosine.html');
    const specFile = path.join(root, 'sine-and-cosine.math.json');
    expect(existsSync(page)).toBe(true);
    expect(JSON.parse(readFileSync(specFile, 'utf8'))).toEqual(GOOD);
    expect(text(r)).toMatch(
      /^Drew "Sine and cosine": sine-and-cosine\.html — a plot of 2 curves, slider a, 2 steps\. The spec is sine-and-cosine\.math\.json\./,
    );
    expect(text(r)).toContain('Checks — clear');
    expect(text(r)).toContain('do not repeat them in the chat');
  });

  it('draws a spec file where it is, and leaves the file as written', async () => {
    const { run } = setup();
    const file = path.join(root, 'lessons', 'waves.math.json');
    rmSync(path.dirname(file), { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(file), { recursive: true });
    const written = `${JSON.stringify(GOOD, null, 1)}\n`;
    writeFileSync(file, written);
    const r = await run({ spec: 'lessons/waves.math.json' });
    expect(text(r)).toMatch(/lessons\/waves\.html/);
    expect(existsSync(path.join(root, 'lessons', 'waves.html'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(written);
    // Named without its extension, or by its page: the same spec.
    expect(text(await run({ spec: 'lessons/waves' }))).toMatch(/lessons\/waves\.html/);
    expect(text(await run({ spec: 'lessons/waves.html' }))).toMatch(/lessons\/waves\.html/);
  });

  it('puts the parts passed as flags together', async () => {
    const { run } = setup();
    const r = await run({
      title: 'Flags',
      plot: JSON.stringify(GOOD.plot),
      params: JSON.stringify(GOOD.params),
      steps: JSON.stringify(GOOD.steps),
    });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Drew "Flags": flags\.html/);
  });

  it('hands the checks back with the command that draws it again, and says so when nothing changed', async () => {
    const { run } = setup();
    const off = {
      ...GOOD,
      title: 'Off the plot',
      plot: { ...GOOD.plot, points: [{ id: 'q', x: 9, y: 0, label: 'Q' }] },
    };
    const r = await run({ spec: JSON.stringify(off) });
    expect(text(r)).toMatch(/Checks — 1 to fix:\n- q at \(9, 0\) is outside the plot/);
    expect(text(r)).toContain(
      'Fix it in off-the-plot.math.json and run `math off-the-plot.math.json` again.',
    );
    const again = await run({ spec: 'off-the-plot.math.json' });
    expect(text(again)).toContain('That is the same spec as last time, so nothing changed');
  });

  it('says what cannot be drawn, and where to fix it', async () => {
    const { run } = setup();
    const bad = await run({ spec: '{"title": "x", "plot": {"curves": ["sin(x"]}}' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^math: curve 1 "sin\(x"/);
    const notJson = await run({ spec: '{"title": "x", plot: }' });
    expect(text(notJson)).toMatch(/not valid JSON .*write it to a file/);
    const missing = await run({ spec: 'nowhere.math.json' });
    expect(text(missing)).toMatch(
      /there is no file at nowhere\.math\.json\. Write the spec there first/,
    );
    expect(text(await run({}))).toMatch(/math needs its spec/);
  });
});

describe('showing', () => {
  const bridge = () => ({
    show: vi.fn(async () => ({ ok: true })),
    preview: vi.fn(async () => ({ imageBase64: 'iVBOR', mimeType: 'image/png' })),
  });

  it('opens the page in the canvas and hands the model its capture', async () => {
    const b = bridge();
    const { run } = setup(b);
    const r = await run({ spec: JSON.stringify({ ...GOOD, title: 'Shown' }) });
    expect(b.show).toHaveBeenCalledWith({ path: path.join(root, 'shown.html'), note: 'Shown' });
    expect(b.preview).toHaveBeenCalledWith({ path: path.join(root, 'shown.html'), kind: 'render' });
    expect(r.content.find((c) => c.type === 'image')?.data).toBe('iVBOR');
    expect(text(r)).toContain('It is open in the canvas beside the chat.');
  });

  it('sends no capture to a model that cannot see one', async () => {
    const b = bridge();
    const { run } = setup(b, false);
    const r = await run({ spec: JSON.stringify({ ...GOOD, title: 'Blind' }) });
    expect(b.preview).not.toHaveBeenCalled();
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
  });
});

describe('small things', () => {
  it('reads JSON the way a model pastes it', () => {
    expect(looseJson('```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
  });
  it('names the files after the title', () => {
    expect(mathSlug('Why $\\sin$ x is Cos x!')).toBe('why-x-is-cos-x');
  });
});

describe('a spec file with TeX typed the way a model types it', () => {
  it('draws — `\\frac` in the file is a fraction, not a form feed', async () => {
    const { run } = setup();
    const file = path.join(root, 'tex.math.json');
    writeFileSync(
      file,
      String.raw`{"title": "TeX", "plot": {"x": "0..1", "curves": [{"id": "f", "expr": "\sqrt{x}"}]}, "steps": [{"text": "It is $\frac{1}{2}$ at a quarter.", "highlight": ["f"]}, {"text": "Then \theta.", "highlight": ["f"]}]}`,
    );
    const r = await run({ spec: 'tex.math.json' });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(path.join(root, 'tex.html'), 'utf8')).toContain('class="mfrac"');
  });
});

describe('the title typed where the spec goes', () => {
  it('is the title when the rest came as flags, and said so when nothing did', async () => {
    const { run } = setup();
    const r = await run({
      spec: 'Titled by position',
      plot: JSON.stringify(GOOD.plot),
      params: JSON.stringify(GOOD.params),
      steps: JSON.stringify(GOOD.steps),
    });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Drew "Titled by position": titled-by-position\.html/);
    const bare = await run({ spec: 'Simple harmonic motion' });
    expect(text(bare)).toMatch(/reads as a title, not a spec/);
  });
});

describe('a spec just written', () => {
  it('is drawn there and then — the page, the controls it has, and what to fix', async () => {
    const { drawWrittenSpec } = await import('./math-tool.js');
    const deps = { bridge: null, root: () => root };
    const good = path.join(root, 'written.math.json');
    writeFileSync(good, JSON.stringify({ ...GOOD, title: 'Written' }));
    const r = await drawWrittenSpec(good, root, deps);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^Drew "Written": written\.html/);
    expect(text(r)).toContain(
      'On the page: Back and Next through its 2 steps; a slider for a, with Play.',
    );
    expect(existsSync(path.join(root, 'written.html'))).toBe(true);
    const bad = path.join(root, 'bad.math.json');
    writeFileSync(bad, '{"title": "Bad", "steps": []}');
    const b = await drawWrittenSpec(bad, root, deps);
    expect(b.isError).toBe(true);
    expect(text(b)).toMatch(/needs a "plot".*Something that moves.*Fix it in bad\.math\.json/s);
  });

  it('says so when nothing on the page moves, so the reply does not offer sliders', async () => {
    const { run } = setup();
    const still = {
      title: 'Still',
      plot: { x: '0..5', curves: ['sin(x)'] },
      steps: [
        { text: 'A sine.', highlight: ['c1'] },
        { text: 'Still a sine.', highlight: ['c1'] },
      ],
    };
    const r = await run({ spec: JSON.stringify(still) });
    expect(text(r)).toContain(
      'On the page: Back and Next through its 2 steps. Nothing on it moves — it has no sliders.',
    );
    expect(text(r)).toContain('with the controls it has, above, and no others');
  });

  it('is found by `@path`, and by a path that repeats the folder’s own name', async () => {
    const { run } = setup();
    writeFileSync(path.join(root, 'at.math.json'), JSON.stringify({ ...GOOD, title: 'At' }));
    expect(text(await run({ spec: '@at.math.json' }))).toMatch(/^Drew "At"/);
    expect(text(await run({ spec: `${path.basename(root)}/at.math.json` }))).toMatch(/^Drew "At"/);
  });
});
