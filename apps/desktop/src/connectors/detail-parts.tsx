/**
 * The sections a detail is composed of. The detail takes the list's place, in
 * one readable column, the way the reference's plugin page does.
 *
 * The order the screen puts them in is the argument of the design: what is
 * wrong (the failure card), what is missing (the setup card), what it lets you
 * ask for (Try it), then what it has (Tools), what it touches (Reach), and the
 * facts (About). The outcome before the inventory.
 */
import type { McpMode, McpServerConfig } from '@pi-desktop/mcp-lite';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  IconExternal,
  IconMore,
  IconRefresh,
  Markdown,
  Spinner,
  Switch,
} from '@pi-desktop/ui';
import { type CSSProperties, type JSX, type ReactNode, useEffect, useState } from 'react';
import { cx } from '../onboarding/cx';
import { useConnectorsStore } from '../state/connectors-store';
import { ItemMark, StateDot } from './marks';
import {
  type Actions,
  agoLabel,
  CATEGORY_LABEL,
  type ConnectorItem,
  type CustomItem,
  commandLine,
  developerOf,
  examplePrompt,
  failing,
  failureLabel,
  failureReason,
  formatTokens,
  hasKeys,
  humanizeTool,
  type Item,
  isCommunity,
  isRemote,
  isSecretField,
  isToolOn,
  keyHelp,
  MODE_HINT,
  MODE_LABEL,
  needsConfig,
  reachLine,
  SKILL_CATEGORY_LABEL,
  type SkillItem,
  serverIdOf,
  type Tool,
  toolCost,
  toolVerb,
  unfilled,
  useCachedTools,
  useListing,
  useToolFailure,
  vendorOf,
} from './model';

/**
 * An identifier that may break, but only at its underscores. `overflow-wrap:
 * anywhere` on the spec column split `GITHUB_PERSONAL_ACC|ESS_TOKEN` mid-word.
 */
export function Key({ children }: { children: string }): JSX.Element {
  const parts = children.split('_');
  return (
    <code className="pdc-key">
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
    <h3 className="mb-2 flex items-baseline gap-2 font-medium text-body text-text-primary">
      {children}
      {aside !== undefined ? (
        <span className="min-w-0 truncate font-normal text-caption text-text-muted">{aside}</span>
      ) : null}
      {action !== undefined ? <span className="ml-auto font-normal">{action}</span> : null}
    </h3>
  );
}

/** Whether this thing can be used in a chat right now. */
export function usable(item: Item): boolean {
  return (item.state === 'on' && !failing(item)) || item.state === 'builtin';
}

/**
 * The top of a detail, laid out the way the reference lays out its plugin
 * page: a large mark, the name, one line, and the controls on the right — the
 * switch (a local process has an off the reference's cloud apps do not), the
 * "···" menu, and the one primary: "Try in chat" once it is on, "Add to
 * Bobble" when it is one click away. A key-needing one's action is the setup
 * card that follows, so its header carries nothing to press.
 */
export function DetailHeader({
  item,
  busy,
  actions,
  tools,
  onEdit,
  onRemove,
  onTry,
}: {
  item: Item;
  busy: boolean;
  actions: Actions;
  /** What "Try in chat" derives its example from. */
  tools: readonly Tool[];
  /** Given for an installed server: the "…" menu offers Edit. */
  onEdit?: () => void;
  /** Given for an installed server: the "…" menu offers Remove (it arms the inline confirm). */
  onRemove?: () => void;
  /** Start a new chat with the example ready to send. Absent only outside the app. */
  onTry?: (prompt: string) => void;
}): JSX.Element {
  const addable =
    item.kind === 'connector' && item.state === 'available' && !needsConfig(item.connector);
  // The switch: every skill (turning one on is a file copy, instant and
  // reversible), and a server that is on or off. Never a server waiting for a
  // key — the card below is how it gets turned on — nor a built-in.
  const isModel = item.kind === 'connector' && item.connector.kind === 'model';
  /* A module connector (Bobble 3D): on, or not added — its Remove turns the
     chat tools off and leaves the studio's engine alone. */
  const isModule = item.kind === 'connector' && item.connector.kind === 'module';
  const moduleState = useConnectorsStore((s) =>
    item.kind === 'connector' ? s.moduleConnectors[item.id] : undefined,
  );
  /* A model connector has no "off": it is downloaded or it is not, and the
     menu's Remove is what deletes it. A switch here would flip and snap back. */
  const switchable =
    !isModel && !isModule && (item.kind === 'skill' || item.state === 'on' || item.state === 'off');
  const failed = failing(item);
  const menu = onEdit !== undefined || onRemove !== undefined;
  const prompt = examplePrompt(item, tools);
  return (
    <div className="pdc-detail-head">
      <ItemMark item={item} size={72} />
      <div className="pdc-detail-title">
        <div className="min-w-0 flex-1">
          <h2 className="pdc-detail-name">{item.name}</h2>
          <p className="pdc-detail-desc">{item.description}</p>
          <p
            className={cx(
              'pdc-detail-state',
              failed ? 'text-status-warning-fg' : 'text-text-muted',
            )}
            data-testid="connector-detail-status"
          >
            <StateDot state={failed ? 'needs-setup' : item.state} />
            {failed
              ? failureLabel(item)
              : isModel
                ? item.state === 'on'
                  ? 'Downloaded · ready'
                  : 'Not downloaded (about 5 GB, once)'
                : isModule
                  ? item.state === 'on'
                    ? 'On · the 3D engine is installed'
                    : moduleState?.ready === true
                      ? 'Not added · the 3D engine is installed'
                      : `Not added · installs the 3D engine${
                          (moduleState?.approxGB ?? 0) > 0
                            ? ` (about ${moduleState?.approxGB} GB, once)`
                            : ''
                        }`
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
        <div className="pdc-detail-actions">
          {busy ? (
            <Spinner size={16} />
          ) : switchable ? (
            <Switch
              checked={item.state === 'on'}
              aria-label={`${item.state === 'on' ? 'Turn off' : 'Turn on'} ${item.name}`}
              data-testid={`connector-toggle-${item.id}`}
              onCheckedChange={(v) => void actions.setOn(item, v === true)}
            />
          ) : null}
          {menu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label="More" data-testid="connector-detail-menu">
                  <IconMore size={16} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onEdit !== undefined ? (
                  <DropdownMenuItem onSelect={onEdit} data-testid="connector-detail-edit">
                    Edit…
                  </DropdownMenuItem>
                ) : null}
                {onEdit !== undefined && onRemove !== undefined ? <DropdownMenuSeparator /> : null}
                {onRemove !== undefined ? (
                  <DropdownMenuItem
                    onSelect={onRemove}
                    className="text-status-danger-fg"
                    data-testid="connector-detail-remove-menu"
                  >
                    Remove…
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {addable && item.kind === 'connector' ? (
            <Button
              variant="accent"
              disabled={busy}
              onClick={() => void actions.add(item)}
              data-testid={`connector-detail-add-${item.id}`}
            >
              {isModel
                ? 'Download (about 5 GB)'
                : isModule && moduleState?.ready !== true
                  ? `Install the 3D engine and add${
                      (moduleState?.approxGB ?? 0) > 0 ? ` (about ${moduleState?.approxGB} GB)` : ''
                    }`
                  : 'Add to Bobble'}
            </Button>
          ) : usable(item) && onTry !== undefined ? (
            <Button
              variant="primary"
              onClick={() => onTry(prompt)}
              data-testid="connector-try-in-chat"
            >
              Try in chat
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The outcome before the inventory: one real ask, drawn the way the chat draws
 * it. The button that sends it is "Try in chat" in the header, where the
 * reference keeps it.
 */
export function TrySection({ item, tools }: { item: Item; tools: readonly Tool[] }): JSX.Element {
  const prompt = examplePrompt(item, tools);
  const ready = usable(item);
  return (
    <section data-testid="connector-try">
      <SectionTitle aside={ready ? undefined : 'once it is on'}>Try it</SectionTitle>
      <div className="pdc-try">
        <div className="pdc-try-bubble" data-testid="connector-try-prompt">
          {prompt}
        </div>
        <p className="text-caption text-text-muted">
          {ready
            ? 'Try in chat opens a new chat with this ready to send. Change it as you like.'
            : item.kind === 'skill'
              ? 'Turn the skill on and it is one click from a chat.'
              : 'Once it is on, it is one click from a chat.'}
        </p>
      </div>
    </section>
  );
}

/**
 * A server that is on and did not start: the reason in its own words, dated,
 * with the remedies as buttons. This is the answer to "why did that tool call
 * fail?", and it sits first, because it is the thing that is wrong.
 */
export function FailureCard({
  item,
  actions,
  onEditKeys,
  onEdit,
}: {
  item: ConnectorItem | CustomItem;
  actions: Actions;
  /** Given on a key-needing connector: reopen the setup card over the saved value. */
  onEditKeys?: () => void;
  onEdit?: () => void;
}): JSX.Element | null {
  const f = item.failure;
  if (f === undefined || !failing(item)) return null;
  const serverId = serverIdOf(item);
  const lastLine = f.stderr?.at(-1);
  const reason = failureReason(f);
  const detail = lastLine !== undefined ? failureReason({ error: f.error }) : undefined;
  const lines = (f.stderr?.length ?? 0) >= 2 ? f.stderr : undefined;
  const server = item.server;
  const retry = () => {
    if (serverId !== null && server !== undefined) {
      void actions.listTools(serverId, commandLine(server));
    }
  };
  return (
    <section className="pdc-fail" data-testid="connector-failure">
      <SectionTitle aside={`tried ${agoLabel(f.at)}`}>{failureLabel(item)}</SectionTitle>
      <div className="flex flex-col gap-2">
        <p className="text-footnote text-text-primary" data-testid="connector-failure-reason">
          {reason}
        </p>
        {lines !== undefined ? (
          <pre className="pdc-stderr" data-testid="connector-failure-stderr">
            {lines.join('\n')}
          </pre>
        ) : null}
        {detail !== undefined ? <p className="text-caption text-text-muted">{detail}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={retry} data-testid="connector-failure-retry">
            <IconRefresh size={12} /> Try again
          </Button>
          {onEditKeys !== undefined ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onEditKeys}
              data-testid="connector-failure-change-key"
            >
              Change the key
            </Button>
          ) : null}
          {onEdit !== undefined ? (
            <Button size="sm" variant="ghost" onClick={onEdit} data-testid="connector-failure-edit">
              Edit
            </Button>
          ) : null}
        </div>
      </div>
    </section>
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
 * the server on — the same `connectors:upsert` the add dialog uses. The button
 * is the accent primary, full width of the card; disabled it is the accent at
 * 40%, which reads as "primary, waiting", not "secondary".
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
  const help = keyHelp(item.connector);
  const save = () => {
    if (!ready || busy) return;
    void actions.setup(item, values).then(() => {
      setValues({});
      onClose?.();
    });
  };
  return (
    <section className="pdc-setup" data-testid="connector-setup">
      <SectionTitle>{editing ? 'Change the key' : 'Before it can run'}</SectionTitle>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
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
                data-testid={`connector-field-${f}`}
              />
            </label>
          );
        })}
        {help !== undefined ? (
          <p className="text-caption text-text-muted" data-testid="connector-setup-help">
            {help.text}
            {help.url !== undefined ? (
              <>
                {' '}
                <a
                  href={help.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-text-link hover:underline"
                >
                  Open <IconExternal size={11} />
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        <p className="text-caption text-text-muted">
          Stays on this Mac, in ~/.pi/desktop/mcp-connectors.json.
        </p>
        <Button
          type="submit"
          variant="accent"
          className="mt-0.5 w-full"
          disabled={!ready || busy}
          data-testid="connector-setup-save"
        >
          Save and turn on
        </Button>
        {editing && onClose !== undefined ? (
          <button
            type="button"
            className="pdc-textbtn pd-focusable self-center"
            onClick={onClose}
            data-testid="connector-setup-cancel"
          >
            Keep the saved key
          </button>
        ) : null}
      </form>
    </section>
  );
}

/**
 * The tools. A built-in's come from the catalog; an installed server's come
 * from the server itself, listed once and REMEMBERED (the tool cache): on
 * every open after the first the list is drawn at once with a caption saying
 * when it was listed. Each row has a switch — on a local model every
 * advertised tool is prompt prefix, so the cost of what is on is a first-class
 * number under the title. `split` groups by the name heuristic and says so.
 */
export function ToolsSection({
  item,
  actions,
  mode,
  split = false,
  cap = 8,
}: {
  item: ConnectorItem | CustomItem;
  actions: Actions;
  mode: McpMode;
  split?: boolean;
  cap?: number;
}): JSX.Element {
  const serverId = serverIdOf(item);
  const cmd = item.server !== undefined ? commandLine(item.server) : '';
  const cached = useCachedTools(serverId ?? '', cmd);
  const failure = useToolFailure(serverId ?? '', cmd);
  const loading = useListing(serverId ?? '');
  const live = item.state === 'on' && serverId !== null;
  const failed = live && failure !== null;

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
  const switchable = item.server !== undefined && item.state !== 'available';
  const cost = toolCost(tools, item.server);
  const offCount = cost.total - cost.on;

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
      className="pdc-textbtn pd-focusable"
      disabled={loading}
      onClick={refresh}
      data-testid="connector-tools-refresh"
    >
      {loading ? <Spinner size={12} /> : <IconRefresh size={12} />} Refresh
    </button>
  ) : undefined;

  const list = (subset: readonly Tool[]) => (
    <ToolList
      tools={subset}
      serverId={serverId ?? item.id}
      cap={cap}
      server={switchable ? item.server : undefined}
      onToggle={switchable ? (name, on) => void actions.setToolOn(item, name, on) : undefined}
    />
  );

  let body: ReactNode;
  if (tools.length === 0 && loading) {
    body = (
      <p className="flex items-center gap-2 text-footnote text-text-muted">
        <Spinner size={14} /> Starting it once to list its tools…
      </p>
    );
  } else if (tools.length === 0 && failed) {
    body = (
      <p className="text-footnote text-text-muted" data-testid="connector-tools-unlisted">
        Not listed yet — it has to start first.
      </p>
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
    body = list(tools);
  } else {
    const looks = tools.filter((t) => toolVerb(t.name) === 'looks-up');
    const changes = tools.filter((t) => toolVerb(t.name) === 'changes');
    const onIn = (subset: readonly Tool[]) =>
      subset.filter((t) => isToolOn(item.server, t.name)).length;
    body = (
      <div className="flex flex-col gap-3">
        {looks.length > 0 ? (
          <div>
            <GroupLabel count={looks.length} on={switchable ? onIn(looks) : undefined}>
              Looks things up
            </GroupLabel>
            {list(looks)}
          </div>
        ) : null}
        {changes.length > 0 ? (
          <div>
            <GroupLabel count={changes.length} on={switchable ? onIn(changes) : undefined}>
              Changes things
            </GroupLabel>
            {list(changes)}
          </div>
        ) : null}
        <p className="text-caption text-text-muted">Grouped by name — a guide, not a guarantee.</p>
      </div>
    );
  }

  return (
    <section data-testid="connector-tools">
      <SectionTitle aside={aside} action={action}>
        Tools
      </SectionTitle>
      {/* A model connector's tool is a command on PATH, not an MCP tool
          reaching the model as a schema — Lite/Native cost is not its axis. */}
      {tools.length > 0 &&
      item.state !== 'available' &&
      !(
        item.kind === 'connector' &&
        (item.connector.kind === 'model' || item.connector.kind === 'module')
      ) ? (
        <p className="mb-2 text-caption text-text-muted" data-testid="connector-tool-cost">
          {offCount > 0 ? `${String(cost.on)} on · ` : ''}
          {mode === 'lite'
            ? `${formatTokens(cost.lite)} tokens per turn in Lite · ${formatTokens(cost.native)} in Native`
            : `${formatTokens(cost.native)} tokens per turn in Native · ${formatTokens(cost.lite)} in Lite`}
          {' — an estimate.'}
        </p>
      ) : null}
      {tools.length > 0 && failed && !loading ? (
        <p className="mb-2 text-caption text-text-muted">This list is from its last answer.</p>
      ) : null}
      {body}
    </section>
  );
}

function GroupLabel({
  children,
  count,
  on,
}: {
  children: string;
  count: number;
  on?: number;
}): JSX.Element {
  return (
    <div className="mb-1 flex items-baseline gap-1.5 text-caption text-text-muted">
      <span className="text-text-secondary">{children}</span>
      <span>
        {count}
        {on !== undefined && on !== count ? ` · ${String(on)} on` : ''}
      </span>
    </div>
  );
}

/**
 * A tool row reads as a sentence first and an identifier second: the sentence
 * is for deciding whether to trust it, the identifier is what appears in the
 * chat when it is called. The switch is what neither reference has.
 */
function ToolList({
  tools,
  serverId,
  cap,
  server,
  onToggle,
}: {
  tools: readonly Tool[];
  serverId: string;
  cap: number;
  server?: Pick<McpServerConfig, 'disabledTools'>;
  onToggle?: (name: string, on: boolean) => void;
}): JSX.Element {
  const [all, setAll] = useState(false);
  // Never hide exactly one row behind a click: a group of cap+1 is whole.
  const capped = tools.length > cap + 1;
  const shown = all || !capped ? tools : tools.slice(0, cap);
  const rest = tools.length - shown.length;
  return (
    <div>
      <ul className="pdc-tools" data-testid="connector-tools-list">
        {shown.map((t) => {
          const plain = humanizeTool(t.name, serverId);
          const on = isToolOn(server, t.name);
          return (
            <li
              key={t.name}
              className="pdc-tool"
              data-on={on}
              data-testid={`connector-tool-${t.name}`}
            >
              <div className="pdc-tool-text">
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
              </div>
              {onToggle !== undefined ? (
                <Switch
                  size="sm"
                  checked={on}
                  aria-label={`${on ? 'Turn off' : 'Turn on'} ${plain}`}
                  data-testid={`connector-tool-toggle-${t.name}`}
                  onCheckedChange={(v) => onToggle(t.name, v === true)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {rest > 0 ? (
        <button
          type="button"
          className="pdc-textbtn pd-focusable mt-1.5"
          onClick={() => setAll(true)}
          data-testid="connector-tools-more"
        >
          Show all {tools.length}
        </button>
      ) : all && capped ? (
        <button
          type="button"
          className="pdc-textbtn pd-focusable mt-1.5"
          onClick={() => setAll(false)}
          data-testid="connector-tools-fewer"
        >
          Show fewer
        </button>
      ) : null}
    </div>
  );
}

/**
 * Where it runs, in the user's terms — and the real command underneath: the
 * INSTALLED server's command and args, never the catalog template's, so a
 * person who edited the JSON sees what is actually running.
 */
export function ReachSection({
  item,
  onChangeKey,
}: {
  item: ConnectorItem;
  /** Given when a key is saved: the Key row offers to change it. */
  onChangeKey?: () => void;
}): JSX.Element {
  const c = item.connector;
  const cmd =
    item.server !== undefined
      ? commandLine(item.server)
      : commandLine({ command: c.template.command, args: c.template.args });
  const remote = isRemote(item.server ?? { args: c.template.args });
  const savedKeys = (c.requiresEnv ?? []).filter((k) => (item.server?.env?.[k] ?? '') !== '');
  return (
    <section>
      <SectionTitle>Reach</SectionTitle>
      <dl className="pdc-spec">
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
              <code className="pdc-cmd" data-testid="connector-detail-command">
                {cmd}
              </code>
              {remote ? (
                <span className="mt-1 block text-caption text-text-muted">
                  A local bridge; the server itself is remote.
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        {savedKeys.length > 0 ? (
          <>
            <dt>{savedKeys.length === 1 ? 'Key' : 'Keys'}</dt>
            <dd>
              {savedKeys.map((k, i) => (
                <span key={k}>
                  {i > 0 ? ', ' : null}
                  <Key>{k}</Key>=••••
                </span>
              ))}
              {onChangeKey !== undefined ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="pdc-link pd-focusable"
                    onClick={onChangeKey}
                    data-testid="connector-change-key"
                  >
                    Change
                  </button>
                </>
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
  if (onSearch === undefined) return <>{label}</>;
  return (
    <button
      type="button"
      className="pdc-link pd-focusable"
      onClick={() => onSearch(label)}
      title={`Show everything in ${label}`}
      data-testid="connector-category-link"
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
    return (
      <section>
        <SectionTitle>About</SectionTitle>
        <dl className="pdc-spec">
          <dt>Kind</dt>
          <dd>
            {c.kind === 'builtin'
              ? 'Built into Bobble'
              : c.kind === 'model'
                ? 'On-device model — runs under its own llama-server'
                : c.kind === 'module'
                  ? "On-device engine — the 3D studio's, offered to the chat"
                  : 'MCP server'}
          </dd>
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
          <p className="mt-2 text-caption text-text-muted" data-testid="connector-community">
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
        <dl className="pdc-spec">
          <dt>Kind</dt>
          <dd>Skill — a playbook Bobble reads</dd>
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
export function HowItRunsSection({
  item,
  onEdit,
}: {
  item: CustomItem;
  onEdit: () => void;
}): JSX.Element {
  const s = item.server;
  const envKeys = Object.keys(s.env ?? {});
  return (
    <section>
      <SectionTitle
        action={
          <button
            type="button"
            className="pdc-textbtn pd-focusable"
            onClick={onEdit}
            data-testid="connector-custom-edit"
          >
            Edit
          </button>
        }
      >
        How it runs
      </SectionTitle>
      <dl className="pdc-spec">
        <dt>Command</dt>
        <dd>
          <code className="pdc-cmd" data-testid="connector-detail-command">
            {commandLine(s)}
          </code>
          {isRemote(s) ? (
            <span className="mt-1 block text-caption text-text-muted">
              A local bridge; the server itself is remote.
            </span>
          ) : null}
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
      <SectionTitle aside="what Bobble reads when this skill is on">The playbook</SectionTitle>
      <div className="pdc-doc rounded-lg border border-border-subtle bg-bg-base px-4 py-3">
        <Markdown data-testid="skill-detail-body">{stripFrontmatter(state.body)}</Markdown>
      </div>
    </section>
  );
}

/**
 * The YAML block a SKILL.md opens with is metadata for the loader, not prose.
 * Rendered as markdown it comes out as one huge run-on paragraph.
 */
export function stripFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * Remove, with the confirmation IN PLACE of the button — never a second
 * modal, never a click that deletes a configured server and its keys with no
 * way back. `armed` can be driven from the header's "…" menu.
 */
export function RemoveRow({
  item,
  busy,
  actions,
  onRemoved,
  armed,
  onArm,
}: {
  item: ConnectorItem | CustomItem;
  busy: boolean;
  actions: Actions;
  onRemoved: () => void;
  armed: boolean;
  onArm: (armed: boolean) => void;
}): JSX.Element | null {
  if (item.state === 'available' || item.state === 'builtin') return null;
  const custom = item.kind === 'custom';
  /* A module connector's Remove takes its tools out of the chat and nothing
     else — the engine is the 3D studio's, and the studio keeps working. */
  const module = item.kind === 'connector' && item.connector.kind === 'module';
  const keys = hasKeys(item) || (custom && Object.keys(item.server.env ?? {}).length > 0);
  return (
    <div
      className="flex items-center justify-between gap-3 border-border-subtle border-t pt-3"
      data-testid="connector-remove-row"
    >
      {armed ? (
        <>
          <span className="text-footnote text-text-primary">
            Remove {item.name}?{' '}
            <span className="text-text-muted">
              {custom
                ? 'Its command is forgotten; nothing else keeps it.'
                : module
                  ? 'Its tools leave the chat; the 3D studio and its engine stay.'
                  : keys
                    ? 'Its key is forgotten; the catalog entry stays.'
                    : 'The catalog entry stays.'}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onArm(false)}>
              Keep
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                void actions.remove(item).then(onRemoved);
              }}
              data-testid="connector-remove-confirm"
            >
              Remove
            </Button>
          </span>
        </>
      ) : (
        <>
          <span className="text-caption text-text-muted">
            {custom
              ? 'Removing forgets the command; nothing else keeps it.'
              : module
                ? 'Removing takes its tools out of the chat; the 3D studio keeps its engine.'
                : keys
                  ? 'Removing forgets its key; the catalog entry stays.'
                  : 'The catalog entry stays; add it again any time.'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onArm(true)}
            data-testid="connector-remove"
          >
            Remove
          </Button>
        </>
      )}
    </div>
  );
}

/** The MCP mode, out of the browsing flow and into one quiet line. */
export function EngineMode({ mode, actions }: { mode: McpMode; actions: Actions }): JSX.Element {
  const modes: McpMode[] = ['lite', 'native', 'bash-cli'];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-caption text-text-muted">Tools reach the model as</span>
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
          data-testid="connectors-mcp-mode"
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
      </div>
      <p className="text-caption text-text-muted leading-snug" data-testid="connectors-mode-hint">
        {MODE_HINT[mode]}
      </p>
    </div>
  );
}
