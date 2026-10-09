/**
 * The threads started in the panel, newest first — continue one here, or open
 * it in Bobble. They are ordinary chats too, so they are in the sidebar as well.
 */
import { IconButton, IconChat, IconExternal } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
import type { QuickThread } from '../../electron/quick/quick-contract';
import { openInMain, openThread } from './quick-panel';

/** "3 min ago", "yesterday" — how a person says when. */
export function whenLabel(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function QuickHistory(): JSX.Element {
  const [threads, setThreads] = useState<QuickThread[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    void window.piDesktop
      .invoke('quick:history', undefined)
      .then((r) => setThreads(r.threads))
      .catch(() => setThreads([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (threads === null || threads.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(threads.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = threads[active];
        if (t === undefined) return;
        if (e.metaKey) openInMain({ kind: 'open-session', file: t.file });
        else void openThread(t.file);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div data-testid="quick-history">
      <div className="qp-view-head">
        <h2 className="pd-display-s">Recent threads</h2>
      </div>
      <p className="qp-view-sub">Continue one here, or open it in Bobble with ⌘↩.</p>
      {threads === null ? null : threads.length === 0 ? (
        <p className="qp-empty">Threads you start here will be listed here.</p>
      ) : (
        <div className="qp-list" role="listbox" aria-label="Recent threads">
          {threads.map((t, i) => (
            <div
              key={t.file}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className="qp-list-row"
              data-active={i === active ? 'true' : 'false'}
              data-testid="quick-history-row"
              onMouseEnter={() => setActive(i)}
              onClick={() => void openThread(t.file)}
              onKeyDown={() => undefined}
            >
              <IconChat size={15} />
              <span className="qp-list-label">{t.title}</span>
              <span className="qp-list-hint">{whenLabel(t.at)}</span>
              <IconButton
                aria-label="Open in Bobble"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  openInMain({ kind: 'open-session', file: t.file });
                }}
              >
                <IconExternal size={13} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
