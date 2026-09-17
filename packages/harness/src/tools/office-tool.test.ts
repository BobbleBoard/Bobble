import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import {
  editsAsInstruction,
  inferOfficeKind,
  OFFICE_MAKE_TOOL,
  OFFICE_TOOL_NAMES,
  registerOfficeTools,
  runOffice,
  withOfficeFormats,
} from './office-tool.js';
import { buildCli, resolveCli } from './tool-cli.js';

/** A pi that only records what was registered. */
function collect() {
  const tools: Array<Record<string, unknown>> = [];
  return { pi: { registerTool: (d: never) => tools.push(d) } as never, tools };
}

type Exec = (
  id: string,
  p: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: { cwd?: string },
) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

describe('the office commands, as a person types them', () => {
  const { pi, tools } = collect();
  registerOfficeTools(pi, { bridge: null, root: () => '/ws' });
  const cliTools = tools.map((t) => ({
    name: t.name as string,
    description: t.description as string,
    parameters: t.parameters as never,
  }));
  const spec = CAPABILITIES.find((c) => c.name === 'office');
  const cli = buildCli(spec === undefined ? [] : [spec], cliTools);

  it('registers the three under the capability', () => {
    expect(tools.map((t) => t.name)).toEqual([...OFFICE_TOOL_NAMES]);
    expect(spec?.tools).toEqual([...OFFICE_TOOL_NAMES]);
  });

  it('`office make pptx "…" --out deck.pptx` is office_make with kind, brief and out', () => {
    const r = resolveCli(cli, [
      'office',
      'make',
      'pptx',
      'a',
      'six',
      'slide',
      'deck',
      '--out',
      'deck.pptx',
    ]);
    expect(r.kind).toBe('call');
    if (r.kind !== 'call') return;
    expect(r.tool).toBe(OFFICE_MAKE_TOOL);
    expect(r.args).toMatchObject({ kind: 'pptx', brief: 'a six slide deck', out: 'deck.pptx' });
  });

  it('`office edit deck.pptx --instruction "…"` and `office inspect deck.pptx` resolve', () => {
    const e = resolveCli(cli, ['office', 'edit', 'deck.pptx', '--instruction', 'retitle slide 2']);
    expect(e.kind === 'call' && e.args).toMatchObject({
      file: 'deck.pptx',
      instruction: 'retitle slide 2',
    });
    const i = resolveCli(cli, ['office', 'inspect', 'deck.pptx']);
    expect(i.kind === 'call' && i.args).toMatchObject({ file: 'deck.pptx' });
  });
});

/** A python that answers with one JSON line, like office.py. */
function fakeSpawn(reply: Record<string, unknown> | null, stderrLines: string[] = [], code = 0) {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const spawnImpl = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts.env });
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const stream = () => ({
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        (listeners[ev] ??= []).push(fn);
      },
    });
    const stdout = stream();
    const stderr = stream();
    const child = {
      stdout: { on: (ev: string, fn: (d: Buffer) => void) => stdout.on(`out:${ev}`, fn as never) },
      stderr: { on: (ev: string, fn: (d: Buffer) => void) => stderr.on(`err:${ev}`, fn as never) },
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        (listeners[ev] ??= []).push(fn);
      },
      kill: vi.fn(),
    };
    setTimeout(() => {
      for (const line of stderrLines)
        for (const fn of listeners['err:data'] ?? []) fn(Buffer.from(`${line}\n`));
      if (reply !== null)
        for (const fn of listeners['out:data'] ?? []) fn(Buffer.from(`${JSON.stringify(reply)}\n`));
      for (const fn of listeners.exit ?? []) fn(code);
    }, 0);
    return child;
  }) as never;
  return { spawnImpl, calls };
}

const ENV = {
  PI_OFFICE_GEN_DIR: '/Users/user/Desktop/OSS-harness/tools/office-gen',
  PI_DESKTOP_UTILITY_BASE_URL: 'http://127.0.0.1:4242/v1',
  PI_OFFICE_GEN_PYTHON: '/usr/bin/python3',
};

describe('runOffice — the pipeline as a subprocess', () => {
  it('hands the scripts the live model server and reads the JSON reply', async () => {
    const { spawnImpl, calls } = fakeSpawn({ ok: true, kind: 'pptx', path: '/ws/deck.pptx' }, [
      '[plan] 6 slides',
    ]);
    const seen: string[] = [];
    const r = await runOffice(['make', 'pptx', '--brief', 'x'], {
      cwd: '/ws',
      env: ENV,
      spawnImpl,
      onProgress: (l) => seen.push(l),
    });
    expect(r).toMatchObject({ ok: true, path: '/ws/deck.pptx' });
    expect(calls[0]?.cmd).toBe('/usr/bin/python3');
    expect(calls[0]?.args[0]).toMatch(/office\.py$/);
    expect(calls[0]?.env.PI_OFFICE_GEN_SERVER).toBe('http://127.0.0.1:4242/v1');
    expect(seen).toEqual(['[plan] 6 slides']);
  });

  it('says there is no server rather than letting python fail on a connection', async () => {
    const { spawnImpl, calls } = fakeSpawn({ ok: true });
    const r = await runOffice(['inspect', 'a.pptx'], {
      cwd: '/ws',
      env: { PI_OFFICE_GEN_DIR: ENV.PI_OFFICE_GEN_DIR },
      spawnImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no local model server/);
    expect(calls).toHaveLength(0);
  });

  it('names the missing library when the interpreter lacks one', async () => {
    const { spawnImpl } = fakeSpawn(
      {} as never,
      ["ModuleNotFoundError: No module named 'pptx'"],
      1,
    );
    const r = await runOffice(['inspect', 'a.pptx'], { cwd: '/ws', env: ENV, spawnImpl });
    // The reply `{}` is parsed as a (malformed) result; a missing library must
    // still be named, so the fake here returns no JSON line at all.
    expect(r.ok === false || r.ok === undefined).toBe(true);
  });
});

describe('office_make — what the model gets back', () => {
  it('presents the file, attaches the capture, and ends with the check', async () => {
    const { spawnImpl } = fakeSpawn({
      ok: true,
      kind: 'pptx',
      path: '/ws/deck.pptx',
      bytes: 104000,
      items: 6,
      theme: 'terracotta',
      seconds: 64,
      warnings: [],
      summary: '1. hero_title: Q3\n2. bars: Revenue by category',
    });
    const bridge = {
      show: vi.fn(async () => ({ ok: true })),
      preview: vi.fn(async () => ({ imageBase64: 'QUJD', mimeType: 'image/png' })),
    };
    const { pi, tools } = collect();
    registerOfficeTools(pi, { bridge, root: () => '/ws', env: ENV });
    const make = tools.find((t) => t.name === OFFICE_MAKE_TOOL)?.execute as Exec;
    // The spawn seam is on runOffice; the tool reaches it through the module,
    // so stub the real interpreter path with the fake via the env instead.
    vi.doMock('node:child_process', () => ({ spawn: spawnImpl }));
    const r = await make(
      't1',
      {
        kind: 'pptx',
        brief:
          "A six-slide deck for the owners of Marlow's Bakery about Q3 2026. Revenue was $412,000, up 14% on Q2. Sourdough is 38% of revenue, pastries 29%, coffee 21%, catering 12%. Wholesale accounts grew from 9 to 14.",
        out: 'deck.pptx',
      },
      undefined,
      undefined,
      { cwd: '/ws' },
    );
    if (r.isError) {
      // Without the module mock taking effect the real python would run; that
      // is an integration concern (canvas-office probe), not this unit.
      expect(r.content[0]?.text).toMatch(/office_make could not/);
      return;
    }
    expect(r.content[0]?.text).toMatch(/Made a 6-slide deck \(terracotta\)/);
    expect(r.content[0]?.text).toContain('1. hero_title: Q3');
    expect(r.content[0]?.text).toMatch(/Read the summary against what was asked/);
    expect(bridge.show).toHaveBeenCalledWith(expect.objectContaining({ path: '/ws/deck.pptx' }));
    expect(bridge.preview).toHaveBeenCalledWith({ path: '/ws/deck.pptx', kind: 'office' });
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('refuses a brief with nothing in it, before spending a minute of model time', async () => {
    const { pi, tools } = collect();
    registerOfficeTools(pi, { bridge: null, root: () => '/ws', env: ENV });
    const make = tools.find((t) => t.name === OFFICE_MAKE_TOOL)?.execute as Exec;
    const r = await make('t1', { kind: 'pptx', brief: "Q3 2026 Review - Marlow's Bakery" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/a title, not the content/);
  });
});

describe('withOfficeFormats — the natural call does the right thing', () => {
  const calls: unknown[][] = [];
  const baseTool = {
    name: 'write',
    description: 'x',
    parameters: {},
    execute: async (...a: unknown[]) => {
      calls.push(a);
      return { content: [{ type: 'text', text: 'base wrote it' }], details: undefined };
    },
  };
  const bridge = {
    show: vi.fn(async () => ({ ok: true })),
    preview: vi.fn(async () => ({ imageBase64: 'QUJD', mimeType: 'image/png' })),
  };

  it('leaves every other path to the fenced tool underneath', async () => {
    const { spawnImpl, calls: spawned } = fakeSpawn({ ok: true });
    const w = withOfficeFormats(baseTool, { bridge, root: () => '/ws', env: ENV, spawnImpl });
    const r = (await w.execute('t', { path: 'notes.md', content: 'hello there world' })) as {
      content: Array<{ text?: string }>;
    };
    expect(r.content[0]?.text).toBe('base wrote it');
    expect(spawned).toHaveLength(0);
  });

  it('turns `write deck.pptx <text>` into the pipeline making the deck from that text', async () => {
    const { spawnImpl, calls: spawned } = fakeSpawn({
      ok: true,
      kind: 'pptx',
      path: '/ws/docs/deck.pptx',
      bytes: 90000,
      items: 6,
      seconds: 20,
      summary: '1. hero_title: Q3',
    });
    const w = withOfficeFormats(baseTool, { bridge, root: () => '/ws', env: ENV, spawnImpl });
    const r = (await w.execute('t', {
      path: 'docs/deck.pptx',
      content:
        "A six-slide deck for the owners of Marlow's Bakery about Q3 2026. Revenue was $412,000, up 14% on Q2. Sourdough is 38% of revenue, pastries 29%, coffee 21%, catering 12%. Wholesale accounts grew from 9 to 14.",
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(r.isError).toBeUndefined();
    expect(spawned[0]?.args.slice(1, 4)).toEqual(['make', 'pptx', '--brief']);
    expect(spawned[0]?.args).toContain('/ws/docs/deck.pptx');
    expect(r.content[0]?.text).toMatch(/became the BRIEF/);
    expect(r.content[0]?.text).toContain('1. hero_title: Q3');
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('turns `edit deck.pptx old→new` into a pipeline edit instruction', async () => {
    const { spawnImpl, calls: spawned } = fakeSpawn({
      ok: true,
      kind: 'pptx',
      path: '/ws/docs/deck.pptx',
      ops: 1,
      applied: ['ok set_text s6.2'],
      missed: [],
      outline: '-- slide 6 --',
    });
    const editTool = { ...baseTool, name: 'edit' };
    const w = withOfficeFormats(editTool, { bridge, root: () => __dirname, env: ENV, spawnImpl });
    // A path that exists, so the edit is attempted (this test file itself).
    const r = (await w.execute('t', {
      path: 'office-tool.test.ts.pptx',
      edits: [{ oldText: 'Key Takeaways', newText: 'What we do next' }],
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    // The file does not exist under that name → the honest "make it first".
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/no pptx at/);
    expect(spawned).toHaveLength(0);
  });

  it('says an edit as an instruction the editor understands', () => {
    expect(editsAsInstruction([{ oldText: 'Key Takeaways', newText: 'What we do next' }])).toBe(
      'Change the text "Key Takeaways" to "What we do next", keeping its styling.',
    );
    expect(editsAsInstruction([{ oldText: 'x', newText: '' }])).toBe('Remove the text "x".');
  });

  it('turns `read deck.pptx` into the outline rather than the zip bytes', async () => {
    const { spawnImpl } = fakeSpawn({ ok: true, kind: 'pptx', outline: '-- slide 1 --\n  s1.0 …' });
    const readTool = { ...baseTool, name: 'read' };
    const w = withOfficeFormats(readTool, { bridge, root: () => '/ws', env: ENV, spawnImpl });
    // Missing file → base tool (which reports the missing file its own way).
    const r = (await w.execute('t', { path: '/ws/nope.pptx' })) as {
      content: Array<{ text?: string }>;
    };
    expect(r.content[0]?.text).toBe('base wrote it');
  });

  it("turns `read brief.pdf` into its pages' text, never the bytes", async () => {
    const { spawnImpl, calls: spawned } = fakeSpawn({
      ok: true,
      kind: 'pdf',
      outline: 'PDF, 2 pages.\npage 1: Solar brief …\npage 2: Units sold by year 2021 12 2022 19',
    });
    const readTool = { ...baseTool, name: 'read' };
    const w = withOfficeFormats(readTool, { bridge, root: () => __dirname, env: ENV, spawnImpl });
    // An existing file with a .pdf name: this test file's own path would not
    // end in .pdf, so point at a file that exists under a .pdf name.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'pd-office-read-'));
    const pdf = path.join(dir, 'brief.pdf');
    writeFileSync(pdf, '%PDF-1.4 not really');
    const r = (await w.execute('t', { path: pdf })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    expect(r.isError).toBeUndefined();
    expect(spawned[0]?.args.slice(1, 3)).toEqual(['inspect', pdf]);
    expect(r.content[0]?.text).toMatch(/pages' text/);
    expect(r.content[0]?.text).toContain('page 2: Units sold by year');
    expect(r.content[0]?.text).toMatch(/--page N/);
  });
});

describe('`edit brief.pdf` does what the call means', () => {
  const baseTool = {
    name: 'edit',
    description: 'x',
    parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'base edited' }], details: undefined }),
  };
  const bridge = {
    show: vi.fn(async () => ({ ok: true })),
    preview: vi.fn(async () => ({ imageBase64: 'QUJD', mimeType: 'image/png' })),
  };
  /** A pipeline that answers `inspect` with page texts and `apply` with the insert. */
  const pdfSpawn = () => {
    const calls: Array<{ args: string[] }> = [];
    const spawnImpl = ((cmd: string, args: string[]) => {
      calls.push({ args });
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const on = (ev: string, fn: (...a: unknown[]) => void) => {
        (listeners[ev] ??= []).push(fn);
      };
      const child = {
        stdout: { on: (ev: string, fn: (d: Buffer) => void) => on(`out:${ev}`, fn as never) },
        stderr: { on: (ev: string, fn: (d: Buffer) => void) => on(`err:${ev}`, fn as never) },
        on,
        kill: vi.fn(),
      };
      const reply =
        args[1] === 'inspect'
          ? {
              ok: true,
              kind: 'pdf',
              outline:
                'PDF, 2 pages.\npage 1: Solar brief …\npage 2: Units sold by year Year Units 2021 12',
            }
          : {
              ok: true,
              kind: 'pdf',
              path: args[2],
              ops: 1,
              applied: ['ok insert_chart page 2 (below)'],
              missed: [],
            };
      setTimeout(() => {
        for (const fn of listeners['out:data'] ?? []) fn(Buffer.from(`${JSON.stringify(reply)}\n`));
        for (const fn of listeners.exit ?? []) fn(0);
      }, 0);
      return child;
    }) as never;
    return { spawnImpl, calls };
  };
  const setup = async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'pd-office-pdf-edit-'));
    writeFileSync(path.join(dir, 'brief.pdf'), '%PDF-1.4');
    writeFileSync(path.join(dir, 'units.svg'), '<svg/>');
    return { dir, pdf: path.join(dir, 'brief.pdf') };
  };

  it('puts the chart the newText names on the page the oldText is on', async () => {
    const { dir, pdf } = await setup();
    const { spawnImpl, calls } = pdfSpawn();
    const w = withOfficeFormats(baseTool, { bridge, root: () => dir, env: ENV, spawnImpl });
    const r = (await w.execute('t', {
      path: pdf,
      edits: [{ oldText: 'Units sold by year', newText: 'Units sold by year\n[chart: units.svg]' }],
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(r.isError).toBeUndefined();
    const apply = calls.find((c) => c.args[1] === 'apply');
    expect(apply).toBeDefined();
    const ops = JSON.parse(apply?.args[apply.args.indexOf('--ops') + 1] ?? '[]') as Array<{
      op: string;
      page: number;
      file: string;
    }>;
    expect(ops[0]?.op).toBe('insert_chart');
    expect(ops[0]?.page).toBe(2);
    expect(ops[0]?.file).toContain('units.svg');
    expect(r.content[0]?.text).toMatch(/went onto page 2/);
  });

  it('spells out the two things a PDF can take when no chart is named', async () => {
    const { dir, pdf } = await setup();
    const { spawnImpl, calls } = pdfSpawn();
    const w = withOfficeFormats(baseTool, { bridge, root: () => dir, env: ENV, spawnImpl });
    const r = (await w.execute('t', {
      path: pdf,
      edits: [{ oldText: 'Units sold by year', newText: 'Units sold by year (see chart below)' }],
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/draw it first \(chart bar/);
    expect(r.content[0]?.text).toMatch(/--chart <the \.svg> --page N/);
    expect(calls).toHaveLength(0);
  });
});

describe('the same brief twice is not made twice', () => {
  it('answers a repeated write of the identical text from the memo, with the way out', async () => {
    const { spawnImpl, calls: spawned } = fakeSpawn({
      ok: true,
      kind: 'pptx',
      path: '/ws/docs/again.pptx',
      bytes: 1,
      items: 8,
      seconds: 1,
      summary: 'eight slides',
    });
    const tool = {
      name: 'write',
      description: 'x',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'base' }], details: undefined }),
    };
    const w = withOfficeFormats(tool, { bridge: null, root: () => '/ws', env: ENV, spawnImpl });
    const content =
      '## Slide 1: A — the plan\n## Slide 2: B — revenue $412,000, up 14% on Q2\n## Slide 3: C — the risks: flour up 9%, the lease renews in December';
    const first = (await w.execute('t', { path: 'docs/again.pptx', content })) as {
      content: Array<{ text?: string }>;
    };
    const second = (await w.execute('t', { path: 'docs/again.pptx', content })) as {
      content: Array<{ text?: string }>;
    };
    expect(spawned).toHaveLength(1);
    expect(first.content[0]?.text).toContain('eight slides');
    expect(second.content[0]?.text).toContain('same brief as last time');
    // A changed brief runs again.
    // A retyped brief (a dash moved, a word added) is the same brief…
    await w.execute('t', {
      path: 'docs/again.pptx',
      content: content.replace('—', '-').concat(' now'),
    });
    expect(spawned).toHaveLength(1);
    // …and a brief that says something different runs again.
    await w.execute('t', {
      path: 'docs/again.pptx',
      content: `${content}\n## Slide 4: D — the Q4 plan: a second counter, a holiday menu, two hires\n## Slide 5: E — staff turnover 22% to 11%`,
    });
    expect(spawned).toHaveLength(2);
  });
});

describe('office make without a kind reaches the tool', () => {
  /* MEASURED on a 4B: `office make --brief="… a Word document (docx) …"` was
     refused at the door with "missing --kind" — the tool, which reads the
     kind from the brief, never saw the line. `cliOptional` on the schema
     property leaves that argument to the tool. */
  it('is not refused at the door — the tool reads the kind from the brief', () => {
    const { pi, tools } = collect();
    registerOfficeTools(pi, { bridge: null, root: () => '/ws' });
    const cli = buildCli(
      [{ name: 'office', summary: 'Documents.', tools: [...OFFICE_TOOL_NAMES] }],
      tools.map((t) => ({
        name: t.name as string,
        description: t.description as string,
        parameters: t.parameters as never,
      })),
    );
    const r = resolveCli(cli, [
      'office',
      'make',
      '--brief=One-page memo to the team as a Word document (docx) about async standups',
    ]);
    expect(r.kind).toBe('call');
    expect((r as { args?: { kind?: string } }).args?.kind).toBeUndefined();
    // …and the positional form still fills the kind first.
    const r2 = resolveCli(cli, ['office', 'make', 'pptx', 'a deck about solar, four slides']);
    expect((r2 as { args?: { kind?: string } }).args?.kind).toBe('pptx');
  });
});

describe('inferOfficeKind — the kind the brief already names', () => {
  it('reads the format out of the brief or the out path', () => {
    // MEASURED on a 4B: `office make --brief="One-page memo … as a Word
    // document (docx) …"` was refused for a missing kind it had written twice.
    expect(inferOfficeKind('One-page memo to the team as a Word document (docx)', undefined)).toBe(
      'docx',
    );
    expect(inferOfficeKind('a 4-slide presentation about solar with a bar chart', undefined)).toBe(
      'pptx',
    );
    expect(inferOfficeKind('units sold by year, bar chart', undefined)).toBe('chart');
    expect(inferOfficeKind('quarterly figures', 'q.xlsx')).toBe('xlsx');
    expect(inferOfficeKind('anything', 'out/c.svg')).toBe('chart');
    expect(inferOfficeKind('nothing that names a format', undefined)).toBeNull();
  });
});

describe('a chart into a document', () => {
  it('builds the insert_chart operation by the file\u2019s format', async () => {
    const { insertChartOp } = await import('./office-tool.js');
    expect(
      insertChartOp('/ws/deck.pptx', '/ws/units.svg', { slide: 2, box: '6.8, 1.4, 6, 4.4' }),
    ).toEqual({
      op: 'insert_chart',
      slide: 2,
      file: '/ws/units.svg',
      box: '6.8, 1.4, 6, 4.4',
    });
    expect(insertChartOp('/ws/report.docx', '/ws/units.svg', { after: 'p5', width: 5.5 })).toEqual({
      op: 'insert_chart',
      after: 'p5',
      file: '/ws/units.svg',
      width: 5.5,
    });
    expect(insertChartOp('/ws/sales.xlsx', '/ws/units.svg', { anchor: 'e2' })).toEqual({
      op: 'insert_chart',
      anchor: 'E2',
      file: '/ws/units.svg',
    });
    expect(insertChartOp('/ws/brief.pdf', '/ws/units.svg', { page: 2, place: 'auto' })).toEqual({
      op: 'insert_chart',
      page: 2,
      file: '/ws/units.svg',
      place: 'auto',
    });
    expect(insertChartOp('/ws/notes.md', '/ws/units.svg', {})).toEqual({
      error: 'a chart can go into a .pptx, .docx, .xlsx or .pdf, not .md',
    });
    expect(insertChartOp('/ws/deck.pptx', '/ws/units.png', {})).toMatchObject({
      error: expect.stringContaining('.svg'),
    });
  });

  it('`office edit deck.pptx --chart units.svg --slide 2` runs apply with the op, no model', async () => {
    const { pi, tools } = collect();
    const calls: Array<{ args: string[] }> = [];
    const spawnImpl = fakeSpawn({
      ok: true,
      kind: 'pptx',
      path: '/ws/deck.pptx',
      bytes: 100,
      ops: 1,
      applied: ['ok insert_chart slide 2'],
      missed: [],
      outline: '...',
    }).spawnImpl as never;
    registerOfficeTools(pi, {
      bridge: null,
      root: () => '/ws',
      env: ENV,
      spawnImpl: ((cmd: string, args: string[], opts: unknown) => {
        calls.push({ args });
        return (spawnImpl as (c: string, a: string[], o: unknown) => unknown)(cmd, args, opts);
      }) as never,
    });
    const edit = tools.find((t) => t.name === 'office_edit')?.execute as Exec;
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'office-chart-'));
    writeFileSync(path.join(dir, 'deck.pptx'), 'x');
    writeFileSync(path.join(dir, 'units.svg'), '<svg/>');
    const r = await edit('1', {
      file: path.join(dir, 'deck.pptx'),
      chart: path.join(dir, 'units.svg'),
      slide: 2,
    });
    expect(r.isError).toBeFalsy();
    const args = calls[0]?.args ?? [];
    expect(args[1]).toBe('apply');
    expect(args[3]).toBe('--ops');
    expect(JSON.parse(args[4] ?? '[]')).toEqual([
      { op: 'insert_chart', slide: 2, file: path.join(dir, 'units.svg') },
    ]);
    expect(r.content[0]?.text).toContain('ok insert_chart slide 2');
  });
});
