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
import { aspectOf, RunHeader, StudioJob, widthOf } from './StudioRun';
import {
  Knob,
  RailGroup,
  RailToggle,
  Segmented,
  StudioEmpty,
  StudioPicker,
  StudioShell,
  type StudioStarter,
} from './StudioShell';
import { useStudioUiStore } from './studio-ui-store';
import { useEnhancer } from './use-enhancer';
import { useStudioInput } from './use-handoff';
import { studioBlockedReason, useStudio } from './use-studio';

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
  { value: 512, label: 'Draft', hint: 'Fastest' },
  { value: 768, label: 'Standard', hint: 'Trained size' },
  { value: 1024, label: 'Large', hint: 'Minutes per clip' },
] as const;

type Shape = (typeof SHAPES)[number]['value'];

/** 24fps, fixed. The only reason this was ever a control was to multiply cost. */
const FPS = 24;

const LENGTHS = [
  { value: 2, label: '2s', hint: '48 frames' },
  { value: 4, label: '4s', hint: '96 frames' },
  { value: 8, label: '8s', hint: '192 frames' },
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
  const { busy, error, runs, job, run, cancel, finishReveal } = useStudio('video');
  const models = useMemo(() => catalog.filter((m) => m.modality === 'video'), [catalog]);
  const blocked = studioBlockedReason(models, 'video');
  const size = (SHAPES.find((x) => x.value === shape) ?? SHAPES[0]).of(long);
  const enhancer = useEnhancer(useCallback((next: string) => setPrompt(next), []));
  /* Media handed to this room — from a card in the transcript, or dropped on
     it. Seeds the prompt with whatever made it. See useStudioInput. */
  const handoff = useStudioInput(
    'video',
    useCallback((p: string) => setPrompt(p), []),
  );
  const setSettingsOpen = useStudioUiStore((st) => st.setSettingsOpen);

  /*
   * Three cards, and every one of them is about COST as much as content —
   * because in this room that is the decision. A first clip at 8 seconds and
   * "Large" is several minutes before you learn the prompt was wrong.
   */
  const starters: readonly StudioStarter[] = [
    {
      id: 'shot',
      icon: <GlyphFrame />,
      title: 'Describe a shot',
      hint: 'One subject, one action, one place.',
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
      hint: 'Two seconds, smallest size.',
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
      hint: '9:16, for a phone.',
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
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="Describe a shot…"
      onRun={() => void onRun()}
      busy={busy || enhancer.enhancing}
      {...(job?.cancellable === true ? { onStop: cancel } : {})}
      runLabel={enhancer.enhancing ? 'Enhancing…' : 'Generate'}
      {...(blocked !== undefined ? { blocked } : {})}
      error={error}
      onRetry={() => void onRun()}
      {...(handoff.card !== undefined ? { input: handoff.card } : {})}
      onDropFiles={handoff.acceptFiles}
      /* The whole core set, in the bar — see ImageStudio for why. */
      controls={
        <>
          <StudioPicker
            testid="video-shape"
            label="Shape"
            value={shape}
            onChange={setShape}
            options={SHAPES.map((x) => ({ value: x.value, label: x.label }))}
          />
          <StudioPicker
            testid="video-size"
            label="Size"
            value={long}
            onChange={setLong}
            options={SIZES.map((x) => ({ value: x.value, label: x.label, hint: x.hint }))}
          />
          <StudioPicker
            testid="video-seconds"
            label="Length"
            value={seconds}
            onChange={setSeconds}
            options={LENGTHS.map((l) => ({ value: l.value, label: l.label, hint: l.hint }))}
          />
          <StudioPicker
            testid="video-model"
            label="Model"
            value={model}
            onChange={setModel}
            options={[
              { value: '', label: 'Recommended' },
              ...models.map((m) => ({
                value: m.id,
                label: m.reserved === true ? `${m.label} (soon)` : m.label,
              })),
            ]}
          />
          <StudioPicker
            testid="video-enhance"
            label="Enhance"
            value={enhancer.enabled ? 'on' : 'off'}
            onChange={(v) => enhancer.setEnabled(v === 'on')}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On', hint: 'Describes the motion first' },
            ]}
          />
        </>
      }
      settings={
        <>
          <RailGroup title="Shape">
            <Knob label="Aspect ratio">
              <Segmented
                testid="video-shape-rail"
                value={shape}
                onChange={setShape}
                options={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
              />
            </Knob>
            <Knob label="Size">
              <Segmented
                testid="video-size-rail"
                value={long}
                onChange={setLong}
                options={SIZES.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))}
              />
            </Knob>
            <p className="pd-studio-rail-note" data-testid="video-pixels-rail">
              {size.replace('x', ' × ')} px · {FPS} fps · {seconds * FPS} frames
            </p>
          </RailGroup>

          <RailGroup title="Prompt">
            <RailToggle
              testid="video-enhance-rail"
              label="Prompt enhancer"
              hint="Describes the motion first, which is what a clip needs."
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
              <StudioPicker
                block
                side="bottom"
                testid="video-model-rail"
                label="Video model"
                value={model}
                onChange={setModel}
                options={[
                  { value: '', label: 'Recommended' },
                  /*
                    A MODEL THAT CANNOT RUN IS SHOWN AS UNAVAILABLE, not offered.
                    `reserved` marks catalogue entries whose backend has not
                    landed. Disabled and labelled is better than hidden: the
                    entry is real, it is coming, and picking it is the one thing
                    that must not quietly fail.
                  */
                  ...models.map((m) => ({
                    value: m.id,
                    label: m.label,
                    ...(m.reserved === true ? { disabled: true, hint: 'not available yet' } : {}),
                  })),
                ]}
              />
            </Knob>
          </RailGroup>
        </>
      }
      advanced={
        <>
          <Knob label="Steps">
            <input
              className="pd-studio-input pd-studio-input--num pd-focusable"
              data-testid="video-steps-rail"
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
              data-testid="video-seed-rail"
              type="number"
              placeholder="random"
              value={seed}
              onChange={(e) => setSeed(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <p className="pd-studio-rail-note">
            Empty uses the model&apos;s default. Steps cost per frame.
          </p>
        </>
      }
    >
      {job !== null ? (
        <StudioJob
          job={job}
          variant="video"
          aspect={aspectOf(size)}
          width={widthOf(size)}
          model={model}
          onRevealed={finishReveal}
        />
      ) : null}
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
/*
 * A FRAME WITH A PLAY MARK, not a clapperboard.
 *
 * The clapper needed a body, a hinged board at an angle, and two stripes inside
 * it — five features inside 26 pixels. It came out as a squat box with a lump
 * on top and a couple of scratches, which is what the user was looking at.
 *
 * Two bold shapes read at this size where five fine ones do not, and they say
 * the same thing: this card is about one shot of moving picture. Landscape and
 * wide, so it does not collide with the tall narrow phone on the third card.
 */
function GlyphFrame(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Shot</title>
      <rect
        x="3.5"
        y="5.5"
        width="17"
        height="13"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        /* Nudged 0.65 right of the frame's true centre and grown a little: a
           triangle pointing right carries its mass on the left, so geometric
           centring reads as sitting low-left of the box. */
        d="M9.9 8.7L15.4 12L9.9 15.3V8.7z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
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
