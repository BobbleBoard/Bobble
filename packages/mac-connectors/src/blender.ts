/**
 * BLENDER, AS THREE COMMANDS — through the add-on Blender itself ships.
 *
 * The connector this replaces was a third-party MCP server fetched from PyPI
 * (`uvx blender-mcp`) that sends its own message types to port 9876. The add-on
 * that is actually installed here — Blender Lab's MCP add-on, from Blender's
 * own extensions platform — listens on that port and accepts exactly one:
 * `{"type": "execute", "code": …}`, answering anything else "Unknown request
 * type". Every call failed, and the server brought telemetry and cloud asset
 * downloads with it. the user: "fix that to be a small cli tool".
 *
 * So: no server, no download. `blender run` sends Python (bpy) to the add-on and
 * prints what comes back — the `result` dict the code fills, its stdout, or its
 * traceback; `blender scene` is a fixed run that reads the scene; `blender
 * render` renders a still to a PNG the model can then look at. The wire is the
 * add-on's own: JSON in, JSON out, each terminated by one NUL byte.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';

export const BLENDER_PORT = 9876;

/** What the add-on answers. */
export interface BlenderReply {
  readonly status?: 'ok' | 'error';
  readonly result?: Record<string, unknown>;
  readonly message?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface BlenderEnv {
  readonly host?: string;
  readonly port?: number;
  /** Is a Blender process running (for the message when nothing listens)? */
  readonly blenderRunning?: () => Promise<boolean>;
  /** Is Blender Lab's MCP add-on on disk at all? */
  readonly addonInstalled?: () => boolean;
}

/**
 * The person's real home — Blender keeps its add-ons there whatever HOME says
 * (an app given a different HOME still runs the person's Blender). MEASURED: a
 * probe's throwaway HOME made the add-on read as "not installed" while it was
 * installed and Blender was simply closed.
 */
function realHome(): string {
  return userInfo().homedir;
}

/** Where Blender is installed on this Mac, if it is. */
export function findBlenderApp(home = realHome(), exists = existsSync): string | undefined {
  for (const app of ['/Applications/Blender.app', path.join(home, 'Applications', 'Blender.app')]) {
    if (exists(app)) return app;
  }
  return undefined;
}

/** Blender Lab's add-on, in any Blender version's extensions or add-ons folder. */
export function blenderAddonInstalled(home = realHome()): boolean {
  const root = path.join(home, 'Library', 'Application Support', 'Blender');
  let versions: string[] = [];
  try {
    versions = readdirSync(root);
  } catch {
    return false;
  }
  return versions.some((v) => {
    const base = path.join(root, v);
    if (existsSync(path.join(base, 'scripts', 'addons', 'mcp_to_blender_server.py'))) return true;
    try {
      return readdirSync(path.join(base, 'extensions')).some((repo) =>
        existsSync(path.join(base, 'extensions', repo, 'mcp', 'mcp_to_blender_server.py')),
      );
    } catch {
      return false;
    }
  });
}

function processRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', 'Blender'], (error) => resolve(error === null));
  });
}

/** The sentence for "nothing answered on the port". */
export async function notListeningMessage(env: BlenderEnv = {}): Promise<string> {
  const installed = (env.addonInstalled ?? blenderAddonInstalled)();
  if (!installed) {
    return (
      "Blender's MCP add-on is not installed, and it is how this command reaches Blender. " +
      'In Blender: Edit › Preferences › Get Extensions, search "MCP" (by Blender Lab), ' +
      'install it — it starts itself whenever Blender opens.'
    );
  }
  if (!(await (env.blenderRunning ?? processRunning)())) {
    return (
      "Blender isn't open. Open it with `open -a Blender`, give its MCP add-on a few seconds " +
      'to start listening, then run this again.'
    );
  }
  return (
    `Blender is open but its MCP add-on is not listening on port ${env.port ?? BLENDER_PORT}. ` +
    'In Blender: Edit › Preferences › Add-ons, turn on "MCP" (Blender Lab) — it starts ' +
    'itself; if it is already on, press Start in its preferences.'
  );
}

export class BlenderUnreachableError extends Error {}

/** Send one piece of Python to the open Blender; resolve with its reply. */
export function blenderExecute(
  code: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } & BlenderEnv = {},
): Promise<BlenderReply> {
  const port = opts.port ?? BLENDER_PORT;
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        done(() =>
          reject(
            new Error(
              `Blender did not answer within ${Math.round(timeoutMs / 1000)} s — it may still be ` +
                'working (a long render or script); its window shows whether it is busy.',
            ),
          ),
        ),
      timeoutMs,
    );
    const onAbort = () => done(() => reject(new Error('stopped')));
    opts.signal?.addEventListener('abort', onAbort);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'execute', code, strict_json: false })}\0`);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf(0);
      if (end < 0) return;
      const text = buf.subarray(0, end).toString('utf8');
      done(() => {
        try {
          resolve(JSON.parse(text) as BlenderReply);
        } catch {
          reject(new Error(`Blender sent something that is not JSON: ${text.slice(0, 200)}`));
        }
      });
    });
    let failed = false;
    socket.on('error', (error: NodeJS.ErrnoException) => {
      /* 'close' follows 'error' at once; the sentence below needs a moment
         (is Blender running?), and 'close' must not answer for it. */
      failed = true;
      if (error.code === 'ECONNREFUSED') {
        void notListeningMessage(opts).then((m) =>
          done(() => reject(new BlenderUnreachableError(m))),
        );
        return;
      }
      done(() => reject(error));
    });
    socket.on('close', () => {
      if (failed) return;
      done(() => reject(new Error('Blender closed the connection without an answer.')));
    });
  });
}

/** A reply as text the model reads: result, printed output, or the traceback. */
export function formatReply(reply: BlenderReply): { text: string; isError: boolean } {
  const parts: string[] = [];
  const isError = reply.status === 'error';
  if (isError) parts.push(`Blender raised an error:\n${(reply.message ?? '').trim()}`);
  else if (reply.result !== undefined && Object.keys(reply.result).length > 0) {
    parts.push(`result: ${JSON.stringify(reply.result, null, 2)}`);
  } else parts.push('Done (the code put nothing in `result`).');
  if (reply.stdout !== undefined && reply.stdout.trim() !== '') {
    parts.push(`printed:\n${reply.stdout.trimEnd()}`);
  }
  if (reply.stderr !== undefined && reply.stderr.trim() !== '') {
    parts.push(`stderr:\n${reply.stderr.trimEnd()}`);
  }
  return { text: parts.join('\n\n'), isError };
}

/** `blender scene`: what is in the open file, as plain data. */
export const SCENE_CODE = `
import bpy
s = bpy.context.scene
def r(v):
    return [round(x, 3) for x in v]
objs = []
for o in s.objects[:200]:
    e = {"name": o.name, "type": o.type, "location": r(o.location), "dimensions": r(o.dimensions)}
    m = getattr(o, "active_material", None)
    if m is not None:
        e["material"] = m.name
    if o.parent is not None:
        e["parent"] = o.parent.name
    objs.append(e)
result["file"] = bpy.data.filepath or "(unsaved)"
result["scene"] = s.name
result["frames"] = {"start": s.frame_start, "end": s.frame_end, "current": s.frame_current}
result["render_engine"] = s.render.engine
result["resolution"] = [s.render.resolution_x, s.render.resolution_y]
result["camera"] = s.camera.name if s.camera else None
result["object_count"] = len(s.objects)
result["objects"] = objs
`;

export type RenderLook = 'quick' | 'eevee' | 'cycles';

/** `blender render`: a still from the scene camera, settings put back after. */
export function renderCode(out: string, look: RenderLook, percent: number): string {
  const params = JSON.stringify({ out, look, percent });
  return `
import bpy, json, os
p = json.loads(${JSON.stringify(params)})
s = bpy.context.scene
if s.camera is None:
    result["error"] = "The scene has no camera to render from. Add one (bpy.ops.object.camera_add) and aim it at the subject, then render again."
else:
    engines = [e.identifier for e in s.render.bl_rna.properties["engine"].enum_items]
    want = {"quick": "BLENDER_WORKBENCH", "cycles": "CYCLES"}.get(p["look"])
    if want is None:
        want = next((e for e in engines if "EEVEE" in e), engines[0])
    r = s.render
    old = (r.engine, r.filepath, r.resolution_percentage, r.image_settings.file_format)
    try:
        os.makedirs(os.path.dirname(p["out"]), exist_ok=True)
        r.engine = want
        r.filepath = p["out"]
        r.resolution_percentage = p["percent"]
        r.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
        result["saved"] = p["out"]
        result["engine"] = want
        result["size"] = [r.resolution_x * p["percent"] // 100, r.resolution_y * p["percent"] // 100]
    finally:
        r.engine, r.filepath, r.resolution_percentage, r.image_settings.file_format = old
`;
}

/** How long each look may take before the client stops waiting. */
export const RENDER_TIMEOUT_MS: Record<RenderLook, number> = {
  quick: 120_000,
  eevee: 300_000,
  cycles: 900_000,
};
