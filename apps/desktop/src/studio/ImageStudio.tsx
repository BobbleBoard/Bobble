/**
 * THE IMAGE STUDIO.
 *
 * The knobs are the ones that change the picture and no others. Size, count,
 * steps, seed, and what to avoid — every one of which a person iterating will
 * reach for. There is no sampler menu, no scheduler menu and no CFG slider,
 * because the honest answer to "which sampler" for someone who has not asked is
 * "the one the model shipped with", and a studio that opens on forty controls
 * teaches nothing about which four matter.
 *
 * COUNT IS THE MOST USEFUL KNOB HERE and is why it sits next to the button:
 * image generation is a numbers game, and four candidates from one description
 * beats four descriptions one candidate at a time.
 */
import { type JSX, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { Knob, StudioEmpty, StudioShell } from './StudioShell';
import { useStudio } from './use-studio';

const SIZES = ['512x512', '768x768', '1024x1024', '1024x576', '576x1024'] as const;

export function ImageStudio(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [size, setSize] = useState<string>('1024x1024');
  const [count, setCount] = useState(1);
  const [negative, setNegative] = useState('');

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, run } = useStudio();
  const models = useMemo(() => catalog.filter((m) => m.modality === 'image'), [catalog]);

  return (
    <StudioShell
      testid="image-studio"
      title="Image Studio"
      subtitle="Make pictures on this machine"
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder="A red fox asleep in tall grass, low evening sun…"
      onRun={() =>
        void run({
          kind: 'image',
          prompt,
          size,
          n: count,
          ...(model !== '' ? { model } : {}),
          ...(negative !== '' ? { negativePrompt: negative } : {}),
        })
      }
      busy={busy}
      runLabel="Generate"
      {...(models.length === 0 ? { blocked: 'No image models are available.' } : {})}
      error={error}
      controls={
        <>
          <Knob label="Model">
            <select
              className="pd-studio-select pd-focusable"
              data-testid="image-model"
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
              data-testid="image-size"
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
          <Knob label="Avoid">
            <input
              className="pd-studio-input pd-studio-input--wide pd-focusable"
              data-testid="image-negative"
              value={negative}
              placeholder="optional"
              onChange={(e) => setNegative(e.target.value)}
            />
          </Knob>
          <Knob label="Count">
            <input
              className="pd-studio-input pd-studio-input--num pd-focusable"
              data-testid="image-count"
              type="number"
              min={1}
              max={8}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </Knob>
        </>
      }
    >
      {runs.length === 0 ? (
        <StudioEmpty>
          Describe a picture and press Generate. Ask for several at once and keep the one that
          works.
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
