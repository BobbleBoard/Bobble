/**
 * THE VIDEO STUDIO.
 *
 * Same program as the image studio with a different cost curve, and the controls
 * reflect that rather than mirroring it out of symmetry. There is no COUNT here:
 * a batch of four videos is minutes of work per attempt on hardware where a
 * single clip is already the slowest thing the app does, and offering it invites
 * a mistake that cannot be taken back once it is queued.
 *
 * LENGTH AND FPS ARE THE EXPENSIVE KNOBS and are labelled with what they cost —
 * a person choosing 10 seconds at 30fps should be able to see, before pressing
 * the button, that they have asked for three hundred frames.
 */
import { type JSX, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { Knob, StudioEmpty, StudioShell } from './StudioShell';
import { useStudio } from './use-studio';

const SIZES = ['768x512', '512x512', '1024x576', '576x1024'] as const;

export function VideoStudio(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [size, setSize] = useState<string>('768x512');
  const [seconds, setSeconds] = useState(5);
  const [fps, setFps] = useState(24);
  const [negative, setNegative] = useState('');

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, run } = useStudio();
  const models = useMemo(() => catalog.filter((m) => m.modality === 'video'), [catalog]);

  const frames = Math.max(1, Math.round(seconds * fps));

  return (
    <StudioShell
      testid="video-studio"
      title="Video Studio"
      subtitle="Make short clips on this machine"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="A paper boat drifting down a rain gutter, close up…"
      onRun={() =>
        void run({
          kind: 'video',
          prompt,
          size,
          seconds,
          fps,
          ...(model !== '' ? { model } : {}),
          ...(negative !== '' ? { negativePrompt: negative } : {}),
        })
      }
      busy={busy}
      runLabel="Generate"
      {...(models.length === 0 ? { blocked: 'No video models are available.' } : {})}
      error={error}
      controls={
        <>
          <Knob label="Model">
            <select
              className="pd-studio-select pd-focusable"
              data-testid="video-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Recommended</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Knob>
          <Knob label="Size">
            <select
              className="pd-studio-select pd-focusable"
              data-testid="video-size"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Knob>
          {/* The label carries the COST, not just the value — 10s at 30fps is
              three hundred frames and the number should be visible before the
              button is pressed, not discovered while waiting. */}
          <Knob label={`Length · ${frames} frames`}>
            <input
              className="pd-studio-input pd-studio-input--num pd-focusable"
              data-testid="video-seconds"
              type="number"
              min={1}
              max={30}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
          </Knob>
          <Knob label="FPS">
            <input
              className="pd-studio-input pd-studio-input--num pd-focusable"
              data-testid="video-fps"
              type="number"
              min={1}
              max={60}
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
            />
          </Knob>
          <Knob label="Avoid">
            <input
              className="pd-studio-input pd-studio-input--wide pd-focusable"
              data-testid="video-negative"
              value={negative}
              placeholder="optional"
              onChange={(e) => setNegative(e.target.value)}
            />
          </Knob>
        </>
      }
    >
      {runs.length === 0 ? (
        <StudioEmpty>
          Describe a shot and press Generate. Keep it short — every second is another two dozen
          frames to render.
        </StudioEmpty>
      ) : (
        runs.map((r) => (
          <section key={r.at} className="pd-studio-run">
            <p className="pd-studio-run-prompt">{r.prompt}</p>
            <ThreadMedia items={r.items} />
          </section>
        ))
      )}
    </StudioShell>
  );
}
