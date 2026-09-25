/**
 * A BOBBLE COMMAND, SAID AS WHAT IT DID.
 *
 * the user: "cli tools showing directly to the user as terminal tools even when
 * they're very parsable and should have special display/handling for visuals
 * eg. 'snapshotted <app icon inline><app>' 'scrolled'."
 *
 * In CLI mode every tool call arrives as a `bash` step whose argument is a line
 * like `mac snapshot "Google Chrome"`. That is the right thing to SEND a model
 * and the wrong thing to show a person: the row says "Ran a command" and the
 * detail is a shell string, so looking at a run means reading argv.
 *
 * These lines are ours, though — we generate the surface they are typed
 * against — so they parse without heuristics. The raw command is never thrown
 * away; it stays as the row's detail for anyone who opens it.
 */

export interface CliCommandLabel {
  /** Present tense, for a row that is still running. */
  readonly running: string;
  /** Past tense, for a row that is done. */
  readonly done: string;
  /** The app this acted on, when there is one — the row shows its real icon. */
  readonly app?: string;
  /**
   * The row is a CHART, not a command: `chart bar "Units" …` is the chart tool
   * in its CLI clothes, and the row shows the data-visuals mark with the kind
   * of chart named, the same as the native call would.
   */
  readonly chart?: { readonly type: string; readonly title?: string };
  /**
   * The ACTION alone, with the app's name taken out of it.
   *
   * the user wants the row read as "<connectors icon> Used <app icon> <app name>
   * <action eg. read page or listed tabs>", which means the app is a NAMED
   * PART of the row rather than a word inside a sentence — the sentence has to
   * come apart for that. `running`/`done` stay whole for the rows that have no
   * app to name.
   */
  readonly action?: { readonly running: string; readonly done: string };
  /**
   * THE ROW IS ONE OF THE APP'S OWN KINDS, not a command. the user (2026-09-21),
   * watching `svg --prompt="a smiley fac…"` and `browser click` render as
   * terminal rows: "ensure all things have custom 'Clicking with browser'
   * 'Drawing SVG' rather than 'svg --prompt a smiley fac...'". So a line that
   * is a browser action, a drawing, a generation or a document carries the
   * kind its native tool call would have, and the row draws the same mark.
   */
  readonly kind?:
    | 'search'
    | 'page'
    | 'browser-navigate'
    | 'browser-click'
    | 'browser-type'
    | 'browser-read'
    | 'image'
    | 'svg'
    | 'video'
    | 'speech'
    | 'music'
    | 'sfx'
    | 'file';
  /** A file name the row's mark should carry (`smiley.svg`, `probe.docx`). */
  readonly filename?: string;
  /** The URL a browser row visited or acted on. */
  readonly url?: string;
  /** What a browser click/type acted on (an index, a selector, a point). */
  readonly target?: string;
  /** What a browser type put into the page. */
  readonly typed?: string;
  /** The one-line thing behind the row (a prompt, a brief, a query). */
  readonly detail?: string;
}

/**
 * `--key=value`, `--key "value"` and `--key value` flags of a command line,
 * with the bare words that are left. Quotes may wrap the value either way.
 */
export function cliFlags(command: string): {
  readonly flags: Readonly<Record<string, string>>;
  readonly bare: readonly string[];
} {
  const flags: Record<string, string> = {};
  const bare: string[] = [];
  const re = /--([\w][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?|"([^"]*)"|'([^']*)'|(\S+)/g;
  let pendingKey: string | null = null;
  let m: RegExpExecArray | null = re.exec(command);
  while (m !== null) {
    if (m[1] !== undefined) {
      const value = m[2] ?? m[3] ?? m[4];
      if (value !== undefined && value !== '') {
        flags[m[1]] = value;
        pendingKey = null;
      } else {
        flags[m[1]] = 'true';
        pendingKey = m[1];
      }
    } else {
      const word = m[5] ?? m[6] ?? m[7] ?? '';
      // A flag the model wrapped whole in quotes — `"--prompt=a smiley face"`
      // (seen in a real run) — is still a flag.
      const quotedFlag = /^--([\w][\w-]*)=(.*)$/s.exec(word);
      if (quotedFlag !== null && (m[5] !== undefined || m[6] !== undefined)) {
        flags[quotedFlag[1] as string] = quotedFlag[2] as string;
        pendingKey = null;
      } else if (pendingKey !== null && !word.startsWith('-')) {
        flags[pendingKey] = word;
        pendingKey = null;
      } else {
        bare.push(word);
      }
    }
    m = re.exec(command);
  }
  return { flags, bare };
}

/** The line after its first word — the arguments, quoting intact. */
function argsOf(line: string): string {
  return line.replace(/^\S+\s*/, '');
}

/** A long argument, shortened for a row: one line, ~72 characters. */
function brief(text: string | undefined, max = 72): string | undefined {
  if (text === undefined) return undefined;
  const one = text.replace(/\s+/g, ' ').trim();
  if (one === '') return undefined;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Split a command line into words, respecting simple quoting. */
function words(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(command);
  while (m !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
    m = re.exec(command);
  }
  return out;
}

/** The first bare word after the verbs — the thing being acted on. */
function firstArg(rest: string[]): string | undefined {
  for (const w of rest) {
    if (w.startsWith('-')) continue;
    return w;
  }
  return undefined;
}

const MAC_VERBS: Record<string, [string, string]> = {
  snapshot: ['Looking at', 'Snapshotted'],
  screenshot: ['Looking at', 'Snapshotted'],
  click: ['Clicking', 'Clicked'],
  type: ['Typing', 'Typed'],
  key: ['Pressing a key', 'Pressed a key'],
  scroll: ['Scrolling', 'Scrolled'],
  launch: ['Opening', 'Opened'],
  drag: ['Dragging', 'Dragged'],
};

const BROWSER_VERBS: Record<string, [string, string]> = {
  navigate: ['Visiting', 'Visited'],
  click: ['Clicking', 'Clicked'],
  type: ['Typing', 'Typed'],
  snapshot: ['Reading the page', 'Read the page'],
  read: ['Reading the page', 'Read the page'],
  scroll: ['Scrolling', 'Scrolled'],
  wait: ['Waiting for the page', 'Waited for the page'],
  back: ['Going back', 'Went back'],
  forward: ['Going forward', 'Went forward'],
  key: ['Pressing a key', 'Pressed a key'],
};

/** Which of the app's kinds a browser verb is — the mark its native call draws. */
const BROWSER_KIND: Record<string, CliCommandLabel['kind']> = {
  navigate: 'browser-navigate',
  back: 'browser-navigate',
  forward: 'browser-navigate',
  click: 'browser-click',
  scroll: 'browser-click',
  type: 'browser-type',
  key: 'browser-type',
  snapshot: 'browser-read',
  read: 'browser-read',
  wait: 'browser-read',
};

/**
 * A browser row from its verb and the line. The CLI takes its arguments BOTH
 * ways — `browser click 4` and `browser click --index=4`, `browser navigate
 * <url>` and `--url=<url>`, `browser type 14 --text "…"` and `--index=14 "…"`
 * (all four seen in one real run) — so the positional words fill whichever flag
 * is missing.
 */
function browserLabel(verb: string, pair: [string, string], line: string): CliCommandLabel {
  const { flags, bare } = cliFlags(argsOf(line));
  // The words after the verb: `browser type 14 "hello"` → ['14', 'hello'].
  const after = bare.slice(bare.indexOf(verb) + 1);
  /*
   * A LEADING NUMBER IS AN INDEX ONLY FOR THE VERBS THAT TAKE ONE. the user
   * (2026-09-23): "what's all this about 'scrolled element 5000' or 10000 …
   * there's certainly not 10 thousand elements on page." `browser scroll 5000`
   * is a DISTANCE, and this read it as element 5000.
   */
  const takesIndex = verb === 'click' || verb === 'type';
  const leadIndex =
    takesIndex && after[0] !== undefined && /^\d+$/.test(after[0]) ? after[0] : undefined;
  const rest = leadIndex === undefined ? after : after.slice(1);
  const url = flags.url ?? (verb === 'navigate' ? after[0] : undefined);
  const index = flags.index ?? leadIndex;
  const key = flags.key ?? (verb === 'key' ? after[0] : undefined);
  const scrollWords = new Set(['up', 'down', 'left', 'right', 'top', 'bottom']);
  const direction =
    flags.direction ?? (verb === 'scroll' ? after.find((w) => scrollWords.has(w)) : undefined);
  const amount =
    verb === 'scroll' ? (flags.amount ?? after.find((w) => /^\d+$/.test(w))) : undefined;
  const distance =
    amount === undefined ? undefined : `${Number(amount).toLocaleString('en-US')} px`;
  const target =
    index !== undefined
      ? `element ${index}`
      : flags.x !== undefined && flags.y !== undefined
        ? `(${flags.x}, ${flags.y})`
        : verb === 'scroll'
          ? [direction, distance].filter((w) => w !== undefined).join(' ') || undefined
          : (flags.selector ?? direction ?? key);
  const typed = verb === 'type' ? (flags.text ?? rest[0]) : verb === 'key' ? key : undefined;
  const detail = url ?? (verb === 'type' ? brief(typed) : target);
  return {
    // "Clicking with the browser" — the row names the surface, since a
    // browser click and a Mac click are different hands.
    running: `${pair[0]} in the browser`,
    done: `${pair[1]} in the browser`,
    kind: BROWSER_KIND[verb],
    ...(url === undefined ? {} : { url }),
    ...(target === undefined ? {} : { target }),
    ...(typed === undefined ? {} : { typed }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** `media generate <what>` / `media edit <what>`: the generate family's kinds. */
const MEDIA_KINDS: Record<string, { kind: CliCommandLabel['kind']; verbs: [string, string] }> = {
  image: { kind: 'image', verbs: ['Generating an image', 'Generated an image'] },
  video: { kind: 'video', verbs: ['Generating a video', 'Generated a video'] },
  speech: { kind: 'speech', verbs: ['Reading it aloud', 'Read it aloud'] },
  music: { kind: 'music', verbs: ['Composing music', 'Composed music'] },
  sfx: { kind: 'sfx', verbs: ['Making a sound effect', 'Made a sound effect'] },
  '3d': { kind: 'file', verbs: ['Building a 3D model', 'Built a 3D model'] },
};

const CHROME_VERBS: Record<string, [string, string]> = {
  tabs: ['Listing tabs', 'Listed tabs'],
  tab: ['Switching tab', 'Switched tab'],
  snapshot: ['Reading the page', 'Read the page'],
  click: ['Clicking', 'Clicked'],
  type: ['Typing', 'Typed'],
  go: ['Opening a page', 'Opened a page'],
};

/**
 * Read one command line, or null when it is not one of ours — an ordinary
 * shell command keeps the ordinary "Ran a command" row, which is honest about
 * what it is.
 */
export function cliCommandLabel(command: string | undefined): CliCommandLabel | null {
  const line = (command ?? '').trim();
  if (line === '') return null;
  const [group, ...rest] = words(line);
  if (group === undefined) return null;

  /* `--help` is its own thing whatever it is asked of: the model is reading the
     guide for a command, and that is worth saying plainly — it is also where a
     surprising amount of a run's time goes. */
  if (rest.includes('--help') || rest.includes('-h')) {
    const sub = rest.filter((w) => !w.startsWith('-')).join(' ');
    const what = sub === '' ? group : `${group} ${sub}`;
    return { running: `Reading the guide for ${what}`, done: `Read the guide for ${what}` };
  }

  if (group === 'mac') {
    const verb = rest.find((w) => !w.startsWith('-'));
    if (verb === undefined) return null;
    // `mac chrome go …` — the Chrome sub-group.
    if (verb === 'chrome') {
      const sub = rest.slice(rest.indexOf('chrome') + 1).find((w) => !w.startsWith('-'));
      const pair = sub === undefined ? undefined : BROWSER_VERBS[sub];
      if (pair === undefined) return { running: 'Driving Chrome', done: 'Drove Chrome' };
      return {
        running: `${pair[0]} in Chrome`,
        done: `${pair[1]} in Chrome`,
        app: 'Google Chrome',
        action: { running: pair[0], done: pair[1] },
      };
    }
    const pair = MAC_VERBS[verb];
    if (pair === undefined) return null;
    const target = firstArg(rest.slice(rest.indexOf(verb) + 1));
    /* An app name only counts for the verbs that TAKE one; `mac click 28`'s
       first argument is an index, not an application. */
    const named = verb === 'snapshot' || verb === 'screenshot' || verb === 'launch';
    const app = named && target !== undefined && !/^\d+$/.test(target) ? target : undefined;
    return {
      running: app === undefined ? pair[0] : `${pair[0]} ${app}`,
      done: app === undefined ? pair[1] : `${pair[1]} ${app}`,
      ...(app === undefined ? {} : { app, action: { running: pair[0], done: pair[1] } }),
    };
  }

  /*
   * `chrome …` — the browser's own set, which is a CONNECTOR rather than an app
   * being clicked at. the user asked for these to read as connector usage, and the
   * verbs are its own: tabs and a tab are things only a browser has.
   */
  if (group === 'chrome') {
    const verb = rest.find((w) => !w.startsWith('-'));
    if (verb === undefined) return null;
    const pair = CHROME_VERBS[verb] ?? BROWSER_VERBS[verb];
    if (pair === undefined) return null;
    return {
      running: `${pair[0]} in Chrome`,
      done: `${pair[1]} in Chrome`,
      app: 'Google Chrome',
      action: { running: pair[0], done: pair[1] },
    };
  }

  if (group === 'browser') {
    const verb = rest.find((w) => !w.startsWith('-'));
    const pair = verb === undefined ? undefined : BROWSER_VERBS[verb];
    if (pair === undefined || verb === undefined) return null;
    return browserLabel(verb, pair, line);
  }

  /*
   * `open <url>` IS a browser visit: the shell wrapper turns it into `browser
   * navigate` (tool-cli-bridge — `open` would hand the page to another browser
   * and bring it in front of the user), so the row says what actually happened.
   * `open -a Safari …` names an app and is the app-launch guard's business.
   */
  if (group === 'open' && !rest.includes('-a')) {
    const url = rest.find((w) => /^[a-z][a-z0-9+.-]*:\/\//i.test(w));
    if (url !== undefined) {
      return browserLabel(
        'navigate',
        BROWSER_VERBS.navigate as [string, string],
        `browser navigate ${url}`,
      );
    }
  }

  /*
   * `svg --prompt="a smiley face" [--out x.svg]` — the OmniSVG drawing. A
   * drawing, not a command: the vector-file mark and "Drawing an SVG".
   */
  if (group === 'svg') {
    const { flags, bare } = cliFlags(argsOf(line));
    // The output path is `--out`, or the positional `.svg`; the prompt is
    // `--prompt`, or whatever bare word is left.
    const out = flags.out ?? flags.output ?? bare.find((w) => /\.svg$/i.test(w));
    const prompt = brief(flags.prompt ?? bare.find((w) => !/\.svg$/i.test(w)));
    return {
      running: 'Drawing an SVG',
      done: 'Drew an SVG',
      kind: 'svg',
      filename: out !== undefined && /\.svg$/i.test(out) ? out : 'drawing.svg',
      ...(prompt === undefined ? {} : { detail: prompt }),
    };
  }

  /*
   * `media generate image --prompt=…`, `media edit image …`: the generate
   * family in CLI clothes — the same kinds and words the native calls have.
   */
  if (group === 'media') {
    const { flags, bare } = cliFlags(argsOf(line));
    const verb = bare[0];
    const what = bare[1];
    const entry = what === undefined ? undefined : MEDIA_KINDS[what];
    if (entry === undefined) return null;
    const prompt = brief(flags.prompt);
    const editing = verb === 'edit';
    return {
      running: editing ? `Editing ${what === 'image' ? 'an image' : what}` : entry.verbs[0],
      done: editing ? `Edited ${what === 'image' ? 'an image' : what}` : entry.verbs[1],
      kind: entry.kind,
      ...(prompt === undefined ? {} : { detail: prompt }),
    };
  }

  /*
   * `office make --kind=docx --out=… --brief=…`, `office edit`, `office
   * inspect`: a document, with its file's mark.
   */
  if (group === 'office') {
    const { flags, bare } = cliFlags(argsOf(line));
    const verb = bare[0];
    const out = flags.out ?? flags.file ?? flags.path;
    const kindWord = flags.kind ?? (out !== undefined ? (out.split('.').pop() ?? '') : undefined);
    const noun =
      kindWord === 'pptx'
        ? 'a deck'
        : kindWord === 'xlsx'
          ? 'a spreadsheet'
          : kindWord === 'pdf'
            ? 'a PDF'
            : 'a document';
    const verbs: Record<string, [string, string]> = {
      make: [`Making ${noun}`, `Made ${noun}`],
      edit: [`Editing ${noun}`, `Edited ${noun}`],
      inspect: [`Reading ${noun}`, `Read ${noun}`],
    };
    const pair = verb === undefined ? undefined : verbs[verb];
    if (pair === undefined) return null;
    const detail = brief(flags.brief) ?? out;
    return {
      running: pair[0],
      done: pair[1],
      kind: 'file',
      ...(out === undefined ? {} : { filename: out }),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  /*
   * `web search --query=…` / `web fetch --url=…`: the SAME rows the native
   * web_search / web_fetch calls draw. They were terminal rows — "Searched the
   * web for …" over a reveal of the tool's raw text — which made the default
   * (CLI) mode's research read as a log while the same search in schemas mode
   * showed what it found. the user's sources wave (2026-09-24) asked for the
   * research to read as research: a search row lists its results (the sites'
   * icons and titles), a fetch row is a page that was read (`page` — not a
   * browser kind, so it never turns the canvas to the browser).
   */
  if (group === 'web') {
    const { flags, bare } = cliFlags(argsOf(line));
    const verb = bare[0];
    if (verb === 'search') {
      const q = brief(flags.query ?? flags.q ?? bare[1]);
      return {
        running: 'Searching the web',
        done: 'Searched the web',
        kind: 'search',
        ...(q === undefined ? {} : { detail: q }),
      };
    }
    if (verb === 'fetch') {
      const url = flags.url ?? bare[1];
      return {
        running: 'Reading a page',
        done: 'Read a page',
        // A page, not the browser: nothing was browsed, so the canvas stays put.
        kind: 'page',
        ...(url === undefined ? {} : { detail: url, url }),
      };
    }
    return null;
  }

  /*
   * `chart bar "Units Sold" --labels … --values …` and `chart edit units.svg
   * --look sunset`. the user (2026-09-17): four rows reading "Chart" beside a
   * spinner; "show something more informative, eg. '<Datavisualization
   * connector icon> Rendering <type> Chart'". The type is the first bare word
   * (or `--type x`); the title the first quoted argument after it.
   */
  if (group === 'chart') {
    const bare = rest.filter((w) => !w.startsWith('-'));
    if (bare[0] === 'edit') {
      return {
        running: 'Redrawing the chart',
        done: 'Redrew the chart',
        chart: { type: 'chart', ...(bare[1] === undefined ? {} : { title: bare[1] }) },
      };
    }
    const typeFlag = rest.findIndex((w) => w === '--type');
    const rawType =
      (typeFlag >= 0 ? rest[typeFlag + 1] : undefined) ??
      bare.find((w) => CHART_TYPE_WORDS.has(w.toLowerCase()));
    const type = chartTypeWord(rawType);
    const title = bare.find((w) => w !== rawType && /\s|[A-Z]/.test(w));
    return {
      running: `Rendering a ${type} chart`,
      done: `Rendered a ${type} chart`,
      chart: { type, ...(title === undefined ? {} : { title }) },
    };
  }

  return null;
}

const CHART_TYPE_WORDS = new Set([
  'bar',
  'bars',
  'column',
  'stacked',
  'hbar',
  'horizontal',
  'line',
  'area',
  'scatter',
  'donut',
  'doughnut',
  'pie',
  'radar',
]);

/** The chart type as a person would say it in "a … chart". */
export function chartTypeWord(raw: string | undefined): string {
  const t = (raw ?? '').toLowerCase().trim();
  switch (t) {
    case 'bar':
    case 'bars':
    case 'column':
      return 'bar';
    case 'stacked':
      return 'stacked bar';
    case 'hbar':
    case 'horizontal':
      return 'horizontal bar';
    case 'line':
    case 'area':
    case 'scatter':
    case 'donut':
    case 'pie':
    case 'radar':
      return t;
    case 'doughnut':
      return 'donut';
    default:
      return t === '' ? 'chart' : t;
  }
}
