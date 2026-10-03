// @vitest-environment jsdom
/**
 * THE CARDS AT THE FOOT OF THE REPLY (the user, 2026-10-01): "inline card should be
 * at the bottom also!" — on a student's circle-area reply whose page card stood
 * ABOVE the words that explained it. A reply whose first message wrote a line
 * and presented a page, and whose second message wrote the explanation, must
 * show the explanation first and the card after it.
 */
import { CanvasProvider } from '@pi-desktop/canvas';
import type { AssistantMsg, ContentBlock, ToolResultMsg } from '@pi-desktop/engine';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PresentedRecord } from '../state/present-store';
import { AssistantGroup } from './AssistantGroup';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const call = (id: string, name: string, args: Record<string, unknown>): ContentBlock =>
  ({ type: 'toolCall', id, name, arguments: args }) as ContentBlock;
const assistant = (id: string, blocks: ContentBlock[]): AssistantMsg => ({
  kind: 'assistant',
  id,
  blocks,
  isStreaming: false,
  timestamp: 0,
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a reply’s presented card stands after its words', () => {
  it('the explanation written after the present call comes first, the card last', async () => {
    const group = [
      assistant('m1', [
        text('Here is a page for it.'),
        call('c1', 'present', { path: 'circle.html' }),
      ]),
      assistant('m2', [text('The page cuts the circle into slices.')]),
    ];
    const done: ToolResultMsg = {
      kind: 'toolResult',
      id: 'c1',
      toolCallId: 'c1',
      toolName: 'present',
      text: 'Presented circle.html to the user.',
      isError: false,
      timestamp: 0,
    };
    const record: PresentedRecord = {
      path: '/w/circle.html',
      kind: 'page',
      at: 1,
      afterMessageId: null,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CanvasProvider>
          <AssistantGroup
            group={group}
            resultByCallId={new Map([['c1', done]])}
            runningToolCalls={[]}
            tps={undefined}
            recordsByCall={new Map([['c1', [record]]])}
            renderRecord={(r) => <div data-testid="the-card">{r.path}</div>}
          />
        </CanvasProvider>,
      );
    });
    const card = container.querySelector('[data-testid="the-card"]');
    const words = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('cuts the circle into slices'),
    );
    expect(card).not.toBeNull();
    expect(words).toBeDefined();
    // DOCUMENT_POSITION_FOLLOWING (4): the card comes after the explanation.
    expect((words as Node).compareDocumentPosition(card as Node) & 4).toBe(4);
    expect(card?.closest('[data-testid="turn-foot"]')).not.toBeNull();
  });
});

describe('a picture the turn made and never presented is in the chat', () => {
  /* The visual-learner student (2026-10-01, Gemma 4 12B, bash-CLI): the picture
     was made through bash, never presented, and the reply was about it. It sat
     in the chain row, and the chain folds once the reply begins — "theres no
     picture in the chat". */
  const PIC = '/w/generated/slices/cand0_seed259687452.png';
  const made = call('c1', 'bash', { command: 'media generate image "a circle cut into slices"' });
  const result: ToolResultMsg = {
    kind: 'toolResult',
    id: 'c1',
    toolCallId: 'c1',
    toolName: 'bash',
    text: `Generated 1 image on the canvas:\n  1. ${PIC} (seed 259687452)\nModel: Qwen-Image 2.1`,
    isError: false,
    timestamp: 0,
  };
  const draw = async (group: AssistantMsg[], live: boolean) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CanvasProvider>
          <AssistantGroup
            group={group}
            resultByCallId={new Map([['c1', result]])}
            runningToolCalls={[]}
            tps={undefined}
            live={live}
          />
        </CanvasProvider>,
      );
    });
    return container;
  };

  it('while its chain works it is in the row that made it', async () => {
    const container = await draw([assistant('m1', [made])], true);
    const card = container.querySelector('[data-testid="media-card"]');
    expect(card).not.toBeNull();
    expect(card?.closest('.pd-chain')).not.toBeNull();
    expect(card?.closest('[data-testid="turn-foot"]')).toBeNull();
  });

  it('once the reply is written it stands at the foot, after the words — not in the folded chain', async () => {
    const container = await draw(
      [assistant('m1', [made]), assistant('m2', [text('Here are the thin slices.')])],
      false,
    );
    const cards = container.querySelectorAll('[data-testid="media-card"]');
    expect(cards).toHaveLength(1);
    const card = cards[0] as Element;
    expect(card.closest('.pd-chain')).toBeNull();
    expect(card.closest('[data-testid="turn-foot"]')).not.toBeNull();
    const words = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('Here are the thin slices'),
    );
    expect((words as Node).compareDocumentPosition(card) & 4).toBe(4);
    expect(card.getAttribute('data-kind')).toBe('image');
  });
});
