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
import { type JSX, useCallback, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { RunHeader, StudioJob } from './StudioRun';
import { Knob, RailGroup, RailToggle, Segmented, StudioEmpty, StudioShell } from './StudioShell';
import { useEnhancer } from './use-enhancer';
import { useStudio } from './use-studio';

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
const SIZES = [
  { value: 768, label: 'Draft', hint: 'fastest — for finding the idea' },
  { value: 1024, label: 'Standard', hint: 'the size these models were trained at' },
  { value: 1536, label: 'Large', hint: 'slowest, and can drift on some models' },
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
  const [style, setStyle] = useState<string>('');
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState<number | ''>('');
  const [guidance, setGuidance] = useState<number | ''>('');
  const [seed, setSeed] = useState<number | ''>('');

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel } = useStudio('image');
  const models = useMemo(() => catalog.filter((m) => m.modality === 'image'), [catalog]);
  const size = (SHAPES.find((x) => x.value === shape) ?? SHAPES[0]).of(long);
  const enhancer = useEnhancer(useCallback((next: string) => setPrompt(next), []));

  /*
   * ENHANCE, THEN STYLE, THEN GENERATE — in that order, and the style suffix is
   * NOT run through the enhancer. The suffix is already written in the target's
   * house style; feeding it back through a rewriter is how "watercolour" comes
   * out as a photograph.
   */
  const onRun = async (): Promise<void> => {
    const base = await enhancer.enhance('image', prompt, model);
    const suffix = STYLES.find((x) => x.value === style)?.suffix ?? '';
    await run({
      kind: 'image',
      prompt: suffix === '' ? base : `${base} ${suffix}`,
      size,
      n: count,
      ...(model !== '' ? { model } : {}),
      ...(steps !== '' ? { steps } : {}),
      ...(guidance !== '' ? { guidance } : {}),
      ...(seed !== '' ? { seed } : {}),
    });
  };

  return (
    <StudioShell
      testid="image-studio"
      title="Image Studio"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="Describe a picture…"
      onRun={() => void onRun()}
      busy={busy || enhancer.enhancing}
      runLabel={enhancer.enhancing ? 'Enhancing…' : 'Generate'}
      {...(models.length === 0 ? { blocked: 'No image models are available.' } : {})}
      error={error}
      controls={
        <Knob label="Count">
          <Segmented
            testid="image-count"
            value={count}
            onChange={setCount}
            options={[
              { value: 1, label: '1' },
              { value: 2, label: '2' },
              { value: 4, label: '4' },
            ]}
          />
        </Knob>
      }
      settings={
        <>
          <RailGroup title="Shape">
            <Knob label="Aspect ratio">
              <Segmented
                testid="image-shape"
                value={shape}
                onChange={setShape}
                options={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
              />
            </Knob>
            <Knob label="Size">
              <Segmented
                testid="image-size"
                value={long}
                onChange={setLong}
                options={SIZES.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))}
              />
            </Knob>
            <p className="pd-studio-rail-note" data-testid="image-pixels">
              {size.replace('x', ' × ')} px
            </p>
          </RailGroup>

          <RailGroup title="Look">
            <Knob label="Style">
              <select
                className="pd-studio-select pd-focusable"
                data-testid="image-style"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
              >
                {STYLES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Knob>
            <RailToggle
              testid="image-enhance"
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
              <select
                className="pd-studio-select pd-focusable"
                data-testid="image-model"
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
          </RailGroup>
        </>
      }
      advanced={
        <>
          <Knob label="Steps">
            <input
              className="pd-studio-input pd-studio-input--num pd-focusable"
              data-testid="image-steps"
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
              data-testid="image-guidance"
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
              data-testid="image-seed"
              type="number"
              placeholder="random"
              value={seed}
              onChange={(e) => setSeed(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <p className="pd-studio-rail-note">
            Empty means the model's own default. A fixed seed makes the same prompt produce the same
            picture, which is how you tell whether a wording change actually helped.
          </p>
        </>
      }
    >
      {job !== null ? <StudioJob job={job} onCancel={cancel} /> : null}
      {runs.length === 0 && job === null ? (
        <StudioEmpty
          glyph={<GlyphImage />}
          title="Make pictures on this machine"
          body="Nothing you type here leaves your Mac. Describe a picture, or start from one of these."
          examples={EXAMPLES}
          onPick={setPrompt}
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
        d="M4 17l4.5-4.5a1.5 1.5 0 012 0L14 16m0 0l2-2a1.5 1.5 0 012 0l2 2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
