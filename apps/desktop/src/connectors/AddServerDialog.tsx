/**
 * Add an MCP server by hand — the one Create-menu row that does something.
 *
 * The gallery's "Create" menu had four rows ("Create plugin", "Add
 * marketplace", "Record a skill", "Request a plugin"), all four wired to
 * `onSelect={() => undefined}`. Meanwhile the whole path for the thing people
 * actually want — point the app at an MCP server it does not know about —
 * already existed and had no way in: the IPC handler, the registry writer, and
 * `useConnectorsStore.upsert`, which had zero renderer callers.
 *
 * So this replaces those four with one that works. The other three describe a
 * marketplace, a skill recorder and a request flow that do not exist, and an
 * unimplemented row is worse than an absent one.
 *
 * DELIBERATELY THIN. Command, args, cwd and env — the fields `McpServerConfig`
 * actually has. No validation beyond "a name and a command are required",
 * because guessing which executables are legitimate is exactly the kind of
 * cleverness that makes a working config unusable.
 */

import type { McpServerConfig } from '@pi-desktop/mcp-lite';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pi-desktop/ui';
import { useState } from 'react';

/** `KEY=value` per line → an env record. Blank and malformed lines are dropped. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * A stable id from the display name.
 *
 * The id is also the native tool-name prefix (`<id>_<tool>`), so it has to be
 * an identifier rather than whatever was typed.
 */
export function idFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'server' : slug;
}

/** Split a command line into argv, respecting simple quoting. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m = re.exec(text);
  while (m !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(text);
  }
  return out;
}

export function buildServerConfig(fields: {
  name: string;
  command: string;
  args: string;
  cwd: string;
  env: string;
}): McpServerConfig {
  const env = parseEnvLines(fields.env);
  const args = splitArgs(fields.args);
  const cwd = fields.cwd.trim();
  return {
    id: idFromName(fields.name),
    name: fields.name.trim(),
    command: fields.command.trim(),
    enabled: true,
    ...(args.length > 0 ? { args } : {}),
    ...(cwd !== '' ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

const EMPTY = { name: '', command: '', args: '', cwd: '', env: '' };

export function AddServerDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (server: McpServerConfig) => void;
}) {
  const [fields, setFields] = useState(EMPTY);
  const set = (key: keyof typeof EMPTY, value: string): void =>
    setFields((f) => ({ ...f, [key]: value }));
  const ready = fields.name.trim() !== '' && fields.command.trim() !== '';

  const submit = (): void => {
    if (!ready) return;
    onAdd(buildServerConfig(fields));
    setFields(EMPTY);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setFields(EMPTY);
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="add-server-dialog" className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="Name" hint="Shown on the card. Also becomes the tool prefix.">
            <input
              className="pd-input pd-focusable"
              data-testid="add-server-name"
              value={fields.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Weather"
            />
          </Field>
          <Field label="Command" hint="The executable that starts the server.">
            <input
              className="pd-input pd-focusable"
              data-testid="add-server-command"
              value={fields.command}
              onChange={(e) => set('command', e.target.value)}
              placeholder="npx"
            />
          </Field>
          <Field label="Arguments" hint="Optional. Space-separated; quotes are respected.">
            <input
              className="pd-input pd-focusable"
              data-testid="add-server-args"
              value={fields.args}
              onChange={(e) => set('args', e.target.value)}
              placeholder="-y @acme/weather-mcp"
            />
          </Field>
          <Field label="Working directory" hint="Optional.">
            <input
              className="pd-input pd-focusable"
              data-testid="add-server-cwd"
              value={fields.cwd}
              onChange={(e) => set('cwd', e.target.value)}
              placeholder="/Users/you/projects/weather"
            />
          </Field>
          <Field label="Environment" hint="Optional. One KEY=value per line.">
            <textarea
              className="pd-input pd-focusable min-h-[64px]"
              data-testid="add-server-env"
              value={fields.env}
              onChange={(e) => set('env', e.target.value)}
              placeholder={'WEATHER_API_KEY=…'}
            />
          </Field>
          {/* Said plainly, because it is the surprising part: pi reads the
              registry when it spawns, so a server added now arrives with the
              next chat rather than in this one. */}
          <p className="text-footnote text-text-muted">
            Its tools become available in your next chat.
          </p>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={submit} data-testid="add-server-submit">
            Add server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-text-secondary">{label}</span>
      {children}
      <span className="text-footnote text-text-muted">{hint}</span>
    </label>
  );
}
