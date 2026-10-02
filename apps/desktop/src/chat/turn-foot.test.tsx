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
