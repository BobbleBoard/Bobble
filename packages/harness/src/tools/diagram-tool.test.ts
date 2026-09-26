import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import {
  DIAGRAM_EDIT_TOOL,
  DIAGRAM_SIDECAR_SUFFIX,
  DIAGRAM_SOURCE_SUFFIX,
  DIAGRAM_TOOL,
  diagramSlug,
  looksLikeMermaid,
  registerDiagramTool,
  renderFailure,
  svgPathFor,
  withDirection,
} from './diagram-tool.js';
import type { DiagramRenderReply, DiagramRenderRequest, PresentBridge } from './present.js';
import { buildCli, commandNameFor, pathFor, resolveCli } from './tool-cli.js';

type Exec = (
  id: string,
  p: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: { cwd?: string },
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

const root = mkdtempSync(path.join(tmpdir(), 'diagram-tool-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The §2.2.3 brief, as Mermaid. */
const FLOW = `flowchart LR
  A([Order placed]) --> B{Payment ok?}
  B -- yes --> C[Pick & pack]
  B -- no --> E[Email customer]
  E -. retry .-> B
  C --> D{Quality ok?}
  D -- no, repack --> C
  D -- yes --> F[Ship] --> G[Delivered] --> H([Review request])`;

/** A stand-in for the app's Mermaid window: it records the request and draws a box. */
function fakeRender(overrides: Partial<Extract<DiagramRenderReply, { ok: true }>> = {}) {
  const calls: DiagramRenderRequest[] = [];
  const render = vi.fn(async (req: DiagramRenderRequest): Promise<DiagramRenderReply> => {
    calls.push(req);
    return {
      ok: true,
      source: req.source,
      notes: [],
      kind: 'flowchart',
      nodes: [
        'Order placed',
        'Payment ok?',
        'Pick & pack',
        'Email customer',
        'Quality ok?',
        'Ship',
        'Delivered',
        'Review request',
      ],
      edges: 9,
      labelledEdges: ['yes', 'no', 'retry', 'no, repack', 'yes'],
      failEdges: 3,
      decisions: 2,
      light: {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="${req.themes.light.paper}"/></svg>`,
        width: 10,
        height: 10,
      },
      dark: {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="${req.themes.dark.paper}"/></svg>`,
        width: 10,
        height: 10,
      },
      ...overrides,
    };
  });
  return { render, calls };
}

function rig(
  opts: {
    render?: ReturnType<typeof fakeRender>['render'] | null;
    bridge?: PresentBridge | null;
    settingsKit?: string;
  } = {},
) {
  const tools: Array<Record<string, unknown>> = [];
  registerDiagramTool({ registerTool: (d: never) => tools.push(d) } as never, {
    render: opts.render === undefined ? fakeRender().render : opts.render,
    bridge: opts.bridge ?? null,
    root: () => root,
    ...(opts.settingsKit !== undefined ? { settingsKit: () => opts.settingsKit } : {}),
  });
  const exec = (name: string) => tools.find((t) => t.name === name)?.execute as Exec;
  return { tools, exec };
}

describe('the diagram command, as a person (or a 4B) types it', () => {
  const { tools } = rig();
  const cli = buildCli(
    CAPABILITIES.filter((c) => c.name === 'diagram'),
    tools.map((t) => ({
      name: t.name as string,
      description: t.description as string,
      parameters: t.parameters as never,
    })),
  );

  it('is the diagram capability: `diagram` with no sub-word, and `diagram edit`', () => {
    expect(tools.map((t) => t.name)).toEqual([DIAGRAM_TOOL, DIAGRAM_EDIT_TOOL]);
    expect(CAPABILITIES.find((c) => c.name === 'diagram')?.tools).toEqual([
      DIAGRAM_TOOL,
      DIAGRAM_EDIT_TOOL,
    ]);
    expect(commandNameFor('diagram')).toBe('diagram');
    expect(pathFor('diagram', DIAGRAM_TOOL)).toEqual([]);
    expect(pathFor('diagram', DIAGRAM_EDIT_TOOL)).toEqual(['edit']);
  });

  it('`diagram "Order fulfilment" \'<mermaid>\'` fills the title then the source', () => {
    const r = resolveCli(cli, ['diagram', 'Order fulfilment', FLOW]);
    expect(r).toMatchObject({
      kind: 'call',
      tool: DIAGRAM_TOOL,
      args: { title: 'Order fulfilment', source: FLOW },
    });
  });

  it('reads --mermaid as the source, and an untitled diagram is still a call', () => {
    const r = resolveCli(cli, ['diagram', '--mermaid', 'flowchart TD\\n A --> B']);
    expect(r).toMatchObject({
      kind: 'call',
      tool: DIAGRAM_TOOL,
      args: { source: 'flowchart TD\\n A --> B' },
    });
  });

  /* MEASURED: the 4B's first call in CLI mode — one positional, the Mermaid
     itself — was refused "missing --source" with the whole usage. */
  it('`diagram "<mermaid>"` alone reaches the tool (it reads the Mermaid for itself)', () => {
    const r = resolveCli(cli, ['diagram', FLOW]);
    expect(r).toMatchObject({ kind: 'call', tool: DIAGRAM_TOOL, args: { title: FLOW } });
  });

  it('knows Mermaid from a title', () => {
    expect(looksLikeMermaid(FLOW)).toBe(true);
    expect(looksLikeMermaid('%% the flow\nsequenceDiagram\n  A->>B: hi')).toBe(true);
    expect(looksLikeMermaid('A --> B\nB --> C')).toBe(true);
    expect(looksLikeMermaid('Order fulfilment')).toBe(false);
    expect(looksLikeMermaid('Flowchart of the order process')).toBe(false);
    expect(looksLikeMermaid('Graphs --> meaning')).toBe(false);
    expect(looksLikeMermaid('graph of sales')).toBe(false);
    expect(looksLikeMermaid('flowchart TD\\n  A --> B')).toBe(true);
  });

  it('`diagram edit flow.svg --direction LR` is diagram_edit with the file', () => {
    const r = resolveCli(cli, ['diagram', 'edit', 'flow.svg', '--direction', 'LR']);
    expect(r).toMatchObject({
      kind: 'call',
      tool: DIAGRAM_EDIT_TOOL,
      args: { file: 'flow.svg', direction: 'LR' },
    });
  });
});

describe('diagram', () => {
  it('draws Mermaid that came in the title’s place, untitled, and says so', async () => {
    const { render, calls } = fakeRender();
    const { exec } = rig({ render });
    const r = await exec(DIAGRAM_TOOL)('1', { title: FLOW }, undefined, undefined, {
      cwd: root,
    });
    expect(r.isError).toBeUndefined();
    expect(calls[0]?.source).toBe(FLOW);
    expect(calls[0]?.title).toBeUndefined();
    expect(r.content[0]?.text).toMatch(/Read the Mermaid given in the title’s place as the source/);
  });

  it('draws it, writes the drawing, its source and the card sidecar, and presents the drawing', async () => {
    const { render, calls } = fakeRender();
    const shown: string[] = [];
    const bridge = {
      show: async (req: { path: string }) => {
        shown.push(req.path);
        return { ok: true };
      },
      preview: async () => ({}),
    } as PresentBridge;
    const { exec } = rig({ render, bridge });
    const r = await exec(DIAGRAM_TOOL)(
      '1',
      { title: 'Order fulfilment', source: FLOW },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(r.isError).toBeUndefined();
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(
      /^Drew a flowchart "Order fulfilment" — 8 steps \(2 decisions\), 9 connections, 5 labelled: yes, no, retry, no, repack, yes: order-fulfilment\.svg/,
    );
    expect(text).toContain('It is in the chat as a diagram card');
    expect(text).toContain('Steps: Order placed · Payment ok? ·');
    expect(text).toContain('Kit: Paper & blue (the house default).');
    expect(text).toContain('do not present it again');
    // The kit's two themes went to the renderer.
    expect(calls[0]?.themes.light.paper).toBe('#FBFAF7');
    expect(calls[0]?.themes.dark.paper).toBe('#191816');
    const svg = path.join(root, 'order-fulfilment.svg');
    expect(shown).toEqual([svg]);
    expect(readFileSync(svg, 'utf8')).toContain('#FBFAF7');
    expect(readFileSync(path.join(root, `order-fulfilment${DIAGRAM_SOURCE_SUFFIX}`), 'utf8')).toBe(
      `${FLOW}\n`,
    );
    const side = JSON.parse(
      readFileSync(path.join(root, `order-fulfilment${DIAGRAM_SIDECAR_SUFFIX}`), 'utf8'),
    );
    expect(side).toMatchObject({
      schema: 1,
      title: 'Order fulfilment',
      kind: 'flowchart',
      kit: 'paper-blue',
      look: 'clean',
      edges: 9,
    });
    expect(side.dark.svg).toContain('#191816');
    expect(side.light.paper).toBe('#FBFAF7');
  });

  it('a parse error names the line and the fix, and draws nothing', async () => {
    const render = vi.fn(
      async (): Promise<DiagramRenderReply> => ({
        ok: false,
        error: 'Parse error on line 3:',
        line: 3,
        lineText: 'B -- no --> E[Email (the customer)]',
        hint: 'A label with ( ) [ ] or { } in it needs double quotes: A["Pick (and pack)"].',
      }),
    );
    const { exec } = rig({ render });
    const r = await exec(DIAGRAM_TOOL)('1', {
      title: 'Broken',
      source: 'flowchart TD\n A --> B\n B -- no --> E[Email (the customer)]',
    });
    expect(r.isError).toBe(true);
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('Mermaid could not read line 3: B -- no --> E[Email (the customer)]');
    expect(text).toContain('Fix: A label with ( ) [ ] or { } in it needs double quotes');
    expect(existsSync(path.join(root, 'broken.svg'))).toBe(false);
  });

  it('says what it needs: a source, and the app', async () => {
    expect(
      (await rig().exec(DIAGRAM_TOOL)('1', { title: 'x', source: '  ' })).content[0]?.text,
    ).toMatch(/needs its Mermaid source/);
    expect(
      (await rig({ render: null }).exec(DIAGRAM_TOOL)('1', { title: 'x', source: FLOW })).content[0]
        ?.text,
    ).toMatch(/needs the app/);
  });

  it('never overwrites a different diagram with the same name — the next one is -2', async () => {
    const { exec } = rig();
    await exec(DIAGRAM_TOOL)('1', { title: 'Twin', source: 'flowchart TD\n A --> B' });
    const r = await exec(DIAGRAM_TOOL)('2', { title: 'Twin', source: 'flowchart TD\n A --> C' });
    expect(r.content[0]?.text).toContain('twin-2.svg');
    expect(r.content[0]?.text).toContain('twin.svg already holds a different diagram');
    // The same diagram drawn again keeps its file.
    const again = await exec(DIAGRAM_TOOL)('3', {
      title: 'Twin',
      source: 'flowchart TD\n A --> B',
    });
    expect(again.content[0]?.text).toMatch(/: twin\.svg \(/);
  });

  it('reads its source from a .mmd file the model wrote first', async () => {
    const { render, calls } = fakeRender();
    writeFileSync(path.join(root, 'from-file.mmd'), 'flowchart TD\n  X --> Y\n');
    await rig({ render }).exec(DIAGRAM_TOOL)('1', { title: 'From file', source: 'from-file.mmd' });
    expect(calls[0]?.source).toBe('flowchart TD\n  X --> Y\n');
  });

  it('wears the project’s brand.md, else the Design setting’s kit', async () => {
    const proj = path.join(root, 'branded');
    mkdirSync(path.join(proj, '.bobble'), { recursive: true });
    writeFileSync(
      path.join(proj, '.bobble', 'brand.md'),
      '---\nname: Tidewell\naccent: "#0E7C7B"\n---\n',
    );
    const { render, calls } = fakeRender();
    const tools: Array<Record<string, unknown>> = [];
    registerDiagramTool({ registerTool: (d: never) => tools.push(d) } as never, {
      render,
      bridge: null,
      root: () => proj,
      settingsKit: () => 'fog',
    });
    const r = await (tools[0]?.execute as Exec)('1', { title: 'Brand', source: FLOW });
    expect(r.content[0]?.text).toContain("Kit: Tidewell (the project's brand.md).");
    expect(calls[0]?.themes.light.start.fill).not.toBe('#0E3A37');
    const { render: r2, calls: c2 } = fakeRender();
    const settingTools: Array<Record<string, unknown>> = [];
    registerDiagramTool({ registerTool: (d: never) => settingTools.push(d) } as never, {
      render: r2,
      bridge: null,
      root: () => root,
      settingsKit: () => 'fog',
    });
    const s = await (settingTools[0]?.execute as Exec)('1', { title: 'Setting', source: FLOW });
    expect(s.content[0]?.text).toContain('Kit: Fog.');
    expect(c2[0]?.themes.light.paper).toBe('#FAFAF8');
  });
});

describe('diagram_edit', () => {
  it('turns a flowchart the other way and redraws it in place', async () => {
    const { render, calls } = fakeRender();
    const { exec } = rig({ render });
    await exec(DIAGRAM_TOOL)('1', { title: 'Turn', source: FLOW });
    const r = await exec(DIAGRAM_EDIT_TOOL)('2', { file: 'turn.svg', direction: 'td' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toMatch(/^Changed the direction \(TD\) → a flowchart "Turn"/);
    expect(calls[1]?.source.split('\n')[0]).toBe('flowchart TD');
    expect(
      readFileSync(path.join(root, `turn${DIAGRAM_SOURCE_SUFFIX}`), 'utf8').startsWith(
        'flowchart TD',
      ),
    ).toBe(true);
  });

  it('refuses to change nothing, and a file it did not make', async () => {
    const { exec } = rig();
    await exec(DIAGRAM_TOOL)('1', { title: 'Still', source: FLOW });
    expect((await exec(DIAGRAM_EDIT_TOOL)('2', { file: 'still.svg' })).content[0]?.text).toMatch(
      /changed nothing/,
    );
    writeFileSync(path.join(root, 'stranger.svg'), '<svg/>');
    expect(
      (await exec(DIAGRAM_EDIT_TOOL)('3', { file: 'stranger.svg', title: 'x' })).content[0]?.text,
    ).toMatch(/not a diagram made here/);
  });
});

describe('the pure parts', () => {
  it('names files from the title, and finds the .svg from any of its files', () => {
    expect(diagramSlug('Order fulfilment', 'flowchart')).toBe('order-fulfilment');
    expect(diagramSlug('', 'sequence diagram')).toBe('sequence-diagram');
    expect(svgPathFor('/w', 'flow.diagram.mmd', 'x')).toBe('/w/flow.svg');
    expect(svgPathFor('/w', 'flow.diagram.json', 'x')).toBe('/w/flow.svg');
    expect(svgPathFor('/w', 'docs/flow', 'x')).toBe('/w/docs/flow.svg');
    expect(svgPathFor('/w', undefined, 'x')).toBe('/w/x.svg');
  });

  it('withDirection rewrites only the flowchart line', () => {
    expect(withDirection('flowchart LR\n A --> B', 'TD')).toBe('flowchart TD\n A --> B');
    expect(withDirection('graph\n A --> B', 'lr')).toBe('graph LR\n A --> B');
    expect(() => withDirection('sequenceDiagram\n A->>B: hi', 'TD')).toThrow(/for a flowchart/);
    expect(() => withDirection('flowchart LR', 'sideways')).toThrow(/not TD, LR/);
  });

  it('renderFailure without a line still says what to do', () => {
    expect(
      renderFailure({
        ok: false,
        error: 'boom',
        line: null,
        lineText: null,
        hint: 'Start with the type.',
      }),
    ).toContain('could not read the source');
  });

  it('a failure of the app’s own is not blamed on the source', () => {
    const text = renderFailure({
      ok: false,
      error: 'An object could not be cloned.',
      line: null,
      lineText: null,
      hint: '',
      cause: 'app',
    });
    expect(text).toMatch(/the app could not draw it — the source is not the problem/);
    expect(text).toMatch(/Try the same call once more/);
    expect(text).not.toMatch(/simplify|could not read/);
  });
});
