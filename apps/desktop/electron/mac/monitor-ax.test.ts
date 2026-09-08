/**
 * Turning a helper reply into a scene the monitor can draw.
 *
 * The fixtures here are trimmed from a REAL `pi-mac snapshot` of TextEdit with
 * its save sheet up (measured 2026-09-07), because the two things that broke
 * when this was written against an imagined shape were both real-world quirks:
 * macOS hands out an invisible `AXUnknown` carrier window beside a sheet, and
 * element bboxes are CENTRES rather than origins.
 */
import { describe, expect, it } from 'vitest';
import {
  axElementsFrom,
  axSceneFrom,
  axWindowsFrom,
  isDrawableAxWindow,
  unionOf,
} from './monitor-ax';

const META = { t: 1000, pid: 9072, appName: 'TextEdit', display: { w: 1512, h: 982 } };

/** The real window list of a TextEdit showing a save sheet. */
const REAL_WINDOWS = [
  // The carrier macOS puts up beside a sheet — invisible, and 248×83.
  {
    role: 'AXWindow',
    subrole: 'AXUnknown',
    title: '',
    frame: { x: 746, y: 266, w: 248, h: 83 },
    windowId: 32359,
    main: false,
    focused: false,
    modal: false,
    sheet: false,
  },
  {
    role: 'AXSheet',
    subrole: '',
    title: '',
    frame: { x: 636, y: 219, w: 390, h: 218 },
    windowId: 32354,
    main: false,
    focused: true,
    modal: true,
    sheet: true,
  },
  {
    role: 'AXWindow',
    subrole: 'AXStandardWindow',
    title: 'Untitled 14',
    frame: { x: 529, y: 76, w: 603, h: 505 },
    windowId: 32330,
    main: true,
    focused: false,
    modal: false,
    sheet: false,
  },
];

describe('isDrawableAxWindow', () => {
  it('drops the invisible AXUnknown carrier a sheet brings with it', () => {
    expect(
      isDrawableAxWindow({
        role: 'AXWindow',
        subrole: 'AXUnknown',
        sheet: false,
        modal: false,
        frame: { x: 0, y: 0, w: 248, h: 83 },
      }),
    ).toBe(false);
  });

  it('keeps a sheet whatever it calls itself', () => {
    expect(
      isDrawableAxWindow({
        role: 'AXUnknown',
        subrole: 'AXUnknown',
        sheet: true,
        modal: true,
        frame: { x: 0, y: 0, w: 390, h: 218 },
      }),
    ).toBe(true);
  });

  it('drops a window too small to be one', () => {
    expect(
      isDrawableAxWindow({
        role: 'AXWindow',
        subrole: 'AXStandardWindow',
        sheet: false,
        modal: false,
        frame: { x: 0, y: 0, w: 8, h: 8 },
      }),
    ).toBe(false);
  });
});

describe('unionOf', () => {
  it('encloses every rect', () => {
    expect(
      unionOf([
        { x: 10, y: 10, w: 100, h: 100 },
        { x: 80, y: 200, w: 50, h: 50 },
      ]),
    ).toEqual({ x: 10, y: 10, w: 120, h: 240 });
  });
  it('is null with nothing in it', () => {
    expect(unionOf([])).toBeNull();
  });
});

describe('axWindowsFrom', () => {
  it('keeps the helper front-to-back order and drops chrome', () => {
    const out = axWindowsFrom(REAL_WINDOWS);
    expect(out.map((w) => w.windowId)).toEqual([32354, 32330]);
    expect(out[0]?.sheet).toBe(true);
    expect(out[1]?.title).toBe('Untitled 14');
  });

  it('survives a helper that sends nothing', () => {
    expect(axWindowsFrom(undefined)).toEqual([]);
    expect(axWindowsFrom([null, 3, { frame: {} }])).toEqual([]);
  });
});

describe('axElementsFrom', () => {
  it('copies a value only when AX returned one', () => {
    const out = axElementsFrom([
      {
        index: 10,
        role: 'AXTextField',
        name: 'Save As:',
        bbox: { x: 871, y: 251, w: 232, h: 26 },
        editable: true,
        value: 'Untitled 14',
        win: 32354,
      },
      {
        index: 11,
        role: 'AXTextField',
        name: 'tag editor',
        bbox: { x: 871, y: 288, w: 232, h: 27 },
        editable: true,
        win: 32354,
      },
    ]);
    expect(out[0]?.value).toBe('Untitled 14');
    expect(out[1]?.value).toBeUndefined();
  });

  it('leaves bboxes in the wire space and drops the shapeless', () => {
    const out = axElementsFrom([
      { index: 1, role: 'AXButton', name: 'Save', bbox: { x: 966, y: 405, w: 81, h: 26 } },
      { index: 2, role: 'AXButton', name: 'Ghost', bbox: { x: 0, y: 0, w: 0, h: 0 } },
      { index: 3, role: '', name: 'Nameless role', bbox: { x: 1, y: 1, w: 10, h: 10 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.bbox).toEqual({ x: 966, y: 405, w: 81, h: 26 });
  });

  it('marks a disabled control and leaves an enabled one unsaid', () => {
    const out = axElementsFrom([
      {
        index: 1,
        role: 'AXButton',
        name: 'Save',
        bbox: { x: 9, y: 9, w: 81, h: 26 },
        enabled: false,
      },
      {
        index: 2,
        role: 'AXButton',
        name: 'Cancel',
        bbox: { x: 9, y: 9, w: 81, h: 26 },
        enabled: true,
      },
    ]);
    expect(out[0]?.enabled).toBe(false);
    expect(out[1]?.enabled).toBeUndefined();
  });
});

describe('axSceneFrom', () => {
  it('builds the union of the DRAWABLE windows, so chrome cannot stretch the stage', () => {
    const scene = axSceneFrom({ app: 'TextEdit', pid: 9072, windows: REAL_WINDOWS }, META);
    // The dropped carrier reaches x=994; the two real surfaces span 529…1132.
    expect(scene?.rect).toEqual({ x: 529, y: 76, w: 603, h: 505 });
    expect(scene?.windows).toHaveLength(2);
  });

  it('keeps only the elements whose window is on the stage', () => {
    const scene = axSceneFrom(
      {
        windows: REAL_WINDOWS,
        elements: [
          {
            index: 1,
            role: 'AXButton',
            name: 'Save',
            bbox: { x: 966, y: 405, w: 81, h: 26 },
            win: 32354,
          },
          {
            index: 2,
            role: 'AXButton',
            name: 'Ghost',
            bbox: { x: 800, y: 300, w: 40, h: 20 },
            win: 32359,
          },
        ],
      },
      META,
    );
    expect(scene?.elements.map((e) => e.index)).toEqual([1]);
  });

  it('draws the one window an older helper reports rather than nothing', () => {
    const scene = axSceneFrom({ windowBounds: { x: 10, y: 20, w: 300, h: 200 } }, META);
    expect(scene?.windows).toHaveLength(1);
    expect(scene?.rect).toEqual({ x: 10, y: 20, w: 300, h: 200 });
  });

  it('is NULL when Accessibility found nothing — not an empty drawing', () => {
    // An empty scene would be drawn as a blank stage, which reads as "the app
    // vanished". The surface's own empty state says the true thing instead.
    expect(axSceneFrom({ windows: [] }, META)).toBeNull();
    expect(axSceneFrom({}, META)).toBeNull();
  });

  it("prefers the app name the helper resolved over the session's", () => {
    const scene = axSceneFrom({ app: 'TextEdit', windows: REAL_WINDOWS }, { ...META, appName: '' });
    expect(scene?.appName).toBe('TextEdit');
    const fallback = axSceneFrom({ windows: REAL_WINDOWS }, META);
    expect(fallback?.appName).toBe('TextEdit');
  });
});
