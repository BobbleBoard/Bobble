/**
 * Model-backed "scary bash" flagger for reviewer permission mode.
 *
 * The regex rules (permissions/rules.ts) are the always-available first line —
 * fast and offline. When a utility model is configured, this flagger layers a
 * small-model judgment on TOP: it only runs for commands the regex did NOT
 * already flag (see registerPermissions in modes.ts), catching destructive /
 * irreversible commands the static rules miss. It fails open (returns null on
 * any error/timeout) so the gate never wedges on a slow or absent model — the
 * regex fallback still stands.
 *
 * ## IT COSTS THE CONVERSATION'S KV CACHE, so it is asked sparingly
 *
 * the user: "sometimes at random, prefill for a short follow-up message takes upward
 * of 80 seconds where it hadn't earlier in the same chat."
 *
 * The utility endpoint IS the conversation's own llama-server (pi-main points it
 * there deliberately), and that server holds ONE slot. A request with a
 * different prefix — and this one's prefix is a security-reviewer system prompt
 * and a shell command, which shares nothing with the chat — evicts the
 * conversation's resident KV. The next message then pays a full cold prefill.
 * This is the same mechanism that got the post-turn reviewer removed.
 *
 * Two things keep it off the hot path: commands that only read, or only write
 * the chat's own folder, are never sent (see {@link needsModelReview}), and
 * every verdict is CACHED by command text — an agent re-runs the same build,
 * the same test, the same grep dozens of times per session.
 *
 * ## A FLAG HAS TO NAME A HARM
 *
 * MEASURED (2026-10-01, the visual-learner student run on Ling 3.0 Tiny — each
 * reply reproduced word for word against the same model, template and flags):
 * the old prompt asked for "a SHORT reason if it is dangerous, or the single
 * word SAFE", and anything that was not SAFE became the reason on a "Run this
 * command?" card. Three cards in one run, none of them a harm:
 *
 *   - "Checks if a specific SVG file exists in a temporary directory." — a
 *     DESCRIPTION, flagged because it was not the word SAFE;
 *   - "lists the contents of a private system path … a restricted directory" —
 *     the probe's HOME under /private/var/folders. The same `ls` of
 *     /Users/user/Bobble/<chat> came back SAFE: the path, not the command;
 *   - "DANGER - writes a large SVG file to a temporary directory with a
 *     suspicious name" — a guess about a file in the chat's own folder.
 *
 * So the model is now asked for SAFE, or DANGEROUS followed by the harm — what
 * would be lost, leaked or changed — and only a reply in that shape counts. A
 * reply that describes the command is not a verdict, and is read like a
 * timeout: the regex rules stand.
 *
 * MEASURED, old prompt → this one, every command put to the model (none of the
 * skips above), same server, template and flags as the app:
 *   Ling 3.0 Tiny   the six measured commands  5 flagged → 2 (the cut-off
 *                   heredoc — which no longer reaches the model at all);
 *                   38 harmless commands that still do reach it  6 → 1;
 *                   42 dangerous ones  42 caught → 41.
 *   Qwen3.5 4B      never made the measured mistakes;  harmless 1 → 1,
 *                   dangerous 32 caught → 34.
 * Asking costs one prefill of ~330 tokens (Ling, cold: 187 ms, was 144 ms)
 * and no re-prefill of the conversation on llama.cpp — the follow-up after a
 * review re-read 21 tokens, as it did without one.
 */

import { homedir } from 'node:os';
import type { CallModel } from '../model-call/call-model.js';
import type { BashFlagger } from './modes.js';
import { shellEffects, writesStayInside } from './shell-effects.js';

const SYSTEM_PROMPT = [
  "You check ONE shell command that a coding agent is about to run on the user's computer, " +
    'and decide whether the user must approve it first.',
  '',
  'It is DANGEROUS only if running it would cause a concrete harm you can name:',
  "- deleting files or folders, or overwriting or moving the user's files outside the working folder;",
  '- erasing or reformatting a disk;',
  '- sending files, keys, passwords or other private data to another computer;',
  '- running a script fetched from the internet, or changing the system: sudo, system ' +
    'settings, startup items, software installed for the whole computer;',
  '- force-pushing, publishing or deploying;',
  '- stopping processes the agent did not start.',
  '',
  'Everything else is SAFE, including:',
  '- listing, reading, searching or printing files, wherever they are;',
  '- creating, writing or editing files in the working folder, whatever they contain;',
  '- a path that only looks unusual (/private/var/folders/…, /tmp/…, a long or odd name);',
  '- a command that is incomplete or malformed — it will just fail.',
  '',
  'Answer with exactly one line, either:',
  'SAFE',
  'or:',
  'DANGEROUS: <the harm in a few words — what would be lost, leaked or changed, and where>',
  'Never describe what the command does.',
].join('\n');

/** How long to wait for the model before failing open to the regex rules. */
const FLAG_TIMEOUT_MS = 4000;

/** The chat's own folder, as the bash tool sees it. */
export interface ChatFolder {
  /** The directory a command starts in — the bash tool's own cwd. */
  readonly cwd: string;
  /** Folders whose files are the chat's: the workspace root and the sandbox. */
  readonly roots: readonly string[];
}

/**
 * Is this command worth a model's opinion (and the conversation's KV cache)?
 *
 * Not when it only reads — the reviewer never gated a read, and the `read`
 * tool still is not — and not when everything it writes lands in the chat's
 * own folder, where `write` and `edit` work without asking either. Everything
 * else goes to the model, and so does anything shell-effects.ts cannot read
 * all the way through.
 *
 * Exported so the cost decision is testable on its own — it is the half of this
 * module that changes how the app FEELS, and it must never quietly widen.
 */
export function needsModelReview(
  command: string,
  folder?: ChatFolder,
  home: string = homedir(),
): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const effects = shellEffects(trimmed, { cwd: folder?.cwd ?? process.cwd(), home });
  if (effects === null) return true;
  if (effects.writes.length === 0) return false;
  if (folder === undefined) return true;
  return !writesStayInside(effects.writes, folder.roots, home);
}

/** How many verdicts to remember. An agent repeats itself; a session does not
 * run thousands of DISTINCT commands. */
const VERDICT_CACHE_MAX = 256;
/** Cap the reason we surface to the user. */
const MAX_REASON_LEN = 140;

/** A reply that is a pass. */
const SAFE_VERDICT = /^[*_`\s]*safe\b/i;
/** A reply that is a flag — the verdict word, then (we hope) the harm. */
const DANGEROUS_VERDICT = /^[*_`\s]*(?:dangerous|danger|unsafe|harmful)\b[*_`]*\s*[:\-–—.]?\s*/i;

/**
 * Interpret the model's reply: a reason string when flagged, else null.
 *
 * Only `DANGEROUS: <harm>` is a flag. A reply that opens any other way — a
 * description of the command, a summary, a question — is not a verdict, and
 * neither is DANGEROUS with nothing after it: a card that cannot say what the
 * harm is cannot help the person decide.
 *
 * A think block is not a verdict either. The request turns thinking off, but an
 * engine that renders the template its own way (oMLX's vision lane, MEASURED
 * 2026-09-13) can still hand the thought back as content — 40 tokens of it,
 * cut mid-sentence. A closed block is dropped for what follows it; an unclosed
 * one carries no verdict at all, which is the same fail-open as a timeout.
 */
export function interpretFlagReply(reply: string): string | null {
  const closed = /<think>[\s\S]*?<\/think>\s*/i.exec(reply);
  let verdict = closed !== null ? reply.slice(closed.index + closed[0].length) : reply;
  if (/<think>/i.test(verdict)) verdict = '';
  const trimmed = verdict.trim();
  if (trimmed.length === 0 || SAFE_VERDICT.test(trimmed)) return null;
  const opened = DANGEROUS_VERDICT.exec(trimmed);
  if (opened === null) return null;
  const harm = (trimmed.slice(opened[0].length).split('\n')[0] ?? '').trim();
  if (harm.length === 0) return null;
  return `flagged by model: ${harm.slice(0, MAX_REASON_LEN)}`;
}

export interface BashFlaggerOptions {
  /**
   * The chat's folder, read per call — it moves when the folder dropdown does.
   * Without one, every write goes to the model.
   */
  readonly folder?: () => ChatFolder | undefined;
  /** HOME, for `~` (defaults to the process's). */
  readonly home?: string;
}

/**
 * Build a {@link BashFlagger} backed by the utility model. Returns a reason
 * string when the model judges the command dangerous, or null when it is safe
 * (or on any error/timeout — fail open).
 */
export function createBashFlagger(
  callModel: CallModel,
  options: BashFlaggerOptions = {},
): BashFlagger {
  // Command text → verdict. See the note at the top: every miss costs the
  // conversation a cold prefill, and agents repeat commands constantly.
  const verdicts = new Map<string, string | null>();
  return async (command: string): Promise<string | null> => {
    const trimmed = command.trim();
    if (trimmed.length === 0) return null;
    let folder: ChatFolder | undefined;
    try {
      folder = options.folder?.();
    } catch {
      // No folder means no write is waved through — the safe way to be wrong.
      folder = undefined;
    }
    if (!needsModelReview(trimmed, folder, options.home)) return null;
    // The working folder is part of the question, so it is part of the key.
    const key = `${folder?.cwd ?? ''}\n${trimmed}`;
    const cached = verdicts.get(key);
    if (cached !== undefined) return cached;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLAG_TIMEOUT_MS);
    try {
      const reply = await callModel({
        system: SYSTEM_PROMPT,
        prompt:
          folder !== undefined
            ? `Working folder: ${folder.cwd}\nCommand:\n${trimmed}`
            : `Command:\n${trimmed}`,
        temperature: 0,
        maxTokens: 40,
        // One word, or twelve: a verdict, not a deliberation. With thinking on
        // the 40 tokens were all thought — llama.cpp then answered with an
        // empty content (every command SAFE, the reviewer silently gone) and
        // oMLX with the thought itself (every command flagged, the turn stuck
        // on the permission prompt). MEASURED 2026-09-13.
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
        signal: controller.signal,
      });
      const verdict = interpretFlagReply(reply);
      if (verdicts.size >= VERDICT_CACHE_MAX) {
        // Oldest first — insertion order is Map's iteration order.
        const oldest = verdicts.keys().next();
        if (!oldest.done) verdicts.delete(oldest.value);
      }
      verdicts.set(key, verdict);
      return verdict;
    } catch {
      // Model unreachable / timed out / aborted → fall back to the regex rules.
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
