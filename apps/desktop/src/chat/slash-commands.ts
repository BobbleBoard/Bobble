/**
 * The slash commands this app runs itself.
 *
 * `/help`, `/new` and `/compact` were listed in the composer's `/` menu
 * unconditionally — so the menu always had something to show — and picking one
 * sent the literal text to the model, which answered as if asked ABOUT
 * compaction. `/compact` is the one that matters on a 32k window.
 *
 * Handled in the app rather than passed to pi: pi's own slash handling would
 * bypass the session bookkeeping (the sidebar, the per-chat snapshots), and
 * `newSession()` already owns the streaming-safe path.
 *
 * Pure and DOM-free, so the parsing — which decides whether a line is a command
 * or a message — is testable without mounting the composer.
 */

/** The built-ins this app runs itself, rather than passing to pi. */
const APP_COMMANDS = new Set(['help', 'new', 'compact']);

/**
 * A bare `/command` line, or null.
 *
 * Only a line that is JUST the command — `/compact do it briefly` is a message
 * about compaction, and treating it as an instruction would be a guess. The
 * one exception is `/compact <instructions>`, which pi's own RPC takes, so it
 * is the one that carries a tail.
 */
export function parseSlashCommand(raw: string): { name: string; rest: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)\s*([\s\S]*)$/i.exec(raw.trim());
  if (m === null) return null;
  const name = (m[1] ?? '').toLowerCase();
  const rest = (m[2] ?? '').trim();
  if (!APP_COMMANDS.has(name)) return null;
  if (rest !== '' && name !== 'compact') return null;
  return { name, rest };
}

/** What `/help` says. Short on purpose — a wall of text is not help. */
export const HELP_TEXT = [
  '**Getting things done**',
  '',
  '- Just describe what you want. The assistant reads and writes files, runs',
  '  commands, browses, and can drive your Mac.',
  '- `!` at the start of a line runs a shell command directly: `!ls -la`',
  '- `@` mentions a file in this folder; `/` lists commands.',
  '',
  '**Commands**',
  '',
  '- `/new` — start a new chat',
  '- `/compact` — summarise the history so far to free up context. Add',
  '  instructions after it to steer the summary: `/compact keep the API decisions`',
  '- `/help` — this',
  '',
  '**Keys**',
  '',
  '- `⌘N` new chat · `⌘P` files · `⌘T` browser · `⌘U` attach',
  '- `Esc` stops a reply; `Esc Esc` clears the draft',
  '- `⇧↵` newline, `↵` send',
].join('\n');
