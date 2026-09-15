/**
 * THE STUDIO'S OWN ENGINE, NOT THE CHAT'S. the user (2026-09-14): "some buttons
 * shouldn't appear / aren't applicable / purpose must be changed to fit eg.
 * proper engines, steps/s for specific studio rather than text always."
 *
 * Next to the studio's name the app showed the chat model's engine menu and
 * its tokens/s — a dial for the wrong machine. This is the 3D studio's: which
 * engine makes the model (the Bobble 3D engine when its core is installed,
 * ComfyUI's native TRELLIS.2 otherwise), and, while a job runs, the sampler's
 * rate in steps a second, read off the job's own step counter.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useGen3dStore } from './gen3d-client';
import { IcCube } from './icons';
import { CORE_MODULE_MODELS } from './module-state';

const STEP_RE = /\(?(?:step )?(\d+)\s*\/\s*(\d+)\)?/;

export function StudioEngineChip(): JSX.Element {
  const job = useGen3dStore((s) => s.job);
  const comfy = useGen3dStore((s) => s.comfy);
  const engineReady = useGen3dStore((s) => s.engineReady);
  const models = useGen3dStore((s) => s.models);
  const engineCore =
    engineReady && CORE_MODULE_MODELS.every((id) => models.find((m) => m.id === id)?.installed);
  const engine = engineCore
    ? 'Bobble 3D engine'
    : comfy?.ready === true
      ? 'ComfyUI · TRELLIS.2'
      : 'No engine yet';

  // Steps a second, from the last two distinct step readings.
  const last = useRef<{ step: number; at: number } | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const message = job !== null && !job.done ? job.message : null;
  useEffect(() => {
    if (message === null) {
      last.current = null;
      setRate(null);
      return;
    }
    const m = STEP_RE.exec(message);
    if (m === null) return;
    const step = Number(m[1]);
    const now = performance.now();
    const prev = last.current;
    if (prev !== null && step > prev.step && now > prev.at) {
      setRate(((step - prev.step) * 1000) / (now - prev.at));
    } else if (prev !== null && step < prev.step) {
      // A new sampler started: its first reading is a baseline, not a rate.
      setRate(null);
    }
    last.current = { step, at: now };
  }, [message]);

  return (
    <span className="tp-engine-chip" data-testid="tp-engine-chip" title={engine}>
      <IcCube size={13} />
      <span className="tp-engine-chip-name">{engine}</span>
      {rate !== null ? (
        <span className="tp-engine-chip-rate" data-testid="tp-engine-rate">
          {rate >= 10 ? Math.round(rate) : rate.toFixed(1)} steps/s
        </span>
      ) : null}
    </span>
  );
}
