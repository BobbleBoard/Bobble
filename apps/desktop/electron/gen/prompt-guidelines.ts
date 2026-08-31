/**
 * WHAT EACH GENERATOR WANTS TO BE TOLD.
 *
 * A prompt that works for one image model is often the worst thing you can hand
 * another. The models this app recommends split into a few dialects, and the
 * split is not about taste — it is about what encodes the text:
 *
 *   - A model with a LANGUAGE-MODEL text encoder (FLUX's T5, Qwen-Image's
 *     Qwen-VL, Z-Image's) reads a sentence. Comma-separated keyword soup makes
 *     it worse, because you have thrown away the grammar it was trained to use.
 *   - A model with a CLIP-only encoder reads a bag of concepts, so tags are
 *     right and long sentences are wasted tokens.
 *   - A VIDEO model is being told about CHANGE. If nothing in the prompt moves,
 *     nothing in the clip moves, and you get a photograph that costs two
 *     minutes.
 *   - A MUSIC model (ACE-Step) is closest to a tag list: genre, instruments,
 *     tempo, production.
 *   - A SPEECH model is not being described to at all — the prompt IS the text
 *     it reads. Rewriting it is not enhancement, it is putting words in
 *     someone's mouth, so speech has no guidance here at all and the enhancer
 *     refuses to run on it.
 *
 * These notes are the enhancer's whole knowledge of the target. They are data,
 * kept apart from the model that applies them, so adding a generator is one
 * entry here and correcting a mistake is one edit rather than a prompt rewrite.
 */

/** The dialects. One per way of being written to, not one per model. */
export type PromptDialect = 'image-natural' | 'video' | 'music' | 'sfx' | 'none';

export interface PromptGuideline {
  readonly dialect: PromptDialect;
  /** Shown to the enhancer as the target's house style. */
  readonly rules: readonly string[];
  /** One worked rewrite. A single example does more than five more rules. */
  readonly example: { readonly from: string; readonly to: string };
  /** Roughly how long the rewrite should be. Enforced as a hard cap downstream. */
  readonly maxWords: number;
}

const IMAGE_NATURAL: PromptGuideline = {
  dialect: 'image-natural',
  rules: [
    'Write ONE flowing description in plain English, not a list of tags.',
    'Order it: subject, what the subject is doing, where, then light, then the medium or lens.',
    'Add concrete visual detail the user implied but did not say — material, colour, time of day, texture.',
    'Never use weight syntax like (word:1.3), never use BREAK, never list negatives or things to avoid.',
    'Do not pad with "masterpiece, best quality, 8k, highly detailed" — these models do not need it and it costs you detail that matters.',
    'If the user asked for words to appear in the picture, keep them in double quotes exactly as written.',
  ],
  example: {
    from: 'a fox in grass',
    to: 'A red fox curled asleep in tall dry grass, its tail across its nose, low golden evening sun raking through the seed heads and lighting the fur along its back, shallow depth of field, 85mm photograph.',
  },
  maxWords: 70,
};

const VIDEO: PromptGuideline = {
  dialect: 'video',
  rules: [
    'This makes a few seconds of MOTION. Say what moves, and say it first — a still description produces a still clip.',
    'One paragraph, in the order it happens. One subject, one continuous action, one place.',
    'Then the camera: static, slow push in, pan left, handheld, tracking.',
    'Then the setting and the light.',
    'Never describe a cut, a second shot or a scene change — it cannot make one, and asking splits the clip into mush.',
    'Do not start with "a video of" or "footage of". Describe the scene itself.',
  ],
  example: {
    from: 'paper boat in a rain gutter',
    to: 'A folded paper boat drifts along a rain gutter, spinning slowly as the current carries it over a grate and bumps it against the kerb. The camera tracks alongside it at water level. Grey afternoon light, wet asphalt, raindrops pocking the surface.',
  },
  maxWords: 80,
};

const MUSIC: PromptGuideline = {
  dialect: 'music',
  rules: [
    'Write a comma-separated tag list, not a sentence — this model is steered by tags.',
    'Cover, in order: genre, instrumentation, mood, tempo as a number in BPM, and production character.',
    'Name real instruments rather than adjectives about them.',
    'Do not write lyrics, a title, or a story about the track.',
  ],
  example: {
    from: 'something chill for studying',
    to: 'lo-fi hip hop, warm Rhodes piano, muted upright bass, brushed drums, vinyl crackle, relaxed and hazy, 72 BPM, soft tape saturation, instrumental',
  },
  maxWords: 40,
};

const SFX: PromptGuideline = {
  dialect: 'sfx',
  rules: [
    'Describe ONE sound event literally: what makes the sound, what it does, and the space it happens in.',
    'Short and concrete. The room matters — "in a stone hallway" changes the result more than any adjective.',
    'No music terms, no story, no emotion words.',
    'Never more than one sound event per prompt.',
  ],
  example: {
    from: 'door slam',
    to: 'A heavy wooden door slamming shut, latch clacking, long reverb tail in a stone hallway',
  },
  maxWords: 30,
};

/** Speech is not described, it is read. Nothing to enhance. */
const NONE: PromptGuideline = {
  dialect: 'none',
  rules: [],
  example: { from: '', to: '' },
  maxWords: 0,
};

/**
 * Model id → dialect.
 *
 * There is no tag dialect in this table because there is no model here that
 * wants one: every image generator the app catalogues has a language-model text
 * encoder. The CLIP-only case is described at the top of this file because it is
 * the thing a maintainer adding an SD-family checkpoint will need to know, and
 * it is one entry away — not because the code half-supports it today.
 */
const BY_MODEL: Readonly<Record<string, PromptGuideline>> = {
  'flux2-klein-4b': IMAGE_NATURAL,
  'flux1-schnell': IMAGE_NATURAL,
  'flux1-dev-gguf': IMAGE_NATURAL,
  'z-image-turbo': IMAGE_NATURAL,
  'qwen-image-2512': IMAGE_NATURAL,
  hyperframes: VIDEO,
  'wan2.1-t2v-1.3b': VIDEO,
  'ltx-video-2b-distilled': VIDEO,
  'ltx-2': VIDEO,
  'ltx-2-22b': VIDEO,
  'ace-step': MUSIC,
  'stable-audio-open': SFX,
  'stable-audio-open-small': SFX,
};

/** What a kind of job wants when the model is "Recommended" (i.e. unnamed). */
const BY_KIND: Readonly<Record<string, PromptGuideline>> = {
  image: IMAGE_NATURAL,
  video: VIDEO,
  music: MUSIC,
  sfx: SFX,
  speech: NONE,
};

/** The kinds of job the enhancer knows about — the studio's mode, not the model. */
export type EnhanceKind = 'image' | 'video' | 'music' | 'sfx' | 'speech';

/**
 * The guidance for this job. The MODEL wins when we know it, because a named
 * model is a fact and the kind is only a default; an unknown model falls back to
 * the kind rather than to nothing, so a user-added generator still gets sensible
 * advice instead of a raw prompt.
 */
export function guidelineFor(kind: EnhanceKind, model?: string): PromptGuideline {
  if (model !== undefined && model !== '') {
    const exact = BY_MODEL[model];
    if (exact !== undefined) return exact;
  }
  return BY_KIND[kind] ?? NONE;
}

/** Whether enhancing this job is meaningful at all. Speech is the one that is not. */
export function canEnhance(kind: EnhanceKind, model?: string): boolean {
  return guidelineFor(kind, model).dialect !== 'none';
}
