/**
 * THE AUDIO STUDIO — speech, voice cloning, music and sound effects.
 *
 * the user: "any audio functions for example, sfx, music, TTS, voice cloning, would
 * go in an audio studio."
 *
 * ONE ROOM, THREE MODES, and the modes are a segmented control rather than three
 * separate studios because they share everything that matters — the same output
 * folder, the same player, the same "make another, compare, keep one" loop — and
 * differ only in what you type and which knobs are on. Somebody making a game
 * scene wants a line of dialogue, a music bed and a door slam in the same
 * sitting, and sending them to three rooms to do it would be three of everything.
 *
 * WHAT CHANGES PER MODE is deliberately not cosmetic:
 *
 *   Speech — a paragraph, so the prompt is a TEXTAREA. Voice, speed, language,
 *            and the reference clip that turns this into voice cloning.
 *   Music  — a description, one line. Length matters and defaults long (20s).
 *   SFX    — a description, one line. Length defaults SHORT (5s) and there is a
 *            variations count, because picking a good door slam is a numbers
 *            game and you want four to choose between, not one to accept.
 */
import { type JSX, useMemo, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { Knob, StudioEmpty, StudioShell } from './StudioShell';
import { useStudio } from './use-studio';

type Mode = 'speech' | 'music' | 'sfx';

const MODES: readonly { id: Mode; label: string; hint: string }[] = [
  { id: 'speech', label: 'Speech', hint: 'Read text aloud, or clone a voice' },
  { id: 'music', label: 'Music', hint: 'Compose from a description' },
  { id: 'sfx', label: 'Sound effects', hint: 'Short sounds, several at a time' },
];

export function AudioStudio(): JSX.Element {
  const [mode, setMode] = useState<Mode>('speech');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('');
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [seconds, setSeconds] = useState<number | undefined>(undefined);
  const [count, setCount] = useState(1);
  const [refAudio, setRefAudio] = useState('');

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, run } = useStudio();

  /** Models that can serve this mode — speech on the TTS backends, sound on Comfy. */
  const models = useMemo(() => {
    const audio = catalog.filter((m) => m.modality === 'audio');
    return mode === 'speech'
      ? audio.filter((m) => m.backend === 'mlx-audio' || m.backend === 'torch-tts')
      : audio.filter((m) => m.backend === 'comfyui');
  }, [catalog, mode]);

  /*
   * NO "IS IT DOWNLOADED" GATE, deliberately. The catalogue DTO does not carry
   * install state, and inventing one here would be a second source of truth for
   * something the job path already handles better: gen-manager's
   * download-then-continue prompts for a missing weights pack, fetches it, and
   * carries on into the same job. Pre-blocking would replace a prompt that
   * resolves itself with a dead end that sends you to another screen.
   */
  const blocked =
    models.length === 0
      ? `No ${mode === 'speech' ? 'speech' : 'sound'} models are available.`
      : undefined;

  const onRun = (): void => {
    void run({
      kind: 'audio',
      audioKind: mode,
      prompt,
      ...(model !== '' ? { model } : {}),
      ...(mode === 'speech' && voice !== '' ? { voice } : {}),
      ...(mode === 'speech' && speed !== 1 ? { speed } : {}),
      ...(mode === 'speech' && refAudio !== '' ? { refAudio } : {}),
      ...(mode !== 'speech' && seconds !== undefined ? { seconds } : {}),
      ...(mode === 'sfx' ? { n: count } : {}),
    });
  };

  const modeMeta = MODES.find((m) => m.id === mode);

  return (
    <StudioShell
      testid="audio-studio"
      title="Audio Studio"
      subtitle={modeMeta?.hint ?? ''}
      multiline={mode === 'speech'}
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder={
        mode === 'speech'
          ? 'The text to read aloud…'
          : mode === 'music'
            ? 'Warm lo-fi piano over vinyl crackle, slow tempo…'
            : 'A heavy wooden door slamming shut in a stone hallway…'
      }
      onRun={onRun}
      busy={busy}
      runLabel={mode === 'speech' ? 'Speak' : mode === 'music' ? 'Compose' : 'Generate'}
      {...(blocked !== undefined ? { blocked } : {})}
      error={error}
      abovePrompt={
        <div className="pd-seg" role="tablist" aria-label="Audio mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              data-testid={`audio-mode-${m.id}`}
              className="pd-seg-item pd-focusable"
              data-on={mode === m.id ? 'true' : undefined}
              onClick={() => {
                setMode(m.id);
                // A model chosen for one mode cannot serve another — Kokoro is
                // not going to make a door slam — so the pick resets with the
                // mode rather than silently failing on the next run.
                setModel('');
                setSeconds(undefined);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
      controls={
        <>
          <Knob label="Model">
            <select
              className="pd-studio-select pd-focusable"
              data-testid="audio-model"
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

          {mode === 'speech' ? (
            <>
              <Knob label="Voice">
                <input
                  className="pd-studio-input pd-focusable"
                  data-testid="audio-voice"
                  value={voice}
                  placeholder="default"
                  onChange={(e) => setVoice(e.target.value)}
                />
              </Knob>
              <Knob label={`Speed ${speed.toFixed(2)}×`}>
                <input
                  className="pd-studio-range pd-focusable"
                  data-testid="audio-speed"
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                />
              </Knob>
              {/* VOICE CLONING, and the reason it is a plain path field rather
                  than a file picker for now: the clip usually comes from
                  something already generated in this app, and pasting its path
                  is one step where a picker is three. */}
              <Knob label="Clone from clip">
                <input
                  className="pd-studio-input pd-studio-input--wide pd-focusable"
                  data-testid="audio-refaudio"
                  value={refAudio}
                  placeholder="3–10s sample"
                  onChange={(e) => setRefAudio(e.target.value)}
                />
              </Knob>
            </>
          ) : (
            <>
              <Knob label="Seconds">
                <input
                  className="pd-studio-input pd-studio-input--num pd-focusable"
                  data-testid="audio-seconds"
                  type="number"
                  min={1}
                  max={120}
                  value={seconds ?? (mode === 'sfx' ? 5 : 20)}
                  onChange={(e) => setSeconds(Number(e.target.value))}
                />
              </Knob>
              {mode === 'sfx' ? (
                <Knob label="Variations">
                  <input
                    className="pd-studio-input pd-studio-input--num pd-focusable"
                    data-testid="audio-count"
                    type="number"
                    min={1}
                    max={8}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  />
                </Knob>
              ) : null}
            </>
          )}
        </>
      }
    >
      {runs.length === 0 ? (
        <StudioEmpty>
          {mode === 'speech'
            ? 'Type something and press Speak. Point “Clone from clip” at a few seconds of a voice to have it read in that voice instead.'
            : mode === 'music'
              ? 'Describe a piece — instruments, tempo, mood — and press Compose.'
              : 'Describe a sound. Ask for several variations and keep the one that lands.'}
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
