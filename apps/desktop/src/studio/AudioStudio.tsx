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
 *   SOUND EFFECTS MAKE ONE, unless asked. "Several at a time, keep the one that
 *   lands" was the thesis, and four identical-looking cards for one prompt read
 *   as an accident next to the music mode's one (the user, 2026-09-17).
 */
import { type JSX, useCallback, useMemo, useRef, useState } from 'react';
import { ThreadMedia } from '../chat/ThreadMedia';
import { ModuleCard } from '../media/ModuleCard';
import { useGenStore } from '../state/gen-store';
import { RunHeader, StudioJob } from './StudioRun';
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

type Mode = 'speech' | 'music' | 'sfx';

/*
 * "Effects", not "Sound effects": these three sit in a 236px-wide rail, and the
 * longer label wrapped to two lines and burst its pill. The word costs nothing
 * here — the room is the Audio Studio and the group is headed MODE, so there is
 * nothing else "effects" could mean.
 */
const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'speech', label: 'Speech' },
  { id: 'music', label: 'Music' },
  { id: 'sfx', label: 'Effects' },
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
  // One take by default (the user, 2026-09-17: four cards for one prompt read as
  // "random amount of output"); the rail's Count still asks for more.
  const [count, setCount] = useState(1);
  const [refAudio, setRefAudio] = useState('');
  const [steps, setSteps] = useState<number | ''>('');
  const [seed, setSeed] = useState<number | ''>('');
  const fileInput = useRef<HTMLInputElement>(null);

  const catalog = useGenStore((s) => s.catalog);
  const { busy, error, runs, job, run, cancel, finishReveal } = useStudio('audio');

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
  const blocked = studioBlockedReason(models, mode === 'speech' ? 'speech' : 'sound');

  const enhancer = useEnhancer(useCallback((next: string) => setPrompt(next), []));

  /* Media handed to this room — from a card in the transcript, or dropped on

     it. Seeds the prompt with whatever made it. See useStudioInput. */

  const handoff = useStudioInput(
    'audio',
    useCallback((p: string) => setPrompt(p), []),
  );
  const setSettingsOpen = useStudioUiStore((st) => st.setSettingsOpen);

  /*
   * The three cards ARE the room's three modes, which is the point: you could
   * not tell from looking at this studio that it clones voices or writes music
   * — the mode switch lives in the rail, behind a button, and a first visitor
   * has no reason to open it. the user asked for exactly this ("these are like
   * 'Clone a voice'"), and cloning is the one that most needed saying out loud.
   */
  const starters: readonly StudioStarter[] = [
    {
      id: 'aloud',
      icon: <GlyphSpeak />,
      title: 'Read it aloud',
      hint: 'Paste a line or a paragraph and pick a voice.',
      onPick: () => {
        setMode('speech');
        setModel('');
        setPrompt(EXAMPLES.speech[0] ?? '');
      },
    },
    {
      id: 'clone',
      icon: <GlyphClone />,
      title: 'Clone a voice',
      hint: 'A few seconds of speech, read back in that voice.',
      onPick: () => {
        setMode('speech');
        setModel('');
        setPrompt(EXAMPLES.speech[1] ?? '');
        // Straight to the rail: the clip picker is the point of this one, and
        // it lives there.
        setSettingsOpen(true);
      },
    },
    {
      id: 'music',
      icon: <GlyphNote />,
      title: 'Compose music',
      hint: 'Genre, instruments, tempo.',
      onPick: () => {
        setMode('music');
        setModel('');
        setSeconds(undefined);
        setPrompt(EXAMPLES.music[0] ?? '');
      },
    },
  ];

  /** `override`: an edited prompt from a run's header, generated straight away. */
  const onRun = async (override?: string): Promise<void> => {
    const asked = override ?? prompt;
    /*
     * SPEECH IS NEVER ENHANCED. The prompt is not a description of the audio —
     * it IS the audio, read out. Rewriting it would put words in the user's
     * mouth, so the enhancer refuses this mode on both sides of the IPC and the
     * toggle is disabled here rather than silently doing nothing.
     */
    const text = await enhancer.enhance(mode, asked, model);
    await run({
      kind: 'audio',
      audioKind: mode,
      prompt: text,
      ...(model !== '' ? { model } : {}),
      ...(mode === 'speech' && voice !== '' ? { voice } : {}),
      ...(mode === 'speech' && speed !== 1 ? { speed } : {}),
      ...(mode === 'speech' && refAudio !== '' ? { refAudio } : {}),
      ...(mode !== 'speech' ? { seconds: seconds ?? (mode === 'sfx' ? 5 : 20) } : {}),
      ...(mode === 'sfx' ? { n: count } : {}),
      // Not for speech: a reading is not sampled the way a picture is, so
      // sending a step count and a seed there would be two fields the job
      // carries and nothing reads.
      ...(mode !== 'speech' && steps !== '' ? { steps } : {}),
      ...(mode !== 'speech' && seed !== '' ? { seed } : {}),
    });
  };

  /* Takes from another mode under this mode's composer are somebody else's work:
     Kokoro's reading is not a candidate door slam. The list filters with the
     mode rather than carrying everything forever. */
  const shown = useMemo(() => runs.filter((r) => r.items.length > 0), [runs]);

  return (
    <StudioShell
      testid="audio-studio"
      multiline={mode === 'speech'}
      prompt={prompt}
      onPrompt={setPrompt}
      placeholder={
        mode === 'speech'
          ? 'The text to read aloud…'
          : mode === 'music'
            ? 'Instruments, tempo, mood…'
            : 'Describe a sound…'
      }
      onRun={() => void onRun()}
      busy={busy || enhancer.enhancing}
      {...(job?.cancellable === true ? { onStop: cancel } : {})}
      runLabel={
        enhancer.enhancing
          ? 'Enhancing…'
          : mode === 'speech'
            ? 'Speak'
            : mode === 'music'
              ? 'Compose'
              : 'Generate'
      }
      {...(blocked !== undefined ? { blocked } : {})}
      notice={<ModuleCard id={mode === 'speech' ? 'audio' : 'comfy'} place="studio" />}
      error={error}
      onRetry={() => void onRun()}
      {...(handoff.card !== undefined ? { input: handoff.card } : {})}
      onDropFiles={handoff.acceptFiles}
      /* The whole core set, in the bar — see ImageStudio for why. The knobs
         that exist depend on the mode, which is itself the first control. */
      controls={
        <>
          <StudioPicker
            testid="audio-mode"
            label="Mode"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setModel('');
              setSeconds(undefined);
            }}
            options={MODES.map((m) => ({ value: m.id, label: m.label }))}
          />
          {mode === 'speech' ? (
            <>
              <StudioPicker
                testid="audio-voice"
                label="Voice"
                value={voice}
                onChange={setVoice}
                options={VOICES.map((v) => ({ value: v.value, label: v.label }))}
              />
              <StudioPicker
                testid="audio-speed"
                label="Pace"
                value={speed}
                onChange={setSpeed}
                options={SPEEDS.map((sp) => ({ value: sp.value, label: sp.label }))}
              />
            </>
          ) : (
            <>
              <StudioPicker
                testid="audio-seconds"
                label="Length"
                value={seconds ?? (mode === 'sfx' ? 5 : 20)}
                onChange={setSeconds}
                options={(mode === 'sfx' ? LENGTHS_SFX : LENGTHS_MUSIC).map((l) => ({
                  value: l.value,
                  label: l.label,
                }))}
              />
              {mode === 'sfx' ? (
                <StudioPicker
                  testid="audio-count"
                  label="Takes"
                  value={count}
                  onChange={setCount}
                  options={[
                    { value: 1, label: '1' },
                    { value: 2, label: '2' },
                    { value: 4, label: '4' },
                  ]}
                />
              ) : null}
            </>
          )}
          <StudioPicker
            testid="audio-model"
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
          {mode === 'speech' ? null : (
            <StudioPicker
              testid="audio-enhance"
              label="Enhance"
              value={enhancer.enabled ? 'on' : 'off'}
              onChange={(v) => enhancer.setEnabled(v === 'on')}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
            />
          )}
        </>
      }
      settings={
        <>
          {/*
            THE MODE IS THE FIRST THING IN THE RAIL, because it is the room's
            name: it decides what the composer means, which knobs exist below it,
            and which models can serve. It used to sit in a header this studio no
            longer has.
          */}
          <RailGroup title="Mode">
            {/* The same `Segmented` as every other choice in the studios, so
                the mode switch slides like the rest rather than being the one
                row that blinks. */}
            <Segmented
              testid="audio-mode-rail"
              ariaLabel="Audio mode"
              value={mode}
              onChange={(next) => {
                setMode(next);
                // A model chosen for one mode cannot serve another — Kokoro is
                // not going to make a door slam — so the pick resets with the
                // mode rather than silently failing on the next run.
                setModel('');
                setSeconds(undefined);
              }}
              options={MODES.map((m) => ({ value: m.id, label: m.label }))}
            />
          </RailGroup>

          {mode === 'speech' ? (
            <RailGroup title="Voice">
              <Knob label="Preset">
                <StudioPicker
                  block
                  side="bottom"
                  testid="audio-voice-rail"
                  label="Preset"
                  value={voice}
                  onChange={setVoice}
                  options={VOICES.map((v) => ({ value: v.value, label: v.label }))}
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
                    data-testid="audio-refaudio-rail"
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
              <p className="pd-studio-rail-note">A few seconds of speech is enough.</p>
            </RailGroup>
          ) : null}

          {mode === 'sfx' ? (
            <RailGroup title="Take">
              <Knob label="Variations">
                <Segmented
                  testid="audio-count-rail"
                  value={count}
                  onChange={setCount}
                  options={[
                    { value: 1, label: '1' },
                    { value: 2, label: '2' },
                    { value: 4, label: '4' },
                  ]}
                />
              </Knob>
            </RailGroup>
          ) : null}

          <RailGroup title="Prompt">
            <RailToggle
              testid="audio-enhance-rail"
              label="Prompt enhancer"
              hint={
                mode === 'speech'
                  ? 'Off for speech — this text is read aloud exactly as you typed it.'
                  : mode === 'music'
                    ? 'Rewrites your idea as the genre, instrument and tempo tags this model is steered by.'
                    : 'Rewrites your idea as one literal sound event in a room.'
              }
              checked={mode !== 'speech' && enhancer.enabled}
              disabled={mode === 'speech'}
              onChange={enhancer.setEnabled}
            />
            {enhancer.previous !== null && mode !== 'speech' ? (
              <button
                type="button"
                className="pd-studio-rail-undo pd-focusable"
                data-testid="audio-enhance-undo"
                onClick={enhancer.undo}
              >
                Undo the rewrite
              </button>
            ) : null}
          </RailGroup>

          <RailGroup title="Model">
            <Knob label={mode === 'speech' ? 'Speech model' : 'Sound model'}>
              <StudioPicker
                block
                side="bottom"
                testid="audio-model-rail"
                label="Model"
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
              data-testid="audio-steps-rail"
              type="number"
              min={1}
              max={200}
              placeholder="auto"
              value={steps}
              onChange={(e) => setSteps(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <Knob label="Seed">
            <input
              className="pd-studio-input pd-studio-input--wide pd-focusable"
              data-testid="audio-seed-rail"
              type="number"
              placeholder="random"
              value={seed}
              onChange={(e) => setSeed(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Knob>
          <p className="pd-studio-rail-note">Music and sound effects only. Speech ignores both.</p>
        </>
      }
    >
      {job !== null ? (
        <StudioJob job={job} variant="audio" model={model} onRevealed={finishReveal} />
      ) : null}
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
          starters={starters}
        />
      ) : (
        shown.map((r) => (
          <section key={r.at} className="pd-studio-run">
            <RunHeader
              run={r}
              onAgain={(edited) => {
                setPrompt(edited);
                void onRun(edited);
              }}
            />
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

/* Starter glyphs — same 1.4 stroke and 24-box as the room's own waveform. */
function GlyphSpeak(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Read aloud</title>
      <path
        /* `H4z` rather than `v-5z`: the old form walked back up the left edge
           and THEN closed over the same point, doubling the join. */
        d="M4 9.5h3l4.5-3.5v12L7 14.5H4z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GlyphClone(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Clone a voice</title>
      <rect x="9" y="2.5" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.4" />
      {/* The cradle ends where the capsule begins and the stand starts below it;
          nothing is drawn twice. */}
      <path
        d="M6 11.2a6 6 0 0012 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M12 17.6v3.9M9.4 21.5h5.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GlyphNote(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Compose music</title>
      {/* The stems STOP at the note heads instead of running through them — the
          circles used to sit on top of the stem path, and two strokes over the
          same pixels is where the drawing went bright. */}
      <path
        d="M9 15.6V5.5l10-2v10.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9 8.4l10-2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.5" cy="17.6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="16.5" cy="15.6" r="2.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
