/**
 * MANAGE STORAGE — what is on disk, where, and how big, sorted the way the
 * app is; Reveal on every row; delete to the Trash; move the whole library.
 *
 * the user (2026-09-12): "a page in the model manager that says 'Manage Storage'
 * — this shows a UI that lets us visually navigate and see how much is being
 * taken up, and view and delete models, sorted the same way, always with a
 * 'Reveal' button easy to see and use if desired."
 *
 * The tree is the library's own folders (LLM · Image · Video · 3D · Audio ·
 * Support · Unsorted, each with its shelves), so what the page shows is what
 * Finder shows when Reveal is pressed — there is no second model of the disk
 * to disagree with the first.
 */
import { IconChevronRight, IconFolderOpen, IconRefresh, IconTrash } from '@pi-desktop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { StorageNode, StorageOverview } from '../../electron/storage/storage-contract';
import { formatBytes } from '../settings/model-manager-logic';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

function bytesLabel(n: number): string {
  if (n <= 0) return '0 MB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} KB`;
  return formatBytes(n);
}

/** The share of `total` a node takes, for the usage bars; 0 when nothing to compare. */
function share(bytes: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, bytes / total)) : 0;
}

export function StorageView() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ copied: number; total: number; phase: string } | null>(
    null,
  );

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
        setMoving(p.phase === 'done' || p.phase === 'failed' ? null : p);
        if (p.phase === 'failed') setNote(p.error ?? 'the move failed');
        if (p.phase === 'done') void load(true);
      }),
    [load],
  );

  const reveal = async (path: string): Promise<void> => {
    const r = await window.piDesktop.invoke('storage:reveal', { path });
    if (!r.ok) setNote(r.error ?? 'could not reveal');
  };

  const trash = async (node: StorageNode): Promise<void> => {
    setConfirming(null);
    const r = await window.piDesktop.invoke('storage:trash', { path: node.path });
    if (!r.ok) {
      setNote(r.error ?? 'could not delete');
      return;
    }
    setNote(`${node.name} moved to the Trash (${bytesLabel(r.freed ?? 0)} freed once emptied).`);
    await load(true);
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

  if (overview === null) {
    return (
      <div className="pd-storage" data-testid="storage-view">
        <p className="pd-storage-note">{error ?? 'Measuring what is on disk…'}</p>
      </div>
    );
  }

  const lib = overview.library;
  const supportBytes = overview.support.reduce((s, n) => s + n.bytes, 0);
  const used = lib.bytes + supportBytes;
  const disk = overview.disk;
  const isDefault = overview.libraryRoot === overview.defaultLibraryRoot;

  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !(o[key] ?? false) }));

  const row = (node: StorageNode, depth: number): React.ReactNode => {
    const hasKids = node.children !== undefined && node.children.length > 0;
    const key = node.path;
    const expanded = open[key] ?? depth === 0;
    const isLeaf = node.kind === 'model' || node.kind === 'file' || node.kind === 'tool';
    return (
      <div key={key} className="pd-storage-node" data-kind={node.kind} data-depth={depth}>
        <div
          className={cx('pd-storage-row', isLeaf && 'pd-storage-row--leaf')}
          data-testid={`storage-row-${node.kind}`}
          data-path={node.path}
        >
          {hasKids ? (
            <button
              type="button"
              className="pd-storage-twisty"
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
              onClick={() => toggle(key)}
            >
              <IconChevronRight size={14} className={cx(expanded && 'pd-storage-twisty--open')} />
            </button>
          ) : (
            <span className="pd-storage-twisty pd-storage-twisty--none" />
          )}
          <div className="pd-storage-main">
            <div className="pd-storage-name">
              <span>{node.name}</span>
              {node.hubLinked ? <span className="pd-storage-chip">linked</span> : null}
              {node.inUse ? (
                <span className="pd-storage-chip pd-storage-chip--live">serving now</span>
              ) : null}
              {node.kind === 'file' ? <span className="pd-storage-chip">file</span> : null}
            </div>
            {node.note !== undefined ? (
              <div className="pd-storage-note-line">{node.note}</div>
            ) : null}
            {depth <= 1 && node.bytes > 0 ? (
              <div className="pd-storage-bar" aria-hidden>
                <div
                  className="pd-storage-bar-fill"
                  style={{ width: `${Math.max(1, share(node.bytes, used) * 100)}%` }}
                />
              </div>
            ) : null}
          </div>
          <div className="pd-storage-size" data-testid="storage-size">
            {bytesLabel(node.bytes)}
          </div>
          <div className="pd-storage-actions">
            <button
              type="button"
              className="pd-storage-reveal"
              onClick={() => void reveal(node.path)}
              data-testid="storage-reveal"
              title={node.path}
            >
              <IconFolderOpen size={14} />
              Reveal
            </button>
            {isLeaf && node.kind !== 'tool' ? (
              confirming === node.path ? (
                <span className="pd-storage-confirm" data-testid="storage-confirm">
                  <span>Move to Trash?</span>
                  <button
                    type="button"
                    className="pd-storage-danger"
                    onClick={() => void trash(node)}
                    data-testid="storage-trash-confirm"
                  >
                    Trash
                  </button>
                  <button
                    type="button"
                    className="pd-storage-quiet"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="pd-storage-quiet"
                  aria-label={`Delete ${node.name}`}
                  onClick={() => setConfirming(node.path)}
                  data-testid="storage-trash"
                  disabled={node.inUse === true}
                  title={
                    node.inUse === true
                      ? 'Being served right now — stop it first'
                      : 'Move to the Trash'
                  }
                >
                  <IconTrash size={14} />
                </button>
              )
            ) : null}
          </div>
        </div>
        {hasKids && expanded ? (
          <div className="pd-storage-children">{node.children?.map((c) => row(c, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="pd-storage" data-testid="storage-view">
      <header className="pd-storage-head">
        <div className="pd-storage-where">
          <div className="pd-storage-title">Your models live in</div>
          <code className="pd-storage-path" data-testid="storage-root">
            {overview.libraryRoot}
          </code>
          <div className="pd-storage-where-actions">
            <button
              type="button"
              className="pd-storage-reveal pd-storage-reveal--big"
              onClick={() => void reveal(overview.libraryRoot)}
              data-testid="storage-reveal-root"
            >
              <IconFolderOpen size={16} />
              Reveal in Finder
            </button>
            <button
              type="button"
              className="pd-storage-quiet"
              onClick={() => void changeRoot()}
              disabled={moving !== null}
              data-testid="storage-change-root"
            >
              Change location…
            </button>
            {!isDefault ? (
              <button
                type="button"
                className="pd-storage-quiet"
                onClick={() => void resetRoot()}
                disabled={moving !== null}
              >
                Back to default
              </button>
            ) : null}
            <button
              type="button"
              className="pd-storage-quiet"
              onClick={() => void load(true)}
              disabled={busy}
              aria-label="Measure again"
              title="Measure again"
            >
              <IconRefresh size={14} className={cx(busy && 'pd-storage-spin')} />
            </button>
          </div>
        </div>
        <div className="pd-storage-disk" data-testid="storage-disk">
          <div className="pd-storage-disk-line">
            <span>
              <strong>{bytesLabel(lib.bytes)}</strong> of models
            </span>
            <span>{bytesLabel(supportBytes)} of engines &amp; tools</span>
            {disk.total > 0 ? <span>{bytesLabel(disk.free)} free on this disk</span> : null}
          </div>
          {disk.total > 0 ? (
            <div className="pd-storage-diskbar" aria-hidden>
              <div
                className="pd-storage-diskbar-lib"
                style={{ width: `${share(lib.bytes, disk.total) * 100}%` }}
              />
              <div
                className="pd-storage-diskbar-support"
                style={{ width: `${share(supportBytes, disk.total) * 100}%` }}
              />
              <div
                className="pd-storage-diskbar-other"
                style={{
                  width: `${share(disk.total - disk.free - lib.bytes - supportBytes, disk.total) * 100}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      </header>

      {moving !== null ? (
        <div className="pd-storage-banner" data-testid="storage-moving">
          {moving.phase === 'copying'
            ? `Copying the library… ${bytesLabel(moving.copied)} of ${bytesLabel(moving.total)}`
            : 'Removing the old copy…'}
        </div>
      ) : null}
      {note !== null ? (
        <div className="pd-storage-banner" data-testid="storage-note">
          {note}
        </div>
      ) : null}
      {overview.migration !== null && overview.migration.moved > 0 ? (
        <div className="pd-storage-banner pd-storage-banner--quiet" data-testid="storage-migration">
          Moved {overview.migration.moved} items out of ~/.cache into the library
          {overview.migration.unsorted.length > 0
            ? ` — ${overview.migration.unsorted.length} could not be placed and sit in Unsorted`
            : ''}
          {overview.migration.skipped.length > 0
            ? ` — ${overview.migration.skipped.length} left where they were (${overview.migration.skipped[0]?.why})`
            : ''}
          .
        </div>
      ) : null}

      <section className="pd-storage-section" data-testid="storage-library">
        {lib.children !== undefined && lib.children.length > 0 ? (
          lib.children.map((m) => row(m, 0))
        ) : (
          <p className="pd-storage-note">Nothing downloaded yet — the library is empty.</p>
        )}
      </section>

      <section className="pd-storage-section" data-testid="storage-support">
        <h3 className="pd-storage-h3">Engines &amp; tools</h3>
        <p className="pd-storage-note">
          Python environments, llama.cpp builds and the workers' scratch, at{' '}
          <code className="pd-storage-path-inline">{overview.supportRoot}</code>. Re-creatable from
          Settings → Engines; the Hugging Face cache inside links into the library.
        </p>
        {overview.support.map((n) => row(n, 1))}
      </section>
      <p className="pd-storage-foot">Measured in {(overview.scanMs / 1000).toFixed(1)} s.</p>
    </div>
  );
}
