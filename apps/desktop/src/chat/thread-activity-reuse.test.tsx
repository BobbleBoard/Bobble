// @vitest-environment jsdom
/**
 * A SETTLED STEP KEEPS ITS DATA OBJECT ACROSS RENDERS. MEASURED (MiniCPM 5 2B, a
 * 26-minute turn of 183 steps): every streamed token re-mapped and re-rendered
 * every row — 130 ms an update, growing with the turn — until the window stopped
 * painting. The chain's rows are memoized on their data object, so a step whose
 * inputs did not move must hand ActivityChain the very same object.
 */
import { CanvasProvider } from '@pi-desktop/canvas';
import type { ToolResultMsg } from '@pi-desktop/engine';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityBlock } from './activity-mapping';

const seen: unknown[][] = [];
vi.mock('@pi-desktop/ui', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pi-desktop/ui')>();
  return {
    ...real,
    ActivityChain: (props: { steps: unknown[] }) => {
      seen.push(props.steps);
      return null;
    },
  };
});

const { ThreadActivityChain } = await import('./ThreadActivity');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const call = (id: string): ActivityBlock =>
  ({ type: 'toolCall', id, name: 'bash', arguments: { command: `echo ${id}` } }) as ActivityBlock;
const done = (id: string): ToolResultMsg => ({
  kind: 'toolResult',
  id,
  toolCallId: id,
  toolName: 'bash',
  text: `${id} ok`,
  isError: false,
  timestamp: 1,
});

afterEach(() => {
  seen.length = 0;
  document.body.innerHTML = '';
});

describe('ThreadActivityChain', () => {
  it('hands the same step objects back for steps that did not move, and a new one for the step that did', async () => {
    const blocks = Array.from({ length: 40 }, (_, i) => call(`c${i}`));
    const results = new Map(
      blocks.slice(0, 39).map((b) => [(b as { id: string }).id, done((b as { id: string }).id)]),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const draw = async (r: Map<string, ToolResultMsg>) => {
      await act(async () => {
        root.render(
          <CanvasProvider>
            <ThreadActivityChain
              blocks={blocks}
              resultForBlock={r}
              runningToolCalls={['c39']}
              streaming
              chainKey="t"
            />
          </CanvasProvider>,
        );
      });
    };
    await draw(results);
    await draw(new Map(results));
    const [first, second] = [seen.at(-2) ?? [], seen.at(-1) ?? []];
    expect(second.length).toBe(40);
    expect(second.slice(0, 39).every((s, i) => s === first[i])).toBe(true);
    // The last call's result lands: only its step is new.
    await draw(new Map([...results, ['c39', done('c39')]]));
    const third = seen.at(-1) ?? [];
    expect(third.slice(0, 39).every((s, i) => s === second[i])).toBe(true);
    expect(third[39]).not.toBe(second[39]);
  });
});
