import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlenderUnreachableError,
  blenderExecute,
  formatReply,
  notListeningMessage,
  renderCode,
} from './blender.js';
import { registerBlenderTools } from './index.js';

/** A stand-in for Blender Lab's add-on: NUL-terminated JSON in, NUL-terminated JSON out. */
function fakeAddon(answer: (req: Record<string, unknown>) => unknown) {
  const seen: Record<string, unknown>[] = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf(0);
      if (end < 0) return;
      const req = JSON.parse(buf.subarray(0, end).toString('utf8')) as Record<string, unknown>;
      seen.push(req);
      sock.write(`${JSON.stringify(answer(req))}\0`);
    });
  });
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, seen, close: () => server.close() });
    });
  });
}

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

describe('blenderExecute — the add-on’s own wire', () => {
  it('sends one execute request and reads the NUL-terminated reply', async () => {
    const addon = await fakeAddon(() => ({ status: 'ok', result: { count: 3 }, stdout: 'hi\n' }));
    close = addon.close;
    const reply = await blenderExecute('result["count"] = 3', { port: addon.port });
    expect(addon.seen).toEqual([
      { type: 'execute', code: 'result["count"] = 3', strict_json: false },
    ]);
    expect(reply).toEqual({ status: 'ok', result: { count: 3 }, stdout: 'hi\n' });
  });

  it('says why when nothing listens — not installed, not open, or add-on off', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const refused = (env: { installed: boolean; running: boolean }) =>
      blenderExecute('x', {
        port: free,
        addonInstalled: () => env.installed,
        blenderRunning: async () => env.running,
      });
    await expect(refused({ installed: false, running: false })).rejects.toThrow(
      /add-on is not installed.*Get Extensions/,
    );
    await expect(refused({ installed: true, running: false })).rejects.toThrow(
      /Blender isn't open\. Open it with `open -a Blender`/,
    );
    await expect(refused({ installed: true, running: true })).rejects.toBeInstanceOf(
      BlenderUnreachableError,
    );
    expect(
      await notListeningMessage({ addonInstalled: () => true, blenderRunning: async () => true }),
    ).toMatch(/not listening on port 9876/);
  });
});

describe('formatReply', () => {
  it('shows the result, what was printed, or the traceback', () => {
    expect(formatReply({ status: 'ok', result: { a: 1 } }).text).toContain('"a": 1');
    expect(formatReply({ status: 'ok', result: {} }).text).toMatch(/put nothing in `result`/);
    const err = formatReply({ status: 'error', message: 'Traceback…\nNameError: x' });
    expect(err.isError).toBe(true);
    expect(err.text).toContain('NameError: x');
    expect(formatReply({ status: 'ok', result: {}, stdout: 'printed this\n' }).text).toContain(
      'printed:\nprinted this',
    );
  });

  it('render code carries its parameters as data, not as code', () => {
    const code = renderCode('/tmp/a "b".png', 'quick', 50);
    expect(code).toContain('json.loads(');
    expect(code).toContain('BLENDER_WORKBENCH');
  });
});

describe('registerBlenderTools', () => {
  const registrar = () => {
    const names: string[] = [];
    return { names, pi: { registerTool: (t: { name: string }) => names.push(t.name) } as never };
  };

  it('registers nothing where Blender is not installed', () => {
    const r = registrar();
    registerBlenderTools(r.pi, { platform: 'darwin', blenderApp: null });
    expect(r.names).toEqual([]);
  });

  it('registers scene, run and render where it is', () => {
    const r = registrar();
    registerBlenderTools(r.pi, { platform: 'darwin', blenderApp: '/Applications/Blender.app' });
    expect(r.names).toEqual(['blender_scene', 'blender_run', 'blender_render']);
  });
});
