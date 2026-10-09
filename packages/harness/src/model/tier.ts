/**
 * The user-facing model-capability tiers — Fast / Balanced / Intelligent.
 *
 * This module used to also hold the task→tier maps that let Auto pick a model
 * from a guessed task class. Those are gone with task classification: Auto now
 * resolves to the best model this machine runs and stays there, so a
 * conversation is never interrupted by a seconds-long server restart because a
 * keyword in one message read as "complex".
 *
 * What remains is vocabulary the UI needs (the tier picker, the model list) and
 * one question about the user's own words. Pure and dependency-free, so both the
 * harness and the renderer import it cheaply.
 */

/** The model-capability tier a user picks (the user-facing labels). */
export type ModelTier = 'fast' | 'balanced' | 'intelligent';

export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'intelligent'];

/** User-facing labels (the grey model name renders separately, below these). */
export const TIER_LABEL: Record<ModelTier, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  intelligent: 'Intelligent',
};

export function isModelTier(v: unknown): v is ModelTier {
  return typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v);
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
 *    resolved to `low` however large the task was. The user asked, on Adaptive with
 *    Fast selected, for a manager to be given a Godot project, and the model
 *    replied that it had no way to contact a manager and offered to draft an
 *    email — because `talk_to_manager` needs high/max and low is what the loaded
 *    model tier produced. The team was not declining to help; it did not exist.
 *
 * The user: "adaptive should be able to be anything based on classifier". So the
 * effort comes from the task class, spans the whole range, and says nothing
 * about model choice — a small model asked to build a game should still think
 * hard and still have its team.
 */

/**
 * Did the user ASK for the team, in so many words?
 *
 * The corporation is gated on high/max effort. Effort used to be derived from a
 * task CLASS — a topic classifier answering a question about SIZE — and plenty
 * of genuinely large work landed under the gate. Classification is gone now and
 * effort is a plain setting, which removes the guess; this stays for the case
 * that was indefensible either way.
 *
 * When someone writes "ask the manager to …", they have said what they want in
 * plain words, and answering "I don't have access to tools that can contact your
 * manager" — which is what the user got, twice — is the harness overruling an
 * explicit instruction. MEASURED: a run whose prompt opened "Ask the manager to
 * research … and build me a slideshow" ran ten minutes with no team and no
 * explanation.
 *
 * Deliberately narrow: an explicit request to delegate, not a passing mention of
 * a manager as a person or a topic.
 */
const ASKS_FOR_THE_TEAM =
  /\b(?:ask|tell|get|have)\s+(?:the|your|our|a)\s+(?:manager|team)\b|\b(?:talk|speak)\s+to\s+(?:the|your)\s+manager\b|\bdelegate\s+(?:this|it|that)\b|\bhand\s+(?:this|it|that)\s+(?:off|over)\s+to\s+(?:the|your)\s+(?:manager|team)\b/i;

export function asksForTheTeam(prompt: string): boolean {
  return ASKS_FOR_THE_TEAM.test(prompt);
}
