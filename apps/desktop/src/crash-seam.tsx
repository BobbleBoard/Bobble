/**
 * A way to make the app throw on purpose.
 *
 * The crash card is the screen nobody can test by waiting for it: it appears
 * only when something else is broken, which is precisely when you are not in a
 * position to check that its buttons work. the user found out they did not the hard
 * way — twice, on a screen he reached because the app had already failed him.
 *
 * So a probe can ask for it: with `?piE2E=1` (the same opt-in the store and
 * theme accessors use), `window.__pi_crash()` makes the next render throw, the
 * boundary catches it, and the recovery path can be driven and LOOKED AT like
 * any other screen. Nothing is armed without that flag, and the component
 * renders nothing at all in a normal launch.
 */
import { useEffect, useState } from 'react';
import { onSoftReload } from './app-reload';

const listeners = new Set<() => void>();
let armed = false;

/*
 * DISARMED BY THE RECOVERY, NOT BY THE THROW.
 *
 * The first cut cleared the flag as it threw, and the boundary then never
 * caught anything: React re-renders a component that throws a second time to
 * recreate the error, and on that replay the seam was already disarmed, so the
 * render "succeeded" and the crash card never appeared. Clearing it when the
 * app is re-mounted instead is both correct and what a probe wants — the throw
 * survives every replay React makes, and Reload comes up clean.
 */
onSoftReload(() => {
  armed = false;
});

/** True once a probe has asked for a throw. */
export function crashArmed(): boolean {
  return armed;
}

if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('piE2E')) {
  (window as unknown as { __pi_crash: () => void }).__pi_crash = () => {
    armed = true;
    for (const l of [...listeners]) l();
  };
}

/** Mounted inside the error boundary; throws when {@link crashArmed} says so. */
export function CrashSeam(): null {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = (): void => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  if (armed) throw new Error('Maximum update depth exceeded (test seam)');
  return null;
}
