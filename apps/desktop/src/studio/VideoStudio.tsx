/**
 * THE VIDEO STUDIO.
 *
 * The same program as the image studio with a far worse cost curve, and the
 * controls answer to that rather than mirroring it out of symmetry. There is no
 * COUNT here: a batch of four clips is many minutes per attempt on hardware
 * where a single clip is already the slowest thing the app does.
 *
 * WHAT CHANGED, AND WHY:
 *
 *   LENGTH IS A CHOICE, NOT A SPINNER — and the choices name what they COST.
 *   The old pair of number fields let you ask for 30 seconds at 60fps: an
 *   1800-frame job, entered by accident in two keystrokes, that nothing in the
 *   room could then stop. The label carried "· 120 frames", which was the right
 *   instinct in the machine's unit; a person's unit is minutes.
 *
 *   FPS IS GONE. 24, because the thing you are making is a film clip. It was a
 *   number field whose only real use was multiplying the render time.
 *
 *   SHAPE, NOT PIXELS, for the same reason as the image studio.
 */
import { type JSX, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { RunHeader, StudioJob } from './StudioRun';
import { Knob, Segmented, StudioEmpty, StudioShell } from './StudioShell';
import { useStudio } from './use-studio';

const SHAPES = [
  { value: 'landscape', label: 'Landscape', size: '768x512' },
  { value: 'square', label: 'Square', size: '512x512' },
  { value: 'portrait', label: 'Portrait', size: '576x1024' },
] as const;

type Shape = (typeof SHAPES)[number]['value'];

/** 24fps, fixed. The only reason this was ever a control was to multiply cost. */
const FPS = 24;

const LENGTHS = [
  { value: 2, label: '2s', hint: 'about 48 frames' },
  { value: 4, label: '4s', hint: 'about 96 frames' },
  { value: 8, label: '8s', hint: 'about 192 frames — the slowest option' },
] as const;

const EXAMPLES = [
  'A paper boat drifting down a rain gutter, close up',
  'Steam rising from a coffee cup by a window',
  'Neon sign flickering in the rain at night',
];

export function VideoStudio(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [shape, setShape] = useState<Shape>('landscape');
  const [seconds, setSeconds] = useState<number>(4);

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel } = useStudio('video');
  const models = useMemo(() => catalog.filter((m) => m.modality === 'video'), [catalog]);
  const size = SHAPES.find((s) => s.value === shape)?.size ?? '768x512';

  return (
    <StudioShell
      testid="video-studio"
      title="Video Studio"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="Describe a shot…"
      onRun={() =>
        void run({
          kind: 'video',
          prompt,
          size,
          seconds,
          fps: FPS,
          ...(model !== '' ? { model } : {}),
        })
      }
      busy={busy}
      runLabel="Generate"
      {...(models.length === 0 ? { blocked: 'No video models are available.' } : {})}
      error={error}
      controls={
        <>
          <Knob label="Length">
            <Segmented
              testid="video-seconds"
              value={seconds}
              onChange={setSeconds}
              options={LENGTHS.map((l) => ({ value: l.value, label: l.label, hint: l.hint }))}
            />
          </Knob>
          <Knob label="Shape">
            <Segmented
              testid="video-shape"
              value={shape}
              onChange={setShape}
              options={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </Knob>
          <Knob label="Model">
            <select
              className="pd-studio-select pd-focusable"
              data-testid="video-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Recommended</option>
              {/*
                A MODEL THAT CANNOT RUN IS SHOWN AS UNAVAILABLE, not offered.
                `reserved` marks catalogue entries whose backend has not landed
                — the dropdowns listed them exactly like the rest, so
                "Recommended" worked and any model you picked by NAME failed.
                Disabled and labelled is better than hidden: the entry is real,
                it is coming, and picking it is the one thing that must not
                quietly fail.
              */}
              {models.map((m) => (
                <option key={m.id} value={m.id} disabled={m.reserved === true}>
                  {m.label}
                  {m.reserved === true ? ' — not available yet' : ''}
                </option>
              ))}
            </select>
          </Knob>
        </>
      }
    >
      {job !== null ? <StudioJob job={job} onCancel={cancel} /> : null}
      {runs.length === 0 && job === null ? (
        <StudioEmpty
          glyph={<GlyphVideo />}
          title="Make short clips on this machine"
          body="Every second is another two dozen frames to render, so start short. Nothing leaves your Mac."
          examples={EXAMPLES}
          onPick={setPrompt}
        />
      ) : (
        runs.map((r) => (
          <section key={r.at} className="pd-studio-run">
            <RunHeader run={r} onAgain={() => setPrompt(r.prompt)} />
            <ThreadMedia items={r.items} layout="single" />
          </section>
        ))
      )}
    </StudioShell>
  );
}

function GlyphVideo(): JSX.Element {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Clips</title>
      <rect
        x="2.5"
        y="5.5"
        width="13"
        height="13"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M15.5 10.5l5-3v9l-5-3z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
