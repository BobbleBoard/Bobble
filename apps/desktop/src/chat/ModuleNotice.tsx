/**
 * THE MODULE CARDS IN THE CHAT — above the composer, exactly while they are
 * called for.
 *
 * Two triggers. A module is WANTED: a generation the model asked for is
 * waiting at the gate for it (gen-modules.ts), and the person pressing
 * Download here is what lets that job continue. Or the newest tool result
 * carries the module marker: the wait ran out or the card was closed, the
 * model has been told, and the button stays one turn longer so the person can
 * still put the module in and ask again. A module the person closed this
 * session stays closed unless a new job wants it.
 */

import { useEffect, useMemo } from 'react';
import { type GenModuleId, MODULE_MARKER_RE } from '../../electron/gen/gen-modules';
import { ModuleCard } from '../media/ModuleCard';
import { useGenModulesStore } from '../state/gen-modules-store';
import { usePiStore } from '../state/pi-slice';

/** The module markers in the last assistant turn's tool results. */
function markedInLatestTurn(messages: readonly unknown[]): GenModuleId[] {
  const out = new Set<GenModuleId>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { kind?: string; text?: string };
    if (m.kind === 'user') break;
    if (m.kind !== 'toolResult' || typeof m.text !== 'string') continue;
    const hit = MODULE_MARKER_RE.exec(m.text);
    if (hit !== null) out.add(hit[1] as GenModuleId);
  }
  return [...out];
}

export function ModuleNotice() {
  const modules = useGenModulesStore((s) => s.modules);
  const closed = useGenModulesStore((s) => s.closed);
  const refresh = useGenModulesStore((s) => s.refresh);
  const loaded = useGenModulesStore((s) => s.loaded);
  const messages = usePiStore((s) => s.messages);
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);
  const marked = useMemo(() => markedInLatestTurn(messages), [messages]);
  const show = modules.filter(
    (m) =>
      !m.ready && (m.wanted || m.installing || (marked.includes(m.id) && !closed.includes(m.id))),
  );
  if (show.length === 0) return null;
  return (
    <div className="pd-module-notice" data-testid="module-notice">
      {show.map((m) => (
        <ModuleCard
          key={m.id}
          id={m.id}
          place="chat"
          why={m.wanted ? 'The model is waiting to use it.' : undefined}
        />
      ))}
    </div>
  );
}
