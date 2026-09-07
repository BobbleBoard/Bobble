/**
 * The detail SECTIONS the candidates compose differently: a sheet (Shelf), a
 * replacing pane (Ledger), an inline expansion (Reach). Content is the same in
 * all three, which is the point — what a connector IS does not change with the
 * layout it is shown in.
 */
import type { ConnectorCategory, McpMode } from '@pi-desktop/mcp-lite';
import { Button, IconExternal, Markdown, Spinner } from '@pi-desktop/ui';
import { type CSSProperties, type JSX, useEffect, useState } from 'react';
import {
  type Actions,
  type ConnectorItem,
  type CustomItem,
  developerOf,
  type Item,
  isSecretField,
  MODE_HINT,
  MODE_LABEL,
  REACH_TITLE,
  reachLine,
  reachOf,
  type SkillItem,
  toolVerb,
  unfilled,
} from './data';
import { ItemMark, KIND_LABEL, OfficialMark, StateControl, StateDot } from './marks';

export const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  files: 'Files',
  dev: 'Developer tools',
  database: 'Databases',
  browser: 'Browser',
  design: 'Design',
  docs: 'Documents and notes',
  project: 'Project management',
  comms: 'Communication',
  analytics: 'Analytics',
  creative: 'Creative',
  media: 'Media',
  devops: 'DevOps',
  search: 'Search',
  observability: 'Observability',
  meetings: 'Meetings and calendar',
};

export const SKILL_CATEGORY_LABEL: Record<string, string> = {
  authoring: 'Authoring',
  dev: 'Developer',
  data: 'Data',
  research: 'Research',
  documents: 'Documents',
  productivity: 'Productivity',
};

export function categoryOf(item: Item): string {
  if (item.kind === 'connector') return CATEGORY_LABEL[item.connector.category];
  if (item.kind === 'skill')
    return SKILL_CATEGORY_LABEL[item.skill.category] ?? item.skill.category;
  return 'Custom';
}

export function SectionTitle({
  children,
  aside,
}: {
  children: string;
  aside?: string;
}): JSX.Element {
  return (
    <h3 className="mb-2 flex items-baseline gap-2 font-medium text-footnote text-text-primary">
      {children}
      {aside !== undefined ? (
        <span className="font-normal text-caption text-text-muted">{aside}</span>
      ) : null}
    </h3>
  );
}

/** Icon, name, one line, and the state control — the top of every detail. */
export function DetailHeader({
  item,
  busy,
  actions,
  onSetup,
  size = 48,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  onSetup: () => void;
  size?: number;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <ItemMark item={item} size={size} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h2 className="truncate text-heading text-text-primary">{item.name}</h2>
          {item.kind === 'connector' &&
          item.connector.official &&
          item.connector.firstParty !== true ? (
            <OfficialMark />
          ) : null}
        </div>
        <p className="mt-0.5 text-footnote text-text-muted leading-snug">{item.description}</p>
        <p className="mt-1 flex items-center gap-1.5 text-caption text-text-muted">
          <StateDot state={item.state} />
          {item.state === 'available'
            ? item.kind === 'skill'
              ? 'Not enabled'
              : 'Not added'
            : item.state === 'builtin'
              ? 'Always on'
              : item.state === 'on'
                ? 'On'
                : item.state === 'off'
                  ? 'Off'
                  : 'Needs setup'}
          <span aria-hidden="true">·</span>
          {KIND_LABEL[item.kind]}
        </p>
      </div>
      {/* When the setup card is on screen, it IS the control; a second "Set up"
          button up here would be a button that does nothing. */}
      {item.kind === 'connector' && unfilled(item.connector, item.server).length > 0 ? null : (
        <div className="flex shrink-0 items-center pt-1">
          <StateControl item={item} busy={busy} actions={actions} onSetup={onSetup} />
        </div>
      )}
    </div>
  );
}

interface Tool {
  name: string;
  description: string;
}

/**
 * The tools — static from the catalog, LIVE from the server when it is on.
 * `split` groups them by the name heuristic in data.ts and says so.
 */
export function ToolsSection({
  item,
  actions,
  split = false,
}: {
  item: ConnectorItem;
  actions: Actions;
  split?: boolean;
}): JSX.Element {
  const staticTools: readonly Tool[] = item.connector.tools ?? [];
  const live = item.state === 'on';
  const [state, setState] = useState<{ loading: boolean; tools: Tool[]; error?: string }>({
    loading: false,
    tools: [],
  });

  useEffect(() => {
    if (!live) {
      setState({ loading: false, tools: [] });
      return;
    }
    let cancelled = false;
    setState({ loading: true, tools: [] });
    void actions.fetchTools(item.id).then((res) => {
      if (cancelled) return;
      setState({ loading: false, tools: res.tools, error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [live, item.id, actions]);

  const tools = state.tools.length > 0 ? state.tools : staticTools;
  const aside = state.loading
    ? undefined
    : state.tools.length > 0
      ? `${tools.length} · from the running server`
      : tools.length > 0
        ? `${tools.length}`
        : undefined;

  if (state.loading) {
    return (
      <section>
        <SectionTitle>Tools</SectionTitle>
        <p className="flex items-center gap-2 text-footnote text-text-muted">
          <Spinner size={14} /> Starting the server to list its tools…
        </p>
      </section>
    );
  }
  if (tools.length === 0) {
    return (
      <section>
        <SectionTitle>Tools</SectionTitle>
        <p className="text-footnote text-text-muted">
          {item.state === 'on'
            ? state.error !== undefined
              ? `Could not list tools: ${state.error}`
              : 'The server reported no tools.'
            : item.state === 'builtin'
              ? 'No tools listed.'
              : item.state === 'available'
                ? 'Add it to see its tools.'
                : item.state === 'needs-setup'
                  ? 'Finish setup to list its tools.'
                  : 'Turn it on to list its tools.'}
        </p>
      </section>
    );
  }
  if (!split) {
    return (
      <section>
        <SectionTitle aside={aside}>Tools</SectionTitle>
        <ToolList tools={tools} />
      </section>
    );
  }
  const looks = tools.filter((t) => toolVerb(t.name) === 'looks-up');
  const changes = tools.filter((t) => toolVerb(t.name) === 'changes');
  return (
    <section className="flex flex-col gap-3">
      {looks.length > 0 ? (
        <div>
          <SectionTitle aside={`${looks.length}`}>Looks things up</SectionTitle>
          <ToolList tools={looks} />
        </div>
      ) : null}
      {changes.length > 0 ? (
        <div>
          <SectionTitle aside={`${changes.length}`}>Changes things</SectionTitle>
          <ToolList tools={changes} />
        </div>
      ) : null}
      <p className="text-caption text-text-muted">
        Grouped from tool names{state.tools.length > 0 ? ', listed by the running server' : ''}.
        Treat the split as a guide, not a guarantee.
      </p>
    </section>
  );
}

function ToolList({ tools }: { tools: readonly Tool[] }): JSX.Element {
  return (
    <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
      {tools.map((t) => (
        <li key={t.name} className="px-3 py-2">
          <code className="text-caption text-text-primary">{t.name}</code>
          <p className="text-caption text-text-muted leading-snug">{t.description}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Keys and placeholders, filled in place. Saving writes the registry and turns
 * the server on — the same `connectors:upsert` the Add-server dialog uses.
 */
export function SetupSection({
  item,
  busy,
  actions,
}: {
  item: ConnectorItem;
  busy: boolean;
  actions: Actions;
}): JSX.Element | null {
  const fields = unfilled(item.connector, item.server);
  const [values, setValues] = useState<Record<string, string>>({});
  if (fields.length === 0) return null;
  const ready = fields.every((f) => (values[f] ?? '').trim() !== '');
  return (
    <section
      className="rounded-lg border border-status-warning-border bg-status-warning-bg p-3"
      data-testid="cand-setup"
    >
      <SectionTitle>Before it can run</SectionTitle>
      <div className="flex flex-col gap-2">
        {fields.map((f) => {
          const secret = isSecretField(item.connector, f);
          return (
            <label key={f} className="flex flex-col gap-1">
              <span className="text-caption text-text-secondary">
                {secret ? 'Key' : 'Value'} <code className="text-text-primary">{f}</code>
              </span>
              <input
                className="pd-input pd-focusable"
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={
                  secret ? 'Paste the token' : f === 'ALLOWED_DIR' ? '/Users/you/Projects' : ''
                }
                value={values[f] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                data-testid={`cand-field-${f}`}
              />
            </label>
          );
        })}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="text-caption text-text-muted">
            Stays on this Mac, in ~/.pi/desktop/mcp-connectors.json.
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready || busy}
            onClick={() => void actions.setup(item, values)}
            data-testid="cand-setup-save"
          >
            Save and turn on
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Where it runs, in the user's terms — and the real command underneath. */
export function ReachSection({
  item,
  showGroup = true,
}: {
  item: ConnectorItem;
  /** Off when the section already sits inside that group's own list. */
  showGroup?: boolean;
}): JSX.Element {
  const c = item.connector;
  // The installed server's command AND args, or the template's — never a mix.
  const cmd = (
    item.server !== undefined
      ? [item.server.command, ...(item.server.args ?? [])]
      : [c.template.command, ...(c.template.args ?? [])]
  )
    .join(' ')
    .trim();
  const remote = (c.template.args ?? []).includes('mcp-remote');
  const runs =
    c.kind === 'builtin'
      ? 'Inside Bobble. No separate process.'
      : remote
        ? 'A local bridge process that talks to a remote server.'
        : 'A local process on this Mac, started with the chat.';
  const needs = unfilled(c, item.server);
  return (
    <section>
      <SectionTitle>Reach</SectionTitle>
      <dl className="cand-spec">
        {showGroup ? (
          <>
            <dt>Group</dt>
            <dd>{REACH_TITLE[reachOf(c)]}</dd>
          </>
        ) : null}
        <dt>Touches</dt>
        <dd>{reachLine(c, item.server)}</dd>
        <dt>Runs as</dt>
        <dd>{runs}</dd>
        {c.kind !== 'builtin' && cmd.length > 0 ? (
          <>
            <dt>Command</dt>
            <dd>
              <code className="cand-cmd">{cmd}</code>
            </dd>
          </>
        ) : null}
        {needs.length > 0 ? (
          <>
            <dt>Needs</dt>
            <dd>{needs.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

export function AboutSection({ item }: { item: Item }): JSX.Element | null {
  if (item.kind === 'connector') {
    const c = item.connector;
    return (
      <section>
        <SectionTitle>About</SectionTitle>
        <dl className="cand-spec">
          <dt>By</dt>
          <dd>{developerOf(c)}</dd>
          <dt>Category</dt>
          <dd>{CATEGORY_LABEL[c.category]}</dd>
          {c.homepage !== undefined ? (
            <>
              <dt>Homepage</dt>
              <dd>
                <a
                  href={c.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-text-link hover:underline"
                >
                  {c.homepage.replace(/^https?:\/\/(www\.)?/, '')} <IconExternal size={12} />
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  }
  if (item.kind === 'skill') {
    const s = item.skill;
    return (
      <section>
        <SectionTitle>About</SectionTitle>
        <dl className="cand-spec">
          <dt>From</dt>
          <dd>{s.source === 'anthropics/skills' ? 'anthropics/skills (vendored)' : 'Bobble'}</dd>
          <dt>License</dt>
          <dd>{s.license}</dd>
          <dt>Category</dt>
          <dd>{SKILL_CATEGORY_LABEL[s.category] ?? s.category}</dd>
          <dt>Installs to</dt>
          <dd>
            <code className="text-caption">~/.pi/agent/skills/{s.id}</code>
          </dd>
          {s.homepage !== undefined && s.homepage !== '' ? (
            <>
              <dt>Homepage</dt>
              <dd>
                <a
                  href={s.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-text-link hover:underline"
                >
                  {s.homepage.replace(/^https?:\/\/(www\.)?/, '')} <IconExternal size={12} />
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  }
  return null;
}

/** A custom server's real config. Values of env keys stay masked. */
export function CustomSection({
  item,
  busy,
  actions,
  onRemoved,
}: {
  item: CustomItem;
  busy: boolean;
  actions: Actions;
  onRemoved: () => void;
}): JSX.Element {
  const s = item.server;
  const envKeys = Object.keys(s.env ?? {});
  return (
    <section>
      <SectionTitle>How it runs</SectionTitle>
      <dl className="cand-spec">
        <dt>Command</dt>
        <dd>
          <code className="cand-cmd">{[s.command, ...(s.args ?? [])].join(' ')}</code>
        </dd>
        {s.cwd !== undefined ? (
          <>
            <dt>Working dir</dt>
            <dd>{s.cwd}</dd>
          </>
        ) : null}
        {envKeys.length > 0 ? (
          <>
            <dt>Environment</dt>
            <dd>{envKeys.map((k) => `${k}=••••`).join(', ')}</dd>
          </>
        ) : null}
        <dt>Tool prefix</dt>
        <dd>
          <code className="text-caption">{s.id}_</code>
        </dd>
      </dl>
      <p className="mt-3 text-caption text-text-muted">
        Added by hand, so Bobble knows only what you typed. Its tools appear in the next chat.
      </p>
      <div className="mt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void actions.remove(item).then(onRemoved);
          }}
          data-testid="cand-remove"
        >
          Remove server
        </Button>
      </div>
    </section>
  );
}

/** The SKILL.md itself — a skill is a document, so the detail IS the document. */
export function SkillBody({ item, actions }: { item: SkillItem; actions: Actions }): JSX.Element {
  const [state, setState] = useState<{ loading: boolean; body: string; error?: string }>({
    loading: true,
    body: '',
  });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, body: '' });
    void actions.readSkill(item.skill.id).then((res) => {
      if (cancelled) return;
      setState({ loading: false, body: res.body, error: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [actions, item.skill.id]);

  if (state.loading) {
    return (
      <p className="flex items-center gap-2 text-footnote text-text-muted">
        <Spinner size={14} /> Reading SKILL.md…
      </p>
    );
  }
  if (state.error !== undefined) {
    return <p className="text-footnote text-status-danger-fg">{state.error}</p>;
  }
  return (
    <section>
      <SectionTitle aside="what the agent reads when this skill is on">The playbook</SectionTitle>
      <div className="cand-doc rounded-lg border border-border-subtle bg-bg-base px-4 py-3">
        <Markdown data-testid="cand-skill-body">{stripFrontmatter(state.body)}</Markdown>
      </div>
    </section>
  );
}

/**
 * The YAML block a SKILL.md opens with is metadata for the loader, not prose.
 * Rendered as markdown it comes out as one huge run-on paragraph — which is
 * exactly what the shipping SkillDetail shows today.
 */
export function stripFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function RemoveRow({
  item,
  busy,
  actions,
  onRemoved,
}: {
  item: ConnectorItem;
  busy: boolean;
  actions: Actions;
  onRemoved: () => void;
}): JSX.Element | null {
  if (item.state === 'available' || item.state === 'builtin') return null;
  return (
    <div className="flex items-center justify-between gap-3 border-border-subtle border-t pt-3">
      <span className="text-caption text-text-muted">
        Removing forgets its keys; the catalog entry stays.
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          void actions.remove(item).then(onRemoved);
        }}
        data-testid="cand-remove"
      >
        Remove
      </Button>
    </div>
  );
}

/** The MCP mode, out of the browsing flow and into a quiet control. */
export function EngineMode({
  mode,
  actions,
  compact = false,
}: {
  mode: McpMode;
  actions: Actions;
  compact?: boolean;
}): JSX.Element {
  const modes: McpMode[] = ['lite', 'native', 'bash-cli'];
  const control = (
    <fieldset
      className="pd-segmented"
      style={
        {
          '--pd-segment-height': '22px',
          '--pd-segment-padding-x': '8px',
          '--pd-segment-font-size': 'var(--pd-font-size-caption)',
        } as CSSProperties
      }
      aria-label="MCP mode"
      data-testid="cand-mode"
    >
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          className="pd-segment pd-focusable"
          aria-pressed={m === mode}
          onClick={() => void actions.setMode(m)}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </fieldset>
  );
  // Compact (a 300px rail): label, control and hint stack; inline they wrapped
  // mid-label and clipped "Bash CLI".
  return (
    <div className="flex flex-col gap-1.5">
      {compact ? (
        <>
          <span className="text-caption text-text-muted">How tools reach the model</span>
          <div>{control}</div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-caption text-text-muted">How tools reach the model</span>
          {control}
        </div>
      )}
      <p className="text-caption text-text-muted leading-snug">{MODE_HINT[mode]}</p>
    </div>
  );
}
