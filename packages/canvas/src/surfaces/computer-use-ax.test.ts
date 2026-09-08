/**
 * The Accessibility drawing's rules, tested as rules.
 *
 * Every assertion here is one of the two things the fallback can get wrong in a
 * way nobody notices: drawing the WRONG SHAPE (a toolbar chip captioned like a
 * tick box, a save sheet painted behind the document it is blocking), or
 * drawing something Accessibility never said (a placeholder in an empty field).
 * The first looks sloppy; the second is a forgery.
 */
import { describe, expect, it } from 'vitest';
import {
  AX_TITLE_BAR,
  axLabelFor,
  axShapeFor,
  ellipsize,
  idleCursorDrift,
  layoutAxScene,
  pickMonitorSource,
  rectContains,
  rectOfBbox,
  restingCursor,
  wrapText,
} from './computer-use-ax.ts';
import type {
  MacMonitorAxElement,
  MacMonitorAxScene,
  MacMonitorAxWindow,
  MacMonitorSessionState,
} from './computer-use-feed.ts';

function el(patch: Partial<MacMonitorAxElement> = {}): MacMonitorAxElement {
  return {
    index: 1,
    role: 'AXButton',
    name: 'Save',
    bbox: { x: 100, y: 100, w: 80, h: 24 },
    ...patch,
  };
}

function win(patch: Partial<MacMonitorAxWindow> = {}): MacMonitorAxWindow {
  return {
    windowId: 1,
    title: 'Untitled',
    role: 'AXWindow',
    subrole: 'AXStandardWindow',
    frame: { x: 0, y: 0, w: 600, h: 400 },
    main: true,
    focused: true,
    sheet: false,
    modal: false,
    ...patch,
  };
}

function scene(patch: Partial<MacMonitorAxScene> = {}): MacMonitorAxScene {
  return {
    t: 1,
    pid: 42,
    appName: 'TextEdit',
    rect: { x: 0, y: 0, w: 600, h: 400 },
    display: { w: 1512, h: 982 },
    windows: [win()],
    elements: [],
    ...patch,
  };
}

function session(patch: Partial<MacMonitorSessionState> = {}): MacMonitorSessionState {
  return {
    active: true,
    appName: 'TextEdit',
    stream: 'live',
    streamError: null,
    wallpaperUrl: null,
    rect: null,
    statusText: '',
    cursorState: 'idle',
    cursor: null,
    bubbleVisible: false,
    captureDenied: false,
    ...patch,
  };
}

describe('pickMonitorSource', () => {
  it('prefers pixels whenever a frame has one', () => {
    // the user: "when screen recording permissions are granted always use the real
    // window visual."
    expect(pickMonitorSource(session(), { bitmap: {} })).toBe('pixels');
  });

  it('asks for the grant when that is why there are no pixels', () => {
    expect(pickMonitorSource(session({ stream: 'unavailable', captureDenied: true }), null)).toBe(
      'permission',
    );
  });

  it('does not ask while the stream is merely starting', () => {
    // A quarter-second of "connecting" is not a reason to show a permission
    // panel — the picture is on its way.
    expect(pickMonitorSource(session({ stream: 'starting' }), null)).toBe('none');
  });

  it('leaves the honest empty state alone when the grant is not the problem', () => {
    // Stream failed for some other reason: "Live view unavailable" says so, and
    // asking for a permission the user already granted would be a lie.
    expect(pickMonitorSource(session({ stream: 'unavailable' }), null)).toBe('none');
  });

  it('shows nothing at all with no session', () => {
    expect(pickMonitorSource(session({ active: false }), { bitmap: {} })).toBe('none');
  });

  it('goes straight back to pixels the moment a grant lets frames through', () => {
    expect(pickMonitorSource(session({ stream: 'unavailable', captureDenied: true }), null)).toBe(
      'permission',
    );
    expect(pickMonitorSource(session({ stream: 'live' }), { bitmap: {} })).toBe('pixels');
  });
});

describe('axShapeFor', () => {
  it('calls a page-sized text area the document and a small one a field', () => {
    expect(axShapeFor({ role: 'AXTextArea', bbox: { x: 0, y: 0, w: 500, h: 300 } })).toBe(
      'document',
    );
    expect(axShapeFor({ role: 'AXTextArea', bbox: { x: 0, y: 0, w: 200, h: 22 } })).toBe('field');
  });

  it("treats TextEdit's 22pt Bold checkbox as a toolbar chip, not a tick box", () => {
    // Every one of Bold/Italic/Underline/align-* is an AXCheckBox about 22pt
    // wide. Drawn as captioned tick boxes they would be seven overlapping
    // labels across the ruler.
    expect(axShapeFor({ role: 'AXCheckBox', bbox: { x: 0, y: 0, w: 22, h: 20 } })).toBe('toggle');
    expect(axShapeFor({ role: 'AXCheckBox', bbox: { x: 0, y: 0, w: 160, h: 20 } })).toBe(
      'checkbox',
    );
  });

  it('maps the roles a save sheet is made of', () => {
    expect(axShapeFor({ role: 'AXTextField', bbox: { x: 0, y: 0, w: 232, h: 26 } })).toBe('field');
    expect(axShapeFor({ role: 'AXPopUpButton', bbox: { x: 0, y: 0, w: 232, h: 26 } })).toBe(
      'popup',
    );
    expect(axShapeFor({ role: 'AXButton', bbox: { x: 0, y: 0, w: 81, h: 26 } })).toBe('button');
    expect(axShapeFor({ role: 'AXDisclosureTriangle', bbox: { x: 0, y: 0, w: 26, h: 26 } })).toBe(
      'disclosure',
    );
  });

  it('gives an unknown role a shape rather than dropping it', () => {
    expect(axShapeFor({ role: 'AXFancyNewThing', bbox: { x: 0, y: 0, w: 60, h: 20 } })).toBe(
      'plain',
    );
    expect(
      axShapeFor({ role: 'AXFancyNewThing', bbox: { x: 0, y: 0, w: 60, h: 20 }, editable: true }),
    ).toBe('field');
  });
});

describe('axLabelFor', () => {
  it('shows a field its VALUE, never its accessible name', () => {
    // AX names the save sheet's filename field "Save As:". Painting that inside
    // the box would put a label where the user's own typing is.
    const field = el({ role: 'AXTextField', name: 'Save As:', value: 'Untitled 14' });
    expect(axLabelFor(field, 'field')).toBe('Untitled 14');
  });

  it('leaves an empty field empty rather than inventing a placeholder', () => {
    expect(axLabelFor(el({ role: 'AXTextField', name: 'tag editor' }), 'field')).toBe('');
  });

  it('shows a button the word on the button', () => {
    expect(axLabelFor(el({ name: 'Cancel' }), 'button')).toBe('Cancel');
  });

  it('says nothing on a chip too small to hold it', () => {
    expect(axLabelFor(el({ role: 'AXCheckBox', name: 'bold' }), 'toggle')).toBe('');
  });
});

describe('rectOfBbox', () => {
  it("converts the wire's CENTRE-anchored bbox into a top-left rect", () => {
    // Measured against a real TextEdit: window at x=529 w=603, its text area
    // reported bbox.x=822 w=586 — a centre, so the left edge is 529.
    expect(rectOfBbox({ x: 822, y: 367, w: 586, h: 382 })).toEqual({
      x: 529,
      y: 176,
      w: 586,
      h: 382,
    });
  });
});

describe('rectContains', () => {
  it('accepts an element flush with its window edge', () => {
    expect(rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(true);
  });
  it('rejects one that pokes out', () => {
    expect(rectContains({ x: 0, y: 0, w: 100, h: 100 }, { x: 90, y: 0, w: 40, h: 10 })).toBe(false);
  });
});

describe('layoutAxScene', () => {
  const sheet = win({
    windowId: 2,
    title: '',
    role: 'AXSheet',
    subrole: '',
    frame: { x: 100, y: 40, w: 390, h: 218 },
    main: false,
    sheet: true,
    modal: true,
  });

  it('paints back to front so a sheet lands ON its parent, not under it', () => {
    // The helper lists windows FRONT to back. Painting in that order put the
    // document over the save sheet — the exact case this feature exists for.
    const laid = layoutAxScene(scene({ windows: [sheet, win()] }));
    expect(laid.map((l) => l.win.windowId)).toEqual([1, 2]);
  });

  it('gives a window a title bar and a sheet none', () => {
    const laid = layoutAxScene(scene({ windows: [sheet, win()] }));
    expect(laid[0]?.titleBar).toBe(AX_TITLE_BAR);
    expect(laid[1]?.titleBar).toBe(0);
  });

  it('routes each element to the window it belongs to', () => {
    const laid = layoutAxScene(
      scene({
        windows: [sheet, win()],
        elements: [
          el({ index: 1, name: 'Cancel', win: 2, bbox: { x: 200, y: 200, w: 80, h: 26 } }),
          el({ index: 2, role: 'AXTextArea', win: 1, bbox: { x: 300, y: 200, w: 560, h: 300 } }),
        ],
      }),
    );
    expect(laid[0]?.elements.map((d) => d.el.index)).toEqual([2]);
    expect(laid[1]?.elements.map((d) => d.el.index)).toEqual([1]);
  });

  it('falls back to containment when the helper sends no window ids', () => {
    const laid = layoutAxScene(
      scene({
        windows: [sheet, win()],
        elements: [el({ index: 7, bbox: { x: 200, y: 100, w: 80, h: 26 } })],
      }),
    );
    // Inside the sheet's frame, so it is the sheet's — front-most first.
    expect(laid[1]?.elements.map((d) => d.el.index)).toEqual([7]);
  });

  it('sorts largest first so a container never covers its own children', () => {
    const laid = layoutAxScene(
      scene({
        elements: [
          el({ index: 1, bbox: { x: 100, y: 100, w: 40, h: 20 }, win: 1 }),
          el({ index: 2, role: 'AXTextArea', bbox: { x: 300, y: 200, w: 560, h: 300 }, win: 1 }),
        ],
      }),
    );
    expect(laid[0]?.elements.map((d) => d.el.index)).toEqual([2, 1]);
  });

  it('drops an element belonging to nothing on the stage', () => {
    const laid = layoutAxScene(
      scene({ elements: [el({ index: 9, bbox: { x: 5000, y: 5000, w: 20, h: 20 } })] }),
    );
    expect(laid[0]?.elements).toHaveLength(0);
  });
});

describe('restingCursor', () => {
  it('rests where the phantom last actually was', () => {
    expect(restingCursor({ x: 0, y: 0, w: 600, h: 400 }, { x: 120, y: 90 })).toEqual({
      x: 120,
      y: 90,
    });
  });

  it('parks inside the window when it has never been anywhere', () => {
    const at = restingCursor({ x: 100, y: 50, w: 600, h: 400 }, null);
    expect(at.x).toBeGreaterThan(100);
    expect(at.x).toBeLessThan(700);
    expect(at.y).toBeGreaterThan(50);
    expect(at.y).toBeLessThan(450);
  });
});

describe('idleCursorDrift', () => {
  it('breathes within a few pixels and never parks dead still', () => {
    let maxX = 0;
    let moved = false;
    let previous = idleCursorDrift(0);
    for (let t = 0; t < 12_000; t += 90) {
      const d = idleCursorDrift(t);
      maxX = Math.max(maxX, Math.abs(d.x), Math.abs(d.y));
      if (Math.abs(d.x - previous.x) > 0.01) moved = true;
      previous = d;
    }
    expect(maxX).toBeLessThan(4);
    expect(moved).toBe(true);
  });
});

describe('wrapText', () => {
  const measure = (s: string): number => s.length * 6;

  it('wraps on words and honours the newlines already in the text', () => {
    expect(wrapText('one two three\nfour', 60, 10, measure)).toEqual(['one two', 'three', 'four']);
  });

  it('stops at maxLines rather than overflowing the box AX gave it', () => {
    expect(wrapText('a b c d e f g h', 12, 2, measure)).toHaveLength(2);
  });

  it('never drops a word that cannot fit at all', () => {
    expect(wrapText('supercalifragilistic', 12, 3, measure)).toEqual(['supercalifragilistic']);
  });
});

describe('ellipsize', () => {
  const measure = (s: string): number => s.length * 6;

  it('leaves text that fits alone', () => {
    expect(ellipsize('Save', 60, measure)).toBe('Save');
  });

  it('cuts with an ellipsis when it must', () => {
    const out = ellipsize('Untitled 14 — Edited', 42, measure);
    expect(out.endsWith('…')).toBe(true);
    expect(measure(out)).toBeLessThanOrEqual(42);
  });

  it('returns nothing when not even one character fits', () => {
    expect(ellipsize('Save', 4, measure)).toBe('');
  });
});
