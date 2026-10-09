/**
 * "Which window?" — every window on screen with its app's real icon and a small
 * picture of it, Bobble's own never among them. Or click one on screen instead.
 */
import { Button, IconPickWindow } from '@pi-desktop/ui';
import { type JSX, useEffect, useState } from 'react';
import type { QuickProblem, QuickWindowChoice } from '../../electron/quick/quick-contract';
import { captureInto } from './quick-panel';
import { useQuickStore } from './quick-store';

export function WindowPicker(): JSX.Element {
  const [windows, setWindows] = useState<QuickWindowChoice[] | null>(null);
  const [active, setActive] = useState(0);
  const set = useQuickStore((s) => s.set);
  const showProblem = useQuickStore((s) => s.showProblem);

  useEffect(() => {
    let live = true;
    void window.piDesktop
      .invoke('quick:list-windows', undefined)
      .then((r) => {
        if (!live) return;
        if (!r.ok && r.problem !== undefined) {
          const problem: QuickProblem = r.problem;
          set({ view: 'home' });
          showProblem(problem, () => set({ view: 'windows' }));
          return;
        }
        setWindows(r.windows);
      })
      .catch(() => {
        if (live) setWindows([]);
      });
    return () => {
      live = false;
    };
  }, [set, showProblem]);

  const pick = (w: QuickWindowChoice) => void captureInto('window', w.windowId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (windows === null || windows.length === 0) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(windows.length - 1, i + (e.key === 'ArrowDown' ? 3 : 1)));
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - (e.key === 'ArrowUp' ? 3 : 1)));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const w = windows[active];
        if (w !== undefined) pick(w);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div data-testid="quick-window-picker">
      <div className="qp-view-head">
        <h2 className="pd-display-s">Which window?</h2>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void captureInto('pick')}
          data-testid="quick-pick-on-screen"
        >
          <IconPickWindow size={14} />
          Click one on screen
        </Button>
      </div>
      <p className="qp-view-sub">Bobble looks only at the window you choose.</p>
      {windows === null ? (
        <p className="qp-empty">Finding your windows</p>
      ) : windows.length === 0 ? (
        <p className="qp-empty">No other windows are open.</p>
      ) : (
        <div className="qp-windows">
          {windows.map((w, i) => (
            <button
              key={w.windowId}
              type="button"
              className="qp-window pd-focusable"
              data-active={i === active ? 'true' : 'false'}
              data-testid="quick-window"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(w)}
            >
              {w.thumbnail !== null ? (
                <img className="qp-window-shot" src={w.thumbnail} alt="" />
              ) : (
                <span className="qp-window-shot" />
              )}
              <span className="qp-window-meta">
                {w.icon !== null ? <img src={w.icon} alt="" /> : null}
                <span className="qp-window-names">
                  <span className="qp-window-app">{w.app !== '' ? w.app : w.title}</span>
                  {w.app !== '' && w.title !== '' ? (
                    <span className="qp-window-title">{w.title}</span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
