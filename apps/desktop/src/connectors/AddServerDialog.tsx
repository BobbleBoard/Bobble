/**
 * Add a server by hand — or edit one — in one paste.
 *
 * Two fields are visible: a name and ONE command line, the way a README gives
 * it. Paste a `{"mcpServers": {…}}` block, a full command line or a URL into
 * either and the form fills itself and says what it saw. Working directory
 * and environment sit behind "More options". A Test starts what was typed and
 * lists its tools before anything is saved; submitting with a field missing
 * says which, in place; Enter submits; the keyboard goes back to the button
 * that opened the dialog when it closes.
 *
 * Deliberately thin on validation beyond "a name and a command": guessing
 * which executables are legitimate is the kind of cleverness that makes a
 * working config unusable.
 */

import type { McpServerConfig } from '@pi-desktop/mcp-lite';
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconChevronDown,
  IconClose,
  Spinner,
} from '@pi-desktop/ui';
import { type ClipboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import type { ConnectorToolListing } from '../../electron/connectors/connectors-contract';
import { classifyFailure, failureReason, humanizeTool, type Tool } from './model';

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

/** An env record → `KEY=value` lines, for the edit form. */
export function envToLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
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

/** `weather` taken → `weather-2`, then `weather-3`. */
export function nextFreeId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${id}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${id}-${String(Date.now())}`;
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

/** `npx -y @acme/weather-mcp --v` → command + args. */
export function parseCommandLine(line: string): { command: string; args: string[] } {
  const [command = '', ...args] = splitArgs(line);
  return { command, args };
}

/**
 * A readable name from a package or URL: `@modelcontextprotocol/server-memory`
 * → "Memory", `blender-mcp` → "Blender", `https://mcp.sentry.dev/mcp` → "Sentry".
 */
export function nameFromSource(source: string): string {
  let s = source;
  if (/^https?:\/\//.test(s)) {
    try {
      const host = new URL(s).hostname.replace(/^(www|mcp|api)\./, '');
      s = host.split('.')[0] ?? host;
    } catch {
      // keep the raw source
    }
  }
  s = s.replace(/@[^/]+\//, '').replace(/@[\d^~.a-z-]+$/i, '');
  // The last path segment, unless it is an entry file (`index.js`, `main.py`)
  // — then the folder before it is the name.
  const segments = s
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/\.(js|mjs|cjs|ts|py)$/i, ''));
  while (
    segments.length > 1 &&
    /^(index|main|server|cli|dist|build)$/i.test(segments.at(-1) ?? '')
  ) {
    segments.pop();
  }
  const last = segments.at(-1) ?? s;
  const words = last
    .split(/[-_.\s]+/)
    .filter((w) => w !== '' && !/^(mcp|server|servers|index)$/i.test(w));
  if (words.length === 0) return 'Server';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export type DetectedKind = 'json' | 'command' | 'url';

/** What a paste turned out to be, and the form it fills. */
export interface Detected {
  kind: DetectedKind;
  name?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fromJsonEntry(name: string | undefined, entry: Record<string, unknown>): Detected | null {
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((a): a is string => typeof a === 'string')
    : [];
  const env = isRecord(entry.env)
    ? Object.fromEntries(
        Object.entries(entry.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
      )
    : undefined;
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
  if (command !== undefined && command !== '') {
    return {
      kind: 'json',
      ...(name !== undefined ? { name } : {}),
      command,
      args,
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  }
  if (url !== undefined && /^https?:\/\//.test(url)) {
    return {
      kind: 'json',
      name: name ?? nameFromSource(url),
      command: 'npx',
      args: ['-y', 'mcp-remote', url],
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return null;
}

/**
 * Recognise what was pasted: a README's `{"mcpServers": {…}}` block (or one
 * server's `{command, args, env}`), a URL (→ a local `mcp-remote` bridge), or
 * a command line. Null for a single word, which is just a name or a command.
 */
export function detectPaste(text: string): Detected | null {
  const t = text.trim();
  if (t === '') return null;
  if (t.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (!isRecord(parsed)) return null;
      const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
      if (servers !== null) {
        const first = Object.entries(servers).find((kv) => isRecord(kv[1]));
        if (first === undefined) return null;
        const [key, entry] = first;
        return isRecord(entry) ? fromJsonEntry(nameFromSource(key), entry) : null;
      }
      return fromJsonEntry(undefined, parsed);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\/\S+$/.test(t)) {
    return { kind: 'url', name: nameFromSource(t), command: 'npx', args: ['-y', 'mcp-remote', t] };
  }
  if (/\s/.test(t)) {
    const { command, args } = parseCommandLine(t);
    if (command === '') return null;
    const source = args.find((a) => !a.startsWith('-')) ?? command;
    return { kind: 'command', name: nameFromSource(source), command, args };
  }
  return null;
}

/** "Detected: local process · npx" — what the paste was read as. */
export function describeDetected(d: Detected): string {
  if (d.args.includes('mcp-remote'))
    return 'Detected: remote server, reached through a local bridge';
  const how = d.kind === 'json' ? 'JSON config' : d.kind === 'url' ? 'URL' : 'command line';
  return `Detected: ${how} · local process · ${d.command}`;
}

export interface ServerFields {
  name: string;
  /** The whole line: executable and arguments. */
  command: string;
  cwd: string;
  /** `KEY=value` per line. */
  env: string;
}

export function buildServerConfig(
  fields: ServerFields,
  base?: Pick<
    McpServerConfig,
    'id' | 'icon' | 'description' | 'mode' | 'enabled' | 'disabledTools'
  >,
): McpServerConfig {
  const env = parseEnvLines(fields.env);
  const { command, args } = parseCommandLine(fields.command);
  const cwd = fields.cwd.trim();
  return {
    ...(base ?? {}),
    id: base?.id ?? idFromName(fields.name),
    name: fields.name.trim(),
    command,
    enabled: base?.enabled ?? true,
    ...(args.length > 0 ? { args } : {}),
    ...(cwd !== '' ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function fieldsFrom(server: McpServerConfig | undefined): ServerFields {
  if (server === undefined) return { name: '', command: '', cwd: '', env: '' };
  return {
    name: server.name,
    command: [server.command, ...(server.args ?? [])].join(' '),
    cwd: server.cwd ?? '',
    env: envToLines(server.env),
  };
}

type TestState =
  | { status: 'idle' }
  | { status: 'running'; key: string }
  | { status: 'done'; key: string; result: ConnectorToolListing };

/** What a test result was for — the config it started, so a changed line makes it stale. */
function configKey(fields: ServerFields): string {
  return JSON.stringify([fields.command.trim(), fields.cwd.trim(), fields.env.trim()]);
}

export function AddServerDialog({
  open,
  onOpenChange,
  onAdd,
  initial,
  existingIds,
  onTest,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add (or replace). `listed` is what Test found, when it ran on exactly this config. */
  onAdd: (server: McpServerConfig, listed?: readonly Tool[]) => void;
  /** Edit mode: pre-fill from this server and keep its id. */
  initial?: McpServerConfig;
  /** Registry ids, for the collision check on a new name. */
  existingIds?: ReadonlySet<string>;
  /** Start a config and list its tools without saving it. */
  onTest?: (server: McpServerConfig) => Promise<ConnectorToolListing>;
  /** Where the keyboard goes when the dialog closes. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const editing = initial !== undefined;
  const [fields, setFields] = useState<ServerFields>(() => fieldsFrom(initial));
  const [errors, setErrors] = useState<{ name?: string; command?: string }>({});
  const [detected, setDetected] = useState<string | null>(null);
  const [collision, setCollision] = useState<McpServerConfig | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [moreOpen, setMoreOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);

  // A fresh form every time it opens: the previous add's fields, errors and
  // test result must not greet the next one. Keyed on `open` and `initial`.
  const initialId = initial?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `initialId` stands for `initial` — a re-render with the same server must not wipe what is being typed.
  useEffect(() => {
    if (!open) return;
    setFields(fieldsFrom(initial));
    setErrors({});
    setDetected(null);
    setCollision(null);
    setTest({ status: 'idle' });
    setMoreOpen(initial !== undefined && (initial.cwd !== undefined || initial.env !== undefined));
  }, [open, initialId]);

  const set = (key: keyof ServerFields, value: string): void => {
    setFields((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setCollision(null);
  };

  const id = editing ? initial.id : idFromName(fields.name);
  const trimmedName = fields.name.trim();

  const validate = (): boolean => {
    const next: { name?: string; command?: string } = {};
    if (trimmedName === '') next.name = 'Give it a name.';
    if (fields.command.trim() === '') next.command = 'Enter the command that starts the server.';
    setErrors(next);
    if (next.name !== undefined) nameRef.current?.focus();
    else if (next.command !== undefined) commandRef.current?.focus();
    return next.name === undefined && next.command === undefined;
  };

  const build = (withId?: string): McpServerConfig => {
    const base = editing
      ? initial
      : withId !== undefined
        ? { id: withId }
        : { id: idFromName(fields.name) };
    const built = buildServerConfig(fields, base);
    // "Keep both as weather-2": the copy is named apart too, or two cards
    // read "Weather" and only their tool prefixes differ.
    if (withId !== undefined && !editing) {
      const suffix = withId.slice(idFromName(fields.name).length + 1);
      if (suffix !== '') built.name = `${built.name} ${suffix}`;
    }
    return built;
  };

  const listedFor = (server: McpServerConfig): readonly Tool[] | undefined => {
    if (test.status !== 'done' || test.key !== configKey(fields)) return undefined;
    if (test.result.error !== undefined) return undefined;
    return server.command === '' ? undefined : test.result.tools;
  };

  const commit = (server: McpServerConfig): void => {
    onAdd(server, listedFor(server));
    onOpenChange(false);
  };

  const submit = (): void => {
    if (!validate()) return;
    const server = build();
    if (!editing && existingIds?.has(server.id) === true && collision === null) {
      setCollision(server);
      return;
    }
    commit(server);
  };

  const runTest = (): void => {
    if (onTest === undefined || !validate()) return;
    const key = configKey(fields);
    setTest({ status: 'running', key });
    void onTest(build()).then(
      (result) => setTest({ status: 'done', key, result }),
      (err: unknown) =>
        setTest({
          status: 'done',
          key,
          result: { tools: [], error: err instanceof Error ? err.message : String(err) },
        }),
    );
  };

  // Paste intelligence: whichever field the README block lands in, the form
  // takes it apart and says so. A plain word pastes as a plain word.
  const onPaste = (e: ClipboardEvent<HTMLElement>): void => {
    const text = e.clipboardData.getData('text');
    const d = detectPaste(text);
    if (d === null) return;
    e.preventDefault();
    setFields((f) => ({
      name: f.name.trim() !== '' && editing ? f.name : (d.name ?? f.name),
      command: [d.command, ...d.args].join(' '),
      cwd: d.cwd ?? f.cwd,
      env: d.env !== undefined ? envToLines(d.env) : f.env,
    }));
    setErrors({});
    setCollision(null);
    setTest({ status: 'idle' });
    setDetected(describeDetected(d));
    if (d.env !== undefined || d.cwd !== undefined) setMoreOpen(true);
  };

  const testFresh = test.status !== 'idle' && test.key === configKey(fields);
  const primaryLabel = editing ? 'Save' : 'Add server';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="add-server-dialog"
        className="pdc-dialog"
        showClose={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          nameRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          const target = returnFocusTo?.current;
          if (target === undefined || target === null) return;
          e.preventDefault();
          target.focus();
        }}
      >
        {/* The close button FIRST in DOM order, so Shift+Tab from the name and
            Tab from the last field both behave; Escape does the same job. */}
        <DialogClose asChild>
          <button
            type="button"
            className="pd-btn pd-btn--ghost-muted pd-icon-btn pd-btn--sm"
            aria-label="Close"
            style={{ position: 'absolute', top: 12, right: 12 }}
            data-testid="add-server-close"
          >
            <IconClose />
          </button>
        </DialogClose>
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{editing ? `Edit ${initial.name}` : 'Add a server'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'How Bobble starts it, and what it needs to run.'
                : 'A tool server Bobble starts for you, or one already running at a URL.'}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          <form
            id="add-server-form"
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onPaste={onPaste}
          >
            <Field
              id="add-server-name"
              label="Name"
              hint={
                trimmedName !== '' ? `Its tools will be called ${id}_…` : 'What the card will say.'
              }
              error={errors.name}
            >
              <input
                ref={nameRef}
                className="pd-input pd-focusable"
                id="add-server-name"
                data-testid="add-server-name"
                value={fields.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Name"
                autoComplete="off"
                aria-invalid={errors.name !== undefined}
              />
            </Field>
            {collision !== null ? (
              <div
                className="-mt-2 flex flex-col gap-2 rounded-lg bg-bg-inset px-3 py-2"
                data-testid="add-server-collision"
              >
                <p className="text-footnote text-text-primary">
                  A server called {collision.name} already exists.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => commit(collision)}
                    data-testid="add-server-replace"
                  >
                    Replace it
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(build(nextFreeId(collision.id, existingIds ?? new Set())))
                    }
                    data-testid="add-server-keep-both"
                  >
                    Keep both as {nextFreeId(collision.id, existingIds ?? new Set())}
                  </Button>
                </div>
              </div>
            ) : null}
            <Field
              id="add-server-command"
              label="Command"
              hint={
                detected ??
                'As the README gives it, e.g. npx -y @modelcontextprotocol/server-memory — or paste a URL or a JSON config.'
              }
              error={errors.command}
            >
              <input
                ref={commandRef}
                className="pd-input pd-focusable font-mono"
                id="add-server-command"
                data-testid="add-server-command"
                value={fields.command}
                onChange={(e) => {
                  set('command', e.target.value);
                  setDetected(null);
                }}
                placeholder="Command"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.command !== undefined}
              />
            </Field>
            <details
              className="pdc-more"
              open={moreOpen}
              onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary data-testid="add-server-more">
                <IconChevronDown size={12} /> More options
              </summary>
              <div className="mt-3 flex flex-col gap-4">
                <Field
                  id="add-server-cwd"
                  label="Working directory"
                  hint="Where the command runs. Leave empty for the default."
                >
                  <input
                    className="pd-input pd-focusable"
                    id="add-server-cwd"
                    data-testid="add-server-cwd"
                    value={fields.cwd}
                    onChange={(e) => set('cwd', e.target.value)}
                    placeholder="Working directory"
                    autoComplete="off"
                  />
                </Field>
                <Field
                  id="add-server-env"
                  label="Environment"
                  hint="One KEY=value per line. Keys stay on this Mac. ⌘↩ to submit from here."
                >
                  <textarea
                    className="pd-input pd-focusable font-mono"
                    id="add-server-env"
                    data-testid="add-server-env"
                    value={fields.env}
                    onChange={(e) => set('env', e.target.value)}
                    placeholder="Environment"
                    spellCheck={false}
                    rows={3}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                </Field>
              </div>
            </details>
            {test.status === 'running' ? (
              <p
                className="flex items-center gap-2 text-footnote text-text-muted"
                data-testid="add-server-testing"
              >
                <Spinner size={14} /> Starting it…
              </p>
            ) : test.status === 'done' && testFresh ? (
              <TestResult result={test.result} />
            ) : null}
            {/* Said plainly, because it is the surprising part: pi reads the
                registry when it spawns, so a server added now arrives with the
                next chat rather than in this one. */}
            <p className="text-footnote text-text-muted">
              Its tools become available in your next chat.
            </p>
          </form>
        </DialogBody>
        <DialogFooter>
          {onTest !== undefined ? (
            <Button
              variant="secondary"
              // `.pd-btn { margin: 0 }` outranks Tailwind's mr-auto; the
              // left-hand slot is the footer's own.
              className="pd-dialog-footer-aside"
              onClick={runTest}
              disabled={test.status === 'running'}
              data-testid="add-server-test"
            >
              Test
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="add-server-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-server-form"
            variant="primary"
            data-testid="add-server-submit"
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What Test found: the tools, or the reason it did not start. */
function TestResult({ result }: { result: ConnectorToolListing }) {
  if (result.error === undefined) {
    const names = result.tools.map((t) => humanizeTool(t.name));
    const shown = names.slice(0, 8);
    const more = names.length - shown.length;
    return (
      <div className="pdc-test" data-ok="true" data-testid="add-server-test-ok">
        <p className="text-footnote text-text-primary">
          Started. {result.tools.length === 1 ? '1 tool' : `${String(result.tools.length)} tools`}
          {names.length > 0 ? ':' : '.'}
        </p>
        {names.length > 0 ? (
          <p className="mt-0.5 text-caption text-text-muted">
            {shown.join(', ')}
            {more > 0 ? ` and ${String(more)} more` : ''}
          </p>
        ) : null}
      </div>
    );
  }
  const kind = classifyFailure(result.error);
  return (
    <div className="pdc-test" data-ok="false" data-testid="add-server-test-failed">
      <p className="text-footnote text-text-primary">
        {kind === 'timeout' ? 'Not responding' : 'Could not start'}
      </p>
      <p className="mt-0.5 text-caption text-text-muted">
        {failureReason({ error: result.error, stderr: result.stderr })}
      </p>
      {(result.stderr?.length ?? 0) >= 2 ? (
        <pre className="pdc-stderr mt-1.5">{result.stderr?.join('\n')}</pre>
      ) : null}
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  children: React.ReactNode;
}) {
  // The dialog's own field (label over control over hint); `htmlFor` rather
  // than wrapping, so a screen reader associates the label with a control
  // that is a child component. The error replaces the hint, under the same id
  // the tests know.
  return (
    <DialogField
      htmlFor={id}
      label={label}
      hint={hint}
      error={
        error !== undefined ? (
          <span className="pdc-field-error" data-testid={`${id}-error`}>
            {error}
          </span>
        ) : undefined
      }
    >
      {children}
    </DialogField>
  );
}
