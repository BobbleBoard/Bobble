/**
 * THE TEACH SKILL, ATTACHED WHEN SOMEONE ASKS TO LEARN.
 *
 * the user (2026-09-25): "test some math/physics/chemistry... practice problem
 * requests … having diagrams/visuals and animating them cleanly to go along
 * with an explanation when informative, find some teaching guidelines
 * somewhere and add a teach skill.md file that you can figure out how to work
 * in or detect and inject automatically when asked maybe".
 *
 * The skill is an ordinary bundled one (apps/desktop/resources/skills/teach),
 * installable from the Skills tab like the rest — and pi lists an installed
 * skill for the model to `read` when a task matches. A small model rarely
 * opens a listed skill on its own, though, so the harness also attaches it:
 * when a message asks to understand something or to work a problem, the
 * skill's text rides beside that message as a hidden note, once per chat. It
 * is not in the system prompt, so a chat that never asks pays nothing and the
 * cached prefix never moves; a chat that does pays for it once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_INSTRUCTIONS_TAG } from './skill-instructions.js';

/** The custom-message type the note travels as (hidden; persisted with the chat). */
export const HARNESS_SKILL_NOTE = 'harness-skill-note';

/*
 * A MESSAGE THAT ASKS TO LEARN — by what it asks for, not by subject. The
 * words people use to ask to be taught, and the shape of a set problem
 * ("calculate …", "Fig. 3.1", "(a) … (b) …"). Not "why", "what" or "how" on
 * their own: those open every kind of question.
 */
const LEARNING_ASK = new RegExp(
  `\\b(?:${[
    // "explain" about an idea or a problem — not "explain what this function does"
    'explain (?:to me )?(?:how|why|the (?:concept|idea|theory|law|principle|rule|difference|meaning)|(?:this|the|that) (?:concept|idea|theorem|law|principle|reaction|equation|formula|proof|problem|question|topic|answer|solution))',
    'teach me',
    'tutor me',
    'walk me through',
    'help me (?:understand|learn|revise|study)',
    'help (?:me )?with (?:this|my|these|the) (?:problem|question|homework|exercise|worksheet)s?',
    'practi[cs]e (?:problem|question|paper|exam)s?',
    'homework',
    'quiz me',
    'test me on',
    'worked (?:example|solution)s?',
    'step[- ]by[- ]step',
    'show (?:me )?(?:the |your )?working',
    'how (?:do|would|can|should) (?:i|you|we) (?:solve|work (?:it |this )?out|derive|prove|approach) (?:this|that|it|the)',
    'derive (?:the|an?|this)',
    'prove that',
    'show that',
  ].join('|')})\\b`,
  'i',
);
const SET_PROBLEM =
  /\b(?:calculate|determine|estimate|deduce)\b[^.?!\n]{0,80}\d|\bfig(?:ure|\.)\s*\d|\(\s*[a-d]\s*\)\s*(?:\(\s*[iv]+\s*\))?\s*[A-Z]/i;

/** Does this message ask to be taught, or set a problem to be worked? */
export function wantsTeaching(prompt: string): boolean {
  return LEARNING_ASK.test(prompt) || SET_PROBLEM.test(prompt);
}

/** A SKILL.md without its frontmatter. */
export function skillBody(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/** The teach skill's text from the app's bundled skills, or null when there is none. */
export function loadTeachSkill(env: Record<string, string | undefined>): string | null {
  const dir = env.PI_DESKTOP_SKILLS_DIR;
  if (dir === undefined || dir === '') return null;
  try {
    return skillBody(readFileSync(join(dir, 'teach', 'SKILL.md'), 'utf8'));
  } catch {
    return null;
  }
}

/** The note as the model reads it: marked as a skill's instructions, not the person's words. */
export function teachNote(body: string): string {
  return (
    'This message asks to learn or to work a problem — follow the teach skill for your answer.\n' +
    `<${SKILL_INSTRUCTIONS_TAG} name="teach">\n${body}\n</${SKILL_INSTRUCTIONS_TAG}>`
  );
}

/** Entries the note is looked for in. */
interface EntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly details?: unknown;
}

/** Has this branch already been given the skill? (Alone, or riding with the folder note.) */
export function teachGiven(entries: readonly EntryLike[]): boolean {
  return entries.some((e) => (e.details as { skill?: unknown } | undefined)?.skill === 'teach');
}
