/*
 * LaTeX's own maths delimiters — `\(…\)` inline, `\[…\]` display — beside
 * remark-math's dollars. Many models write maths no other way (Qwen and
 * DeepSeek especially, for every display equation), and CommonMark reads `\(`
 * as an escaped parenthesis: MEASURED 2026-10-06, `\(x^2\)` rendered as the
 * text "(x^2)" and a display block as "[ … ]" around raw TeX.
 *
 * Two parts, because they are two kinds of thing:
 *   - `\(…\)` and a one-line `\[…\]` are INLINE syntax: a micromark extension
 *     (remarkLatexMath), the layer remark-math itself works at, so code spans,
 *     emphasis and escapes are the parser's business — `\(a*b*c\)` is maths,
 *     not emphasis; `` `\(x\)` `` stays code.
 *   - a `\[` … `\]` across lines is a BLOCK: by the time inline syntax is read,
 *     its lines are already structure (a "  + c" line inside it is a list
 *     item). So those delimiters become remark-math's `$$` fence lines before
 *     parsing (fenceLatexDisplay), and the TeX between is never markdown.
 */

/** micromark's character codes: a character's code point, or below -2 a line ending; `null` ends the input. */
type Code = number | null;
type State = (code: Code) => State | undefined;
interface Effects {
  enter(type: string): unknown;
  exit(type: string): unknown;
  consume(code: Code): undefined;
  attempt(construct: Construct, ok: State, nok: State): State;
}
interface Construct {
  name: string;
  partial?: boolean;
  tokenize(effects: Effects, ok: State, nok: State): State;
}

const BACKSLASH = 92;
/** `(` closes with `)`, `[` with `]`. */
const CLOSER = new Map([
  [40, 41],
  [91, 93],
]);
const isLineEnding = (code: Code) => code === null || code < -2;

/**
 * `\(` or `\[`, TeX, then the matching `\)` or `\]` on the same line. Inside,
 * a backslash and the character after it are TeX (`\\`, `\$`, `\frac`); only
 * the matching closer ends it. Empty, or no closer on the line: not maths, and
 * the parser reads the backslash as an escape, as before.
 */
function tokenizeLatexMath(effects: Effects, ok: State, nok: State): State {
  let closer = 0;
  let empty = true;
  const close: Construct = {
    name: 'latexMathClose',
    partial: true,
    tokenize: (fx, yes, no) => (code) => {
      fx.enter('latexMathSequence');
      fx.consume(code);
      return (next) => {
        if (next !== closer) return no(next);
        fx.consume(next);
        fx.exit('latexMathSequence');
        return yes;
      };
    },
  };
  const start: State = (code) => {
    effects.enter('latexMath');
    effects.enter('latexMathSequence');
    effects.consume(code);
    return open;
  };
  const open: State = (code) => {
    const match = code === null ? undefined : CLOSER.get(code);
    if (match === undefined) return nok(code);
    closer = match;
    effects.consume(code);
    effects.exit('latexMathSequence');
    return inside;
  };
  const inside: State = (code) => {
    if (isLineEnding(code)) return nok(code);
    if (code === BACKSLASH) return effects.attempt(close, empty ? nok : done, texEscape)(code);
    effects.enter('latexMathData');
    return data(code);
  };
  const data: State = (code) => {
    if (isLineEnding(code) || code === BACKSLASH) {
      effects.exit('latexMathData');
      return inside(code);
    }
    empty = false;
    effects.consume(code);
    return data;
  };
  const texEscape: State = (code) => {
    effects.enter('latexMathData');
    effects.consume(code);
    empty = false;
    return escaped;
  };
  const escaped: State = (code) => {
    if (isLineEnding(code)) {
      effects.exit('latexMathData');
      return nok(code);
    }
    effects.consume(code);
    return data;
  };
  const done: State = (code) => {
    effects.exit('latexMath');
    return ok(code);
  };
  return start;
}

const LATEX_MATH: Construct = { name: 'latexMath', tokenize: tokenizeLatexMath };

/** The slice of mdast-util-from-markdown's compile context the handlers use. */
interface CompileContext {
  enter(node: object, token: unknown): unknown;
  exit(token: unknown): unknown;
  buffer(): void;
  resume(): string;
  sliceSerialize(token: unknown): string;
  stack: Array<{ value?: string; data?: { hChildren?: object[] } }>;
  config: {
    enter: { data(this: CompileContext, token: unknown): void };
    exit: { data(this: CompileContext, token: unknown): void };
  };
}

/**
 * The tokens become remark-math's own `inlineMath` node — the shape
 * mdast-util-math gives `$…$` — so rehype-katex renders them like any other.
 * A `\[…\]` carries `math-display`, as remarkDisplayMath gives a lone `$$…$$`.
 */
const LATEX_FROM_MARKDOWN = {
  enter: {
    latexMath(this: CompileContext, token: unknown) {
      const display = this.sliceSerialize(token).startsWith('\\[');
      this.enter(
        {
          type: 'inlineMath',
          value: '',
          data: {
            hName: 'code',
            hProperties: { className: ['language-math', display ? 'math-display' : 'math-inline'] },
            hChildren: [],
          },
        },
        token,
      );
      this.buffer();
    },
  },
  exit: {
    latexMath(this: CompileContext, token: unknown) {
      const value = this.resume();
      const node = this.stack[this.stack.length - 1];
      this.exit(token);
      if (node === undefined) return;
      node.value = value;
      node.data?.hChildren?.push({ type: 'text', value });
    },
    latexMathData(this: CompileContext, token: unknown) {
      this.config.enter.data.call(this, token);
      this.config.exit.data.call(this, token);
    },
  },
};

/** remark plugin: `\(…\)` and one-line `\[…\]` parse as maths (after remark-math). */
export function remarkLatexMath(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: object[]; fromMarkdownExtensions?: object[] };
  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.micromarkExtensions.push({ text: { [BACKSLASH]: LATEX_MATH } });
  data.fromMarkdownExtensions.push(LATEX_FROM_MARKDOWN);
}

const CODE_FENCE = /^\s{0,3}(```|~~~)/;
const DOLLAR_OPEN = /^\s{0,3}\$\$[^$]*$/;
const DOLLAR_CLOSE = /^\s{0,3}\$\$+\s*$/;
/** What a container puts before a line's text: indentation, `>` quote markers, one list marker. */
const CONTAINER = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;
const QUOTE_INDENT = /^[ \t]*(?:>[ \t]?)*/;

/** Where `\` + `ch` is on this line, outside code spans, from `from`; or -1. */
function findDelimiter(line: string, ch: string, from = 0): number {
  let i = from;
  while (i < line.length) {
    if (line[i] === '`') {
      let run = 0;
      while (line[i + run] === '`') run += 1;
      const close = line.indexOf('`'.repeat(run), i + run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (line[i] === '\\') {
      if (line[i + 1] === ch) return i;
      i += 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * A `\[` whose `\]` is on a later line becomes a `$$` fence line, and so does
 * its `\]` — in place, under the same `>` or list indentation, so a display
 * inside a quote or a list item stays there. Text before the `\[` stays a
 * paragraph (a fence may interrupt one); text after the `\]` starts the next,
 * except a lone full stop or comma, which LaTeX puts inside the display and so
 * does this. Code fences and `$$` blocks are left alone.
 *
 * `openTail`: the text is still streaming, so a `\[` with no `\]` yet opens
 * its fence now and the equation fills in as it arrives, as a `$$` block does.
 * On a finished reply an unclosed `\[` is left as written.
 */
export function fenceLatexDisplay(text: string, openTail = false): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let codeFence = false;
  let dollarFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!dollarFence && CODE_FENCE.test(line)) {
      codeFence = !codeFence;
      out.push(line);
      continue;
    }
    if (!codeFence && (dollarFence ? DOLLAR_CLOSE : DOLLAR_OPEN).test(line)) {
      dollarFence = !dollarFence;
      out.push(line);
      continue;
    }
    const open = codeFence || dollarFence ? -1 : findDelimiter(line, '[');
    if (open === -1 || findDelimiter(line, ']', open + 2) !== -1) {
      out.push(line);
      continue;
    }
    let close = -1;
    let searched = i + 1;
    for (; searched < lines.length; searched += 1) {
      const next = lines[searched] as string;
      if (CODE_FENCE.test(next)) break;
      if (findDelimiter(next, ']') !== -1) {
        close = searched;
        break;
      }
    }
    const tail = close === -1 && openTail && searched === lines.length;
    if (close === -1 && !tail) {
      out.push(line);
      continue;
    }
    const prefix = CONTAINER.exec(line)?.[0] ?? '';
    const indent = prefix.replace(/[-*+]|\d{1,9}[.)]/, (marker) => ' '.repeat(marker.length));
    const before = line.slice(prefix.length, open).trimEnd();
    const after = line.slice(open + 2).trim();
    if (before === '') out.push(`${prefix}$$`);
    else out.push(`${prefix}${before}`, `${indent}$$`);
    if (after !== '') out.push(`${indent}${after}`);
    if (tail) {
      out.push(...lines.slice(i + 1));
      break;
    }
    out.push(...lines.slice(i + 1, close));
    const last = lines[close] as string;
    const at = findDelimiter(last, ']');
    const quote = QUOTE_INDENT.exec(last)?.[0] ?? '';
    let tex = last.slice(quote.length, at).trimEnd();
    let rest = last.slice(at + 2).trim();
    if (/^[.,;:]$/.test(rest)) {
      tex = `${tex}${rest}`;
      rest = '';
    }
    if (tex !== '') out.push(`${quote}${tex}`);
    out.push(`${quote}$$`);
    if (rest !== '') out.push(`${quote}${rest}`);
    i = close;
  }
  return out.join('\n');
}
