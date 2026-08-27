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
import { type JSX, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { RunHeader, StudioJob } from './StudioRun';
import { Knob, Segmented, StudioEmpty, StudioShell } from './StudioShell';
import { useStudio } from './use-studio';

/** Shape → the pixels we actually ask for. Resolution is not a user decision. */
const SHAPES = [
  { value: 'square', label: 'Square', size: '1024x1024' },
  { value: 'landscape', label: 'Landscape', size: '1024x576' },
  { value: 'portrait', label: 'Portrait', size: '576x1024' },
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
  const [count, setCount] = useState(1);

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel } = useStudio('image');
  const models = useMemo(() => catalog.filter((m) => m.modality === 'image'), [catalog]);
  const size = SHAPES.find((s) => s.value === shape)?.size ?? '1024x1024';

  return (
    <StudioShell
      testid="image-studio"
      title="Image Studio"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="Describe a picture…"
      onRun={() =>
        void run({
          kind: 'image',
          prompt,
          size,
          n: count,
          ...(model !== '' ? { model } : {}),
        })
      }
      busy={busy}
      runLabel="Generate"
      {...(models.length === 0 ? { blocked: 'No image models are available.' } : {})}
      error={error}
      controls={
        <>
          <Knob label="Shape">
            <Segmented
              testid="image-shape"
              value={shape}
              onChange={setShape}
              options={SHAPES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </Knob>
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
          <Knob label="Model">
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
