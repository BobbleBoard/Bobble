/**
 * `find /` IS NOT A SEARCH, IT IS A FIVE-MINUTE WALK.
 *
 * SEEN in the canvas assessment: asked where a file was, the model ran
 * `find / -name "*.glb"` in a sandboxed chat and was still walking the disk at
 * 4m59s when the turn's timeout took it. Spotlight answers the same question
 * in milliseconds, and the app already offers it (`spotlight_search`, or
 * `machine search` in CLI mode).
 *
 * Narrow by design, in the spirit of the hang guard: only a `find` ROOTED at
 * the whole disk or at HOME with no depth limit is refused. `find . -name x`,
 * `find src -type f`, `find / -maxdepth 2` all run — they are ordinary work.
 */

/** A `find` (or `fd`) that starts at / or ~ with nothing to stop it. */
export function wouldWalkDisk(command: string): { root: string; pattern: string | null } | null {
  const c = command.trim();
  const m = /(?:^|[\s;&|(])(?:sudo\s+)?(find|fd)\s+(\/|~|\$HOME|\/Users\/[^/\s]+)(?=\s|$)/.exec(c);
  if (m === null) return null;
  if (/-maxdepth\s+\d|--max-depth|-d\s+\d/.test(c)) return null;
  const name = /-i?name\s+(['"]?)([^'"\s]+)\1/.exec(c)?.[2] ?? null;
  return { root: m[2] as string, pattern: name };
}

/** The refusal, naming the search that answers in milliseconds when there is one. */
export function diskWalkRefusal(
  hit: { root: string; pattern: string | null },
  searchCommand: string | null,
): string {
  const what = hit.pattern !== null ? `"${hit.pattern}"` : 'a file';
  const better =
    searchCommand !== null
      ? `To find ${what} anywhere on this Mac, use Spotlight instead — it is indexed and answers at once:\n  ${searchCommand} ${hit.pattern !== null ? `"${hit.pattern.replace(/\*/g, '')}"` : '<name>'}`
      : `Search from where the file is likely to be (the project, ~/Documents, ~/Downloads), or add -maxdepth 3.`;
  return `Not run: \`find ${hit.root}\` walks the whole disk — hundreds of thousands of files, minutes of I/O, and the last one that ran here was still going when the turn timed out. ${better}`;
}
