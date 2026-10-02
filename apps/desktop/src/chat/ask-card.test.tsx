// @vitest-environment jsdom
/**
 * EVERY QUESTION TO THE PERSON, AS A CARD ABOVE THE COMPOSER (the user, 2026-10-01):
 * "let's put this sort of permission popup just as a little card same width as
 * the input bar floating directly above it (not on top of), and make the 'ask
 * user' question modals and any user inputs from the model or for the chat
 * just appear there". No backdrop, no modal; the three answers; Escape is Don't.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers: Array<[string, unknown]> = [];
vi.mock('../state/pi-connect', () => ({
  respondUi: async (id: string, answer: unknown) => {
    answers.push([id, answer]);
  },
}));

const { usePiStore } = await import('../state/pi-slice');
const { AskCard } = await import('./AskCard');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function mount(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(<AskCard />);
  });
  return container;
}

beforeEach(() => {
  answers.length = 0;
  usePiStore.setState({
    session: { sessionFile: '/s/chat.jsonl' } as never,
    uiRequests: [
      {
        id: 'r1',
        method: 'permission',
        permission: {
          toolName: 'bash',
          reason: 'reviewer mode: flagged by model: lists a private system path',
          args: { command: 'ls -la /tmp' },
        },
        sessionFile: '/s/chat.jsonl',
      } as never,
    ],
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the ask card', () => {
  it('is a card in the composer slot — no backdrop, no modal', async () => {
    const root = await mount();
    const card = root.querySelector('[data-testid="permission-dialog"]');
    expect(card).not.toBeNull();
    expect(card?.closest('[data-testid="ask-slot"]')).not.toBeNull();
    expect(card?.getAttribute('aria-modal')).toBe('false');
    expect(document.querySelector('.pd-dialog-overlay')).toBeNull();
    expect(card?.textContent).toContain('Run this command?');
    expect(root.querySelector('[data-testid="permission-preview"]')?.textContent).toBe(
      'ls -la /tmp',
    );
  });

  it('answers once, for this chat, or not at all — and Escape is "Don\'t"', async () => {
    const root = await mount();
    await act(async () => {
      (root.querySelector('[data-testid="permission-once"]') as HTMLButtonElement).click();
    });
    expect(answers).toEqual([['r1', { value: 'once' }]]);
    const card = root.querySelector('[data-testid="permission-dialog"]') as HTMLElement;
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(answers.at(-1)).toEqual(['r1', { value: 'deny' }]);
  });

  it('a chat in the background asks through its banner, not here', async () => {
    usePiStore.setState({
      uiRequests: [
        {
          id: 'r2',
          method: 'confirm',
          title: 'Let Bobble use Maps?',
          sessionFile: '/s/other.jsonl',
        } as never,
      ],
    });
    const root = await mount();
    expect(root.querySelector('[data-testid="ask-slot"]')).toBeNull();
  });

  it('a yes/no ask is a card too', async () => {
    usePiStore.setState({
      uiRequests: [
        {
          id: 'r3',
          method: 'confirm',
          title: 'Let Bobble use Maps?',
          sessionFile: '/s/chat.jsonl',
        } as never,
      ],
    });
    const root = await mount();
    const card = root.querySelector('[data-testid="confirm-card"]');
    expect(card?.textContent).toContain('Let Bobble use Maps?');
    const confirm = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Confirm');
    await act(async () => {
      confirm?.click();
    });
    expect(answers).toEqual([['r3', { confirmed: true }]]);
  });
});
