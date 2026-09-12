/**
 * THE IMAGE STUDIO.
 *
 * The knobs are the ones that change the picture and no others. There is no
 * sampler menu, no scheduler menu and no CFG slider, because the honest answer
 * to "which sampler" for someone who has not asked is "the one the model shipped
 * with", and a studio that opens on forty controls teaches nothing about which
 * four matter.
 *
 * WHAT CHANGED, AND WHY, after a design review of the shipped build:
 *
 *   SHAPE, NOT PIXELS. "1024x1024 / 768x768 / 512x512" offered three squares
 *   that differ only in quality — a rendering decision wearing the clothes of a
 *   composition decision. You choose a shape; the room picks the best resolution
 *   the model supports for it.
 *
 *   COUNT IS THE THESIS, so it is a choice you can see, not a 68px number
 *   spinner you have to notice. (It also could not be emptied without sending
 *   NaN to the job.) Four candidates from one description beats four
 *   descriptions one candidate at a time, so 4 is one press away.
 *
 *   NO "AVOID". Negative prompting is a model's weakness expressed as a user
 *   chore: nobody wants to enumerate what should not be in their picture. Say
 *   what you want instead.
 */
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * SHAPE × SIZE — as explicit pairs, not arithmetic.
 *
 * the user asked for res in the rail alongside the ratio, so it is there — but as
 * SIZE crossed with the ratio rather than a pixel menu beside it. The old
 * "1024x1024 / 768x768 / 512x512" was three squares that differ only in
 * quality: a rendering decision wearing the clothes of a composition one. Pick
 * the shape you are composing, then how much of it you want to pay for.
 *
 * Each shape carries a formatter rather than a table of pairs, and the sizes
 * below are chosen so every product is exact: 16:9 of 768 is 432, of 1024 is
 * 576, of 1536 is 864 — all whole, all multiples of 16, which is what these
 * pipelines' latent grids need. Computing a ratio and SNAPPING to a multiple is
 * what this replaced: 16:9 at a 512 long edge snapped to 64 gives 512×320,
 * which is 16:10 and not what the label promised.
 */
const SHAPES = [
  {
    value: 'square',
    label: '1:1',
    of: (n: number) => `${n}x${n}`,
  },
  {
    value: 'landscape',
    label: '16:9',
    of: (n: number) => `${n}x${(n * 9) / 16}`,
  },
  {
    value: 'portrait',
    label: '9:16',
    of: (n: number) => `${(n * 9) / 16}x${n}`,
  },
  {
    value: 'photo',
    label: '4:3',
    of: (n: number) => `${n}x${(n * 3) / 4}`,
  },
] as const;

/** The long edge. Named by what it is for, because that is how the choice is made. */
/*
 * THE LONG EDGE — and a size a 24 GB Mac can actually run.
 *
 * MEASURED 2026-09-11 as the OS's own free-memory drop: FLUX.2 klein and
 * Z-Image both take ~10.5 GB at 512² and 14 GB or more at 768², ~19 GB at
 * 1024². Beside the app's 6 GB reserve on a 24 GB machine, 768² is admitted
 * only on an empty machine and 1024² never (the guardian refuses it with the
 * reason, rather than freezing the Mac as it did before the guardian existed).
 * 512² is the size that reliably runs there — eleven seconds — and the studio
 * had no way to ask for it.
 */
const SIZES = [
  { value: 512, label: 'Quick', hint: 'Runs on 16 GB' },
  { value: 768, label: 'Draft', hint: 'Fast' },
  { value: 1024, label: 'Standard', hint: 'Trained size' },
  { value: 1536, label: 'Large', hint: 'Slowest' },
] as const;

/**
 * STYLES ARE PROMPT SUFFIXES, not model settings.
 *
 * Every image model here reads a sentence, so "photographic" is not a switch to
 * flip — it is a clause to add. Keeping them as text means they compose with the
 * enhancer instead of fighting it, and the one that costs nothing ("None") is
 * the default because a style you did not ask for is a surprise in every result.
 */
const STYLES = [
  { value: '', label: 'None', suffix: '' },
  { value: 'photo', label: 'Photographic', suffix: 'Photograph, natural light, realistic detail.' },
  {
    value: 'cinema',
    label: 'Cinematic',
    suffix: 'Cinematic still, anamorphic lens, dramatic lighting, shallow depth of field.',
  },
  {
    value: 'illustration',
    label: 'Illustration',
    suffix: 'Digital illustration, clean linework, flat shapes, limited palette.',
  },
  {
    value: 'watercolour',
    label: 'Watercolour',
    suffix: 'Loose watercolour painting on cold-press paper, soft bleeding edges.',
  },
  {
    value: 'ink',
    label: 'Ink drawing',
    suffix: 'Black ink drawing, cross-hatched shading, white paper.',
  },
  {
    value: 'render',
    label: '3D render',
    suffix: 'Physically based 3D render, soft studio lighting, subtle depth of field.',
  },
] as const;

type Shape = (typeof SHAPES)[number]['value'];

const EXAMPLES = [
  'A red fox asleep in tall grass, low evening sun',
  'A paper lantern on a wet street at night',
  'A still life of lemons on a blue tablecloth',
];

export function ImageStudio(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [shape, setShape] = useState<Shape>('square');
  const [long, setLong] = useState<number>(1024);
  /*
   * THE DEFAULT SIZE IS THE MACHINE'S, not the model's.
   *
   * 1024² is the trained size and the right default on a machine that can hold
   * it. On a 24 GB Mac it is ~19 GB of the OS's memory for either default
   * model (MEASURED, see SIZES) and the guardian now refuses it outright — so a
   * default of 1024 there would be a studio whose first Generate is a refusal.
   * Until the reader picks a size, the machine picks: 512² under 32 GB, 768²
   * under 48, 1024² above. `app:get-info` is the same fact the model hub reads.
   */
  const sizeTouched = useRef(false);
  const pickLong = useCallback((v: number) => {
    sizeTouched.current = true;
    setLong(v);
  }, []);
  useEffect(() => {
    void window.piDesktop
      .invoke('app:get-info', undefined)
      .then((info) => {
        if (sizeTouched.current) return;
        const gb = info.totalMemoryBytes / 1024 ** 3;
        setLong(gb < 32 ? 512 : gb < 48 ? 768 : 1024);
      })
      .catch(() => undefined);
  }, []);
  const [style, setStyle] = useState<string>('');
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState<number | ''>('');
  const [guidance, setGuidance] = useState<number | ''>('');
  const [seed, setSeed] = useState<number | ''>('');

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel, finishReveal } = useStudio('image');
  const models = useMemo(() => catalog.filter((m) => m.modality === 'image'), [catalog]);
  const blocked = studioBlockedReason(models, 'image');
  const size = (SHAPES.find((x) => x.value === shape) ?? SHAPES[0]).of(long);
  const enhancer = useEnhancer(useCallback((next: string) => setPrompt(next), []));
  /*
   * HOW FAR AN EDIT MAY TRAVEL from its input picture, 0..1. Only meaningful
   * with an input, so it is only offered with one — a slider that does nothing
   * most of the time teaches people to ignore it.
   */
  const [strength, setStrength] = useState(0.6);
  /* Media handed to this room — from a card in the transcript, or dropped on
     it. Seeds the prompt with whatever made it. See useStudioInput. */
  const handoff = useStudioInput(
    'image',
    useCallback((p: string) => setPrompt(p), []),
  );
  const setSettingsOpen = useStudioUiStore((st) => st.setSettingsOpen);

  /*
   * ENHANCE, THEN STYLE, THEN GENERATE — in that order, and the style suffix is
   * NOT run through the enhancer. The suffix is already written in the target's
   * house style; feeding it back through a rewriter is how "watercolour" comes
   * out as a photograph.
   */
  /*
   * WHAT THIS ROOM IS FOR, as three cards.
   *
   * Each one puts the studio into the shape that task needs and leaves a line
   * in the composer to replace — the knobs it sets are the ones you would have
   * had to find in the rail first, which is the part nobody does on their first
   * visit.
   */
  /*
   * WITH AN INPUT, THE ROOM IS ABOUT THAT PICTURE.
   *
   * The empty state said "Make pictures on this machine … Pick somewhere to
   * start, or just describe a picture" while the run button next to it said
   * Edit and a thumbnail of your picture sat under it. Found by LOOKING at a
   * screenshot of the working handoff: every assertion passed and the room was
   * still inviting you to start from nothing.
   *
   * The starters change with it, because "Describe a picture" is the wrong
   * offer when a picture is already there — these are the three things people
   * ask for when handed one.
   */
  const editStarters: readonly StudioStarter[] = [
    {
      id: 'change',
      icon: <GlyphPencil />,
      title: 'Change something',
      hint: 'Say only what should be different.',
      onPick: () => {
        setStrength(0.6);
        setPrompt('make it golden hour, warm low sun');
      },
    },
    {
      id: 'restyle',
      icon: <GlyphPalette />,
      title: 'Restyle it',
      hint: 'Same subject, different hand.',
      onPick: () => {
        setStrength(0.85);
        setStyle('watercolour');
        setPrompt('the same scene as a loose watercolour');
      },
    },
    {
      id: 'polish',
      icon: <GlyphGrid />,
      title: 'Just polish it',
      hint: 'Keep it, clean it up.',
      onPick: () => {
        setStrength(0.3);
        setPrompt('the same picture, sharper and better lit');
      },
    },
  ];

  const starters: readonly StudioStarter[] = [
    {
      id: 'describe',
      icon: <GlyphPencil />,
      title: 'Describe a picture',
      hint: 'What, where, and in what light.',
      onPick: () => {
        setStyle('');
        setCount(1);
        setPrompt(EXAMPLES[0] ?? '');
      },
    },
    {
      id: 'stylize',
      icon: <GlyphPalette />,
      title: 'Stylize a picture',
      hint: 'Watercolour, ink, cinematic.',
      onPick: () => {
        setStyle('watercolour');
        setCount(1);
        setPrompt(EXAMPLES[2] ?? '');
        setSettingsOpen(true);
      },
    },
    {
      id: 'compare',
      icon: <GlyphGrid />,
      title: 'Four to compare',
      hint: 'Four candidates, side by side.',
      onPick: () => {
        setCount(4);
        setPrompt(EXAMPLES[1] ?? '');
      },
    },
  ];

  const onRun = async (): Promise<void> => {
    const base = await enhancer.enhance('image', prompt, model);
    const suffix = STYLES.find((x) => x.value === style)?.suffix ?? '';
    /*
     * WITH AN INPUT, THIS IS AN EDIT — the model starts from those pixels
     * instead of from noise. `strength` is how far it may travel: low keeps the
     * composition and changes the finish, high keeps little but the shape.
     */
    const editing = handoff.input !== null && handoff.input.kind === 'image';
    await run({
      kind: 'image',
      prompt: suffix === '' ? base : `${base} ${suffix}`,
      size,
      n: count,
      ...(model !== '' ? { model } : {}),
      ...(steps !== '' ? { steps } : {}),
      ...(guidance !== '' ? { guidance } : {}),
      ...(seed !== '' ? { seed } : {}),
      ...(editing ? { inputImage: handoff.input?.path, strength } : {}),
    });
  };

  return (
    <StudioShell
      testid="image-studio"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder={handoff.input !== null ? 'What should change?…' : 'Describe a picture…'}
      onRun={() => void onRun()}
      busy={busy || enhancer.enhancing}
      {...(job?.cancellable === true ? { onStop: cancel } : {})}
      runLabel={enhancer.enhancing ? 'Enhancing…' : handoff.input !== null ? 'Edit' : 'Generate'}
      {...(blocked !== undefined ? { blocked } : {})}
      error={error}
      onRetry={() => void onRun()}
      {...(handoff.card !== undefined ? { input: handoff.card } : {})}
      onDropFiles={handoff.acceptFiles}
      /*
       * EVERYTHING CORE IS DOWN HERE. the user: "move a bit more really core
       * functionality to the bottom bar… you should be able to access all core
       * functionality and settings without even going into the right sidebar."
       *
       * So the bar under the composer carries the whole set — shape, size, look,
       * count, model, enhancer — and the rail on the right is the same controls
       * with room to breathe plus the things that need it. The progression is
       * bar → rail → gears: what you change between two runs, what you set for a
       * sitting, and what you touch once a month.
       */
      controls={
        <>
          <StudioPicker
            testid="image-shape"
            label="Shape"
            value={shape}
            onChange={setShape}
            options={SHAPES.map((x) => ({ value: x.value, label: x.label }))}
          />
          <StudioPicker
            testid="image-size"
            label="Size"
            value={long}
            onChange={pickLong}
            options={SIZES.map((x) => ({ value: x.value, label: x.label, hint: x.hint }))}
          />
          <StudioPicker
            testid="image-style"
            label="Style"
            value={style}
            onChange={setStyle}
            options={STYLES.map((x) => ({ value: x.value, label: x.label }))}
          />
          <StudioPicker
            testid="image-count"
            label="Count"
            value={count}
            onChange={setCount}
            options={[
              { value: 1, label: '1 picture' },
              { value: 2, label: '2 pictures' },
              { value: 4, label: '4 pictures' },
            ]}
          />
          <StudioPicker
            testid="image-model"
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
            testid="image-enhance"
            label="Enhance"
            value={enhancer.enabled ? 'on' : 'off'}
            onChange={(v) => enhancer.setEnabled(v === 'on')}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On', hint: "Rewrites your line in the model's house style" },
            ]}
          />
        </>
      }
      settings={
        <>
          {/*
            HOW FAR TO TRAVEL FROM THE PICTURE YOU HANDED IN.

            Only meaningful with an input, so it is only offered with one — a
            slider that does nothing most of the time teaches people to ignore
            it. It heads the rail rather than hiding under Advanced because when
            you arrive here from a picture this is THE control; steps and
            guidance are still fine print.

            Named amounts, not a raw 0..1: the number is meaningless on its own,
            and (see worker.py) the engine's own flag runs the other way. What
            the app carries everywhere is the ordinary reading — bigger means
            more different.
          */}
          {handoff.input !== null ? (
            <RailGroup title="Edit">
              <Knob label="Edit magnitude">
                <Segmented
                  testid="image-strength-rail"
                  value={strength}
                  onChange={setStrength}
                  options={[
                    { value: 0.3, label: 'Low', hint: 'Touch it up — same picture' },
                    { value: 0.6, label: 'Medium', hint: 'Clearly reworked, still recognisable' },
                    { value: 0.85, label: 'High', hint: 'Keeps the composition, redraws it' },
                  ]}
                />
              </Knob>
            </RailGroup>
          ) : null}

          <RailGroup title="Shape">
            <Knob label="Aspect ratio">
              <Segmented
                testid="image-shape-rail"
                value={shape}
                onChange={setShape}
                options={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
              />
            </Knob>
            <Knob label="Size">
              <Segmented
                testid="image-size-rail"
                value={long}
                onChange={pickLong}
                options={SIZES.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))}
              />
            </Knob>
            <p className="pd-studio-rail-note" data-testid="image-pixels-rail">
              {size.replace('x', ' × ')} px
            </p>
          </RailGroup>

          <RailGroup title="Look">
            <Knob label="Style">
              <StudioPicker
                block
                side="bottom"
                testid="image-style-rail"
                label="Style"
                value={style}
                onChange={setStyle}
                options={STYLES.map((st) => ({ value: st.value, label: st.label }))}
              />
            </Knob>
            <RailToggle
              testid="image-enhance-rail"
              label="Prompt enhancer"
              hint="A small local model rewrites your description in this model's house style. You see the result before it runs."
              checked={enhancer.enabled}
              onChange={enhancer.setEnabled}
            />
            {enhancer.previous !== null ? (
              <button
                type="button"
                className="pd-studio-rail-undo pd-focusable"
                data-testid="image-enhance-undo"
                onClick={enhancer.undo}
              >
                Undo the rewrite
              </button>
            ) : null}
          </RailGroup>

          <RailGroup title="Model">
            <Knob label="Image model">
              <StudioPicker
                block
                side="bottom"
                testid="image-model-rail"
                label="Image model"
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
              data-testid="image-steps-rail"
              type="number"
              min={1}
              max={100}
              placeholder="auto"
              value={steps}
              onChange={(e) => setSteps(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <Knob label="Guidance">
            <input
              className="pd-studio-input pd-focusable"
              data-testid="image-guidance-rail"
              type="number"
              min={0}
              max={20}
              step={0.5}
              placeholder="auto"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <Knob label="Seed">
            <input
              className="pd-studio-input pd-studio-input--wide pd-focusable"
              data-testid="image-seed-rail"
              type="number"
              placeholder="random"
              value={seed}
              onChange={(e) => setSeed(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <p className="pd-studio-rail-note">
            Empty uses the model&apos;s default. A fixed seed repeats the same picture.
          </p>
        </>
      }
    >
      {job !== null ? (
        <StudioJob
          job={job}
          variant="image"
          aspect={aspectOf(size)}
          width={widthOf(size)}
          model={model}
          onRevealed={finishReveal}
        />
      ) : null}
      {runs.length === 0 && job === null ? (
        <StudioEmpty
          glyph={<GlyphImage />}
          title={
            handoff.input === null ? 'Make pictures on this machine' : 'Working from your picture'
          }
          body={
            handoff.input === null
              ? 'Nothing you type here leaves your Mac. Pick somewhere to start, or just describe a picture.'
              : `Say what should be different about ${handoff.input.name}. Nothing you type here leaves your Mac.`
          }
          starters={handoff.input === null ? starters : editStarters}
        />
      ) : (
        runs.map((r) => (
          <section key={r.at} className="pd-studio-run">
            <RunHeader run={r} onAgain={() => setPrompt(r.prompt)} />
            {/* Several candidates from one description are a SET — they exist to
                be compared, which a single vertical column of full-width images
                makes impossible (one fills the window; the second is below the
                fold). A grid puts them side by side. */}
            <ThreadMedia items={r.items} layout={r.items.length > 1 ? 'grid' : 'single'} />
          </section>
        ))
      )}
    </StudioShell>
  );
}

function GlyphImage(): JSX.Element {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Pictures</title>
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
      <path
        /* One continuous line. The `m0 0` used to restart a subpath on the same
           point, so two round caps stacked there and made a bright dot. */
        d="M4 17l4.5-4.5a1.5 1.5 0 012 0L14 16l2-2a1.5 1.5 0 012 0l2 2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* The three starter glyphs. Same 1.4 stroke and 24-box as the room's own, so a
   card reads as part of the same drawing rather than a borrowed icon set. */
/*
 * A PENCIL WITH A BODY.
 *
 * The old one was a single narrow outline — at 26px it read as a sliver, a
 * stick with a bent end, and you could not tell what it was without the label
 * under it. the user: "these could be better."
 *
 * Redrawn with the three things that make a pencil legible small: a WIDE enough
 * body to be a shape rather than a line, a real sharpened point (the tip is its
 * own facet, not a rounded corner), and a ferrule band across the barrel. The
 * outline and the band are ONE path so the whole drawing is stroked in a single
 * operation — no seams where they meet, whatever the ink.
 */
function GlyphPencil(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Describe</title>
      <path
        d="M4.2 19.8L5.2 15.1L14.4 5.9L18.1 9.6L8.9 18.8ZM11.6 8.8L15.2 12.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/*
 * A PALETTE, not a brush.
 *
 * The brush redrawn without overlapping strokes came out as a closed blade with
 * a tip — which is a pencil, and the card next to it already is one. Two cards
 * side by side with the same glyph is worse than a slightly doubled stroke.
 * A palette says "a chosen look" and shares nothing with the others: an outline
 * and four filled wells, none of them touching it.
 */
function GlyphPalette(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Stylize</title>
      <path
        d="M12 3.4a8.6 8.6 0 100 17.2c1.1 0 1.8-.8 1.8-1.7 0-1.5 1.1-2.3 2.4-2.3h1.6a3.4 3.4 0 003.4-3.4c0-5-4.1-9.8-9.2-9.8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="7.6" cy="12.6" r="1.15" fill="currentColor" />
      <circle cx="9.2" cy="8.2" r="1.15" fill="currentColor" />
      <circle cx="14" cy="7.4" r="1.15" fill="currentColor" />
      <circle cx="17.4" cy="10.6" r="1.15" fill="currentColor" />
    </svg>
  );
}

function GlyphGrid(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Compare</title>
      <rect
        x="3.5"
        y="3.5"
        width="7.5"
        height="7.5"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="13"
        y="3.5"
        width="7.5"
        height="7.5"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="3.5"
        y="13"
        width="7.5"
        height="7.5"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="13"
        y="13"
        width="7.5"
        height="7.5"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
