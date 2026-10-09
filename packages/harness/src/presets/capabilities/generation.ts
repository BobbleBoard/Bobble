/**
 * The `generation` capability.
 *
 * One file per capability (the W0-A pre-wire, deliverables/research/PLAN.md
 * §2.3): the lane that owns a capability's wording edits this file and nothing
 * else. The ORDER the model reads them in is the list in ../capabilities.ts, and
 * every byte of this text is in the canonical prompt — a change here is a prompt
 * change (the snapshot test in ../../prompt, the prefix ledger, a BENCH TTFT
 * check; PLAN.md R8).
 */
import type { Capability } from './types.js';

export const generation: Capability = {
  name: 'generation',
  /* MEASURED: with this line present AND the standing "imaging libraries …
     are not how this works" below it, a 2B asked for a picture still probed
     the shell, found Pillow, and wrote a script that draws the subject out of
     rectangles. So the line names the mistake directly — and handmade-media.ts
     catches it at the write, because a line among nine abilities does not
     outweigh what a model already knows how to do. */
  summary:
    'Create images, video, speech, music and sound effects on-device. Every request for a ' +
    'picture, a clip or a sound goes here — never draw or synthesise one in code.',
  guidance:
    'Use when the deliverable IS the media, rather than a description of it. NEVER write a ' +
    'script that draws a picture or synthesises a sound (Pillow, cairo, wave, ffmpeg): a ' +
    'drawing library makes the shapes you described, this makes the thing itself. Code is ' +
    'right for a CHART or a diagram, which is a rendering of data and not a picture of ' +
    'something. For a picture that has to be GOOD rather than merely produced, commission ' +
    'the image specialist with spawn_subagent instead — it works in passes and keeps the best.',
  /*
   * ONLY WHAT IS REGISTERED. This listed nine names; four existed. `image_generate`,
   * `image_edit`, `video_generate`, `video_edit`, `extract_frames`, `probe` and
   * `motion_graphics_render` were aspirational — activating this capability handed
   * the model seven tools it could not call, and (per the coercion this codebase has
   * measured twice) a bid for one of them lands on whichever advertised name is
   * nearest. The user: "you can remove things from being explicitly in the ui gallery
   * card." So: the four that a real extension registers, and nothing else.
   */
  /*
   * AUDIO ADDED. The three audio tools were registered by the gen-tools
   * extension and reachable through `use`, but this capability's summary said
   * "images, video, motion graphics and 3D models" and its list named none of
   * them — so a model asked to read a sentence aloud answered, correctly from
   * what it could see, "I don't have a speech or text-to-speech tool
   * available." MEASURED: exactly that reply, on a real turn.
   *
   * Same rule as the note above — only names a real extension registers.
   */
  tools: [
    'generate_image',
    'edit_image',
    'generate_video',
    'generate_speech',
    'generate_music',
    'generate_sfx',
  ],
};
