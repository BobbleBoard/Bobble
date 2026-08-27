/**
 * THE AUDIO STUDIO — speech, voice cloning, music and sound effects.
 *
 * the user: "any audio functions for example, sfx, music, TTS, voice cloning, would
 * go in an audio studio."
 *
 * ONE ROOM, THREE MODES, because they share everything that matters — the same
 * output folder, the same player, the same "make another, compare, keep one"
 * loop — and differ only in what you type and which knobs are on. Somebody
 * making a game scene wants a line of dialogue, a music bed and a door slam in
 * the same sitting, and sending them to three rooms would be three of
 * everything.
 *
 * WHAT CHANGED, AND WHY:
 *
 *   THE MODE SWITCH IS THE ROOM'S NAME, so it moved into the header. It used to
 *   be a third identity statement stacked above the composer, under a title and
 *   a subtitle that both said the same thing the segment said.
 *
 *   VOICE IS A LIST. It was a free-text field with the placeholder "default",
 *   expecting you to know a backend's internal voice identifier — the first
 *   wall in the room's default mode, and unclimbable without reading model
 *   documentation.
 *
 *   CLONING TAKES A FILE, NOT A PATH. It was a text box you pasted a POSIX path
 *   into. The argument for that was that the clip usually comes from something
 *   this app already made — true for the person who wrote it, and for nobody
 *   else. It is a file picker and a drop target now.
 *
 *   SOUND EFFECTS MAKE FOUR. The mode whose whole thesis is "several at a time,
 *   keep the one that lands" shipped with its count defaulting to 1.
 */
import { type JSX, useMemo, useRef, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { useGenStore } from '../state/gen-store';
import { RunHeader, StudioJob } from './StudioRun';
import { Knob, Segmented, StudioEmpty, StudioShell } from './StudioShell';
import { useStudio } from './use-studio';

type Mode = 'speech' | 'music' | 'sfx';

const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'speech', label: 'Speech' },
  { id: 'music', label: 'Music' },
  { id: 'sfx', label: 'Sound effects' },
];

/*
 * The voices these TTS backends actually ship. A picker of real names beats a
 * text field every time; "Default" means whatever the chosen model prefers,
 * which is the right answer for almost everyone.
 */
const VOICES = [
  { value: '', label: 'Default' },
  { value: 'af_heart', label: 'Heart (warm)' },
  { value: 'af_bella', label: 'Bella' },
  { value: 'af_nicole', label: 'Nicole (soft)' },
  { value: 'am_michael', label: 'Michael' },
  { value: 'am_adam', label: 'Adam' },
  { value: 'bf_emma', label: 'Emma (British)' },
  { value: 'bm_george', label: 'George (British)' },
] as const;

const LENGTHS_MUSIC = [
  { value: 10, label: '10s' },
  { value: 20, label: '20s' },
  { value: 40, label: '40s' },
] as const;

const LENGTHS_SFX = [
  { value: 3, label: '3s' },
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
] as const;

const SPEEDS = [
  { value: 0.85, label: 'Slower' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Faster' },
] as const;

const EXAMPLES: Record<Mode, readonly string[]> = {
  speech: [
    'Once upon a time, in a village at the edge of the woods…',
    'Your table is ready. Follow me, please.',
    'Testing, one two three.',
  ],
  music: [
    'Warm lo-fi piano over vinyl crackle, slow tempo',
    'Bright acoustic guitar, sunny morning, fingerpicked',
    'Low synth drone under distant thunder',
  ],
  sfx: [
    'A heavy wooden door slamming shut in a stone hallway',
    'Footsteps on gravel, slow and deliberate',
    'A glass bottle rolling across a tiled floor',
  ],
};

export function AudioStudio(): JSX.Element {
  const [mode, setMode] = useState<Mode>('speech');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('');
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1);
  const [seconds, setSeconds] = useState<number | undefined>(undefined);
  const [count, setCount] = useState(4);
  const [refAudio, setRefAudio] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel } = useStudio('audio');

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
   * carries on into the same job.
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
      ...(mode !== 'speech' ? { seconds: seconds ?? (mode === 'sfx' ? 5 : 20) } : {}),
      ...(mode === 'sfx' ? { n: count } : {}),
    });
  };

  /* Takes from another mode under this mode's composer are somebody else's work:
     Kokoro's reading is not a candidate door slam. The list filters with the
     mode rather than carrying everything forever. */
  const shown = useMemo(() => runs.filter((r) => r.items.length > 0), [runs]);

  return (
    <StudioShell
      testid="audio-studio"
      title="Audio Studio"
      multiline={mode === 'speech'}
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder={
        mode === 'speech'
          ? 'The text to read aloud…'
          : mode === 'music'
            ? 'Describe a piece — instruments, tempo, mood…'
            : 'Describe a sound…'
      }
      onRun={onRun}
      busy={busy}
      runLabel={mode === 'speech' ? 'Speak' : mode === 'music' ? 'Compose' : 'Generate'}
      {...(blocked !== undefined ? { blocked } : {})}
      error={error}
      headerAccessory={
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
          {mode === 'speech' ? (
            <>
              <Knob label="Voice">
                <select
                  className="pd-studio-select pd-focusable"
                  data-testid="audio-voice"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                >
                  {VOICES.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </Knob>
              <Knob label="Pace">
                <Segmented
                  testid="audio-speed"
                  value={speed}
                  onChange={setSpeed}
                  options={SPEEDS.map((s) => ({ value: s.value, label: s.label }))}
                />
              </Knob>
              {/* VOICE CLONING. A file, chosen or dropped — not a path you paste. */}
              <Knob label="Clone a voice">
                {/* Drop is a pointer gesture by nature; the "Choose a clip…"
                    button inside is the keyboard path to the same thing. */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: the button is the accessible path. */}
                <div
                  className="pd-studio-drop"
                  data-has={refAudio !== '' ? 'true' : undefined}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files[0];
                    if (f !== undefined) setRefAudio(filePath(f));
                  }}
                >
                  <button
                    type="button"
                    className="pd-studio-drop-btn pd-focusable"
                    data-testid="audio-refaudio"
                    onClick={() => fileInput.current?.click()}
                  >
                    {refAudio !== '' ? baseName(refAudio) : 'Choose a clip…'}
                  </button>
                  {refAudio !== '' ? (
                    <button
                      type="button"
                      className="pd-studio-drop-clear pd-focusable"
                      aria-label="Remove the reference clip"
                      onClick={() => setRefAudio('')}
                    >
                      ✕
                    </button>
                  ) : null}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="audio/*"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f !== undefined) setRefAudio(filePath(f));
                    }}
                  />
                </div>
              </Knob>
            </>
          ) : (
            <>
              <Knob label="Length">
                <Segmented
                  testid="audio-seconds"
                  value={seconds ?? (mode === 'sfx' ? 5 : 20)}
                  onChange={setSeconds}
                  options={(mode === 'sfx' ? LENGTHS_SFX : LENGTHS_MUSIC).map((l) => ({
                    value: l.value,
                    label: l.label,
                  }))}
                />
              </Knob>
              {mode === 'sfx' ? (
                <Knob label="Variations">
                  <Segmented
                    testid="audio-count"
                    value={count}
                    onChange={setCount}
                    options={[
                      { value: 1, label: '1' },
                      { value: 2, label: '2' },
                      { value: 4, label: '4' },
                    ]}
                  />
                </Knob>
              ) : null}
            </>
          )}
          <Knob label="Model">
            <select
              className="pd-studio-select pd-focusable"
              data-testid="audio-model"
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
      {shown.length === 0 && job === null ? (
        <StudioEmpty
          glyph={<GlyphAudio />}
          title={
            mode === 'speech'
              ? 'Read anything aloud'
              : mode === 'music'
                ? 'Compose from a description'
                : 'Make a sound, four ways'
          }
          body={
            mode === 'speech'
              ? 'Type something and press Speak. Point “Clone a voice” at a few seconds of someone talking to have it read in that voice.'
              : mode === 'music'
                ? 'Describe instruments, tempo and mood. Everything is made on this Mac.'
                : 'Four takes come back at once. Play them against each other and keep the one that lands.'
          }
          examples={EXAMPLES[mode]}
          onPick={setPrompt}
        />
      ) : (
        shown.map((r) => (
          <section key={r.at} className="pd-studio-run">
            <RunHeader run={r} onAgain={() => setPrompt(r.prompt)} />
            <ThreadMedia items={r.items} layout="single" />
          </section>
        ))
      )}
    </StudioShell>
  );
}

/** Electron exposes the real path on a dropped/chosen File. */
function filePath(f: File): string {
  return (f as File & { path?: string }).path ?? f.name;
}

function baseName(p: string): string {
  return p.split('/').pop() ?? p;
}

function GlyphAudio(): JSX.Element {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Sound</title>
      {/* A waveform: five bars, tallest in the middle. */}
      {[
        { x: 3, h: 3 },
        { x: 7, h: 6 },
        { x: 11, h: 9 },
        { x: 15, h: 5 },
        { x: 19, h: 2 },
      ].map((b) => (
        <line
          key={b.x}
          x1={b.x}
          x2={b.x}
          y1={12 - b.h}
          y2={12 + b.h}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
