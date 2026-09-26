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

  const run = async (
    path: string,
    stat: (p: string) => Promise<{ isDirectory: boolean } | null>,
  ) => {
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

  /* MEASURED: the 4B presented a diagram it had just drawn, and the preview
     handed back 1,112 tokens of the drawing's markup. */
  it('a diagram the diagram tool drew is re-shown, with a short answer and no preview', async () => {
    bridge.preview.mockClear();
    bridge.show.mockClear();
    const r = await run('/a/order-flow.svg', async () => ({ isDirectory: false }));
    expect(bridge.show).toHaveBeenCalledWith({ path: '/a/order-flow.svg' });
    expect(bridge.preview).not.toHaveBeenCalled();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.text).toMatch(
      /is a diagram the diagram tool drew — its card is already in the chat/,
    );
  });

  it('an .svg without a diagram sidecar is still previewed', async () => {
    bridge.preview.mockClear();
    const r = await run('/a/logo.svg', async (p) =>
      p.endsWith('.diagram.json') ? null : { isDirectory: false },
    );
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    expect(bridge.preview).toHaveBeenCalled();
  });

  it('refuses a path that does not exist, rather than showing nothing', async () => {
    const r = await run('/a/missing.png', async () => null);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('nothing at /a/missing.png');
  });

  /* MEASURED: `present probe-note.md` right after writing it — stat'd in pi's
     cwd, opened by the app from another, "ENOENT" under a "Presented" line. */
  it('roots a relative path at the working folder, and shows THAT path', async () => {
    const { pi, tools } = collect();
    const seen: string[] = [];
    registerPresentTool(pi, {
      bridge,
      stat: async (p) => {
        seen.push(p);
        return { isDirectory: false };
      },
      resolvePath: (p) => `/work/${p}`,
    });
    const exec = tools[0]?.execute as (
      i: string,
      p: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const r = await exec('t', { path: 'notes/probe-note.md' });
    expect(seen).toEqual(['/work/notes/probe-note.md']);
    expect(bridge.show).toHaveBeenLastCalledWith({ path: '/work/notes/probe-note.md' });
    // The canvas got the absolute path; the model hears it relative to the
    // working folder (the user, 2026-09-17).
    expect(r.content[0]?.text).toContain('Presented notes/probe-note.md');
    // An absolute path and a ~ path are left where they point.
    await exec('t', { path: '/abs/x.png' });
    expect(seen.at(-1)).toBe('/abs/x.png');
  });

  /* MEASURED on a 4B: the svg tool named the file by its absolute path,
     `…/Bobble/draw-a-simple-bicycle-as/bicycle.svg`; told its folder was
     Bobble, the model presented `draw-a-simple-bicycle-as/bicycle.svg` and was
     told there was nothing there. The path it wrote is the one from the parent. */
  it("reads a relative path that starts with the working folder's own name from the parent", async () => {
    const { pi, tools } = collect();
    const files = new Set(['/home/Bobble/draw-a-bicycle/bicycle.svg']);
    registerPresentTool(pi, {
      bridge,
      stat: async (p) => (files.has(p) ? { isDirectory: false } : null),
      resolvePath: (p) =>
        p === '.' ? '/home/Bobble/draw-a-bicycle' : `/home/Bobble/draw-a-bicycle/${p}`,
    });
    const exec = tools[0]?.execute as (
      i: string,
      p: unknown,
    ) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
    const r = await exec('t', { path: 'draw-a-bicycle/bicycle.svg' });
    expect(r.isError).not.toBe(true);
    expect(bridge.show).toHaveBeenLastCalledWith({
      path: '/home/Bobble/draw-a-bicycle/bicycle.svg',
    });
    // A genuinely missing file is still missing.
    const miss = await exec('t', { path: 'draw-a-bicycle/other.svg' });
    expect(miss.isError).toBe(true);
  });

  it('says so when there is no desktop app to present into', async () => {
    const { pi, tools } = collect();
    registerPresentTool(pi, { bridge: null, stat: async () => ({ isDirectory: false }) });
    const exec = tools[0]?.execute as (i: string, p: unknown) => Promise<{ isError?: boolean }>;
    expect((await exec('t', { path: '/a/x.png' })).isError).toBe(true);
  });
});

describe('a page’s pictures from addresses nothing gave the model', () => {
  /* MEASURED (4B, the visual suite, twice): a landing page's photos were all
     images.unsplash.com ids recalled from training — the hero, a bathroom. */
  const page =
    '<img src="https://images.unsplash.com/photo-1610701596007-11502861dcfa?w=1920">' +
    '<img src="https://cdn.example.com/given.jpg"><img src="assets/local.png">';
  const present = async (chat: string) => {
    const tools: Array<Record<string, unknown>> = [];
    const pi = { registerTool: (d: never) => tools.push(d) } as never;
    registerPresentTool(pi, {
      bridge: {
        show: async () => ({ ok: true }),
        preview: async () => ({ imageBase64: 'QUJD', mimeType: 'image/png' }),
      },
      stat: async () => ({ isDirectory: false }),
      readText: async () => page,
      chatText: () => chat,
    });
    const exec = tools[0]?.execute as (
      id: string,
      p: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    const r = await exec('t1', { path: '/site/index.html' });
    return r.content.map((c) => c.text ?? '').join('\n');
  };

  it('says so beside the preview, naming the host — not for one the chat gave it', async () => {
    const text = await present('search result: https://cdn.example.com/given.jpg');
    expect(text).toContain('Its picture loads from images.unsplash.com');
    expect(text).toContain('nothing in this chat gave you');
    expect(text).not.toContain('cdn.example.com,');
    // Every picture given (or local): nothing to say.
    const quiet = await present(
      'use https://images.unsplash.com/photo-1610701596007-11502861dcfa and https://cdn.example.com/given.jpg',
    );
    expect(quiet).not.toContain('nothing in this chat gave you');
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
