/**
 * Dictation: hold the mic, watch the waveform, watch the words appear.
 *
 * The microphone is streamed, not recorded-then-sent. An AudioWorklet taps raw
 * float32 at 16 kHz and posts it to a warm recogniser in main (see
 * DictationSession), which answers with a growing transcript while you are
 * still speaking. MEASURED: ready in 0.9s warm, and 16.5s of speech consumed in
 * 4.4s, so it stays ahead of the voice.
 *
 * THE PARTIALS ARE NOT WHAT LANDS IN THE COMPOSER. Streaming decodes with a
 * small lookahead and it shows — the same clip that streams as "we should crack
 * the every factor the retapa worker" comes back from the full-context pass on
 * stop as "we should probably uh refactor the Retopo worker". So partials are
 * shown live and then REPLACED by the final text. What you watch is a preview;
 * what you keep is the accurate version.
 *
 * RAW PCM ALSO REMOVES A DEPENDENCY. The old path handed MediaRecorder's webm
 * to the worker, which decoded it with ffmpeg — and a GUI-launched app has no
 * /opt/homebrew/bin on its PATH, so dictation failed in the packaged app with
 * "FFmpeg is not installed". Samples need no decoder.
 *
 * THE LEVELS COME FROM AN AnalyserNode, not from those samples: the analyser is
 * already smoothing and windowing for exactly this, and the waveform must keep
 * moving even while a chunk is in flight.
 *
 * The stream is torn down on every exit path — stop, cancel, error, unmount. A
 * live getUserMedia track keeps the OS microphone indicator lit, and an app
 * that leaves that on after you stop dictating looks like it is listening.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGenModulesStore } from '../state/gen-modules-store';

/**
 * `needs-module`: the recogniser runs on the Dictation module and it is not on this
 * Mac yet. The composer shows the module's Download card in place of an error
 * (The user, 2026-10-08: "'the voice model is not installed' … just can't exist
 * anymore"), and dictation starts by itself the moment the install lands.
 */
export type DictationPhase =
  | 'idle'
  | 'needs-module'
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'error';

/** What fixes a dictation that could not happen — a button on its notice. */
export type DictationFix = 'retry' | 'mic-settings';

export interface DictationProblem {
  /** One plain sentence: what happened. */
  readonly text: string;
  /** The button that fixes it. */
  readonly fix: DictationFix;
}

/** Main's answer when the Dictation module is missing. */
const NOT_INSTALLED_RE = /not installed/i;
/** Main's answers for a recording with no speech in it. */
const NOTHING_HEARD_RE = /no speech|nothing was recorded/i;

/** How many bars the waveform keeps. ~3s of history at the sample rate below,
 * and enough of them to span the composer rather than huddle by the button. */
const LEVEL_HISTORY = 96;
// ~30fps. At 60ms the bars visibly stepped; speech has syllable structure well
// under that and the meter has to show it or it reads as not listening.
const LEVEL_INTERVAL_MS = 33;
/** What the recogniser wants. Asking the AudioContext for it makes the browser
 * resample the device, so nothing downstream has to. */
const SAMPLE_RATE = 16_000;

export interface DictationState {
  readonly phase: DictationPhase;
  /** Newest-last RMS levels in 0..1, for the waveform. */
  readonly levels: readonly number[];
  /** The transcript so far. Provisional — later audio revises earlier words. */
  readonly partial: string;
  /** Why the last attempt could not happen, and its fix; null when it did. */
  readonly problem: DictationProblem | null;
  readonly start: () => void;
  /** Stop and keep the text. */
  readonly stop: () => void;
  /** Stop and throw the recording away. */
  readonly cancel: () => void;
}

function toBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  // In chunks: String.fromCharCode(...bytes) on a 16 KB array overflows the
  // argument limit in some builds, and this runs several times a second.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function useDictation(onText: (text: string) => void): DictationState {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [partial, setPartial] = useState('');
  const [problem, setProblem] = useState<DictationProblem | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const timerRef = useRef<number | null>(null);
  const sessionRef = useRef<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const teardownAudio = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (nodeRef.current !== null) {
      nodeRef.current.disconnect();
      if ('port' in nodeRef.current) nodeRef.current.port.onmessage = null;
      else nodeRef.current.onaudioprocess = null;
      nodeRef.current = null;
    }
    // Order matters: stop the tracks before closing the context, or Chromium
    // can leave the capture device open and the OS mic indicator lit.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {
      /* closing a context twice is not an error worth surfacing */
    });
    audioCtxRef.current = null;
  }, []);

  // Partials from the warm recogniser. Subscribed for the component's life
  // rather than per recording: a partial that arrives a beat after `stop` is
  // still about the session the user just ended, and dropping the listener
  // first would lose it.
  useEffect(() => {
    return window.piDesktop.onEvent('audio:dictation', (ev) => {
      if (ev.sessionId === sessionRef.current) setPartial(ev.partial);
    });
  }, []);

  useEffect(() => {
    return () => {
      // Unmounting mid-recording must not leave a session open in main.
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id !== null) void window.piDesktop.invoke('audio:dictation-cancel', { sessionId: id });
      teardownAudio();
    };
  }, [teardownAudio]);

  const fail = useCallback(
    (next: DictationProblem): void => {
      teardownAudio();
      sessionRef.current = null;
      setPhase('error');
      setProblem(next);
    },
    [teardownAudio],
  );
  /** The Dictation module is missing: show its Download card, and start once it lands. */
  const needModule = useCallback((): void => {
    teardownAudio();
    sessionRef.current = null;
    setProblem(null);
    setPhase('needs-module');
  }, [teardownAudio]);

  const start = useCallback((): void => {
    if (phase !== 'idle' && phase !== 'error' && phase !== 'needs-module') return;
    setProblem(null);
    setLevels([]);
    setPartial('');
    setPhase('starting');
    void (async () => {
      // The recogniser runs on the Dictation module. Asking for the microphone
      // first and then failing would be a prompt for nothing.
      const modules = useGenModulesStore.getState();
      if (!modules.loaded) await modules.refresh().catch(() => undefined);
      const module = useGenModulesStore.getState().modules.find((m) => m.id === 'dictation');
      if (module !== undefined && !module.ready) {
        needModule();
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // The recogniser wants speech, not a good recording: these three
          // help it far more than fidelity does.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        fail(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? {
                text: 'Bobble is not allowed to use the microphone. Turn it on in System Settings, then try again.',
                fix: 'mic-settings',
              }
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? { text: 'No microphone is connected. Plug one in, then try again.', fix: 'retry' }
              : {
                  text: 'The microphone is busy or could not be opened. Close other apps using it, then try again.',
                  fix: 'retry',
                },
        );
        return;
      }
      streamRef.current = stream;

      // Open the session BEFORE wiring the tap: a cold recogniser takes a
      // moment to load, and samples sent into that gap would be dropped
      // silently — the user would speak the first few words to nothing.
      const started = await window.piDesktop.invoke('audio:dictation-start', {}).catch(() => null);
      if (started === null || !started.ok || started.sessionId === undefined) {
        for (const track of stream.getTracks()) track.stop();
        if (NOT_INSTALLED_RE.test(started?.error ?? '')) {
          needModule();
          return;
        }
        fail({
          text: 'The speech recogniser did not start — it may still be downloading its model. Try again in a moment.',
          fix: 'retry',
        });
        return;
      }
      // Cancelled while the model was loading: honour it rather than opening
      // a recording the user already backed out of.
      if (streamRef.current !== stream) {
        void window.piDesktop.invoke('audio:dictation-cancel', { sessionId: started.sessionId });
        return;
      }
      sessionRef.current = started.sessionId;
      const sessionId = started.sessionId;

      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);

      // Live levels for the waveform.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      timerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const c = (v - 128) / 128;
          sum += c * c;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Speech RMS sits around 0.02-0.15 — on a linear scale that is the
        // bottom tenth of the meter, which is exactly why the first cut looked
        // dead. Map it in dB instead, where the ear lives: -55 dBFS floor to
        // -12 dBFS full scale, then keep a visible minimum so silence still
        // draws a line rather than nothing.
        const db = 20 * Math.log10(Math.max(rms, 1e-5));
        const level = Math.max(0.06, Math.min(1, (db + 55) / 43));
        setLevels((prev) => [...prev, level].slice(-LEVEL_HISTORY));
      }, LEVEL_INTERVAL_MS);

      const sendChunk = (samples: Float32Array): void => {
        if (sessionRef.current !== sessionId) return;
        void window.piDesktop
          .invoke('audio:dictation-chunk', { sessionId, pcmBase64: toBase64(samples) })
          .catch(() => {
            /* one lost chunk is a word, not a session; the next one still lands */
          });
      };

      try {
        await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
        const node = new AudioWorkletNode(ctx, 'pcm-capture');
        node.port.onmessage = (e: MessageEvent<Float32Array>) => sendChunk(e.data);
        source.connect(node);
        // A worklet with no downstream is not pulled in every engine; a
        // zero-gain sink guarantees it runs without making the mic audible.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
        nodeRef.current = node;
      } catch {
        // The worklet is a separate asset and asset loading is the kind of
        // thing packaging breaks. ScriptProcessor is deprecated and runs on the
        // main thread, but a dictation that works beats one that is modern.
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => sendChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
        source.connect(node);
        node.connect(ctx.destination);
        nodeRef.current = node;
      }

      setPhase('recording');
    })();
  }, [phase, fail, needModule]);

  const stop = useCallback((): void => {
    const sessionId = sessionRef.current;
    if (sessionId === null) {
      // Pressed before the recogniser finished loading: nothing was heard, so
      // there is nothing to transcribe. Cancelling is the honest answer.
      teardownAudio();
      setPhase('idle');
      setLevels([]);
      setPartial('');
      return;
    }
    // Stop the microphone NOW. Everything the recogniser needs has already been
    // sent, and leaving the mic open while the final pass runs is exactly the
    // "is it still listening?" that makes people distrust dictation.
    teardownAudio();
    setPhase('transcribing');
    void (async () => {
      const res = await window.piDesktop
        .invoke('audio:dictation-stop', { sessionId })
        .catch(() => null);
      sessionRef.current = null;
      // Main answers an empty recording with ok:false ("no speech was
      // recognised", "nothing was recorded"): that is nothing heard, not a fault.
      const heardNothing =
        res !== null &&
        (res.ok ? (res.text ?? '').trim() === '' : NOTHING_HEARD_RE.test(res.error ?? ''));
      if (!heardNothing && (res === null || !res.ok || res.text === undefined)) {
        setPhase('error');
        setProblem({
          text: 'That recording could not be turned into text. Try saying it again.',
          fix: 'retry',
        });
        return;
      }
      if (heardNothing || res === null || res.text === undefined) {
        // The live preview guessed at a sound; with nothing heard, the
        // composer goes back to what was there before the mic opened.
        onTextRef.current('');
        setPhase('error');
        setProblem({
          text: 'Nothing was heard. Speak a little closer to the microphone and try again.',
          fix: 'retry',
        });
        return;
      }
      onTextRef.current(res.text.trim());
      setPhase('idle');
      setLevels([]);
      setPartial('');
    })();
  }, [teardownAudio]);

  const cancel = useCallback((): void => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    teardownAudio();
    setPhase('idle');
    setLevels([]);
    setPartial('');
    setProblem(null);
    if (sessionId !== null) {
      void window.piDesktop.invoke('audio:dictation-cancel', { sessionId }).catch(() => {
        /* the session dies with the process anyway */
      });
    }
  }, [teardownAudio]);

  /*
   * DOWNLOAD, THEN CONTINUE. While the Download card is up, the install
   * landing starts the dictation the person asked for; closing the card puts
   * the mic back to rest.
   */
  const moduleReady = useGenModulesStore(
    (st) => st.modules.find((m) => m.id === 'dictation')?.ready === true,
  );
  const closed = useGenModulesStore((st) => st.closed);
  const closedAtAsk = useRef(closed);
  useEffect(() => {
    if (phase !== 'needs-module') closedAtAsk.current = closed;
  }, [phase, closed]);
  useEffect(() => {
    if (phase !== 'needs-module') return;
    if (moduleReady) start();
    else if (closed !== closedAtAsk.current && closed.includes('dictation')) cancel();
  }, [phase, moduleReady, closed, start, cancel]);

  return { phase, levels, partial, problem, start, stop, cancel };
}
