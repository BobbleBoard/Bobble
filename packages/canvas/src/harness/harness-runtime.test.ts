import { describe, expect, it } from 'vitest';
import { startHarness } from './harness-runtime.ts';
import type { FrameToHostMessage, HostToFrameMessage } from './protocol.ts';

/** A fake window whose `parent` is distinct, so source-validation is exercised. */
function fakeWindow(root: HTMLElement) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const posted: FrameToHostMessage[] = [];
  const parent = {
    postMessage: (message: FrameToHostMessage) => {
      posted.push(message);
    },
  };
  const win = {
    parent,
    document: root.ownerDocument,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id?: number) => clearTimeout(id),
    getComputedStyle: (el: Element) => window.getComputedStyle(el),
    scrollY: 0,
    addEventListener: (type: string, cb: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.push(cb);
    },
    removeEventListener: (type: string, cb: (event: MessageEvent) => void) => {
      if (type === 'message') {
        const i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      }
    },
  };
  const deliver = (data: HostToFrameMessage | unknown, source: unknown = parent): void => {
    for (const cb of listeners.slice()) {
      cb({ data, source } as unknown as MessageEvent);
    }
  };
  return { win: win as unknown as Window, posted, deliver, listenerCount: () => listeners.length };
}

describe('startHarness', () => {
  it('announces ready and applies a patch from the parent', () => {
    const root = document.createElement('div');
    const { win, posted, deliver } = fakeWindow(root);
    startHarness(win, { root });

    expect(posted.some((m) => m.type === 'ready')).toBe(true);

    deliver({ channel: 'pd-canvas', type: 'patch', seq: 7, html: '<p id="x">hi</p>' });
    expect(root.querySelector('#x')?.textContent).toBe('hi');
    expect(posted.some((m) => m.type === 'applied' && m.seq === 7)).toBe(true);
  });

  it('ignores messages that are not from the parent window', () => {
    const root = document.createElement('div');
    const { win, deliver } = fakeWindow(root);
    startHarness(win, { root });

    deliver(
      { channel: 'pd-canvas', type: 'patch', seq: 1, html: '<p>nope</p>' },
      { notParent: true },
    );
    expect(root.querySelector('p')).toBeNull();
  });

  it('replies to a ping with ready', () => {
    const root = document.createElement('div');
    const { win, posted, deliver } = fakeWindow(root);
    startHarness(win, { root });
    posted.length = 0;
    deliver({ channel: 'pd-canvas', type: 'ping' });
    expect(posted.some((m) => m.type === 'ready')).toBe(true);
  });

  it('dispose() removes the message listener', () => {
    const root = document.createElement('div');
    const state = fakeWindow(root);
    const dispose = startHarness(state.win, { root });
    expect(state.listenerCount()).toBe(1);
    dispose();
    expect(state.listenerCount()).toBe(0);
  });

  describe('a page whose scripts have run', () => {
    const PAGE = '<h1>Circle</h1><div id="fig"></div><script>draw()</script>';
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const harness = () => {
      const root = document.createElement('div');
      const state = fakeWindow(root);
      let restarts = 0;
      startHarness(state.win, {
        root,
        settleMs: 20,
        restart: () => {
          restarts += 1;
        },
      });
      const patch = (seq: number, html: string) =>
        state.deliver({ channel: 'pd-canvas', type: 'patch', seq, html });
      // What the page's script did: drew into its figure and moved on a step.
      const draw = () => {
        const fig = root.querySelector('#fig');
        fig?.append(document.createElement('svg'));
        fig?.classList.add('is-on');
      };
      const reset = () => state.deliver({ channel: 'pd-canvas', type: 'reset' });
      return { root, patch, reset, draw, restarts: () => restarts, posted: state.posted };
    };

    it('the same snapshot again changes nothing: what the page drew stays', async () => {
      const h = harness();
      h.patch(1, PAGE);
      h.draw();
      h.patch(2, `${PAGE}\n`);
      await wait(60);
      expect(h.root.querySelector('#fig svg')).not.toBeNull();
      expect(h.root.querySelector('#fig')?.classList.contains('is-on')).toBe(true);
      expect(h.restarts()).toBe(0);
      expect(h.posted.some((m) => m.type === 'applied' && m.seq === 2)).toBe(true);
    });

    it('a changed snapshot over what its script drew starts the frame over, once the patches settle', async () => {
      const h = harness();
      h.patch(1, PAGE);
      h.draw();
      h.patch(2, PAGE.replace('Circle', 'Circle area'));
      h.patch(3, PAGE.replace('Circle', 'The circle area'));
      expect(h.restarts()).toBe(0);
      // The markup still follows the stream meanwhile.
      expect(h.root.querySelector('h1')?.textContent).toBe('The circle area');
      await wait(60);
      expect(h.restarts()).toBe(1);
    });

    it('a page whose script left its markup alone is patched in place, never restarted', async () => {
      const h = harness();
      h.patch(1, PAGE);
      h.patch(2, PAGE.replace('Circle', 'Circle area'));
      await wait(60);
      expect(h.root.querySelector('h1')?.textContent).toBe('Circle area');
      expect(h.restarts()).toBe(0);
    });

    it('a script that changed after it ran — a write still streaming — starts the frame over', async () => {
      const h = harness();
      h.patch(1, '<p>x</p><script>const a = 1;');
      h.patch(2, '<p>x</p><script>const a = 1; draw(a);</script>');
      await wait(60);
      expect(h.restarts()).toBe(1);
    });

    it('a page with no scripts is never restarted, whatever changed in it', async () => {
      const h = harness();
      h.patch(1, '<h1>Plain</h1><div id="fig"></div>');
      h.draw();
      h.patch(2, '<h1>Plain, edited</h1><div id="fig"></div>');
      await wait(60);
      expect(h.restarts()).toBe(0);
      expect(h.root.querySelector('#fig svg')).toBeNull();
    });

    it('a reset after scripts ran starts over at once; before any ran it only empties', () => {
      const h = harness();
      h.patch(1, '<p>no scripts</p>');
      h.reset();
      expect(h.restarts()).toBe(0);
      expect(h.root.childNodes.length).toBe(0);
      h.patch(2, PAGE);
      h.reset();
      expect(h.restarts()).toBe(1);
    });
  });
});
