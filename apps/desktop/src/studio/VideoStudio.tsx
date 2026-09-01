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
import { type JSX, useCallback, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { RunHeader, StudioJob } from './StudioRun';
import {
  Knob,
  RailGroup,
  RailToggle,
  Segmented,
  StudioEmpty,
  StudioShell,
  type StudioStarter,
} from './StudioShell';
import { useStudioUiStore } from './studio-ui-store';
import { useEnhancer } from './use-enhancer';
import { useStudio } from './use-studio';

/**
 * SHAPE × SIZE, written out for the same reason as the image studio: computing
 * a ratio and snapping to a multiple of 64 silently breaks the ratio (16:9 at a
 * 512 long edge becomes 512×320, which is 16:10).
 */
const SHAPES = [
  { value: 'landscape', label: '16:9', of: (n: number) => `${n}x${(n * 9) / 16}` },
  { value: 'square', label: '1:1', of: (n: number) => `${n}x${n}` },
  { value: 'portrait', label: '9:16', of: (n: number) => `${(n * 9) / 16}x${n}` },
] as const;

/**
 * The long edge. Far smaller numbers than the image studio's, and that is not
 * timidity — a clip is this many pixels times twenty-four times the number of
 * seconds, so the same step costs about two orders of magnitude more here than
 * it does for one still.
 */
const SIZES = [
  { value: 512, label: 'Draft', hint: 'fastest — for checking the motion' },
  { value: 768, label: 'Standard', hint: 'near what these models were trained at' },
  { value: 1024, label: 'Large', hint: 'minutes per clip on this machine' },
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
  const [long, setLong] = useState<number>(512);
  const [seconds, setSeconds] = useState<number>(4);
  const [steps, setSteps] = useState<number | ''>('');
  const [seed, setSeed] = useState<number | ''>('');

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel } = useStudio('video');
  const models = useMemo(() => catalog.filter((m) => m.modality === 'video'), [catalog]);
  const size = (SHAPES.find((x) => x.value === shape) ?? SHAPES[0]).of(long);
  const enhancer = useEnhancer(useCallback((next: string) => setPrompt(next), []));
  const setSettingsOpen = useStudioUiStore((st) => st.setSettingsOpen);

  /*
   * Three cards, and every one of them is about COST as much as content —
   * because in this room that is the decision. A first clip at 8 seconds and
   * "Large" is several minutes before you learn the prompt was wrong.
   */
  const starters: readonly StudioStarter[] = [
    {
      id: 'shot',
      icon: <GlyphClapper />,
      title: 'Describe a shot',
      hint: 'One subject, one continuous action, one place.',
      onPick: () => {
        setShape('landscape');
        setSeconds(4);
        setPrompt(EXAMPLES[0] ?? '');
      },
    },
    {
      id: 'draft',
      icon: <GlyphStopwatch />,
      title: 'Quick draft',
      hint: 'Two seconds at the smallest size — check the motion first.',
      onPick: () => {
        setSeconds(2);
        setLong(512);
        setPrompt(EXAMPLES[1] ?? '');
      },
    },
    {
      id: 'vertical',
      icon: <GlyphPhone />,
      title: 'Vertical clip',
      hint: '9:16, the shape a phone actually plays it in.',
      onPick: () => {
        setShape('portrait');
        setSeconds(4);
        setPrompt(EXAMPLES[2] ?? '');
        setSettingsOpen(true);
      },
    },
  ];

  const onRun = async (): Promise<void> => {
    const enhanced = await enhancer.enhance('video', prompt, model);
    await run({
      kind: 'video',
      prompt: enhanced,
      size,
      seconds,
      fps: FPS,
      ...(model !== '' ? { model } : {}),
      ...(steps !== '' ? { steps } : {}),
      ...(seed !== '' ? { seed } : {}),
    });
  };

  return (
    <StudioShell
      testid="video-studio"
      title="Video Studio"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="Describe a shot…"
      onRun={() => void onRun()}
      busy={busy || enhancer.enhancing}
      runLabel={enhancer.enhancing ? 'Enhancing…' : 'Generate'}
      {...(models.length === 0 ? { blocked: 'No video models are available.' } : {})}
      error={error}
      controls={
        <Knob label="Length">
          <Segmented
            testid="video-seconds"
            value={seconds}
            onChange={setSeconds}
            options={LENGTHS.map((l) => ({ value: l.value, label: l.label, hint: l.hint }))}
          />
        </Knob>
      }
      settings={
        <>
          <RailGroup title="Shape">
            <Knob label="Aspect ratio">
              <Segmented
                testid="video-shape"
                value={shape}
                onChange={setShape}
                options={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
              />
            </Knob>
            <Knob label="Size">
              <Segmented
                testid="video-size"
                value={long}
                onChange={setLong}
                options={SIZES.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))}
              />
            </Knob>
            <p className="pd-studio-rail-note" data-testid="video-pixels">
              {size.replace('x', ' × ')} px · {FPS} fps · {seconds * FPS} frames
            </p>
          </RailGroup>

          <RailGroup title="Prompt">
            <RailToggle
              testid="video-enhance"
              label="Prompt enhancer"
              hint="Rewrites your line so the MOTION is described first — the difference between a clip and an expensive photograph."
              checked={enhancer.enabled}
              onChange={enhancer.setEnabled}
            />
            {enhancer.previous !== null ? (
              <button
                type="button"
                className="pd-studio-rail-undo pd-focusable"
                data-testid="video-enhance-undo"
                onClick={enhancer.undo}
              >
                Undo the rewrite
              </button>
            ) : null}
          </RailGroup>

          <RailGroup title="Model">
            <Knob label="Video model">
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
                */}
                {models.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.reserved === true}>
                    {m.label}
                    {m.reserved === true ? ' — not available yet' : ''}
                  </option>
                ))}
              </select>
            </Knob>
          </RailGroup>
        </>
      }
      advanced={
        <>
          <Knob label="Steps">
            <input
              className="pd-studio-input pd-studio-input--num pd-focusable"
              data-testid="video-steps"
              type="number"
              min={1}
              max={100}
              placeholder="auto"
              value={steps}
              onChange={(e) => setSteps(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <Knob label="Seed">
            <input
              className="pd-studio-input pd-studio-input--wide pd-focusable"
              data-testid="video-seed"
              type="number"
              placeholder="random"
              value={seed}
              onChange={(e) => setSeed(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <p className="pd-studio-rail-note">
            Steps multiply by every frame here, so a change that costs a second on one picture costs
            a minute on a clip. Empty means the model's own default.
          </p>
        </>
      }
    >
      {job !== null ? <StudioJob job={job} onCancel={cancel} /> : null}
      {runs.length === 0 && job === null ? (
        <StudioEmpty
          glyph={<GlyphVideo />}
          title="Make short clips on this machine"
          body="Every second is another two dozen frames to render, so start short. Nothing leaves your Mac."
          starters={starters}
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
      {/* The lens is an OPEN path with a gap to the body. Closed, its last
          segment ran straight down the body's right edge — the same line
          stroked twice, which is the brightest artefact of the set. */}
      <path
        d="M16.4 10.6l4.1-2.6v8l-4.1-2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* Starter glyphs — same 1.4 stroke and 24-box as the room's own. */
function GlyphClapper(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Shot</title>
      {/* The board and the clapper are drawn as two stacked boxes that SHARE an
          edge rather than as diagonals running into the body — the old version
          had three strokes crossing the rectangle's top line, and a crossing is
          the one place a stroke doubles up. */}
      <rect x="3" y="9.5" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.4 9.5V6.2a1 1 0 01.78-.98l14.4-2.7a1 1 0 011.22.98V9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8.7 5.1l1.5 4.1M14.2 4.1l1.5 4.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GlyphStopwatch(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Draft</title>
      <circle cx="12" cy="14" r="7" stroke="currentColor" strokeWidth="1.4" />
      {/* The hand stops short of the centre and the crown stops short of the
          dial: nothing crosses anything. */}
      <path
        d="M12 10.4v3.6l2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.6 2.6h4.8M12 3.4v3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GlyphPhone(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Vertical</title>
      <rect
        x="6.5"
        y="2.5"
        width="11"
        height="19"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M10.5 5.2h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
