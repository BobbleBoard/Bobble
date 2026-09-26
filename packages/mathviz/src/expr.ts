/**
 * EXPRESSIONS A SMALL MODEL WRITES, EVALUATED SAFELY.
 *
 * A plot's curves arrive as text — "sin(x) + sin(3x)/3", "4/pi * sum(k, 1, n,
 * sin((2k-1)x)/(2k-1))" — and are parsed here into a closure, never handed to
 * `eval`. What is accepted is what people and 4B models actually type:
 * implicit multiplication ("2x", "3pi", "(x+1)(x-1)", "2sin(x)"), `^` for
 * powers, light LaTeX ("\sin", "\pi", "\frac{a}{b}", "\cdot", braces), and a
 * series as `sum(k, from, to, term)` — the partial sums a slider walks through.
 * A mistake is reported with where it is and what names exist, so the model's
 * next call can fix it.
 */

export type Scope = Readonly<Record<string, number>>;
export type Compiled = (scope: Scope) => number;

export class ExprError extends Error {}

const FUNCTIONS: Readonly<Record<string, (...a: number[]) => number>> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sign: Math.sign,
  sgn: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => ((a % b) + b) % b,
  sec: (a) => 1 / Math.cos(a),
  csc: (a) => 1 / Math.sin(a),
  cot: (a) => 1 / Math.tan(a),
};

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

/** Series and products bind their own variable; at most this many terms. */
const MAX_TERMS = 2000;

/** LaTeX a model reaches for, as the plain form this parser reads. */
/** Greek as a model types it straight into an expression: ωt is ω times t. */
const GREEK: Readonly<Record<string, string>> = {
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  ε: 'epsilon',
  θ: 'theta',
  ϑ: 'theta',
  λ: 'lambda',
  μ: 'mu',
  ν: 'nu',
  ρ: 'rho',
  σ: 'sigma',
  τ: 'tau',
  φ: 'phi',
  ϕ: 'phi',
  ω: 'omega',
  Δ: 'Delta',
  Ω: 'Omega',
  Φ: 'Phi',
  Θ: 'Theta',
};

export function fromLatex(src: string): string {
  let s = src
    .replace(/[αβγδεθϑλμνρστφϕωΔΩΦΘ]/g, (g) => ` ${GREEK[g] ?? g} `)
    .replace(/\\left|\\right/g, '')
    .replace(/\\cdot|\\times/g, '*');
  // \frac{a}{b} → ((a)/(b)), innermost first.
  for (let guard = 0; guard < 20 && /\\frac\s*\{/.test(s); guard += 1) {
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
  }
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
  s = s.replace(/\\([a-zA-Z]+)/g, '$1');
  return s.replace(/\{/g, '(').replace(/\}/g, ')');
}

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'op'; v: string; at: number; implicit?: true };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i += 1;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i));
      if (m === null)
        throw new ExprError(`a number is malformed at ${i + 1}: "${src.slice(i, i + 6)}"`);
      out.push({ t: 'num', v: Number(m[0]), at: i });
      i += m[0].length;
    } else if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: 'id', v: m[0], at: i });
      i += m[0].length;
    } else if (src.startsWith('**', i)) {
      out.push({ t: 'op', v: '^', at: i });
      i += 2;
    } else if (/[-+*/^(),]/.test(c)) {
      out.push({ t: 'op', v: c, at: i });
      i += 1;
    } else if (/^(?:<=|>=|==|!=)/.test(src.slice(i, i + 2))) {
      out.push({ t: 'op', v: src.slice(i, i + 2), at: i });
      i += 2;
    } else if (c === '<' || c === '>') {
      out.push({ t: 'op', v: c, at: i });
      i += 1;
    } else if (c === '·' || c === '×') {
      out.push({ t: 'op', v: '*', at: i });
      i += 1;
    } else if (c === 'π') {
      out.push({ t: 'id', v: 'pi', at: i });
      i += 1;
    } else if (c === '−') {
      out.push({ t: 'op', v: '-', at: i });
      i += 1;
    } else {
      throw new ExprError(`"${c}" at ${i + 1} is not part of an expression`);
    }
  }
  return out;
}

/**
 * An identifier that is really several: "pix" → pi·x, "sinx" → sin(x) is NOT
 * guessed, but a run of known single-letter variables and constants is split
 * ("kx" when k and x are both names in scope is k·x).
 */
function splitIdentifier(id: string, names: ReadonlySet<string>): string[] | null {
  if (names.has(id) || id in CONSTANTS || id in FUNCTIONS) return null;
  const parts: string[] = [];
  let rest = id;
  while (rest !== '') {
    const hit = ['tau', 'pi', ...[...names].sort((a, b) => b.length - a.length)].find((n) =>
      rest.startsWith(n),
    );
    if (hit === undefined) return null;
    parts.push(hit);
    rest = rest.slice(hit.length);
  }
  return parts.length > 1 ? parts : null;
}

/** The parsed expression. Built once; evaluated in Node, or written out as page script. */
export type Node =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'var'; readonly n: string }
  | {
      readonly k: 'bin';
      readonly op: '+' | '-' | '*' | '/' | '^';
      readonly a: Node;
      readonly b: Node;
    }
  | { readonly k: 'neg'; readonly a: Node }
  | { readonly k: 'call'; readonly f: string; readonly args: readonly Node[] }
  | { readonly k: 'cmp'; readonly op: string; readonly a: Node; readonly b: Node }
  | { readonly k: 'if'; readonly c: Node; readonly a: Node; readonly b: Node }
  | {
      readonly k: 'series';
      readonly kind: 'sum' | 'prod';
      readonly v: string;
      readonly from: Node;
      readonly to: Node;
      readonly term: Node;
    };

/** Parse `src` into a tree over the variables in `names`. */
export function parse(src: string, names: readonly string[]): Node {
  const known = new Set(names);
  const raw = tokenize(fromLatex(src));
  // Split glued names ("kx", "2pix") before implicit multiplication is inserted.
  const toks: Tok[] = [];
  for (const tk of raw) {
    const parts = tk.t === 'id' ? splitIdentifier(tk.v, known) : null;
    if (parts === null) toks.push(tk);
    else for (const p of parts) toks.push({ t: 'id', v: p, at: tk.at });
  }
  // Implicit multiplication: "2x", "2(x)", ")(", ")x", "x(" when x is not a function.
  const callable = (v: string): boolean =>
    v in FUNCTIONS || v === 'sum' || v === 'prod' || v === 'if';
  const withMul: Tok[] = [];
  for (const tk of toks) {
    const prev = withMul[withMul.length - 1];
    const prevEnds =
      prev !== undefined &&
      (prev.t === 'num' || (prev.t === 'id' && !callable(prev.v)) || prev.v === ')');
    const startsValue = tk.t === 'num' || tk.t === 'id' || tk.v === '(';
    if (prevEnds && startsValue) withMul.push({ t: 'op', v: '*', at: tk.at, implicit: true });
    withMul.push(tk);
  }
  let pos = 0;
  const peek = (): Tok | undefined => withMul[pos];
  const take = (v?: string): Tok => {
    const tk = withMul[pos];
    if (tk === undefined)
      throw new ExprError(`the expression ends early${v ? ` — expected "${v}"` : ''}`);
    if (v !== undefined && tk.v !== v) {
      throw new ExprError(`expected "${v}" at ${tk.at + 1}, found "${String(tk.v)}"`);
    }
    pos += 1;
    return tk;
  };
  const bound = new Set<string>();

  const primary = (): Node => {
    const tk = take();
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') {
      const inner = comparison();
      take(')');
      return inner;
    }
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      const inner = power();
      return tk.v === '-' ? { k: 'neg', a: inner } : inner;
    }
    if (tk.t === 'id') {
      const name = tk.v;
      if (name === 'sum' || name === 'prod') return series(name);
      if (name === 'if') {
        take('(');
        const c = comparison();
        take(',');
        const a = comparison();
        take(',');
        const b = comparison();
        take(')');
        return { k: 'if', c, a, b };
      }
      if (name in FUNCTIONS) {
        // "sin x" / "sin 2x": a function without parentheses takes the product
        // written side by side after it — up to the next function, so
        // "sin x cos x" is sin(x)·cos(x).
        if (peek()?.v !== '(') {
          let arg = power();
          for (;;) {
            const star = peek();
            const next = withMul[pos + 1];
            if (star?.t !== 'op' || star.implicit !== true) break;
            if (next?.t === 'id' && callable(next.v)) break;
            take();
            arg = { k: 'bin', op: '*', a: arg, b: power() };
          }
          return { k: 'call', f: name, args: [arg] };
        }
        take('(');
        const args: Node[] = [];
        if (peek()?.v !== ')') {
          args.push(comparison());
          while (peek()?.v === ',') {
            take(',');
            args.push(comparison());
          }
        }
        take(')');
        return { k: 'call', f: name, args };
      }
      if (name in CONSTANTS && !known.has(name) && !bound.has(name)) {
        return { k: 'num', v: CONSTANTS[name] as number };
      }
      if (known.has(name) || bound.has(name)) return { k: 'var', n: name };
      const all = [...known, ...Object.keys(CONSTANTS)].join(', ');
      throw new ExprError(`"${name}" at ${tk.at + 1} is not a variable here (these are: ${all})`);
    }
    throw new ExprError(`"${String(tk.v)}" at ${tk.at + 1} cannot start a value`);
  };

  const series = (kind: 'sum' | 'prod'): Node => {
    take('(');
    const v = take();
    if (v.t !== 'id')
      throw new ExprError(`${kind}( needs its counter first, like ${kind}(k, 1, n, …)`);
    take(',');
    const from = comparison();
    take(',');
    const to = comparison();
    take(',');
    bound.add(v.v);
    const term = comparison();
    bound.delete(v.v);
    take(')');
    return { k: 'series', kind, v: v.v, from, to, term };
  };

  const power = (): Node => {
    const base = primary();
    if (peek()?.v === '^') {
      take('^');
      return { k: 'bin', op: '^', a: base, b: unary() }; // right-associative
    }
    return base;
  };
  const unary = (): Node => {
    const tk = peek();
    if (tk?.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      take();
      const inner = unary();
      return tk.v === '-' ? { k: 'neg', a: inner } : inner;
    }
    return power();
  };
  const term = (): Node => {
    let left = unary();
    while (peek()?.v === '*' || peek()?.v === '/') {
      const op = take().v as '*' | '/';
      left = { k: 'bin', op, a: left, b: unary() };
    }
    return left;
  };
  const additive = (): Node => {
    let left = term();
    while (peek()?.v === '+' || peek()?.v === '-') {
      const op = take().v as '+' | '-';
      left = { k: 'bin', op, a: left, b: term() };
    }
    return left;
  };
  const CMP = ['<', '>', '<=', '>=', '==', '!='];
  const comparison = (): Node => {
    const left = additive();
    const op = peek()?.v;
    if (typeof op === 'string' && CMP.includes(op)) {
      take();
      return { k: 'cmp', op, a: left, b: additive() };
    }
    return left;
  };

  if (withMul.length === 0) throw new ExprError('the expression is empty');
  const root = comparison();
  if (pos < withMul.length) {
    const tk = withMul[pos] as Tok;
    throw new ExprError(`unexpected "${String(tk.v)}" at ${tk.at + 1}`);
  }
  return root;
}

/** Evaluate a tree in a scope. */
export function evaluate(node: Node, scope: Scope): number {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'var': {
      const v = scope[node.n];
      if (v === undefined) throw new ExprError(`"${node.n}" has no value`);
      return v;
    }
    case 'neg':
      return -evaluate(node.a, scope);
    case 'bin': {
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      return node.op === '+'
        ? a + b
        : node.op === '-'
          ? a - b
          : node.op === '*'
            ? a * b
            : node.op === '/'
              ? a / b
              : a ** b;
    }
    case 'call':
      return (FUNCTIONS[node.f] as (...a: number[]) => number)(
        ...node.args.map((a) => evaluate(a, scope)),
      );
    case 'cmp': {
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      const r =
        node.op === '<'
          ? a < b
          : node.op === '>'
            ? a > b
            : node.op === '<='
              ? a <= b
              : node.op === '>='
                ? a >= b
                : node.op === '=='
                  ? a === b
                  : a !== b;
      return r ? 1 : 0;
    }
    case 'if':
      return evaluate(node.c, scope) !== 0 ? evaluate(node.a, scope) : evaluate(node.b, scope);
    case 'series': {
      const a = Math.round(evaluate(node.from, scope));
      const b = Math.round(evaluate(node.to, scope));
      if (b - a > MAX_TERMS)
        throw new ExprError(`${node.kind} runs ${b - a + 1} terms — at most ${MAX_TERMS}`);
      let acc = node.kind === 'sum' ? 0 : 1;
      const inner: Record<string, number> = { ...scope };
      for (let k = a; k <= b; k += 1) {
        inner[node.v] = k;
        acc =
          node.kind === 'sum' ? acc + evaluate(node.term, inner) : acc * evaluate(node.term, inner);
      }
      return acc;
    }
  }
}

/** Parse `src` into a closure over a scope. `names` are the variables it may use. */
export function compile(src: string, names: readonly string[]): Compiled {
  const tree = parse(src, names);
  return (scope) => evaluate(tree, scope);
}

/** JS for Math's name of a function this parser knows (page script). */
const JS_FN: Readonly<Record<string, string>> = {
  ln: 'Math.log',
  log: 'Math.log',
  sgn: 'Math.sign',
  mod: '((a,b)=>((a%b)+b)%b)',
  sec: '((a)=>1/Math.cos(a))',
  csc: '((a)=>1/Math.sin(a))',
  cot: '((a)=>1/Math.tan(a))',
};

/**
 * The tree as a JavaScript expression over `s` (the scope object), for the
 * page's live sliders. Safe by construction: it is written from the parsed
 * tree — numbers, known names and Math's functions — never from the text.
 */
export function toJs(node: Node): string {
  switch (node.k) {
    case 'num':
      return Number.isFinite(node.v) ? `(${node.v})` : 'NaN';
    case 'var':
      return `s[${JSON.stringify(node.n)}]`;
    case 'neg':
      return `(-${toJs(node.a)})`;
    case 'bin':
      return node.op === '^'
        ? `(${toJs(node.a)}**${toJs(node.b)})`
        : `(${toJs(node.a)}${node.op}${toJs(node.b)})`;
    case 'call':
      return `${JS_FN[node.f] ?? `Math.${node.f}`}(${node.args.map(toJs).join(',')})`;
    case 'cmp':
      return `((${toJs(node.a)}${node.op === '==' ? '===' : node.op === '!=' ? '!==' : node.op}${toJs(node.b)})?1:0)`;
    case 'if':
      return `((${toJs(node.c)})!==0?${toJs(node.a)}:${toJs(node.b)})`;
    case 'series': {
      const init = node.kind === 'sum' ? 0 : 1;
      const op = node.kind === 'sum' ? '+' : '*';
      return `((s)=>{const a=Math.round(${toJs(node.from)}),b=Math.min(Math.round(${toJs(node.to)}),a+${MAX_TERMS});let r=${init};const o=Object.assign({},s);for(let k=a;k<=b;k++){o[${JSON.stringify(node.v)}]=k;r${op}=((s)=>${toJs(node.term)})(o);}return r;})(s)`;
    }
  }
}

/** A number written as an expression ("-pi", "2pi/3", "1e3"), or an error. */
export function numberOf(src: string | number): number {
  if (typeof src === 'number') return src;
  const v = compile(String(src), [])({});
  if (!Number.isFinite(v)) throw new ExprError(`"${src}" is not a finite number`);
  return v;
}
