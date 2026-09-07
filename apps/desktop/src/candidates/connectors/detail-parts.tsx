/**
 * The detail SECTIONS the candidates compose differently: a sheet (Shelf), a
 * replacing pane (Ledger), an inline expansion (Reach), a pinned pane (Shelf+).
 * Content is the same in all four, which is the point — what a connector IS
 * does not change with the layout it is shown in.
 */
import type { McpMode } from '@pi-desktop/mcp-lite';
import { Button, IconExternal, IconRefresh, Markdown, Spinner } from '@pi-desktop/ui';
import { type CSSProperties, type JSX, type ReactNode, useEffect, useState } from 'react';
import { cx } from '../../onboarding/cx';
import {
  type Actions,
  agoLabel,
  CATEGORY_LABEL,
  type ConnectorItem,
  type CustomItem,
  commandLine,
  developerOf,
  failing,
  failureLabel,
  hasKeys,
  humanizeTool,
  type Item,
  isCommunity,
  isSecretField,
  MODE_HINT,
  MODE_LABEL,
  needsConfig,
  reachLine,
  SKILL_CATEGORY_LABEL,
  type SkillItem,
  serverIdOf,
  type Tool,
  toolVerb,
  unfilled,
  useCachedTools,
  useListing,
  useToolFailure,
  vendorOf,
} from './data';
import { ItemMark, StateControl, StateDot } from './marks';

// The label maps moved to data.ts (the search matches them now); Ledger still
// imports them from here.
export { CATEGORY_LABEL, categoryOf, SKILL_CATEGORY_LABEL } from './data';

/**
 * An identifier that may break, but only at its underscores. `overflow-wrap:
 * anywhere` on the spec column split `GITHUB_PERSONAL_ACC|ESS_TOKEN` mid-word
 * in every 640px shot.
 */
export function Key({ children }: { children: string }): JSX.Element {
  const parts = children.split('_');
  return (
    <code className="cand-key">
      {parts.map((p, i) => (
        <span key={`${p}-${String(i)}`}>
          {i > 0 ? (
            <>
              _<wbr />
            </>
          ) : null}
          {p}
        </span>
      ))}
    </code>
  );
}

export function SectionTitle({
  children,
  aside,
  action,
}: {
  children: string;
  aside?: string;
  /** A small control on the title's right edge (Refresh). */
  action?: ReactNode;
}): JSX.Element {
  return (
    <h3 className="mb-2 flex items-baseline gap-2 font-medium text-footnote text-text-primary">
      {children}
      {aside !== undefined ? (
        <span className="min-w-0 truncate font-normal text-caption text-text-muted">{aside}</span>
      ) : null}
      {action !== undefined ? <span className="ml-auto font-normal">{action}</span> : null}
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
  // An available tool's action is the full-width button below, the way the
  // hub's pane puts Download under the name; a key-needing one's action is the
  // setup card that follows. A switch stays up here: it is a state, not an act.
  const addable =
    item.kind === 'connector' && item.state === 'available' && !needsConfig(item.connector);
  const asks = item.kind === 'connector' && unfilled(item.connector, item.server).length > 0;
  // On, and the last listing failed: the status line goes amber and says so
  // — "Needs setup" where a key is the likeliest cause, "Not responding"
  // otherwise — with the switch beside it, because the switch is still how
  // the server is turned off. Round 4's first item was this line reading a
  // green "● On" above "Could not list its tools."
  const failed = failing(item);
  return (
    <div>
      <div className="flex items-start gap-3">
        <ItemMark item={item} size={size} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-heading text-text-primary">{item.name}</h2>
          <p className="mt-0.5 text-footnote text-text-muted leading-snug">{item.description}</p>
          <p
            className={cx(
              'mt-1 flex items-center gap-1.5 text-caption',
              failed ? 'text-status-warning-fg' : 'text-text-muted',
            )}
            data-testid="cand-status"
          >
            <StateDot state={failed ? 'needs-setup' : item.state} />
            {failed
              ? failureLabel(item)
              : item.state === 'available'
                ? item.kind === 'skill'
                  ? 'Not enabled'
                  : 'Not added'
                : item.state === 'builtin'
                  ? 'Built in, always on'
                  : item.state === 'on'
                    ? 'On'
                    : item.state === 'off'
                      ? 'Off'
                      : 'Needs setup'}
          </p>
        </div>
        {addable || asks ? null : (
          <div className="flex shrink-0 items-center pt-1">
            <StateControl
              item={item}
              busy={busy}
              actions={actions}
              onSetup={onSetup}
              showFailure={false}
            />
          </div>
        )}
      </div>
      {addable && item.kind === 'connector' ? (
        <Button
          variant="accent"
          className="mt-3 w-full"
          disabled={busy}
          onClick={() => void actions.add(item)}
          data-testid={`cand-add-${item.id}`}
        >
          Add to Bobble
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The tools. A built-in's come from the catalog; an installed server's come
 * from the server itself, listed once and REMEMBERED (data.ts, the tool
 * cache): on every open after the first the list is drawn at once with a
 * caption saying when it was listed, and the first listing happens when the
 * server is turned on, not when someone looks. The spinner is left for the
 * one case nothing else covers — a server enabled outside this screen that
 * has never answered — and even that is paid once.
 *
 * `split` groups the list by the name heuristic in data.ts and says so; `cap`
 * shows that many per group before a "Show all" row (every reference caps).
 */
export function ToolsSection({
  item,
  actions,
  split = false,
  cap = 8,
  onEditKeys,
}: {
  item: ConnectorItem | CustomItem;
  actions: Actions;
  split?: boolean;
  cap?: number;
  /** Offered beside a failed start on a key-needing connector: reopen the setup card. */
  onEditKeys?: () => void;
}): JSX.Element {
  const serverId = serverIdOf(item);
  const cmd = item.server !== undefined ? commandLine(item.server) : '';
  const cached = useCachedTools(serverId ?? '', cmd);
  // The failure and the flight are the cache's, not this component's: a
  // failure recorded by the turn-on warm shows here without a second spawn,
  // and it is the same record the ledger row and the pill read. Round 3 kept
  // the error in component state and dated it against the list; the cache
  // clears a failure on the next success, so the dating is gone with it.
  const failure = useToolFailure(serverId ?? '', cmd);
  const loading = useListing(serverId ?? '');
  const live = item.state === 'on' && serverId !== null;
  const error = live && failure !== null ? failure.error : undefined;

  // The one cold path: on, never listed, never failed. Start it once; the
  // result — list or failure — is kept, so a look never spawns twice and a
  // recorded failure is retried only by "Try again" or by the next launch.
  useEffect(() => {
    if (!live || cached !== null || failure !== null || serverId === null) return;
    void actions.listTools(serverId, cmd);
  }, [live, cached, failure, serverId, cmd, actions]);

  const refresh = () => {
    if (serverId !== null) void actions.listTools(serverId, cmd);
  };

  const staticTools: readonly Tool[] =
    item.kind === 'connector' ? (item.connector.tools ?? []) : [];
  const tools: readonly Tool[] = cached !== null ? cached.tools : staticTools;
  const keys = hasKeys(item);

  const aside =
    cached !== null
      ? live
        ? loading
          ? `${String(tools.length)} · listing…`
          : `${String(tools.length)} · listed ${agoLabel(cached.at)}`
        : `${String(tools.length)} · from its last run`
      : tools.length > 0
        ? String(tools.length)
        : undefined;
  const action = live ? (
    <button
      type="button"
      className="cand-textbtn pd-focusable"
      disabled={loading}
      onClick={refresh}
      data-testid="cand-tools-refresh"
    >
      {loading ? <Spinner size={12} /> : <IconRefresh size={12} />} Refresh
    </button>
  ) : undefined;
  // Offered under a failure, with or without a list: retry, and — where a key
  // is the likeliest cause — the card that changes it.
  const remedies = (
    <div className="flex items-center gap-3">
      <button type="button" className="cand-textbtn pd-focusable" onClick={refresh}>
        Try again
      </button>
      {keys && onEditKeys !== undefined ? (
        <button
          type="button"
          className="cand-textbtn pd-focusable"
          onClick={onEditKeys}
          data-testid="cand-tools-fix-keys"
        >
          Change the key
        </button>
      ) : null}
    </div>
  );

  let body: ReactNode;
  if (tools.length === 0 && loading) {
    body = (
      <p className="flex items-center gap-2 text-footnote text-text-muted">
        <Spinner size={14} /> Starting it once to list its tools…
      </p>
    );
  } else if (tools.length === 0 && error !== undefined) {
    body = (
      <div className="flex flex-col gap-1.5" data-testid="cand-tools-error">
        <p className="text-footnote text-text-primary">Could not list its tools.</p>
        <p className="text-caption text-text-muted">{error}</p>
        {remedies}
      </div>
    );
  } else if (tools.length === 0) {
    body = (
      <p className="text-footnote text-text-muted">
        {item.state === 'builtin'
          ? 'No tools listed.'
          : item.state === 'available'
            ? 'Add it to see its tools.'
            : item.state === 'needs-setup'
              ? 'Finish setup to list its tools.'
              : item.state === 'on'
                ? 'The server reported no tools.'
                : 'Turn it on to list its tools.'}
      </p>
    );
  } else if (!split) {
    body = <ToolList tools={tools} serverId={serverId ?? item.id} cap={cap} />;
  } else {
    const looks = tools.filter((t) => toolVerb(t.name) === 'looks-up');
    const changes = tools.filter((t) => toolVerb(t.name) === 'changes');
    body = (
      <div className="flex flex-col gap-3">
        {looks.length > 0 ? (
          <div>
            <GroupLabel count={looks.length}>Looks things up</GroupLabel>
            <ToolList tools={looks} serverId={serverId ?? item.id} cap={cap} />
          </div>
        ) : null}
        {changes.length > 0 ? (
          <div>
            <GroupLabel count={changes.length}>Changes things</GroupLabel>
            <ToolList tools={changes} serverId={serverId ?? item.id} cap={cap} />
          </div>
        ) : null}
        <p className="text-caption text-text-muted">Grouped by name — a guide, not a guarantee.</p>
      </div>
    );
  }

  return (
    <section data-testid="cand-tools">
      <SectionTitle aside={aside} action={action}>
        Tools
      </SectionTitle>
      {/* A refresh that failed with a list in hand: the reason and the
          remedies go ABOVE the list, beside the amber status they explain —
          under seventeen rows they were the last thing on the pane. */}
      {tools.length > 0 && error !== undefined && !loading ? (
        <div className="mb-2 flex flex-col gap-1.5" data-testid="cand-tools-error">
          <p className="text-caption text-text-muted">
            Could not refresh — this list is from its last answer. {error}
          </p>
          {remedies}
        </div>
      ) : null}
      {body}
    </section>
  );
}

function GroupLabel({ children, count }: { children: string; count: number }): JSX.Element {
  return (
    <div className="mb-1 flex items-baseline gap-1.5 text-caption text-text-muted">
      <span className="text-text-secondary">{children}</span>
      <span>{count}</span>
    </div>
  );
}

/**
 * A tool row reads as a sentence first and an identifier second: the sentence
 * is for deciding whether to trust it, the identifier is what appears in the
 * chat when it is called.
 */
function ToolList({
  tools,
  serverId,
  cap,
}: {
  tools: readonly Tool[];
  serverId: string;
  cap: number;
}): JSX.Element {
  const [all, setAll] = useState(false);
  // Never hide exactly one row behind a click: "Show all 9" over eight rows
  // charged a click for one line (judgement 10). A group of cap+1 is whole.
  const capped = tools.length > cap + 1;
  const shown = all || !capped ? tools : tools.slice(0, cap);
  const rest = tools.length - shown.length;
  return (
    <div>
      <ul className="cand-tools" data-testid="cand-tools-list">
        {shown.map((t) => {
          const plain = humanizeTool(t.name, serverId);
          return (
            <li key={t.name} className="cand-tool">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-footnote text-text-primary">{plain}</span>
                {plain.toLowerCase() !== t.name.toLowerCase() ? (
                  <code className="min-w-0 truncate text-caption text-text-muted">{t.name}</code>
                ) : null}
              </div>
              {t.description !== '' ? (
                <p className="line-clamp-2 text-footnote text-text-muted leading-snug">
                  {t.description}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rest > 0 ? (
        <button
          type="button"
          className="cand-textbtn pd-focusable mt-1.5"
          onClick={() => setAll(true)}
          data-testid="cand-tools-more"
        >
          Show all {tools.length}
        </button>
      ) : all && capped ? (
        <button
          type="button"
          className="cand-textbtn pd-focusable mt-1.5"
          onClick={() => setAll(false)}
          data-testid="cand-tools-fewer"
        >
          Show fewer
        </button>
      ) : null}
    </div>
  );
}

/** Every key and placeholder a connector takes, filled or not. */
function configFields(item: ConnectorItem): string[] {
  const out = [...(item.connector.requiresEnv ?? [])];
  for (const a of item.server?.args ?? item.connector.template.args ?? []) {
    const m = /<([^>]+)>/.exec(a);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/**
 * Keys and placeholders, filled in place. Saving writes the registry and turns
 * the server on — the same `connectors:upsert` the Add-server dialog uses.
 *
 * The button is the ACCENT primary, full width of the card, the same button
 * `Add to Bobble` is: it is the one thing the pane asks for, and round 2 gave
 * it the secondary grey (the least emphatic control on the screen — the
 * judge's item 2). Disabled it is the accent at half opacity, which reads as
 * "primary, waiting", not "secondary".
 */
export function SetupSection({
  item,
  busy,
  actions,
  open = false,
  onClose,
}: {
  item: ConnectorItem;
  busy: boolean;
  actions: Actions;
  /** Re-enter a key that is already saved (a bad one, say). */
  open?: boolean;
  onClose?: () => void;
}): JSX.Element | null {
  const missing = unfilled(item.connector, item.server);
  const editing = missing.length === 0 && open;
  const fields = missing.length > 0 ? missing : editing ? configFields(item) : [];
  const [values, setValues] = useState<Record<string, string>>({});
  if (fields.length === 0) return null;
  const ready = fields.every((f) => (values[f] ?? '').trim() !== '');
  const save = () => {
    void actions.setup(item, values).then(() => {
      setValues({});
      onClose?.();
    });
  };
  return (
    <section className="cand-setup" data-testid="cand-setup">
      <SectionTitle>{editing ? 'Change the key' : 'Before it can run'}</SectionTitle>
      <div className="flex flex-col gap-2">
        {fields.map((f) => {
          const secret = isSecretField(item.connector, f);
          return (
            <label key={f} className="flex flex-col gap-1">
              <span className="text-caption text-text-secondary">
                {secret ? 'Key' : 'Value'} <Key>{f}</Key>
              </span>
              <input
                className="pd-input pd-focusable"
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={
                  secret
                    ? editing
                      ? 'Paste a new token'
                      : 'Paste the token'
                    : f === 'ALLOWED_DIR'
                      ? '/Users/you/Projects'
                      : ''
                }
                value={values[f] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ready && !busy) save();
                }}
                data-testid={`cand-field-${f}`}
              />
            </label>
          );
        })}
        <p className="text-caption text-text-muted">
          Stays on this Mac, in ~/.pi/desktop/mcp-connectors.json.
        </p>
        <Button
          variant="accent"
          className="mt-0.5 w-full"
          disabled={!ready || busy}
          onClick={save}
          data-testid="cand-setup-save"
        >
          Save and turn on
        </Button>
        {editing && onClose !== undefined ? (
          <button
            type="button"
            className="cand-textbtn pd-focusable self-center"
            onClick={onClose}
            data-testid="cand-setup-cancel"
          >
            Keep the saved key
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Where it runs, in the user's terms — and the real command underneath.
 *
 * No "Runs as" row for an MCP server: *A local process on this Mac, started
 * with the chat* printed on every server's detail while the list's section
 * header already said "each one runs as a local process" — a constant row is
 * texture. It stays on a built-in, where *Inside Bobble. No separate process.*
 * is the surprising fact, and a remote bridge gets a caption under its command.
 */
export function ReachSection({ item }: { item: ConnectorItem }): JSX.Element {
  const c = item.connector;
  // The installed server's command AND args, or the template's — never a mix.
  const cmd =
    item.server !== undefined
      ? commandLine(item.server)
      : commandLine({ command: c.template.command, args: c.template.args });
  const remote = (item.server?.args ?? c.template.args ?? []).includes('mcp-remote');
  // No "Needs" row: the setup card above names the key, and "Touches" names it
  // again — three rows saying GITHUB_PERSONAL_ACCESS_TOKEN was the round-1 sheet.
  return (
    <section>
      <SectionTitle>Reach</SectionTitle>
      <dl className="cand-spec">
        <dt>Touches</dt>
        <dd>{reachLine(c, item.server)}</dd>
        {c.kind === 'builtin' ? (
          <>
            <dt>Runs as</dt>
            <dd>Inside Bobble. No separate process.</dd>
          </>
        ) : null}
        {c.kind !== 'builtin' && cmd.length > 0 ? (
          <>
            <dt>Command</dt>
            <dd>
              <code className="cand-cmd">{cmd}</code>
              {remote ? (
                <span className="mt-1 block text-caption text-text-muted">
                  A local bridge; the server itself is remote.
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function CategoryValue({
  label,
  onSearch,
}: {
  label: string;
  onSearch?: (query: string) => void;
}): JSX.Element {
  // A link that puts the category into the search: category browsing with no
  // new surface. Plain text where the candidate has no search to put it in.
  if (onSearch === undefined) return <>{label}</>;
  return (
    <button
      type="button"
      className="cand-link pd-focusable"
      onClick={() => onSearch(label)}
      title={`Show everything in ${label}`}
      data-testid="cand-category-link"
    >
      {label}
    </button>
  );
}

function Homepage({ url }: { url: string }): JSX.Element {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-text-link hover:underline"
    >
      {url.replace(/^https?:\/\/(www\.)?/, '')} <IconExternal size={12} />
    </a>
  );
}

export function AboutSection({
  item,
  onSearch,
}: {
  item: Item;
  /** Given, the Category row becomes a link that searches for it. */
  onSearch?: (query: string) => void;
}): JSX.Element | null {
  if (item.kind === 'connector') {
    const c = item.connector;
    // The kind lives here, once, in the words the rest of the app uses — not
    // as a third name on the state line. The rule (the vendor's own server)
    // prints nothing after the author; the EXCEPTION gets a sentence.
    return (
      <section>
        <SectionTitle>About</SectionTitle>
        <dl className="cand-spec">
          <dt>Kind</dt>
          <dd>{c.kind === 'builtin' ? 'Built into Bobble' : 'MCP server'}</dd>
          <dt>By</dt>
          <dd>{developerOf(c)}</dd>
          <dt>Category</dt>
          <dd>
            <CategoryValue label={CATEGORY_LABEL[c.category]} onSearch={onSearch} />
          </dd>
          {c.homepage !== undefined ? (
            <>
              <dt>Homepage</dt>
              <dd>
                <Homepage url={c.homepage} />
              </dd>
            </>
          ) : null}
        </dl>
        {isCommunity(c) ? (
          <p className="mt-2 text-caption text-text-muted" data-testid="cand-community">
            Community server — not published by {vendorOf(c)}.
          </p>
        ) : null}
      </section>
    );
  }
  if (item.kind === 'skill') {
    const s = item.skill;
    return (
      <section>
        <SectionTitle>About</SectionTitle>
        <dl className="cand-spec">
          <dt>Kind</dt>
          <dd>Skill — a playbook the agent reads</dd>
          <dt>From</dt>
          <dd>{s.source === 'anthropics/skills' ? 'anthropics/skills (vendored)' : 'Bobble'}</dd>
          <dt>License</dt>
          <dd>{s.license}</dd>
          <dt>Category</dt>
          <dd>
            <CategoryValue
              label={SKILL_CATEGORY_LABEL[s.category] ?? s.category}
              onSearch={onSearch}
            />
          </dd>
          <dt>Installs to</dt>
          <dd>
            <code className="text-caption">~/.pi/agent/skills/{s.id}</code>
          </dd>
          {s.homepage !== undefined && s.homepage !== '' ? (
            <>
              <dt>Homepage</dt>
              <dd>
                <Homepage url={s.homepage} />
              </dd>
            </>
          ) : null}
        </dl>
      </section>
    );
  }
  return null;
}

/**
 * A custom server's real config. Values of env keys stay masked. Its tools
 * are listed the way a catalog server's are — a custom server is just a tool
 * the catalog does not know.
 */
export function CustomSection({
  item,
  busy,
  actions,
  onRemoved,
  split = false,
}: {
  item: CustomItem;
  busy: boolean;
  actions: Actions;
  onRemoved: () => void;
  split?: boolean;
}): JSX.Element {
  const s = item.server;
  const envKeys = Object.keys(s.env ?? {});
  return (
    <>
      <ToolsSection item={item} actions={actions} split={split} />
      <section>
        <SectionTitle>How it runs</SectionTitle>
        <dl className="cand-spec">
          <dt>Command</dt>
          <dd>
            <code className="cand-cmd">{commandLine(s)}</code>
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
              <dd>
                {envKeys.map((k, i) => (
                  <span key={k}>
                    {i > 0 ? ', ' : null}
                    <Key>{k}</Key>=••••
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          <dt>Tool prefix</dt>
          <dd>
            <code className="text-caption">{s.id}_</code>
          </dd>
        </dl>
        <p className="mt-3 text-caption text-text-muted">
          Added by hand, so Bobble knows only what you typed.
        </p>
        {/* The catalog's Remove row's form — caption left, action right — at the
            heavier weight: removing a custom server forgets the command with
            nothing to fall back on. */}
        <div className="mt-3 flex items-center justify-between gap-3 border-border-subtle border-t pt-3">
          <span className="text-caption text-text-muted">
            Removing forgets the command; nothing else keeps it.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
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
    </>
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
        {hasKeys(item)
          ? 'Removing forgets its keys; the catalog entry stays.'
          : 'The catalog entry stays; add it again any time.'}
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
