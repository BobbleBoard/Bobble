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
    if (pair === undefined) return null;
    return { running: pair[0], done: pair[1] };
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
