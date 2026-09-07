// @vitest-environment jsdom
/**
 * The palette closes on Escape wherever the focus is.
 *
 * It used to listen on its input, so it closed only while the caret was in the
 * field — and opening it over Settings hands focus to the field one tick after
 * paint, which a dialog underneath can take straight back. The probe that
 * caught this passed alone and failed inside the suite, because the probes
 * share a HOME and whether Settings was left focus-trapping depended on a run
 * forty probes earlier. A test that presses Escape at the document, with focus
 * nowhere near the field, is the one that would have caught it every time.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const pressEscape = (target: EventTarget) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

describe('the command palette owns Escape', () => {
  it('closes when Escape arrives with focus on the body', () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} actions={[]} />);
    document.body.focus();
    pressEscape(document.body);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes when Escape arrives from an element outside it entirely', () => {
    const onOpenChange = vi.fn();
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    render(<CommandPalette open onOpenChange={onOpenChange} actions={[]} />);
    elsewhere.focus();
    pressEscape(elsewhere);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    elsewhere.remove();
  });

  it('does nothing when it is closed', () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open={false} onOpenChange={onOpenChange} actions={[]} />);
    pressEscape(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves Escape to whatever opened above it', () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} actions={[]} />);
    // Something later in the document declares itself an escape layer too.
    const above = document.createElement('div');
    above.setAttribute('data-escape-layer', '');
    document.body.append(above);
    pressEscape(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    above.remove();
  });
});
