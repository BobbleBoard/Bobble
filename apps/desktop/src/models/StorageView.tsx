/**
 * MANAGE STORAGE — what is on disk, where, and how big, sorted the way the
 * app is.
 *
 * the user (2026-09-12): "a page in the model manager that says 'Manage Storage'
 * — this shows a UI that lets us visually navigate and see how much is being
 * taken up, and view and delete models, sorted the same way, always with a
 * 'Reveal' button easy to see and use if desired."
 *
 * And on the first cut (2026-09-13): no raw "Move to Trash?" text — a dialog
 * with "don't show again"; a red Delete beside every Reveal; Reveal as a
 * rounded rectangle in the theme's inverse (white on dark, black on light);
 * search, sort by size and by recent; folders collapsed by default; no blurbs
 * ("people know what they are"); compact rows with the size prominent and
 * coloured (green under 1 GB, yellow under 10, red above) instead of bars; the
 * tree pushed left with a card on the right — the disk summary, or the model
 * you clicked (icon, parameters, size, Delete / Reveal / Export); a Select
 * mode with checkboxes for bulk Delete/Export, counted in the top-right; and
 * nothing that is only a button once you hover it.
 *
 * The tree is the library's own folders, so what the page shows is what
 * Finder shows when Reveal is pressed — there is no second model of the disk
 * to disagree with the first.
 */
import {
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconBrain,
  IconChevronRight,
  IconFile,
  IconFolderOpen,
  IconGears,
  IconImage,
  IconMore,
  IconPuzzle,
  IconRefresh,
  IconTrash,
  IconVideo,
  IconWaveform,
} from '@pi-desktop/ui';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StorageNode, StorageOverview } from '../../electron/storage/storage-contract';
import { formatBytes } from '../settings/model-manager-logic';
import { useSettingsStore } from '../state/settings-store';
import { useOutsideClose } from './use-outside-close';

const cx = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(' ');

export function bytesLabel(n: number): string {
  if (n <= 0) return '0 MB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  return formatBytes(n);
}

/** the user: "<1gb green <10gb yellow otherwise red". */
export function sizeTone(bytes: number): 'green' | 'yellow' | 'red' {
  if (bytes < 1e9) return 'green';
  if (bytes < 10e9) return 'yellow';
  return 'red';
}

type SortKey = 'size' | 'recent' | 'name';

/** Newest first / biggest first / A→Z, within one level of the tree. */
export function sortNodes(nodes: readonly StorageNode[], by: SortKey): StorageNode[] {
  const out = [...nodes];
  if (by === 'size') out.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  else if (by === 'recent') {
    out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.name.localeCompare(b.name));
  } else out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** A node, or any descendant, whose name matches the query. */
export function matchesQuery(node: StorageNode, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  if (node.name.toLowerCase().includes(needle)) return true;
  return (node.children ?? []).some((c) => matchesQuery(c, needle));
}

function modalityIcon(node: StorageNode, size = 16): ReactNode {
  const m = node.meta?.modality ?? (node.kind === 'modality' ? node.name : '');
  if (node.kind === 'tool' || m === 'Support') return <IconGears size={size} />;
  switch (m) {
    case 'LLM':
      return <IconBrain size={size} />;
    case 'Image':
      return <IconImage size={size} />;
    case 'Video':
      return <IconVideo size={size} />;
    case '3D':
      return <IconPuzzle size={size} />;
    case 'Audio':
      return <IconWaveform size={size} />;
    default:
      return <IconFile size={size} />;
  }
}

function when(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '';
  const d = new Date(ms);
  const days = (Date.now() - ms) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.floor(days)} days ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Every path under `node`, itself included — what selecting a folder selects. */
function pathsUnder(node: StorageNode): string[] {
  return [node.path, ...(node.children ?? []).flatMap(pathsUnder)];
}

export function StorageView() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('size');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StorageNode[] | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const hideConfirm = useSettingsStore((s) => s.settings.hideDeleteModelConfirm);

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    setError(null);
    try {
      const o = await window.piDesktop.invoke('storage:overview', { fresh });
      setOverview(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      window.piDesktop.onEvent('storage:move', (p) => {
        if (p.phase === 'copying') {
          setProgress(`Copying the library… ${bytesLabel(p.copied)} of ${bytesLabel(p.total)}`);
        } else if (p.phase === 'removing') setProgress('Removing the old copy…');
        else {
          setProgress(null);
          if (p.phase === 'failed') setNote(p.error ?? 'the move failed');
          if (p.phase === 'done') void load(true);
        }
      }),
    [load],
  );
  useEffect(
    () =>
      window.piDesktop.onEvent('storage:export', (p) => {
        if (p.phase === 'copying') {
          setProgress(
            `Exporting ${p.current ?? ''}… ${bytesLabel(p.copied)} of ${bytesLabel(p.total)}`,
          );
        } else {
          setProgress(null);
          if (p.phase === 'failed') setNote(p.error ?? 'the export failed');
        }
      }),
    [],
  );

  // ── the tree ──────────────────────────────────────────────────────────────
  const roots = useMemo<StorageNode[]>(() => {
    if (overview === null) return [];
    const tools: StorageNode = {
      name: 'Engines & tools',
      path: overview.supportRoot,
      bytes: overview.support.reduce((s, n) => s + n.bytes, 0),
      kind: 'dir',
      children: overview.support,
      mtime: overview.support.reduce((m, n) => Math.max(m, n.mtime ?? 0), 0),
    };
    return [...(overview.library.children ?? []), tools];
  }, [overview]);
  const byPath = useMemo(() => {
    const map = new Map<string, StorageNode>();
    const walk = (n: StorageNode) => {
      map.set(n.path, n);
      for (const c of n.children ?? []) walk(c);
    };
    for (const r of roots) walk(r);
    return map;
  }, [roots]);
  const focus = focusPath === null ? null : (byPath.get(focusPath) ?? null);
  const q = query.trim();

  // ── actions ───────────────────────────────────────────────────────────────
  const reveal = async (path: string): Promise<void> => {
    const r = await window.piDesktop.invoke('storage:reveal', { path });
    if (!r.ok) setNote(r.error ?? 'could not reveal');
  };

  const runDelete = async (nodes: readonly StorageNode[]): Promise<void> => {
    setPendingDelete(null);
    const r = await window.piDesktop.invoke('storage:trash', { paths: nodes.map((n) => n.path) });
    const done = nodes.length - r.failed.length;
    const first = r.failed[0];
    setNote(
      done > 0
        ? `${done === 1 ? nodes[0]?.name : `${done} items`} moved to the Trash — ${bytesLabel(r.freed)} freed once it is emptied.${first !== undefined ? ` ${first.error}.` : ''}`
        : (first?.error ?? 'nothing was deleted'),
    );
    setSelected(new Set());
    if (focusPath !== null && nodes.some((n) => n.path === focusPath)) setFocusPath(null);
    await load(true);
  };

  const requestDelete = (nodes: readonly StorageNode[]): void => {
    if (nodes.length === 0) return;
    if (hideConfirm) {
      void runDelete(nodes);
      return;
    }
    setDontAsk(false);
    setPendingDelete([...nodes]);
  };

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return;
    if (dontAsk) await useSettingsStore.getState().update({ hideDeleteModelConfirm: true });
    await runDelete(pendingDelete);
  };

  const exportNodes = async (nodes: readonly StorageNode[]): Promise<void> => {
    if (nodes.length === 0) return;
    setNote(null);
    const r = await window.piDesktop.invoke('storage:export', { paths: nodes.map((n) => n.path) });
    if (r.cancelled === true) return;
    if (!r.ok) setNote(r.error ?? 'the export failed');
    else {
      setNote(
        `Exported ${nodes.length === 1 ? nodes[0]?.name : `${nodes.length} items`} to ${r.dest}.`,
      );
    }
  };

  const changeRoot = async (): Promise<void> => {
    const picked = await window.piDesktop.invoke('storage:pick-root', undefined);
    if (picked.path === null) return;
    setNote(null);
    const r = await window.piDesktop.invoke('storage:set-root', { path: picked.path });
    if (!r.ok) setNote(r.error ?? 'could not move the library');
    else {
      setNote(`The library is now at ${r.root}.`);
      await load(true);
    }
  };
  const resetRoot = async (): Promise<void> => {
    const r = await window.piDesktop.invoke('storage:set-root', { path: null });
    if (!r.ok) setNote(r.error ?? 'could not move the library');
    else await load(true);
  };

  /** Selection: a folder stands for everything in it; its rows are then shown ticked and inert. */
  const toggleSelect = (node: StorageNode) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else {
        for (const p of pathsUnder(node)) next.delete(p);
        next.add(node.path);
      }
      return next;
    });
  };
  const ancestorSelected = (path: string): boolean =>
    [...selected].some((s) => s !== path && path.startsWith(`${s}/`));
  const selectedNodes = [...selected]
    .map((p) => byPath.get(p))
    .filter((n): n is StorageNode => n !== undefined);
  const selectedBytes = selectedNodes.reduce((s, n) => s + n.bytes, 0);

  if (overview === null) {
    return (
      <div className="pd-storage" data-testid="storage-view">
        <p className="pd-storage-empty">{error ?? 'Measuring what is on disk…'}</p>
      </div>
    );
  }

  const supportBytes = overview.support.reduce((s, n) => s + n.bytes, 0);
  const isDefault = overview.libraryRoot === overview.defaultLibraryRoot;
  const disk = overview.disk;

  const row = (node: StorageNode, depth: number): ReactNode => {
    if (!matchesQuery(node, q)) return null;
    const kids = node.children ?? [];
    const hasKids = kids.length > 0;
    // Collapsed by default; a search opens whatever holds a match.
    const open = q !== '' ? true : (expanded[node.path] ?? false);
    const deletable = node.kind !== 'dir' && node.kind !== 'root';
    const isSelected = selected.has(node.path);
    const inherited = ancestorSelected(node.path);
    const focused = focusPath === node.path;
    return (
      <div key={node.path} className="pd-storage-node" data-kind={node.kind} data-depth={depth}>
        <div
          className={cx('pd-storage-row', focused && 'pd-storage-row--focused')}
          data-testid={`storage-row-${node.kind}`}
          data-path={node.path}
        >
          {selecting ? (
            <Checkbox
              className="pd-storage-check"
              checked={isSelected || inherited}
              disabled={inherited}
              aria-label={`Select ${node.name}`}
              onCheckedChange={() => toggleSelect(node)}
              data-testid="storage-select"
            />
          ) : null}
          {hasKids ? (
            <button
              type="button"
              className="pd-storage-twisty"
              aria-expanded={open}
              aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
              onClick={() => setExpanded((e) => ({ ...e, [node.path]: !open }))}
            >
              <IconChevronRight size={13} className={cx(open && 'pd-storage-twisty--open')} />
            </button>
          ) : (
            <span className="pd-storage-twisty pd-storage-twisty--none" />
          )}
          <button
            type="button"
            className="pd-storage-name"
            onClick={() => setFocusPath(focused ? null : node.path)}
            aria-pressed={focused}
            data-testid="storage-name"
          >
            <span className="pd-storage-name-text">{node.name}</span>
            {node.hubLinked ? <span className="pd-storage-chip">linked</span> : null}
            {node.inUse ? (
              <span className="pd-storage-chip pd-storage-chip--live">serving now</span>
            ) : null}
          </button>
          <span
            className="pd-storage-size"
            data-tone={sizeTone(node.bytes)}
            data-testid="storage-size"
          >
            {bytesLabel(node.bytes)}
          </span>
          <div className="pd-storage-actions">
            <button
              type="button"
              className="pd-btn-reveal"
              onClick={() => void reveal(node.path)}
              data-testid="storage-reveal"
              title={node.path}
            >
              <IconFolderOpen size={13} />
              Reveal
            </button>
            {deletable ? (
              <button
                type="button"
                className="pd-btn-delete"
                onClick={() => requestDelete([node])}
                disabled={node.inUse === true}
                title={
                  node.inUse === true
                    ? 'Being served right now — stop it first'
                    : 'Move to the Trash'
                }
                data-testid="storage-delete"
              >
                <IconTrash size={13} />
                Delete
              </button>
            ) : null}
            {deletable ? (
              <RowMenu
                open={menuFor === node.path}
                onOpen={() => setMenuFor(menuFor === node.path ? null : node.path)}
                onClose={() => setMenuFor(null)}
                items={[
                  { label: 'Export…', onSelect: () => void exportNodes([node]) },
                  {
                    label: 'Copy path',
                    onSelect: () => void navigator.clipboard.writeText(node.path).catch(() => {}),
                  },
                ]}
              />
            ) : null}
          </div>
        </div>
        {hasKids && open ? (
          <div className="pd-storage-children">
            {sortNodes(kids, sort).map((c) => row(c, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="pd-storage" data-testid="storage-view">
      <div className="pd-storage-toolbar">
        <input
          type="search"
          className="pd-storage-search pd-focusable"
          placeholder="Search models…"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="storage-search"
        />
        <fieldset className="pd-storage-seg" aria-label="Sort by">
          {(
            [
              ['size', 'Size'],
              ['recent', 'Recent'],
              ['name', 'Name'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={cx('pd-storage-seg-btn', sort === k && 'pd-storage-seg-btn--on')}
              aria-pressed={sort === k}
              onClick={() => setSort(k)}
              data-testid={`storage-sort-${k}`}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <span className="pd-storage-toolbar-gap" />
        {selecting ? (
          <>
            <button
              type="button"
              className="pd-btn-delete pd-btn-delete--solid"
              disabled={selectedNodes.length === 0}
              onClick={() => requestDelete(selectedNodes)}
              data-testid="storage-delete-selected"
            >
              <IconTrash size={13} />
              Delete ({selectedNodes.length})
            </button>
            <button
              type="button"
              className="pd-btn-plain"
              disabled={selectedNodes.length === 0}
              onClick={() => void exportNodes(selectedNodes)}
              data-testid="storage-export-selected"
            >
              Export ({selectedNodes.length})
            </button>
            <button
              type="button"
              className="pd-btn-plain"
              onClick={() => {
                setSelecting(false);
                setSelected(new Set());
              }}
              data-testid="storage-select-done"
            >
              Done
            </button>
          </>
        ) : (
          <button
            type="button"
            className="pd-btn-plain"
            onClick={() => {
              setSelecting(true);
              setFocusPath(null);
            }}
            data-testid="storage-select-mode"
          >
            Select
          </button>
        )}
        <button
          type="button"
          className="pd-btn-plain pd-btn-plain--icon"
          onClick={() => void load(true)}
          disabled={busy}
          aria-label="Measure again"
          title="Measure again"
        >
          <IconRefresh size={14} className={cx(busy && 'pd-storage-spin')} />
        </button>
      </div>

      {progress !== null ? (
        <div className="pd-storage-banner" data-testid="storage-progress">
          {progress}
        </div>
      ) : null}
      {note !== null ? (
        <div className="pd-storage-banner" data-testid="storage-note">
          {note}
        </div>
      ) : null}

      <div className="pd-storage-body">
        <div className="pd-storage-tree" data-testid="storage-library">
          {roots.length === 0 ? (
            <p className="pd-storage-empty">Nothing downloaded yet — the library is empty.</p>
          ) : (
            sortNodes(roots, sort).map((r) => row(r, 0))
          )}
          {q !== '' && roots.every((r) => !matchesQuery(r, q)) ? (
            <p className="pd-storage-empty">Nothing matches “{q}”.</p>
          ) : null}
        </div>

        <aside className="pd-storage-side">
          {focus !== null ? (
            <div className="pd-storage-card" data-testid="storage-inspector">
              <div className="pd-storage-card-head">
                <span className="pd-storage-card-icon">{modalityIcon(focus, 22)}</span>
                <div className="pd-storage-card-title">
                  <div className="pd-storage-card-name">{focus.name}</div>
                  <div className="pd-storage-card-meta">
                    {[
                      focus.meta?.params,
                      focus.meta?.quant,
                      focus.meta?.org,
                      focus.kind === 'modality' || focus.kind === 'shelf' || focus.kind === 'dir'
                        ? `${focus.children?.length ?? 0} items`
                        : undefined,
                    ]
                      .filter((x): x is string => typeof x === 'string' && x !== '')
                      .join(' · ')}
                  </div>
                </div>
                <button
                  type="button"
                  className="pd-storage-card-close"
                  aria-label="Close"
                  onClick={() => setFocusPath(null)}
                >
                  ×
                </button>
              </div>
              <div className="pd-storage-card-size" data-tone={sizeTone(focus.bytes)}>
                {bytesLabel(focus.bytes)}
              </div>
              <div className="pd-storage-card-actions">
                {focus.kind !== 'dir' ? (
                  <button
                    type="button"
                    className="pd-btn-delete pd-btn-delete--solid"
                    onClick={() => requestDelete([focus])}
                    disabled={focus.inUse === true}
                    data-testid="inspector-delete"
                  >
                    <IconTrash size={14} />
                    Delete
                  </button>
                ) : null}
                <button
                  type="button"
                  className="pd-btn-reveal"
                  onClick={() => void reveal(focus.path)}
                  data-testid="inspector-reveal"
                >
                  <IconFolderOpen size={14} />
                  Reveal
                </button>
                <button
                  type="button"
                  className="pd-btn-plain"
                  onClick={() => void exportNodes([focus])}
                  data-testid="inspector-export"
                >
                  Export
                </button>
              </div>
              <dl className="pd-storage-card-facts">
                {focus.fileCount !== undefined ? (
                  <>
                    <dt>Files</dt>
                    <dd>{focus.fileCount}</dd>
                  </>
                ) : null}
                {when(focus.mtime) !== '' ? (
                  <>
                    <dt>Modified</dt>
                    <dd>{when(focus.mtime)}</dd>
                  </>
                ) : null}
                {focus.meta?.repo !== undefined ? (
                  <>
                    <dt>Repo</dt>
                    <dd>{focus.meta.repo}</dd>
                  </>
                ) : null}
                <dt>Path</dt>
                <dd className="pd-storage-card-path">{focus.path}</dd>
                {focus.hubLinked ? (
                  <>
                    <dt>Note</dt>
                    <dd>The engine reaches it through a link; deleting here removes both.</dd>
                  </>
                ) : null}
                {focus.inUse ? (
                  <>
                    <dt>Note</dt>
                    <dd>Being served right now — stop the model before deleting.</dd>
                  </>
                ) : null}
              </dl>
            </div>
          ) : (
            <div className="pd-storage-card" data-testid="storage-summary">
              <div className="pd-storage-sum">
                <div className="pd-storage-sum-line">
                  <span className="pd-storage-sum-big" data-tone={sizeTone(overview.library.bytes)}>
                    {bytesLabel(overview.library.bytes)}
                  </span>
                  <span>of models</span>
                </div>
                <div className="pd-storage-sum-line">
                  <span className="pd-storage-sum-big">{bytesLabel(supportBytes)}</span>
                  <span>of engines &amp; tools</span>
                </div>
                {disk.total > 0 ? (
                  <div className="pd-storage-sum-line">
                    <span className="pd-storage-sum-big">{bytesLabel(disk.free)}</span>
                    <span>free on this disk</span>
                  </div>
                ) : null}
                {disk.total > 0 ? (
                  <div className="pd-storage-diskbar" aria-hidden>
                    <div
                      className="pd-storage-diskbar-lib"
                      style={{ width: `${(overview.library.bytes / disk.total) * 100}%` }}
                    />
                    <div
                      className="pd-storage-diskbar-support"
                      style={{ width: `${(supportBytes / disk.total) * 100}%` }}
                    />
                    <div
                      className="pd-storage-diskbar-other"
                      style={{
                        width: `${Math.max(0, ((disk.total - disk.free - overview.library.bytes - supportBytes) / disk.total) * 100)}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>
              <code
                className="pd-storage-card-path pd-storage-card-path--root"
                data-testid="storage-root"
              >
                {overview.libraryRoot}
              </code>
              <div className="pd-storage-card-actions">
                <button
                  type="button"
                  className="pd-btn-reveal"
                  onClick={() => void reveal(overview.libraryRoot)}
                  data-testid="storage-reveal-root"
                >
                  <IconFolderOpen size={14} />
                  Reveal
                </button>
                <button
                  type="button"
                  className="pd-btn-plain"
                  onClick={() => void changeRoot()}
                  disabled={progress !== null}
                  data-testid="storage-change-root"
                >
                  Change location…
                </button>
                {!isDefault ? (
                  <button
                    type="button"
                    className="pd-btn-plain"
                    onClick={() => void resetRoot()}
                    disabled={progress !== null}
                  >
                    Back to default
                  </button>
                ) : null}
              </div>
              {overview.migration !== null && overview.migration.moved > 0 ? (
                <p className="pd-storage-card-foot" data-testid="storage-migration">
                  Moved {overview.migration.moved} items out of the old cache
                  {overview.migration.unsorted.length > 0
                    ? `; ${overview.migration.unsorted.length} in Unsorted`
                    : ''}
                  .
                </p>
              ) : null}
              <p className="pd-storage-card-foot">
                Measured in {(overview.scanMs / 1000).toFixed(1)} s.
              </p>
            </div>
          )}
        </aside>
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
      >
        <DialogContent data-testid="delete-model-dialog" className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {pendingDelete !== null && pendingDelete.length === 1
                ? `Delete ${pendingDelete[0]?.name}?`
                : `Delete ${pendingDelete?.length ?? 0} items?`}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-body text-text-secondary">
              {bytesLabel(pendingDelete?.reduce((s, n) => s + n.bytes, 0) ?? 0)} goes to the Trash —
              recoverable until you empty it. A model an engine reaches through a link loses the
              link too.
            </p>
            {pendingDelete !== null && pendingDelete.length > 1 ? (
              <ul className="pd-storage-dialog-list">
                {pendingDelete.slice(0, 8).map((n) => (
                  <li key={n.path}>
                    {n.name} <span>{bytesLabel(n.bytes)}</span>
                  </li>
                ))}
                {pendingDelete.length > 8 ? <li>…and {pendingDelete.length - 8} more</li> : null}
              </ul>
            ) : null}
            <label
              htmlFor="delete-model-dontask"
              className="mt-3 flex cursor-pointer items-center gap-2 text-footnote text-text-muted"
            >
              <Checkbox
                id="delete-model-dontask"
                checked={dontAsk}
                onCheckedChange={(v) => setDontAsk(v === true)}
                data-testid="delete-model-dontask"
              />
              Don’t show again
            </label>
          </DialogBody>
          <DialogFooter>
            <button
              type="button"
              className="pd-btn-ghost pd-focusable"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pd-btn-danger pd-focusable"
              data-testid="delete-model-confirm"
              onClick={() => void confirmDelete()}
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {selecting && selectedNodes.length > 0 ? (
        <div className="pd-storage-selbar" data-testid="storage-selection-bar">
          {selectedNodes.length} selected · {bytesLabel(selectedBytes)}
        </div>
      ) : null}
    </div>
  );
}

/** The row's "…": Export and Copy path, in a small menu that closes on an outside press. */
function RowMenu({
  open,
  onOpen,
  onClose,
  items,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  items: readonly { label: string; onSelect: () => void }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(open, ref, onClose);
  return (
    <div className="pd-storage-more" ref={ref}>
      <button
        type="button"
        className="pd-btn-plain pd-btn-plain--icon"
        aria-label="More"
        aria-expanded={open}
        onClick={onOpen}
        data-testid="storage-more"
      >
        <IconMore size={14} />
      </button>
      {open ? (
        <div className="pd-storage-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="pd-storage-menu-item"
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
