/**
 * Collapse the editors' ribbon by default and offer a "Show toolbar" button.
 *
 * The user: "allow the entire toolbar at the top to be not shown at all to start
 * and just don't show it unless a button that you show called 'show toolbar' at
 * the top is clicked. the user can still edit it via clicking, dragging items,
 * typing in text boxes deleting things etc."
 *
 * Nothing about editing depends on the ribbon. Selection, drag, direct typing,
 * delete, undo/redo shortcuts and the context menu are all handled by the
 * document surface itself, so hiding the ribbon costs no capability — it just
 * stops a full Office command strip dominating a canvas sidebar before anyone
 * has asked for one.
 *
 * All five editors root their command strip at `.ribbon`, which is what makes a
 * single rule work everywhere.
 */

/** Attribute on <html> that drives the collapse. Absent/`hidden` = collapsed. */
export const TOOLBAR_ATTR = 'data-pd-toolbar';

export function officeChromeCss(dark: boolean): string {
  // Translucent over an unknown strip is a coin flip: the chip is painted from
  // the theme we last pushed, the strip behind it from whatever the editor's own
  // sheet says, and when those disagree the label vanishes — near-white text on
  // near-white chrome, which is how it read in the capture. Opaque both ways, so
  // legibility never depends on the two agreeing.
  const bg = dark ? '#3a3a38' : '#e8e6df';
  const bgHover = dark ? '#4a4a47' : '#dcd9d0';
  const fg = dark ? '#faf9f5' : '#141413';
  const edge = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';
  return `
/* Collapsed is the DEFAULT: the attribute is only added to reveal. Keying off
   [${TOOLBAR_ATTR}="shown"] rather than a "hidden" flag means the ribbon stays
   down even if the injected script fails to run — a script error should not
   hand the user a full Office ribbon in a sidebar.

   BOTH selectors are needed. docs, slides, pdf and markdown nest their tab strip
   INSIDE .ribbon, so hiding that is enough; sheets keeps .ribbon-tabs as a
   sibling <nav>, so hiding .ribbon alone left its Home/Insert row and quick
   -access icons on screen — and the Show toolbar button then landed on top of
   the save and undo controls. Verified per editor by screenshot, not assumed
   from one of them. */
html:not([${TOOLBAR_ATTR}="shown"]) .ribbon,
html:not([${TOOLBAR_ATTR}="shown"]) .ribbon-tabs { display: none !important; }

/* RESERVE a strip rather than floating over the document.
   The button started as a floating overlay at top-left, which was fine in docs,
   slides, pdf and markdown — after collapsing, their top-left is empty document
   area. In sheets it landed squarely on the name box, because the formula strip
   stays (it is an editing surface, not a toolbar). Shrinking #root is the only
   placement that is correct in all five, and every editor mounts React there. */
html:not([${TOOLBAR_ATTR}="shown"]) #root {
  height: calc(100% - 28px) !important;
  margin-top: 28px !important;
}

#pd-toolbar-toggle {
  position: fixed;
  top: 4px;
  left: 8px;
  z-index: 2147483000;
  appearance: none;
  border: 1px solid ${edge};
  border-radius: 7px;
  padding: 4px 10px;
  font: 500 12px/1.4 var(--gs-font-sans, -apple-system, BlinkMacSystemFont, system-ui, sans-serif);
  color: ${fg};
  background: ${bg};
  cursor: pointer;
}
#pd-toolbar-toggle:hover { background: ${bgHover}; }
`.trim();
}

/**
 * Injected into every editor view. Idempotent: it runs again on each in-app
 * navigation (new document, reload after save), and a second button would
 * otherwise stack up on the first.
 */
export function officeChromeScript(): string {
  return `
(() => {
  const ID = 'pd-toolbar-toggle';
  const ATTR = ${JSON.stringify(TOOLBAR_ATTR)};
  const label = () =>
    document.documentElement.getAttribute(ATTR) === 'shown' ? 'Hide toolbar' : 'Show toolbar';
  // TRADEMARK SWEEP.
  //
  // Apache-2.0 §6 grants no trademark rights, so the wordmark must not ship —
  // and selector-based hiding kept missing places it appears. It was hidden in
  // the ribbon, then reappeared in the ribbon's COLLAPSED dropdown, then again
  // in a floating bar over the slide canvas whose container is neither. Each
  // fix was correct and each was incomplete, because the rule was "hide these
  // containers" when the obligation is "this text must not be visible".
  //
  // So: match the text, hide the nearest thing that looks like a control. Runs
  // on every load and on DOM changes, since these bars mount lazily.
  const hide = (el) => el.style.setProperty('display', 'none', 'important');

  const sweep = () => {
    // 1. Anything that says it, wherever it lives.
    for (const el of document.querySelectorAll('button, [class*="entry"], [class*="tool"]')) {
      if (/genspark/i.test((el.textContent || '').trim())) hide(el);
    }
    // 2. The AI command set, and whatever bar exists only to hold it.
    //
    // Hiding the wordmark alone left "AI Beautify" and "AI Fact Check" sitting
    // in a floating bar over the slide — the same group, rendered somewhere the
    // container selectors did not reach. Every one of these buttons carries
    // .ai-entry, so walking up to the nearest ancestor whose visible children
    // are ALL .ai-entry finds the bar without needing to know its class. The
    // all-children test is what stops this from hiding a real toolbar that
    // merely happens to contain one AI button.
    for (const el of document.querySelectorAll('.ai-entry')) {
      hide(el);
      let node = el.parentElement;
      for (let depth = 0; node && depth < 4; depth++) {
        const kids = Array.from(node.children).filter(
          (c) => !/sep|spacer/i.test(c.className || ''),
        );
        if (kids.length > 0 && kids.every((c) => c.classList.contains('ai-entry'))) {
          hide(node);
          node = node.parentElement;
          continue;
        }
        break;
      }
    }
  };
  sweep();
  if (!window.__pdBrandObserver) {
    window.__pdBrandObserver = new MutationObserver(() => sweep());
    window.__pdBrandObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  let btn = document.getElementById(ID);
  if (!btn) {
    btn = document.createElement('button');
    btn.id = ID;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const shown = document.documentElement.getAttribute(ATTR) === 'shown';
      if (shown) document.documentElement.removeAttribute(ATTR);
      else document.documentElement.setAttribute(ATTR, 'shown');
      btn.textContent = label();
      // The editors size their canvas from the viewport; revealing or hiding a
      // ribbon changes it, and Univer in particular will not reflow on its own.
      window.dispatchEvent(new Event('resize'));
    });
    document.body.appendChild(btn);
  }
  btn.textContent = label();
})();
`.trim();
}
