/**
 * A snapshot must always come back with something the model can act on.
 *
 * the user, on Mac computer-use: it "constantly will return something that just
 * isn't able to do anything, it also gives some useless information to the model
 * sometimes about it being AX opaque ... if there's really no other option it
 * just has to return an image of the app window and a blurb that says 'control
 * the application via coordinates'."
 */
import { describe, expect, it } from 'vitest';
import {
  blockedIndexes,
  dialogOf,
  dialogSignature,
  formatMacSnapshot,
  isAxOpaque,
  snapshotRect,
} from './format';
import type { MacSnapshot } from './protocol';
import { MAC_COMPUTER_USE_TOOL_NAMES } from './tool-names';

const snap = (over: Partial<MacSnapshot> = {}): MacSnapshot =>
  ({
    app: 'Photoshop',
    window: 'Untitled-1',
    pid: 42,
    elements: [],
    summary: { app: 'Photoshop', window: 'Untitled-1', elementCount: 0, truncated: false },
    /* The AX-opaque path always has a picture in practice: mac_snapshot re-takes
     * the snapshot WITH the screenshot the moment Accessibility comes back
     * empty. Tests that care about the no-picture floor override this. */
    screenshot: { path: '/tmp/x.png', base64: 'AAAA', mimeType: 'image/png' },
    ...over,
  }) as MacSnapshot;

describe('an app that tells Accessibility nothing', () => {
  it('is recognised, rather than treated as an error', () => {
    // Normal for a large slice of the Mac: anything drawing its own UI.
    expect(isAxOpaque(snap())).toBe(true);
    expect(
      isAxOpaque(
        snap({
          elements: [{ index: 0, role: 'AXButton', name: 'OK' }] as MacSnapshot['elements'],
        }),
      ),
    ).toBe(false);
  });

  it('says to work in COORDINATES, and points at the image', () => {
    const text = formatMacSnapshot(snap());
    expect(text).toContain('CONTROL THE APPLICATION VIA COORDINATES');
    expect(text).toContain('screenshot attached below IS your view');
    // The old dead end — telling the model to call the same tool again — is gone.
    expect(text).not.toContain('request a screenshot');
  });

  it('gives the window geometry, so a point read off the image maps to the screen', () => {
    const text = formatMacSnapshot(snap({ windowBounds: { x: 100, y: 60, w: 1200, h: 800 } }));
    expect(text).toContain('x=100');
    expect(text).toContain('y=60');
    expect(text).toContain('w=1200');
    expect(text).toContain('h=800');
  });

  it('still lists elements normally when Accessibility DOES answer', () => {
    const text = formatMacSnapshot(
      snap({
        elements: [
          { index: 0, role: 'AXButton', name: 'Save' },
          { index: 1, role: 'AXTextField', name: 'Name', editable: true },
        ] as MacSnapshot['elements'],
        summary: { app: 'Photoshop', window: 'Untitled-1', elementCount: 2, truncated: false },
      }),
    );
    expect(text).toContain('[0] AXButton "Save"');
    expect(text).toContain('(editable)');
    expect(text).not.toContain('COORDINATES');
  });

  /*
   * ...and the floor UNDER the floor. If Screen Recording is not granted there
   * is no picture either, and the old text still said "the screenshot attached
   * below IS your view of it" — pointing at nothing. Keys and coordinates both
   * work without an image, so the text names them instead of describing a hole.
   */
  it('does not point at an image that is not there', () => {
    const text = formatMacSnapshot(snap({ screenshot: undefined }));
    expect(text).not.toContain('attached below');
    expect(text).toContain('YOU CAN STILL DRIVE IT');
    expect(text).toContain('mac_key');
    expect(text).toContain('Screen Recording');
  });

  it('only names tools that exist', () => {
    // The blurb used to send the model to mac_move / mac_drag, which are not
    // registered anywhere — the same false-availability failure as advertising
    // a tool that is not in the list.
    const both = [formatMacSnapshot(snap()), formatMacSnapshot(snap({ screenshot: undefined }))];
    for (const text of both) {
      for (const name of text.match(/mac_[a-z]+/g) ?? []) {
        expect(MAC_COMPUTER_USE_TOOL_NAMES).toContain(name);
      }
    }
  });
});

/*
 * A SAVE SHEET IS PART OF TEXTEDIT, NOT OF FINDER.
 *
 * the user's named failure: "the model clicks Open in TextEdit, a file dialog
 * appears — that dialog is part of TextEdit, not Finder — and the model must be
 * able to see and drive it." A snapshot that folds a sheet's controls into the
 * window's list without saying so leaves the model guessing which surface an
 * index belongs to, which is how it clicks the document behind an open panel.
 */
const SAVE_SHEET = {
  windowId: 7,
  role: 'AXSheet',
  subrole: 'AXDialog',
  title: 'Save',
  frame: { x: 300, y: 180, w: 560, h: 320 },
  sheet: true,
  modal: true,
  focused: true,
};
const DOC_WINDOW = {
  windowId: 3,
  role: 'AXWindow',
  subrole: 'AXStandardWindow',
  title: 'Untitled',
  frame: { x: 100, y: 60, w: 900, h: 700 },
  main: true,
};

const withSheet = (over: Partial<MacSnapshot> = {}): MacSnapshot =>
  snap({
    app: 'TextEdit',
    window: 'Untitled',
    windows: [DOC_WINDOW, SAVE_SHEET],
    dialog: { title: 'Save', role: 'AXSheet' },
    elements: [
      { index: 1, role: 'AXTextArea', name: 'text entry area', editable: true, win: 3 },
      {
        index: 2,
        role: 'AXTextField',
        name: 'Save As:',
        value: 'Untitled',
        editable: true,
        focused: true,
        win: 7,
      },
      { index: 3, role: 'AXButton', name: 'Save', win: 7 },
      { index: 4, role: 'AXButton', name: 'Cancel', win: 7 },
    ],
    summary: { app: 'TextEdit', window: 'Untitled', elementCount: 4, truncated: false },
    ...over,
  } as Partial<MacSnapshot>);

describe('a dialog the app itself opened', () => {
  it('is resolved from the explicit dialog field, enriched from the windows list', () => {
    const d = dialogOf(withSheet());
    expect(d).toMatchObject({ title: 'Save', kind: 'sheet', windowId: 7 });
    expect(d?.frame).toEqual(SAVE_SHEET.frame);
  });

  it('is resolved from the windows list alone when the helper states no dialog', () => {
    // Two independent sources, because a helper may send either.
    const d = dialogOf(withSheet({ dialog: undefined }));
    expect(d).toMatchObject({ title: 'Save', windowId: 7 });
  });

  it('is announced BEFORE the elements, naming the dialog and the app it belongs to', () => {
    const text = formatMacSnapshot(withSheet());
    const banner = text.indexOf('A DIALOG IS OPEN');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(text.indexOf('[2]'));
    expect(text).toContain('"Save" (sheet)');
    expect(text).toContain('It belongs to "TextEdit"');
  });

  it('attributes each index to the surface it lives in', () => {
    const text = formatMacSnapshot(withSheet());
    const dialogHeading = text.indexOf("The dialog's controls");
    const behind = text.indexOf('Behind it');
    expect(dialogHeading).toBeGreaterThanOrEqual(0);
    expect(behind).toBeGreaterThan(dialogHeading);
    // The sheet's controls come first; the blocked window's come after.
    expect(text.indexOf('[3] AXButton "Save"')).toBeLessThan(behind);
    expect(text.indexOf('[1] AXTextArea')).toBeGreaterThan(behind);
  });

  it('degrades to a flat list, still announced, when the helper cannot attribute', () => {
    // An OLDER prebuilt helper sends no `win` on elements. That must not throw
    // and must not invent an attribution — but the banner still fires.
    const text = formatMacSnapshot(
      withSheet({
        elements: [
          { index: 1, role: 'AXTextArea', name: 'text entry area', editable: true },
          { index: 3, role: 'AXButton', name: 'Save' },
        ] as MacSnapshot['elements'],
      }),
    );
    expect(text).toContain('A DIALOG IS OPEN');
    expect(text).toContain("the dialog's controls are among them");
    expect(text).toContain('[3] AXButton "Save"');
    expect(text).not.toContain('Behind it');
  });

  it('says nothing about dialogs when there are none', () => {
    const text = formatMacSnapshot(withSheet({ windows: [DOC_WINDOW], dialog: null }));
    expect(text).not.toContain('DIALOG');
    expect(text).toContain('Actionable elements (act by index):');
  });

  it('changes signature when the dialog changes, and is empty for none', () => {
    // The mechanism the stale-index retry compares against.
    expect(dialogSignature(dialogOf(withSheet()))).not.toBe('');
    expect(dialogSignature(dialogOf(withSheet({ dialog: null, windows: [DOC_WINDOW] })))).toBe('');
    expect(dialogSignature(dialogOf(withSheet()))).not.toBe(
      dialogSignature(dialogOf(withSheet({ dialog: { title: 'Open', role: 'AXSheet' } }))),
    );
  });

  it('survives an older helper that sends no windows/dialog at all', () => {
    const bare = withSheet({ windows: undefined, dialog: undefined });
    expect(dialogOf(bare)).toBeNull();
    expect(() => formatMacSnapshot(bare)).not.toThrow();
    expect(formatMacSnapshot(bare)).toContain('Actionable elements');
  });

  it('wraps the banner instead of going ragged on a long dialog title', () => {
    // The banner's width depends on the dialog's OWN title, so it cannot be
    // hard-wrapped at authoring time.
    const long = 'Save changes to “Q3 revenue model (final) (revised) (really final)”?';
    const text = formatMacSnapshot(withSheet({ dialog: { title: long, role: 'AXSheet' } }));
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.includes('A DIALOG IS OPEN'));
    const banner = lines.slice(start, lines.indexOf('', start));
    expect(banner.length).toBeGreaterThan(1); // it really did wrap
    for (const line of banner) expect(line.length).toBeLessThanOrEqual(80);
    // Wrapped across lines, but every word of the title survives.
    for (const word of long.split(' ')) expect(banner.join('\n')).toContain(word);
  });

  it('tells a visual-only app to click the dialog’s rect, not to act on controls', () => {
    // Promising "act on ITS controls" to an app with no indices is the dead end
    // this whole round is about.
    const text = formatMacSnapshot(
      withSheet({
        elements: [],
        summary: { app: 'TextEdit', window: 'Untitled', elementCount: 0, truncated: false },
      }),
    );
    expect(text).toContain('A DIALOG IS OPEN');
    expect(text).not.toContain('Act on ITS controls');
    expect(text).toContain('click inside those');
  });
});

describe('the indices a dialog blocks', () => {
  it('names every index in a window other than the dialog’s', () => {
    expect(blockedIndexes(withSheet(), dialogOf(withSheet()))).toEqual([1]);
  });

  it('names none when there is no dialog, no id, or no attribution', () => {
    const noDialog = withSheet({ dialog: null, windows: [DOC_WINDOW] });
    expect(blockedIndexes(noDialog, dialogOf(noDialog))).toEqual([]);
    // An older helper attributes nothing, so nothing can be called blocked.
    const noWin = withSheet({
      elements: [{ index: 1, role: 'AXTextArea', name: 'text' }] as MacSnapshot['elements'],
    });
    expect(blockedIndexes(noWin, dialogOf(noWin))).toEqual([]);
  });
});

describe('the rect a coordinate is read against', () => {
  /*
   * A composite capture covers the window AND its sheets. Handing back the
   * parent window's frame would make every point read off that image land
   * inside the window — the exact "corrected toward the parent" failure that
   * puts a click through an open save panel.
   */
  it('prefers what the image actually covers over the parent window frame', () => {
    const composite = withSheet({
      windowBounds: DOC_WINDOW.frame,
      union: { x: 100, y: 60, w: 900, h: 720 },
      screenshot: { path: '/tmp/c.png', base64: 'AAAA', rect: { x: 90, y: 50, w: 940, h: 760 } },
    });
    expect(snapshotRect(composite)).toEqual({ x: 90, y: 50, w: 940, h: 760 });
    expect(snapshotRect({ ...composite, screenshot: undefined } as MacSnapshot)).toEqual({
      x: 100,
      y: 60,
      w: 900,
      h: 720,
    });
    // Older helper: no union, no rect — the single window's bounds, as before.
    expect(
      snapshotRect({ ...composite, screenshot: undefined, union: undefined } as MacSnapshot),
    ).toEqual(DOC_WINDOW.frame);
  });

  it('gives a visual-only app the dialog’s own rect as well as the image’s', () => {
    const text = formatMacSnapshot(
      withSheet({
        elements: [],
        summary: { app: 'TextEdit', window: 'Untitled', elementCount: 0, truncated: false },
        union: { x: 100, y: 60, w: 900, h: 720 },
      }),
    );
    expect(text).toContain('A DIALOG IS OPEN');
    expect(text).toContain('Image bounds (screen points): x=100 y=60 w=900 h=720');
    expect(text).toContain('Dialog bounds (screen points): x=300 y=180 w=560 h=320');
  });
});
