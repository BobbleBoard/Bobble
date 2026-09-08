/**
 * Tools a run may not call, whatever it thinks.
 *
 * ## Why this is not "just don't advertise it"
 *
 * An unadvertised tool is still reachable: `use` dispatches by name, the bash
 * CLI dispatches by command, and a capability the model activates mid-turn pulls
 * a whole group in. Every one of those paths goes through `tool_call`, so that
 * is where a refusal has to live — anywhere earlier is a suggestion.
 *
 * ## What it is for
 *
 * An UNATTENDED run — a scheduled brief at 07:30 with nobody watching — must not
 * be able to send anything outward. Reading the user's mail to summarise it is
 * the feature; sending a message on their behalf while they are asleep is not,
 * and no prompt wording is a guarantee against it.
 *
 * Set `PI_DESKTOP_FORBID_TOOLS` to a comma-separated list. The app sets it for
 * scheduled runs; nothing else in the product does.
 */

export const FORBID_TOOLS_ENV = 'PI_DESKTOP_FORBID_TOOLS';

/** Parse the env list. Empty, absent or whitespace-only means "nothing forbidden". */
export function forbiddenTools(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env[FORBID_TOOLS_ENV];
  if (raw === undefined || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
  );
}

/**
 * The refusal a blocked call gets back.
 *
 * Says what it cannot do AND what it can, because a model told only "no" will
 * try the same thing another way — which is how a refusal becomes a loop. The
 * one that matters here is "read and draft, do not send", so the message points
 * at the useful half rather than just closing the door.
 */
export function forbiddenReason(toolName: string): string {
  if (toolName === 'messages_send') {
    return 'Sending messages is off for an unattended run. Write the draft into your answer instead — the user will send it themselves.';
  }
  /*
   * A "no" with no "instead" is how a refusal becomes a loop — this module's own
   * opening argument, and MEASURED against it: nineteen `edit` calls in a row,
   * every one answered "edit is not available in this run", the model varying
   * the arguments each time because nothing told it the arguments were not the
   * problem. Say that they are not.
   */
  return (
    `${toolName} is not available in this run, and no arguments will change that. ` +
    'Do not call it again — do the task with the tools and commands you do have, or say ' +
    'plainly what you would need.'
  );
}
