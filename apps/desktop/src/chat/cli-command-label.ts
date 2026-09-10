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
      ...(app === undefined ? {} : { app }),
    };
  }

  if (group === 'browser') {
    const verb = rest.find((w) => !w.startsWith('-'));
    const pair = verb === undefined ? undefined : BROWSER_VERBS[verb];
    if (pair === undefined) return null;
    return { running: pair[0], done: pair[1] };
  }

  return null;
}
