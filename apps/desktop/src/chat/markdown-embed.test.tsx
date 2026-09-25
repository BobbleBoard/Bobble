// @vitest-environment jsdom
/**
 * A PICTURE THE TURN PRESENTED IS NOT DRAWN AGAIN IN ITS REPLY.
 *
 * The model presents what it makes (its card, beneath the chain) and also
 * writes it into the reply as `![…](path)` — the same picture twice, one above
 * the other (STATUS, from the thread track; reply-embed-look.mjs in the app).
 * The reply leaves out its copy of any file the turn shows as a card, by
 * whichever name it uses — absolute, relative to the chat's folder, or the
 * app's own URL — and keeps every other picture.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePiStore } from '../state/pi-slice';
import { Markdown, TurnCardsContext } from './markdown';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DIR = '/Users/j/Bobble/evening-fox';
const FOX = `${DIR}/fox.png`;

async function render(text: string, shown: readonly string[]): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TurnCardsContext.Provider value={new Set(shown)}>
        <Markdown text={text} />
      </TurnCardsContext.Provider>,
    );
  });
  return container;
}
const pictures = (el: HTMLElement): number => el.querySelectorAll('img.pd-md-image').length;

beforeEach(() => {
  usePiStore.setState({ session: { cwd: DIR } } as never);
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('the reply’s copy of a picture the turn shows as a card', () => {
  it('is left out, by its absolute path', async () => {
    const el = await render(`Here it is:\n\n![A fox](${FOX})\n\nWarm light.`, [FOX]);
    expect(pictures(el)).toBe(0);
    expect(el.textContent).toContain('Here it is:');
    expect(el.textContent).toContain('Warm light.');
  });

  it('…relative to the chat’s folder', async () => {
    expect(pictures(await render('![A fox](fox.png)', [FOX]))).toBe(0);
    expect(pictures(await render('![A fox](./fox.png)', [FOX]))).toBe(0);
  });

  it('…and by the app’s own URL', async () => {
    expect(pictures(await render(`![A fox](pd-file://f${FOX})`, [FOX]))).toBe(0);
  });

  it('a picture the turn did not show as a card stays', async () => {
    expect(pictures(await render(`![An owl](${DIR}/owl.png)`, [FOX]))).toBe(1);
    expect(pictures(await render(`![A fox](${FOX})`, []))).toBe(1);
  });
});
