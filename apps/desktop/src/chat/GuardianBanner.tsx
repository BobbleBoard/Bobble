/**
 * THE MACHINE SPOKE — a pill at the top when the guardian stopped or is holding
 * a generation to keep the computer responsive.
 *
 * the user: "computer just became unusably laggy … needs monitoring for cpu and mem
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
import { useEffect, useState } from 'react';

type Notice = { kind: 'shed' | 'hold'; text: string; at: number };

/** How long a shed notice stays after the machine has recovered. */
const LINGER_MS = 12_000;

export function GuardianBanner() {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const off = window.piDesktop.onEvent('gen:guardian', ({ verdict, reason, shed }) => {
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
        // A hold replaces nothing more important: a recent shed keeps its line.
        setNotice((cur) =>
          cur?.kind === 'shed' && Date.now() - cur.at < LINGER_MS
            ? cur
            : { kind: 'hold', text: `Waiting to generate — ${reason}`, at: Date.now() },
        );
        return;
      }
      // calm: a hold clears at once; a shed lingers long enough to be read.
      setNotice((cur) => {
        if (cur === null || cur.kind === 'hold') return null;
        return cur;
      });
    });
    return () => off();
  }, []);

  // The shed line leaves on its own.
  useEffect(() => {
    if (notice?.kind !== 'shed') return;
    const t = setTimeout(() => setNotice(null), LINGER_MS);
    return () => clearTimeout(t);
  }, [notice]);

  if (notice === null) return null;
  return (
    <div className="pd-guardian-banner fixed top-3 left-1/2 z-[80] -translate-x-1/2 max-w-[min(640px,92vw)]">
      <output
        className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised px-3.5 py-1.5 text-footnote shadow-[0_8px_24px_rgb(0_0_0/0.22)]"
        data-testid="guardian-banner"
        data-kind={notice.kind}
        aria-live="polite"
      >
        <span
          className={
            notice.kind === 'shed'
              ? 'pd-chat-dot pd-chat-dot--needs-input'
              : 'pd-chat-dot pd-chat-dot--finished'
          }
        />
        <span className="text-text-primary truncate">{notice.text}</span>
      </output>
    </div>
  );
}
