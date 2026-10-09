/**
 * WHAT THE MODEL IS TOLD A PATH IS.
 *
 * The user (2026-09-17), on a reply ending "The file is located at
 * /Users/user/Bobble/show-me-how-svg-is-generlaly/sample.svg": "it should
 * not say or know that unless it explicitly looks for it via bash, it should
 * only know the relative path from the chat workspace's root by default, eg.
 * it should just know and say this is at 'sample.svg' nothing more."
 *
 * The tools resolve every path against the chat's working folder and hand pi
 * an absolute one, so pi's own success lines — "Successfully wrote N bytes to
 * <abs>" — and this harness's replies ("Drew …: <abs>", "Made …: <abs>",
 * "Presented <abs>") were the leak: the model read the absolute path back and
 * repeated it to the person. So every path a tool REPORTS goes through here:
 * inside the working folder it is said relative to it (`sample.svg`,
 * `assets/logo.svg`); a file the person named somewhere else (their Desktop)
 * keeps its full path, because "sample.svg" would then be a lie. A shell
 * command that prints `pwd` is the model looking for itself, and is not
 * touched.
 *
 * The app reads the same result text to key its tabs and cards, and resolves
 * a relative path against the working folder it is told by the harness — the
 * two sides agree because both start from the same root.
 */
import path from 'node:path';

/** The path as the model should hear it: workspace-relative when inside the root. */
export function pathForModel(abs: string, root: string | null | undefined): string {
  if (root === null || root === undefined || root === '') return abs;
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel;
}

/**
 * Rewrite the absolute `abs` wherever it appears in a reply's text, as the
 * model should hear it. Only the exact path (a whole token, not a prefix of a
 * longer one), so a file's own contents are never rewritten by accident.
 */
export function sayPath(text: string, abs: string, root: string | null | undefined): string {
  const said = pathForModel(abs, root);
  if (said === abs) return text;
  const escaped = abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Not a prefix of a longer path (`a.ts.bak`, `a.ts/x`, `a.ts-old`); a full
  // stop that ends the sentence is fine.
  return text.replace(new RegExp(`${escaped}(?![\\w/-]|\\.\\w)`, 'g'), said);
}
