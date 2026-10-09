/**
 * THE MACHINE SPOKE — a pill at the top when the guardian stopped or is holding
 * a generation to keep the computer responsive.
 *
 * The user: "computer just became unusably laggy … needs monitoring for cpu and mem
 * pressure to ensure extremes like this absolutely never happen." The guardian
 * (electron/gen/guardian-main.ts) now cancels a heavy job before the OS gets to
 * that point. A generation that stops on its own, with no explanation, reads as
 * the app breaking; this is the explanation, in the same shape as the
 * needs-input banner three lines above it in ChatApp so it is one vocabulary.
 *
 * Shown for a `shed` (a job was cancelled) and for a `hold` that lasts, because
 * "the mark is animating and nothing is happening" needs a sentence beside it.
 * A `calm` verdict clears it. Nothing here retries the job — that is the
 * person's call, and the studio's Generate button is right there.
 */
import { type ReactNode, useEffect, useState } from 'react';

type Notice = { kind: 'shed' | 'hold' | 'pause'; text: string; at: number };

/** "the 3D model", "the 3D model and the chat", "a, b and c" — the heavy work first. */
function listOf(labels: readonly string[]): string {
  const ordered = [...labels].sort((a, b) => Number(a === 'the chat') - Number(b === 'the chat'));
  if (ordered.length <= 1) return ordered.join('');
  return `${ordered.slice(0, -1).join(', ')} and ${ordered.at(-1)}`;
}

/** How long a shed notice stays after the machine has recovered. */
const LINGER_MS = 12_000;

/**
 * Rendered IN THE TOP BAR'S CENTRE, not floated over the page. A fixed pill
 * anywhere under the bar lands on something — a studio's panel title, the
 * viewport's gizmo (the user: "overlap such as this must be fixed on sight") —
 * while the bar's centre is the status slot in the chat and empty in every
 * studio. `fallback` is what the slot shows when there is nothing to say.
 */
export function GuardianBanner({ fallback = null }: { fallback?: ReactNode } = {}) {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const off = window.piDesktop.onEvent('gen:guardian', (event) => {
      const { verdict, reason, shed, queued } = event;
      if (verdict === 'pause') {
        // The running work is stopped in place, not lost — say so, and what
        // is stopped, so the frozen progress bar reads as the guard and not
        // as the app dying. The user (2026-09-16): pause rather than terminate.
        const what = event.paused ?? [];
        setNotice({
          kind: 'pause',
          text: `Paused ${what.length === 0 ? 'generating' : listOf(what)} to keep your Mac responsive — ${reason}`,
          at: Date.now(),
        });
        return;
      }
      if (verdict === 'shed') {
        const n = shed?.length ?? 0;
        // At the wall with nothing of ours running there is nothing to stop —
        // but there is still something to say, because nothing will start.
        setNotice({
          kind: 'shed',
          text:
            n === 0
              ? `Memory is at its limit — not starting generations (${reason})`
              : `Stopped ${n === 1 ? 'a generation' : `${n} generations`} to keep your Mac responsive — ${reason}`,
          at: Date.now(),
        });
        return;
      }
      if (verdict === 'hold') {
        // A hold with nothing waiting is the machine's business, not the
        // person's — SEEN as "Waiting to generate" over an idle chat.
        if ((queued ?? 0) === 0) {
          setNotice((cur) => (cur?.kind === 'hold' ? null : cur));
          return;
        }
        // A hold replaces nothing more important: a recent shed keeps its line.
        setNotice((cur) =>
          cur?.kind === 'shed' && Date.now() - cur.at < LINGER_MS
            ? cur
            : { kind: 'hold', text: `Waiting to generate — ${reason}`, at: Date.now() },
        );
        return;
      }
      // calm: a hold or a pause clears at once (a resume names what went on
      // for a moment); a shed lingers long enough to be read.
      const resumed = event.resumed ?? [];
      setNotice((cur) => {
        if (cur?.kind === 'pause' && resumed.length > 0) {
          return { kind: 'hold', text: `Resumed ${listOf(resumed)}`, at: Date.now() };
        }
        if (cur === null || cur.kind === 'hold' || cur.kind === 'pause') return null;
        return cur;
      });
    });
    return () => off();
  }, []);

  // The shed line leaves on its own; so does the "Resumed …" line.
  useEffect(() => {
    if (notice?.kind !== 'shed' && !(notice?.kind === 'hold' && notice.text.startsWith('Resumed')))
      return;
    const t = setTimeout(() => setNotice(null), notice.kind === 'shed' ? LINGER_MS : 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (notice === null) return <>{fallback}</>;
  return (
    <div className="pd-guardian-banner flex min-w-0 max-w-full justify-center">
      <output
        className="flex min-w-0 items-center gap-2 rounded-full border border-border-subtle bg-bg-raised px-3.5 py-1 text-footnote"
        data-testid="guardian-banner"
        data-kind={notice.kind}
        aria-live="polite"
      >
        <span
          className={
            notice.kind === 'shed' || notice.kind === 'pause'
              ? 'pd-chat-dot pd-chat-dot--needs-input'
              : 'pd-chat-dot pd-chat-dot--finished'
          }
        />
        <span className="text-text-primary truncate">{notice.text}</span>
      </output>
    </div>
  );
}
