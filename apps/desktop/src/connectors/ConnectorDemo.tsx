/**
 * TRY IT, PLAYED — the connector at work, the way the chat shows it.
 *
 * the user (2026-10-08): "for the connectors I would imagine we want a prominent
 * card that shows a little animation of an input text bubble sliding up, and
 * then some model response that goes 'Sure i'll use <the connector> to do this'
 * the 'used <connector>' tool visual, a sped up 'worked for nm ns' and then
 * done".
 *
 * The parts are the chat's own: the ask in the user's bubble, a line of reply,
 * and the real ActivityChain with the connector's real row — its brand mark,
 * "Using <name>" while it runs and "Used <name>" after — under a "Worked for"
 * that counts a minute and more in under two seconds, then Done. It plays once
 * when the page opens and again on Replay; with Reduce Motion it shows the
 * finished exchange.
 */
import { ActivityChain, type ActivityStepData, IconRefresh } from '@pi-desktop/ui';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { examplePrompt, humanizeTool, type Item, serverIdOf, type Tool, toolVerb } from './model';

type Phase = 'idle' | 'asked' | 'said' | 'working' | 'done';
const ORDER: readonly Phase[] = ['idle', 'asked', 'said', 'working', 'done'];
const at = (p: Phase, q: Phase) => ORDER.indexOf(p) >= ORDER.indexOf(q);

/** How long the work "took" — what the counter reaches. */
const WORKED_MS = 72_000;
/** How long the counter takes to get there, for real. */
const COUNT_MS = 1700;

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function ConnectorDemo({
  item,
  tools,
}: {
  item: Item;
  tools: readonly Tool[];
}): JSX.Element {
  const prompt = examplePrompt(item, tools);
  const serverId = serverIdOf(item) ?? undefined;
  const first = tools.find((t) => toolVerb(t.name) === 'looks-up') ?? tools[0];
  const action = first === undefined ? undefined : humanizeTool(first.name, serverId).toLowerCase();
  const iconSvg = item.kind === 'connector' ? item.connector.iconSvg : undefined;

  const [phase, setPhase] = useState<Phase>(() => (reducedMotion() ? 'done' : 'idle'));
  const [worked, setWorked] = useState(() => (reducedMotion() ? WORKED_MS : 0));
  const timers = useRef<number[]>([]);
  const raf = useRef(0);

  const play = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    cancelAnimationFrame(raf.current);
    timers.current = [];
    if (reducedMotion()) {
      setPhase('done');
      setWorked(WORKED_MS);
      return;
    }
    setPhase('idle');
    setWorked(0);
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    later(250, () => setPhase('asked'));
    later(1050, () => setPhase('said'));
    later(1800, () => {
      setPhase('working');
      const start = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - start) / COUNT_MS);
        // Fast at first, easing into the total — a sped-up clock, not a linear one.
        setWorked(Math.round(WORKED_MS * (1 - (1 - t) ** 2)));
        if (t < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    });
    later(1800 + COUNT_MS + 150, () => setPhase('done'));
  }, []);

  useEffect(() => {
    play();
    return () => {
      for (const t of timers.current) window.clearTimeout(t);
      cancelAnimationFrame(raf.current);
    };
  }, [play]);

  const done = phase === 'done';
  const step: ActivityStepData = {
    id: 'demo-call',
    kind: 'connector',
    label: done ? `Used ${item.name}` : `Using ${item.name}`,
    status: done ? 'done' : 'running',
    ...(action !== undefined ? { detail: action } : {}),
    ...(iconSvg !== undefined ? { iconSvg } : {}),
  } as ActivityStepData;

  return (
    <div className="pdc-demo" data-testid="connector-demo" data-phase={phase}>
      <div className="pdc-demo-thread">
        <div
          className="pdc-try-bubble pdc-demo-ask"
          data-shown={at(phase, 'asked')}
          data-testid="connector-try-prompt"
        >
          {prompt}
        </div>
        <p className="pdc-demo-reply" data-shown={at(phase, 'said')}>
          Sure, I&rsquo;ll use {item.name} to do this.
        </p>
        <div className="pdc-demo-work" data-shown={at(phase, 'working')}>
          <ActivityChain
            steps={[step]}
            expanded
            active={!done}
            complete={done}
            wallMs={worked}
            summary={done || worked > 0 ? `Worked for ${clock(worked)}` : undefined}
          />
        </div>
      </div>
      <button
        type="button"
        className="pdc-demo-replay pd-focusable"
        onClick={play}
        aria-label="Play it again"
        title="Play it again"
        data-testid="connector-demo-replay"
      >
        <IconRefresh size={14} />
        Replay
      </button>
    </div>
  );
}

/** 72000 → "1m 12s"; under a minute, "8s". */
function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
