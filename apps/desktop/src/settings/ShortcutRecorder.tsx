/**
 * A SHORTCUT RECORDER — press the keys you want, see at once what they would
 * collide with.
 *
 * Click it, press a chord: the chord is shown as you hold the modifiers, and
 * checked the moment the key lands (electron/quick/hotkeys.ts). A key macOS or
 * every app already owns is refused in a sentence that says whose it is; a key
 * that merely shares with a launcher or an editor is kept with a note. Esc
 * stops recording and keeps the old key, Backspace takes the key away.
 *
 * Every registered hotkey is let go while recording — a live global key would
 * be swallowed before this field could see it.
 */
import { IconButton, IconClose } from '@pi-desktop/ui';
import { type JSX, useEffect, useRef, useState } from 'react';
import {
  type HotkeyConflict,
  hotkeyCaps,
  hotkeyConflicts,
  type QuickAction,
  recordKey,
} from '../../electron/quick/hotkeys';
import './shortcut-recorder.css';

export function ShortcutRecorder({
  action,
  value,
  assigned,
  onChange,
  testid,
}: {
  action: QuickAction;
  value: string | null;
  /** Every action's key, so a clash with another action is caught here. */
  assigned: Readonly<Record<QuickAction, string | null>>;
  onChange: (accelerator: string | null) => void;
  testid?: string;
}): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<readonly string[]>([]);
  const [refused, setRefused] = useState<HotkeyConflict | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;
    void window.piDesktop
      .invoke('quick:suspend-hotkeys', { suspended: true })
      .catch(() => undefined);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const got = recordKey(e);
      if (got.kind === 'pending') {
        setPending(got.caps);
        return;
      }
      if (got.kind === 'cancel') {
        setRecording(false);
        return;
      }
      if (got.kind === 'clear') {
        setRecording(false);
        setRefused(null);
        onChange(null);
        return;
      }
      const block = hotkeyConflicts(got.accelerator, { action, assigned }).find(
        (c) => c.severity === 'block',
      );
      if (block !== undefined) {
        // Stay recording: the next try is one keypress away.
        setRefused(block);
        setPending([]);
        return;
      }
      setRefused(null);
      setRecording(false);
      onChange(got.accelerator);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const got = recordKey(e);
      if (got.kind === 'pending') setPending(got.caps);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      void window.piDesktop
        .invoke('quick:suspend-hotkeys', { suspended: false })
        .catch(() => undefined);
    };
  }, [recording, action, assigned, onChange]);

  const caps = recording ? pending : hotkeyCaps(value);
  const warnings =
    !recording && value !== null
      ? hotkeyConflicts(value, { action, assigned }).filter((c) => c.severity === 'warn')
      : [];

  return (
    <div className="pd-shortcut" data-testid={testid}>
      <div className="pd-shortcut-row">
        <button
          ref={ref}
          type="button"
          className="pd-shortcut-field pd-focusable"
          data-recording={recording ? 'true' : 'false'}
          aria-label={recording ? 'Press the new keys' : 'Change the shortcut'}
          onClick={() => {
            setPending([]);
            setRefused(null);
            setRecording((r) => !r);
          }}
          onBlur={() => setRecording(false)}
        >
          {caps.length > 0 ? (
            caps.map((c) => (
              <kbd key={c} className="pd-shortcut-cap">
                {c}
              </kbd>
            ))
          ) : (
            <span className="pd-shortcut-empty">{recording ? 'Press the keys' : 'None'}</span>
          )}
        </button>
        <IconButton
          aria-label="Remove this shortcut"
          size="sm"
          className={value !== null && !recording ? undefined : 'pd-shortcut-spacer'}
          disabled={value === null || recording}
          tabIndex={value !== null && !recording ? 0 : -1}
          onClick={() => onChange(null)}
        >
          <IconClose size={12} />
        </IconButton>
      </div>
      {recording && refused !== null ? (
        <p className="pd-shortcut-note" data-testid={testid ? `${testid}-refused` : undefined}>
          Can't use that: {refused.reason} Try another.
        </p>
      ) : recording ? (
        <p className="pd-shortcut-note">Press the keys. Esc keeps the current one.</p>
      ) : warnings.length > 0 ? (
        <p className="pd-shortcut-note" data-testid={testid ? `${testid}-warning` : undefined}>
          {warnings.map((w) => w.reason).join(' ')}
        </p>
      ) : null}
    </div>
  );
}
