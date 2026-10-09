/**
 * WHAT THE MODEL IS TOLD, FROM WHAT THE PERSON GATHERED IN THE QUICK PANEL.
 *
 * The panel collects context as chips — a window's picture, a dragged area, the
 * text that was selected in the app in front, the clipboard, Finder's
 * selection, the page open in the browser, or the app itself as something to
 * act in — and the message sent is assembled from them HERE, in one pure
 * function, so the words the model reads are testable and cannot drift between
 * the places that send.
 *
 * Three things come out:
 *
 *   display       the bubble — what the person typed, or the action they
 *                 pressed ("Explain the selection"). Never the folded context.
 *   agentMessage  what pi receives: a line per picture saying what it is, the
 *                 text context in fences, then the request.
 *   images        the pictures as data URIs, in chip order.
 *
 * Pure: no electron, no DOM. The renderer imports it.
 */

/** A text action offered on a selection. */
export type QuickTextAction = 'explain' | 'rewrite' | 'translate' | 'summarize' | 'fix';

export const QUICK_TEXT_ACTION_LABELS: Readonly<Record<QuickTextAction, string>> = {
  explain: 'Explain',
  rewrite: 'Rewrite',
  translate: 'Translate',
  summarize: 'Summarize',
  fix: 'Fix spelling and grammar',
};

/** The actions whose answer is meant to REPLACE the selection. */
export const REPLACING_ACTIONS: ReadonlySet<QuickTextAction> = new Set([
  'rewrite',
  'translate',
  'fix',
]);

export type QuickContext =
  | {
      readonly kind: 'window';
      readonly id: string;
      readonly app: string;
      readonly title: string;
      /** `data:image/…;base64,…` */
      readonly image: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: 'region';
      readonly id: string;
      readonly image: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: 'screen';
      readonly id: string;
      readonly image: string;
      readonly width: number;
      readonly height: number;
      /** "Built-in Display", or "Display 2". */
      readonly display: string;
    }
  | {
      readonly kind: 'selection';
      readonly id: string;
      readonly app: string;
      readonly text: string;
      /** The field it came from takes text back (so "Replace selection" can work). */
      readonly editable: boolean;
    }
  | {
      readonly kind: 'clipboard';
      readonly id: string;
      readonly text?: string;
      readonly image?: string;
    }
  | {
      readonly kind: 'files';
      readonly id: string;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'browser';
      readonly id: string;
      readonly app: string;
      readonly url: string;
      readonly title: string;
      /** The page's text, when the browser would give it. */
      readonly text?: string;
    }
  | {
      /** The app in front, as somewhere to ACT: computer use on its pid. */
      readonly kind: 'app';
      readonly id: string;
      readonly app: string;
      readonly pid: number;
      readonly bundleId?: string;
    };

export type QuickContextKind = QuickContext['kind'];

/** Caps, so one long selection or page cannot eat the model's window. */
export const MAX_SELECTION_CHARS = 20_000;
export const MAX_CLIPBOARD_CHARS = 20_000;
export const MAX_PAGE_CHARS = 30_000;
export const MAX_LISTED_FILES = 50;

/** A fence longer than any run of backticks inside the text, so it cannot close early. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
  const f = fenceFor(text);
  return `${f}\n${text}\n${f}`;
}

/** `text` cut to `max` characters, saying so when it was. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters not included)`;
}

/** The chip's words: what it is, short. */
export function contextLabel(c: QuickContext): string {
  switch (c.kind) {
    case 'window':
      return c.title !== '' ? `${c.app} · ${c.title}` : c.app;
    case 'region':
      return `Area · ${c.width} × ${c.height}`;
    case 'screen':
      return `Screen · ${c.display}`;
    case 'selection':
      return `Selection in ${c.app}`;
    case 'clipboard':
      return c.image !== undefined ? 'Clipboard picture' : 'Clipboard text';
    case 'files':
      return c.paths.length === 1
        ? (c.paths[0]?.split('/').pop() ?? 'File')
        : `${c.paths.length} files from Finder`;
    case 'browser':
      return c.title !== '' ? c.title : c.url;
    case 'app':
      return `Use ${c.app}`;
  }
}

function pictureLine(c: QuickContext): string | null {
  switch (c.kind) {
    case 'window':
      return `Attached: a screenshot of the ${c.app} window${c.title !== '' ? ` “${c.title}”` : ''} (${c.width}×${c.height}).`;
    case 'region':
      return `Attached: a screenshot of an area of the screen the user selected (${c.width}×${c.height}).`;
    case 'screen':
      return `Attached: a screenshot of the whole screen (${c.display}, ${c.width}×${c.height}).`;
    case 'clipboard':
      return c.image !== undefined ? 'Attached: the picture on the clipboard.' : null;
    default:
      return null;
  }
}

function textBlock(c: QuickContext): string | null {
  switch (c.kind) {
    case 'selection':
      return `Selected text in ${c.app}:\n${fenced(capText(c.text, MAX_SELECTION_CHARS))}`;
    case 'clipboard':
      return c.text !== undefined && c.text !== ''
        ? `Clipboard text:\n${fenced(capText(c.text, MAX_CLIPBOARD_CHARS))}`
        : null;
    case 'files': {
      const shown = c.paths.slice(0, MAX_LISTED_FILES);
      const more = c.paths.length - shown.length;
      return `Selected in Finder:\n${shown.map((p) => `- ${p}`).join('\n')}${more > 0 ? `\n- … and ${more} more` : ''}`;
    }
    case 'browser': {
      const head = `Open in ${c.app}: “${c.title}” ${c.url}`;
      return c.text !== undefined && c.text !== ''
        ? `${head}\nPage text:\n${fenced(capText(c.text, MAX_PAGE_CHARS))}`
        : head;
    }
    default:
      return null;
  }
}

function appPreamble(c: Extract<QuickContext, { kind: 'app' }>): string {
  return (
    `The user summoned Bobble while working in ${c.app} and wants this done IN ${c.app}. ` +
    `Use the Mac computer-use tools on that app (start with mac_snapshot on the app “${c.app}”; ` +
    `it is running as pid ${c.pid}). Work in the background, and when you are done say in one ` +
    `or two sentences what you did.`
  );
}

function actionInstruction(action: QuickTextAction, language: string): string {
  switch (action) {
    case 'explain':
      return 'Explain this.';
    case 'rewrite':
      return 'Rewrite this so it reads better, keeping its meaning and tone. Reply with only the rewritten text: no preamble, no quotes.';
    case 'translate':
      return `Translate this into ${language}. Reply with only the translation: no preamble, no quotes.`;
    case 'summarize':
      return 'Summarize this in a few sentences.';
    case 'fix':
      return 'Fix the spelling and grammar and change nothing else. Reply with only the corrected text: no preamble, no quotes.';
  }
}

/** The bubble's words for an action pressed with nothing typed. */
export function actionDisplay(action: QuickTextAction, language: string): string {
  switch (action) {
    case 'explain':
      return 'Explain the selection';
    case 'rewrite':
      return 'Rewrite the selection';
    case 'translate':
      return `Translate the selection into ${language}`;
    case 'summarize':
      return 'Summarize the selection';
    case 'fix':
      return 'Fix the spelling and grammar';
  }
}

/** What a send with no typed words asks, given what is attached. */
function defaultQuestion(contexts: readonly QuickContext[]): string | null {
  if (contexts.some((c) => c.kind === 'window' || c.kind === 'region' || c.kind === 'screen')) {
    return 'What am I looking at? Point out what matters.';
  }
  if (contexts.some((c) => c.kind === 'clipboard' && c.image !== undefined)) {
    return 'What is this picture?';
  }
  if (contexts.some((c) => c.kind === 'selection' || c.kind === 'clipboard'))
    return 'Explain this.';
  if (contexts.some((c) => c.kind === 'browser')) return 'Summarize this page.';
  if (contexts.some((c) => c.kind === 'files')) return 'What are these files?';
  return null;
}

export interface AssembledMessage {
  readonly display: string;
  readonly agentMessage: string;
  readonly images: readonly string[];
  /** The answer is meant to replace the selection it was asked about. */
  readonly replacesSelection: boolean;
}

/**
 * The message for a send, or null when there is nothing to send (no words, no
 * action, and nothing attached that a question could be asked of — an app to
 * act in needs to be told what to do).
 */
export function assembleQuickMessage(input: {
  readonly text: string;
  readonly contexts: readonly QuickContext[];
  readonly action?: QuickTextAction;
  /** For `translate`: the language to translate into, as a person names it. */
  readonly language?: string;
}): AssembledMessage | null {
  const typed = input.text.trim();
  const language = input.language?.trim() || 'English';
  const contexts = input.contexts;
  const action = input.action;
  const app = contexts.find((c): c is Extract<QuickContext, { kind: 'app' }> => c.kind === 'app');

  let request: string;
  let display: string;
  if (action !== undefined) {
    request = actionInstruction(action, language);
    if (typed !== '') request = `${request}\n\nAlso: ${typed}`;
    display = typed !== '' ? typed : actionDisplay(action, language);
  } else if (typed !== '') {
    request = typed;
    display = typed;
  } else {
    if (app !== undefined) return null;
    const fallback = defaultQuestion(contexts);
    if (fallback === null) return null;
    request = fallback;
    display = fallback;
  }

  const pictures = contexts.map(pictureLine).filter((l): l is string => l !== null);
  const blocks = contexts.map(textBlock).filter((b): b is string => b !== null);
  const parts = [
    app !== undefined ? appPreamble(app) : '',
    pictures.join('\n'),
    blocks.join('\n\n'),
    request,
  ].filter((p) => p !== '');

  const images: string[] = [];
  for (const c of contexts) {
    if (c.kind === 'window' || c.kind === 'region' || c.kind === 'screen') images.push(c.image);
    else if (c.kind === 'clipboard' && c.image !== undefined) images.push(c.image);
  }

  const selection = contexts.find((c) => c.kind === 'selection');
  return {
    display,
    agentMessage: parts.join('\n\n'),
    images,
    replacesSelection:
      action !== undefined &&
      REPLACING_ACTIONS.has(action) &&
      selection !== undefined &&
      selection.kind === 'selection' &&
      selection.editable,
  };
}

/**
 * The text to paste back for "Replace selection": the reply without the
 * wrapping a model adds despite being asked not to — one surrounding fence, or
 * one pair of surrounding quotes.
 */
export function replacementText(reply: string): string {
  let t = reply.trim();
  const fence = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1$/.exec(t);
  if (fence !== null) t = (fence[2] ?? '').trim();
  const quoted = /^(["“'‘])([\s\S]*)(["”'’])$/.exec(t);
  if (quoted !== null) {
    const open = quoted[1];
    const close = quoted[3];
    const pairs: Record<string, string> = { '"': '"', '“': '”', "'": "'", '‘': '’' };
    if (open !== undefined && pairs[open] === close) t = (quoted[2] ?? '').trim();
  }
  return t;
}
