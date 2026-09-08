/**
 * A tool's description, cut to the one line the command list can afford.
 *
 * the user's spec for CLI mode: "the names and a quick description of what it is is
 * there for each tool, with a tidbit at the end that says --help should be used
 * to get started with any." That is what a schema gives a model, and the mode
 * is supposed to lose nothing — a group summary alone told a model that `mac`
 * existed but not that `mac launch` did, which is how one asked to open an app
 * spent four runs never finding the command for opening apps.
 *
 * The first sentence and no more: the rest of a description is arguments and
 * caveats, and `--help` is where those belong.
 */

/** Abbreviations whose full stop is not the end of anything. */
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|Dr|Mr|Ms)\./g;

/** A private stand-in for the stop inside an abbreviation, restored after. */
const HELD = '';

export const SHORT_DESCRIPTION_MAX = 96;

export function shortDescription(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  if (text === '') return 'no description';
  /*
   * A full stop is not always the end of a sentence. Splitting naively turned
   * `mac key`'s "Press a key combo, e.g. cmd+s" into "Press a key combo, e.g."
   * — a line that stops exactly where it starts being useful. Break only on a
   * stop followed by a capital, and never inside an abbreviation or a decimal.
   */
  const held = text.replace(ABBREVIATIONS, (m) => m.replace('.', HELD));
  const cut = held.search(/\.\s+(?=[A-Z(])/);
  const first = (cut === -1 ? held : held.slice(0, cut + 1)).split(HELD).join('.');
  return first.length <= SHORT_DESCRIPTION_MAX
    ? first
    : `${first.slice(0, SHORT_DESCRIPTION_MAX - 1).trimEnd()}…`;
}
