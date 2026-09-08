/**
 * Coarse task-complexity tiers + the user-facing model-capability tiers, and the
 * pure task→tier maps the app uses to route Auto model selection (round-12).
 *
 * The harness only PUBLISHES the active model tier (via `HarnessStatus.activeTier`);
 * resolving a tier to a concrete model + performing the llama-server switch is the
 * APP's job (it alone can restart the server + pi). This module stays pure +
 * dependency-free so both the harness and the renderer import it cheaply.
 */
import type { EffortLevel } from '../effort/effort.js';
import type { TaskClass } from './classify.js';

/** Coarse task complexity the classifier emits (the user's quick/balanced/complex). */
export type CoarseTier = 'quick' | 'balanced' | 'complex';

/** The model-capability tier a coarse task maps to (the user-facing labels). */
export type ModelTier = 'fast' | 'balanced' | 'intelligent';

export const COARSE_TIERS: readonly CoarseTier[] = ['quick', 'balanced', 'complex'];
export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'intelligent'];

/** User-facing labels (the grey model name renders separately, below these). */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  intelligent: 'Intelligent',
};

/** 1:1 coarse→model tier (kept as two vocabularies because the user uses both). */
export const COARSE_TO_MODEL: Record<CoarseTier, ModelTier> = {
  quick: 'fast',
  balanced: 'balanced',
  complex: 'intelligent',
};

export function isCoarseTier(v: unknown): v is CoarseTier {
  return typeof v === 'string' && (COARSE_TIERS as readonly string[]).includes(v);
}

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v);
}

/**
 * Map a concrete {@link TaskClass} → coarse tier. Pure, deterministic, tunable —
 * this switch is the SINGLE knob for the app's Auto router:
 *   simple-QA                                             → quick
 *   basic-tools | other | connectors | file-ops | 2d-art | audio | video-edit | perception → balanced
 *   coding | browser-use | 3d | motion-graphics | advanced-video → complex
 *
 * (2d-art / file-ops / video-edit / perception are LLM-orchestrated typed-tool
 *  calls, not heavy reasoning → balanced; gen/agentic categories that plan
 *  multi-step work → complex.)
 */
export function coarseTier(cls: TaskClass): CoarseTier {
  switch (cls) {
    case 'simple-QA':
      return 'quick';
    case 'basic-tools':
    case 'other':
    case 'connectors':
    case 'file-ops':
    case '2d-art':
    case 'audio':
    case 'video-edit':
    case 'perception':
      return 'balanced';
    case 'coding':
    case 'browser-use':
    // Same shape as browser-use: look, act, look again, and check what changed.
    case 'computer-use':
    case '3d':
    case 'motion-graphics':
    case 'advanced-video':
      return 'complex';
  }
}

/** The user-facing model tier a task class routes to. */
export function modelTierForClass(cls: TaskClass): ModelTier {
  return COARSE_TO_MODEL[coarseTier(cls)];
}

/**
 * The effort ADAPTIVE should use for a task — the classifier's judgement, not a
 * function of which model happens to be loaded.
 *
 * Adaptive used to be `autoEffortForTier(activeModelTier)`: fast→low,
 * balanced→medium, intelligent→high. Two consequences, both wrong:
 *
 *  - MAX WAS UNREACHABLE. No adaptive setting could ever produce it, so anything
 *    gated on high/max — the corp system among them — was off unless the user
 *    dragged the slider by hand.
 *  - PINNING THE MODEL PINNED THE THINKING. With the model held on Fast, effort
 *    resolved to `low` however large the task was. the user asked, on Adaptive with
 *    Fast selected, for a manager to be given a Godot project, and the model
 *    replied that it had no way to contact a manager and offered to draft an
 *    email — because `talk_to_manager` needs high/max and low is what the loaded
 *    model tier produced. The team was not declining to help; it did not exist.
 *
 * the user: "adaptive should be able to be anything based on classifier". So the
 * effort comes from the task class, spans the whole range, and says nothing
 * about model choice — a small model asked to build a game should still think
 * hard and still have its team.
 */
/**
 * Did the user ASK for the team, in so many words?
 *
 * Effort is otherwise derived from the task CLASS, and a class says what
 * MODALITY a task is — never how big it is. The corporation is gated on
 * high/max, so a size question is being answered by a topic classifier, and
 * plenty of genuinely large work lands under the gate: "research X and build me
 * a slideshow" classes as `basic-tools` (medium), "add dark mode to the project"
 * as `other` (medium). That mismatch is a real design gap and is NOT fixed here.
 *
 * What IS fixed here is the indefensible case. When someone writes "ask the
 * manager to ...", they have said what they want in plain words, and answering
 * "I don't have access to tools that can contact your manager" — which is what
 * the user got, twice — is the harness overruling an explicit instruction with a
 * guess about size. MEASURED: a run whose prompt opened "Ask the manager to
 * research ... and build me a slideshow" was classed medium, so
 * `talk_to_manager` was stripped from the tool list and ten minutes were spent
 * with no team and no explanation.
 *
 * Deliberately narrow: it matches an explicit request to delegate, not a passing
 * mention of a manager as a person or a topic.
 */
const ASKS_FOR_THE_TEAM =
  /\b(?:ask|tell|get|have)\s+(?:the|your|our|a)\s+(?:manager|team)\b|\b(?:talk|speak)\s+to\s+(?:the|your)\s+manager\b|\bdelegate\s+(?:this|it|that)\b|\bhand\s+(?:this|it|that)\s+(?:off|over)\s+to\s+(?:the|your)\s+(?:manager|team)\b/i;

export function asksForTheTeam(prompt: string): boolean {
  return ASKS_FOR_THE_TEAM.test(prompt);
}

export function effortForClass(cls: TaskClass): EffortLevel {
  switch (cls) {
    case 'simple-QA':
      return 'low';
    case 'basic-tools':
    case 'other':
    case 'connectors':
    case 'file-ops':
    case 'perception':
      return 'medium';
    case '2d-art':
    case 'audio':
    case 'video-edit':
    case 'browser-use':
    // An errand in an app, not a project — but a chain, and a chain that has to
    // check what each step actually did.
    case 'computer-use':
      return 'high';
    // The multi-part builds: a project, not an errand. These are the ones that
    // want the whole apparatus — the team, and the verification that comes with
    // it — so they reach the top of the range.
    case 'coding':
    case '3d':
    case 'motion-graphics':
    case 'advanced-video':
      return 'max';
  }
}
