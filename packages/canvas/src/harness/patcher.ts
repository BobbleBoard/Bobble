import morphdom from 'morphdom';

/**
 * The no-reload patch core. Given a live root element and a full HTML snapshot,
 * morph the root's children toward the snapshot IN PLACE so that:
 *
 *  - the running scripts / timers inside the frame keep running (nodes are
 *    morphed, never re-parsed wholesale, so identities survive),
 *  - the value + focus + caret of the element the user is editing survive a
 *    patch that rewrites the surrounding markup,
 *  - scroll positions of untouched scroll containers survive,
 *  - `<script>` elements that appear in a patch actually execute (nodes created
 *    via innerHTML are inert, so newly-added scripts are re-created as live ones).
 *
 * This function is the exact code bundled into the shipped harness, and is unit
 * tested in jsdom (patcher.test.ts) — that test is the no-reload proof.
 */

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

function isEditable(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** Copy the user's live, in-progress state into the incoming node so morphdom's
 * form-field property sync keeps it instead of resetting to the streamed markup. */
function preserveLiveValue(fromEl: Element, toEl: Element): void {
  if (fromEl instanceof HTMLInputElement && toEl instanceof HTMLInputElement) {
    toEl.setAttribute('value', fromEl.value);
    toEl.value = fromEl.value;
    toEl.checked = fromEl.checked;
    if (fromEl.checked) toEl.setAttribute('checked', '');
    else toEl.removeAttribute('checked');
    return;
  }
  if (fromEl instanceof HTMLTextAreaElement && toEl instanceof HTMLTextAreaElement) {
    toEl.value = fromEl.value;
    toEl.textContent = fromEl.value;
    return;
  }
  if (fromEl instanceof HTMLSelectElement && toEl instanceof HTMLSelectElement) {
    toEl.value = fromEl.value;
  }
}

/** Re-create a `<script>` so it executes (innerHTML-inserted scripts are inert). */
function reviveScript(
  script: HTMLScriptElement,
  onRun?: (script: HTMLScriptElement) => void,
): void {
  const revived = script.ownerDocument.createElement('script');
  for (const attr of Array.from(script.attributes)) {
    revived.setAttribute(attr.name, attr.value);
  }
  revived.textContent = script.textContent;
  script.replaceWith(revived);
  onRun?.(revived);
}

function reviveScriptsIn(node: Node, onRun?: (script: HTMLScriptElement) => void): void {
  if (node instanceof HTMLScriptElement) {
    reviveScript(node, onRun);
    return;
  }
  if (node instanceof Element) {
    for (const script of Array.from(node.querySelectorAll('script'))) {
      reviveScript(script, onRun);
    }
  }
}

/** A script as it stands: what it would run (its attributes and its text). */
export function scriptKey(script: Element): string {
  const attrs = Array.from(script.attributes, (a) => `${a.name}=${a.value}`).join(' ');
  return `${attrs}\n${script.textContent ?? ''}`;
}

/** What a form field holds is the reader's (the patch keeps it), not the page's markup. */
const FORM_STATE = new Set(['value', 'checked', 'selected']);
const FORM_FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

/**
 * Whether two lists of nodes are the same markup — tags, attributes, text — leaving
 * out what a reader typed or ticked into a form field. Used to tell whether a page's
 * own scripts have changed what its snapshot drew.
 */
export function sameMarkup(a: NodeListOf<ChildNode>, b: NodeListOf<ChildNode>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) return false;
    if (x.nodeType !== 1) {
      if (x.nodeValue !== y.nodeValue) return false;
      continue;
    }
    const ex = x as Element;
    const ey = y as Element;
    const field = FORM_FIELDS.has(ex.tagName);
    const attrs = (el: Element) =>
      Array.from(el.attributes)
        .filter((at) => !(field && FORM_STATE.has(at.name)))
        .map((at) => `${at.name}=${at.value}`)
        .sort()
        .join('\u0000');
    if (attrs(ex) !== attrs(ey)) return false;
    if (ex.tagName === 'TEXTAREA') continue;
    if (!sameMarkup(ex.childNodes, ey.childNodes)) return false;
  }
  return true;
}

/**
 * LLM HTML is often a FULL document (`<html><head><style>…</head><body>…`).
 * `div.innerHTML` silently drops `html`/`head`/`body`, losing head styles and
 * scripts, so a full document is flattened to body-level markup: head content
 * (styles/links/scripts, valid in `<body>` under HTML5) is prepended to the body
 * markup. Fragments pass through untouched.
 */
function normalizeToBodyMarkup(html: string): string {
  if (!/<(?:html|body|head)[\s>]/i.test(html)) return html;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return (parsed.head?.innerHTML ?? '') + (parsed.body?.innerHTML ?? '');
}

export interface ApplyHtmlPatchOptions {
  /** Execute `<script>` elements that appear in the patch. Default: true. */
  runScripts?: boolean;
  /** Called with each script the patch ran, once it has run. */
  onScriptRun?: (script: HTMLScriptElement) => void;
  /** The snapshot already parsed by {@link parseSnapshot} — consumed by the morph. */
  template?: HTMLElement;
}

/**
 * The snapshot as markup alone — what the page is before any of its scripts
 * run — built as a detached mirror of `root` (same tag), ready to morph toward.
 */
export function parseSnapshot(root: HTMLElement, html: string): HTMLElement {
  const template = root.ownerDocument.createElement(root.tagName);
  template.innerHTML = normalizeToBodyMarkup(html);
  return template;
}

/**
 * Morph `root`'s children toward `html` in place. Returns nothing; mutates
 * `root`. `html` is the FULL current body snapshot (the harness always sends a
 * full snapshot and lets morphdom compute the minimal DOM delta).
 */
export function applyHtmlPatch(
  root: HTMLElement,
  html: string,
  options: ApplyHtmlPatchOptions = {},
): void {
  const runScripts = options.runScripts ?? true;
  const doc = root.ownerDocument;

  // Snapshot the caret/selection of the element being edited so we can restore
  // it after the morph (setting .value can reset the caret to the end).
  const active = doc.activeElement;
  let caret: { el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number } | undefined;
  if (active && isTextField(active) && root.contains(active) && active.selectionStart !== null) {
    caret = {
      el: active,
      start: active.selectionStart,
      end: active.selectionEnd ?? active.selectionStart,
    };
  }

  // Build the target as a detached mirror of `root` so childrenOnly morphs only
  // the content and leaves `root` itself (its scroll, listeners) untouched.
  const template = options.template ?? parseSnapshot(root, html);

  morphdom(root, template, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Skip subtrees that are byte-identical: cheaper, and it guarantees we
      // never clobber a node the user is interacting with when nothing changed.
      if (fromEl.isEqualNode(toEl)) return false;
      const activeEl = fromEl.ownerDocument.activeElement;
      if (fromEl === activeEl && isEditable(fromEl)) {
        preserveLiveValue(fromEl, toEl);
      }
      return true;
    },
    onNodeAdded(node) {
      if (runScripts) reviveScriptsIn(node, options.onScriptRun);
      return node;
    },
  });

  if (caret && root.contains(caret.el) && caret.el.isConnected) {
    if (doc.activeElement !== caret.el) caret.el.focus();
    try {
      caret.el.setSelectionRange(caret.start, caret.end);
    } catch {
      // Some input types (email/number) disallow setSelectionRange; ignore.
    }
  }
}
