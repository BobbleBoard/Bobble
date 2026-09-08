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

const listeners = new Set<() => void>();
let armed = false;

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
  if (armed) {
    // Disarmed as it fires, so the re-mount after "Reload" comes up clean —
    // which is the behaviour being tested.
    armed = false;
    throw new Error('Maximum update depth exceeded (test seam)');
  }
  return null;
}
