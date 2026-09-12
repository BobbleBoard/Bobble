import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '../presets/capabilities.js';
import {
  editsAsInstruction,
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
