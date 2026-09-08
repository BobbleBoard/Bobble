/**
 * The edit motion ON THE SURFACE — what {@link edit-animation.test.ts} proves
 * about the schedule, proved again through the component that plays it: the
 * file is shown (never a diff), the replaced text really leaves the buffer
 * before the replacement arrives, and every reason not to move lands on the
 * finished file instead.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactContent } from '../model.ts';
import { render } from '../test-utils.tsx';
import { planEditAnimation } from './edit-animation.ts';
import { FileSurface } from './file-surface.tsx';
import type { EditAnimationSpec } from './use-edit-animation.ts';

const BASE = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;', ''].join('\n');
const OLD = 'export const b = 2;';
const NEW = 'export const beautiful = 22;';
const FINAL = BASE.replace(OLD, NEW);

function code(body: string): ArtifactContent {
  return { kind: 'code', text: body, language: 'typescript' };
}

/** jsdom does no layout — give every box a real one so the "is this even on
 * screen?" guard sees a laid-out surface rather than a collapsed panel. */
function stubLayout(height = 600): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: 800,
    bottom: height,
    width: 800,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * jsdom has no `Range.getClientRects`, which CodeMirror's text measurement calls
 * from its own animation frame. Harmless here (nothing under test depends on
 * glyph widths) but it throws, so give it an empty answer.
 */
function stubRangeRects(): void {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = () => [];
  }
}

/** A hand-cranked clock + frame queue, so a frame is a step and not a race. */
function clock(startMs = 1_000_000) {
  let now = startMs;
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    now: () => now,
    /** Move time on and run whatever frames were waiting. */
    async advance(ms: number): Promise<void> {
      now += ms;
      const pending = queue;
      queue = [];
      await act(async () => {
        for (const frame of pending) {
          // CodeMirror shares this queue for its own measuring, which cannot
          // succeed without layout. Its failure is not this test's business.
          try {
            frame(now);
          } catch {
            /* jsdom has no layout */
          }
        }
      });
    },
  };
}

function spec(startedAt: number): EditAnimationSpec {
  const plan = planEditAnimation(BASE, [{ oldText: OLD, newText: NEW }]);
  if (plan === null) throw new Error('expected a plan');
  return { id: 'call_edit_1', plan, startedAt };
}

/** The code buffer's text, with CodeMirror's line wrappers flattened out. */
function buffer(container: HTMLElement): string {
  const lines = [...container.querySelectorAll('.cm-line')].map((l) => l.textContent ?? '');
  return lines.join('\n');
}

beforeEach(() => {
  stubRangeRects();
  stubLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileSurface — an edit plays as an edit', () => {
  it('shows the FILE, not a diff, when an edit arrives', async () => {
    const c = clock();
    const { container } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" streaming editAnim={spec(c.now())} />,
    );
    expect(container.querySelector('.pd-canvas-diff')).toBeNull();
    expect(container.querySelector('.cm-editor')).toBeTruthy();
    expect(buffer(container)).toBe(BASE);
  });

  it('forward-deletes the replaced text, then types the replacement in its place', async () => {
    const c = clock();
    const s = spec(c.now());
    const { container } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" streaming editAnim={s} />,
    );
    const editor = container.querySelector('.cm-editor');
    const hunk = s.plan.hunks[0];
    if (hunk === undefined) throw new Error('expected a hunk');

    // Settling: the file, untouched.
    await c.advance(s.plan.settleMs / 2);
    expect(buffer(container)).toBe(BASE);
    expect(container.querySelector('.pd-file')?.getAttribute('data-edit-phase')).toBe('settle');

    // Mid-delete: shorter than the file, the replaced line partly gone, and the
    // replacement nowhere in sight yet.
    await c.advance(s.plan.settleMs / 2 + hunk.deleteMs / 2);
    const midDelete = buffer(container);
    expect(container.querySelector('.pd-file')?.getAttribute('data-edit-phase')).toBe('delete');
    expect(midDelete.length).toBeLessThan(BASE.length);
    expect(midDelete).toContain('export const a = 1;');
    expect(midDelete).toContain('export const c = 3;');
    expect(midDelete).not.toContain(OLD);
    expect(midDelete).not.toContain('beautiful');

    // Mid-type: growing again, the replacement partly present.
    await c.advance(hunk.deleteMs / 2 + hunk.typeMs / 2);
    const midType = buffer(container);
    expect(container.querySelector('.pd-file')?.getAttribute('data-edit-phase')).toBe('type');
    expect(midType.length).toBeGreaterThan(midDelete.length);
    expect(midType).not.toBe(FINAL);
    // It is typing IN PLACE — on the replaced line, between its untouched
    // neighbours — and it is a prefix of the replacement, not the whole thing.
    const [before, typing, after] = midType.split('\n');
    expect(before).toBe('export const a = 1;');
    expect(after).toBe('export const c = 3;');
    expect(typing === undefined ? '' : NEW.startsWith(typing)).toBe(true);
    expect(typing).not.toBe('');
    expect(typing).not.toBe(NEW);

    // Landed, in the same editor it started in — one continuous motion, no
    // remount, no flash of a diff.
    await c.advance(hunk.typeMs);
    expect(buffer(container)).toBe(FINAL);
    expect(container.querySelector('.cm-editor')).toBe(editor);
    expect(container.querySelector('.pd-canvas-diff')).toBeNull();
  });

  it('holds the animated text when the tool result lands mid-motion', async () => {
    const c = clock();
    const s = spec(c.now());
    const { container, rerender } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" streaming editAnim={s} />,
    );
    const hunk = s.plan.hunks[0];
    if (hunk === undefined) throw new Error('expected a hunk');
    await c.advance(s.plan.settleMs + hunk.deleteMs / 2);
    const midDelete = buffer(container);

    // The edit completes on disk while the delete is still playing: the tab's
    // content becomes the FINAL file. The motion must not jump-cut to it.
    await rerender(<FileSurface content={code(FINAL)} filename="x.ts" editAnim={s} />);
    expect(buffer(container)).toBe(midDelete);

    await c.advance(hunk.deleteMs + hunk.typeMs);
    expect(buffer(container)).toBe(FINAL);
  });

  it('goes straight to the final state under prefers-reduced-motion', async () => {
    const c = clock();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" streaming editAnim={spec(c.now())} />,
    );
    expect(buffer(container)).toBe(FINAL);
    expect(container.querySelector('.pd-file')?.getAttribute('data-edit-phase')).toBe('done');
  });

  it('settles instead of animating into a void (a collapsed / unlaid-out surface)', async () => {
    vi.restoreAllMocks();
    stubLayout(0);
    const c = clock();
    const { container } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" streaming editAnim={spec(c.now())} />,
    );
    expect(buffer(container)).toBe(FINAL);
  });

  it('settles when the motion already ran while the tab was elsewhere', async () => {
    const c = clock();
    const s = spec(c.now() - 60_000);
    const { container } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" editAnim={s} />,
    );
    expect(buffer(container)).toBe(FINAL);
  });

  it('does not stick to the bottom while an edit plays', async () => {
    const c = clock();
    const s = spec(c.now());
    const { container } = await render(
      <FileSurface content={code(BASE)} filename="x.ts" streaming editAnim={s} />,
    );
    const scroller = container.querySelector<HTMLElement>('.cm-scroller');
    if (scroller === null) throw new Error('missing scroller');
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 });
    await c.advance(s.plan.settleMs + (s.plan.hunks[0]?.deleteMs ?? 0) / 2);
    // The stick-to-bottom pin would have parked this at 5000; the edit site is
    // where the eye belongs, not the end of the file.
    expect(top).not.toBe(5000);
  });

  it('still falls back to the diff when there is no motion to play', async () => {
    const { container } = await render(
      <FileSurface
        content={code(BASE)}
        filename="x.ts"
        streaming
        diff={[
          {
            path: 'x.ts',
            lines: [
              { kind: 'del', text: OLD },
              { kind: 'add', text: NEW },
            ],
          },
        ]}
      />,
    );
    expect(container.querySelector('.pd-canvas-diff')).toBeTruthy();
  });
});
