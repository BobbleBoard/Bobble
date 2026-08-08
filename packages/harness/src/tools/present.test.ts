import { describe, expect, it, vi } from 'vitest';
import {
  entryPointIn,
  extensionOf,
  PRESENT_TOOL_NAME,
  previewPlanFor,
  registerPresentTool,
  reviewInstruction,
} from './present.js';

describe('previewPlanFor', () => {
  const file = (path: string) => previewPlanFor({ path, isDirectory: false });

  it('shows an image as an image', () => {
    expect(file('/a/logo.png').kind).toBe('image');
    expect(file('/a/shot.JPEG').kind).toBe('image');
  });

  it('renders a page rather than describing it', () => {
    expect(file('/a/index.html').kind).toBe('render');
  });

  it('runs a script, because output is the only proof it works', () => {
    expect(file('/a/build.py').kind).toBe('run');
    expect(file('/a/x.sh').kind).toBe('run');
  });

  it('reads text formats back', () => {
    expect(file('/a/README.md').kind).toBe('text');
    expect(file('/a/player.gd').kind).toBe('text');
    expect(file('/a/LICENSE').kind).toBe('text');
  });

  /* A folder is where "it exists" is most easily mistaken for "it works" — the
   * Godot run wrote 14 files and opened none of them. */
  it('treats a folder as a project', () => {
    expect(previewPlanFor({ path: '/a/game', isDirectory: true }).kind).toBe('project');
  });

  it('is honest when it cannot preview something', () => {
    const p = file('/a/thing.bin');
    expect(p.kind).toBe('describe');
    expect(p.because).toContain('.bin');
  });
});

describe('extensionOf', () => {
  it('ignores dots in directories and dotfiles', () => {
    expect(extensionOf('/a.b/c/file')).toBe('');
    expect(extensionOf('/a/.gitignore')).toBe('');
    expect(extensionOf('/a/x.tar.gz')).toBe('.gz');
  });
});

describe('entryPointIn', () => {
  it('names a Godot project by its project file', () => {
    expect(entryPointIn(['scripts', 'project.godot', 'icon.svg'])).toBe('project.godot');
  });

  it('returns undefined when nothing is recognisable', () => {
    expect(entryPointIn(['a.txt', 'b.txt'])).toBeUndefined();
  });
});

describe('registerPresentTool', () => {
  const collect = () => {
    const tools: Array<Record<string, unknown>> = [];
    return { pi: { registerTool: (d: never) => tools.push(d) } as never, tools };
  };

  const bridge = {
    show: vi.fn(async () => ({ ok: true })),
    preview: vi.fn(async () => ({ imageBase64: 'QUJD', mimeType: 'image/png' })),
  };

  it('registers under the agreed name', () => {
    const { pi, tools } = collect();
    registerPresentTool(pi, { bridge, stat: async () => ({ isDirectory: false }) });
    expect(tools[0]?.name).toBe(PRESENT_TOOL_NAME);
  });

  const run = async (path: string, stat: () => Promise<{ isDirectory: boolean } | null>) => {
    const { pi, tools } = collect();
    registerPresentTool(pi, { bridge, stat });
    const exec = tools[0]?.execute as (
      id: string,
      p: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
    return exec('t1', { path });
  };

  it('returns the artefact as an image the model can see', async () => {
    const r = await run('/a/logo.png', async () => ({ isDirectory: false }));
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
  });

  /* The whole point: presenting cannot be a way to finish without looking. */
  it('always ends by demanding the model judge it as the user', async () => {
    const r = await run('/a/logo.png', async () => ({ isDirectory: false }));
    const last = r.content[r.content.length - 1];
    expect(last?.text).toContain('as them');
    expect(last?.text).toContain('present again');
  });

  it('refuses a path that does not exist, rather than showing nothing', async () => {
    const r = await run('/a/missing.png', async () => null);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('nothing at /a/missing.png');
  });

  it('says so when there is no desktop app to present into', async () => {
    const { pi, tools } = collect();
    registerPresentTool(pi, { bridge: null, stat: async () => ({ isDirectory: false }) });
    const exec = tools[0]?.execute as (i: string, p: unknown) => Promise<{ isError?: boolean }>;
    expect((await exec('t', { path: '/a/x.png' })).isError).toBe(true);
  });
});

describe('reviewInstruction', () => {
  it('frames the check as the user, not as the author', () => {
    expect(reviewInstruction()).toMatch(/as them/);
  });

  it('says the turn is not over yet', () => {
    expect(reviewInstruction()).toMatch(/you still have the turn/);
  });
});

describe('present resolves ~ before touching the filesystem', () => {
  /*
   * the user, from a screenshot: "I see a present file/folder tool call that didn't
   * present anything." A model writes `~/proj/app.py` constantly; nothing
   * downstream expanded it, so stat failed, present returned "There is nothing
   * at ~/proj/app.py", no present:show was emitted, and the thread showed a
   * present ROW with no card beneath it.
   *
   * Same root as the syntax check running py_compile on a quoted tilde.
   */
  it('stats, shows and previews the expanded path — never the tilde', async () => {
    const seen: string[] = [];
    type Registered = { execute: (id: string, params: unknown) => Promise<unknown> };
    /* Held in a one-slot box: assigning through a closure narrows `tool` to
     * `never` at the use site, which typechecks as an error even though the
     * value is there at runtime. */
    const box: { tool: Registered | null } = { tool: null };
    const pi = {
      registerTool: (def: Registered) => {
        box.tool = def;
      },
    };
    registerPresentTool(
      pi as never,
      {
        stat: async (path: string) => {
          seen.push(path);
          return { isDirectory: false, size: 10 };
        },
        bridge: {
          show: async ({ path }: { path: string }) => {
            seen.push(path);
            return { ok: true };
          },
          preview: async ({ path }: { path: string }) => {
            seen.push(path);
            return { ok: true, text: 'hello' };
          },
        },
      } as never,
    );
    expect(box.tool).not.toBeNull();
    await box.tool?.execute('id', { path: '~/proj/app.py' });

    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(p.startsWith('~')).toBe(false);
    expect(seen.every((p) => p.endsWith('/proj/app.py'))).toBe(true);
  });
});
