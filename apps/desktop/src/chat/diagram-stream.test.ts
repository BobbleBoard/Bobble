import { describe, expect, it } from 'vitest';
import {
  FRAME_GAP_MS,
  liveSource,
  nextRender,
  pendingDiagramArgs,
  shellWords,
} from './diagram-stream';

const FLOW = 'flowchart TD\n  A([Order placed]) --> B{Payment ok?}\n  B -- yes --> C[Pick & pack]';

describe('pendingDiagramArgs — a diagram call, either way it is written', () => {
  it('reads the tool’s own arguments as they stream, the title only once it is whole', () => {
    const text = JSON.stringify({ title: 'Order fulfilment', source: FLOW });
    const cut = text.slice(0, text.indexOf('Pick'));
    expect(pendingDiagramArgs({ name: 'diagram', argsText: cut })).toEqual({
      title: 'Order fulfilment',
      source: FLOW.slice(0, FLOW.indexOf('Pick')),
      sourceClosed: false,
    });
    // Mid-title: no title yet, and no source — nothing to draw, but a diagram.
    expect(pendingDiagramArgs({ name: 'diagram', argsText: '{"title": "Order ful' })).toEqual({
      sourceClosed: false,
    });
    // Parsed: whole.
    expect(
      pendingDiagramArgs({
        name: 'diagram',
        arguments: { title: 'T', source: FLOW, kit: 'fog', look: 'sketch' },
      }),
    ).toEqual({ title: 'T', source: FLOW, sourceClosed: true, kit: 'fog', look: 'sketch' });
  });

  it('reads Mermaid given in the title’s place as the source (the tool does)', () => {
    expect(pendingDiagramArgs({ name: 'diagram', arguments: { title: FLOW } })).toEqual({
      source: FLOW,
      sourceClosed: true,
    });
  });

  it('reads the command line through bash, quote still open while it streams', () => {
    const command = `diagram "Order fulfilment" --subtitle "Checkout" --source '${FLOW}'`;
    const whole = JSON.stringify({ command });
    const streaming = whole.slice(0, whole.indexOf('Pick'));
    expect(pendingDiagramArgs({ name: 'bash', argsText: streaming })).toEqual({
      title: 'Order fulfilment',
      subtitle: 'Checkout',
      source: FLOW.slice(0, FLOW.indexOf('Pick')),
      sourceClosed: false,
    });
    expect(pendingDiagramArgs({ name: 'bash', arguments: { command } })).toMatchObject({
      source: FLOW,
      sourceClosed: true,
    });
  });

  it('takes the source by any flag the command reads it from, = or space, and a positional', () => {
    expect(
      pendingDiagramArgs({ name: 'bash', arguments: { command: `diagram --mermaid="${FLOW}"` } }),
    ).toMatchObject({ source: FLOW, sourceClosed: true });
    expect(
      pendingDiagramArgs({ name: 'bash', arguments: { command: `diagram "T" '${FLOW}'` } }),
    ).toMatchObject({ title: 'T', source: FLOW });
  });

  it('reads a heredoc source up to its marker', () => {
    const command = `diagram "T" --source "$(cat <<'EOF'\n${FLOW}\nEOF\n)"`;
    expect(pendingDiagramArgs({ name: 'bash', arguments: { command } })).toMatchObject({
      source: FLOW,
      sourceClosed: true,
    });
    const open = `diagram "T" --source "$(cat <<'EOF'\nflowchart TD\n  A --> B\n`;
    expect(
      pendingDiagramArgs({
        name: 'bash',
        argsText: JSON.stringify({ command: open }).slice(0, -2),
      }),
    ).toMatchObject({
      source: 'flowchart TD\n  A --> B\n',
      sourceClosed: false,
    });
  });

  it('is not a diagram: another tool, another command, an edit', () => {
    expect(pendingDiagramArgs({ name: 'chart', arguments: { type: 'bar' } })).toBeNull();
    expect(pendingDiagramArgs({ name: 'bash', arguments: { command: 'ls diagrams' } })).toBeNull();
    expect(
      pendingDiagramArgs({
        name: 'bash',
        arguments: { command: 'diagram edit flow.svg --title X' },
      }),
    ).toBeNull();
    expect(pendingDiagramArgs({ name: 'diagram', argsText: '{"out": "x.svg"' })).toBeNull();
  });
});

describe('shellWords — a command line that may still be arriving', () => {
  it("reads quotes, escapes and $'…', and marks the word still open", () => {
    expect(shellWords(`a "b \\"c\\"" 'd e' $'f\\ng' h`)).toEqual([
      { value: 'a', closed: true },
      { value: 'b "c"', closed: true },
      { value: 'd e', closed: true },
      { value: 'f\ng', closed: true },
      { value: 'h', closed: false },
    ]);
    expect(shellWords(`diagram --source 'flowchart TD`)).toEqual([
      { value: 'diagram', closed: true },
      { value: '--source', closed: true },
      { value: 'flowchart TD', closed: false },
    ]);
  });

  it('stops at the end of the command', () => {
    expect(shellWords('diagram "T" && echo done').map((w) => w.value)).toEqual(['diagram', 'T']);
  });
});

describe('liveSource — the part Mermaid can read', () => {
  it('draws whole lines only, until the source has closed', () => {
    expect(liveSource('flowchart TD\n  A --> B\n  B --> C', false)).toBe('flowchart TD\n  A --> B');
    expect(liveSource('flowchart TD\n  A --> B\n  B --> C', true)).toBe(
      'flowchart TD\n  A --> B\n  B --> C',
    );
    // The type line alone: a frame with the title and nothing else yet.
    expect(liveSource('flowchart TD\n  A --', false)).toBe('flowchart TD');
    expect(liveSource('flowch', false)).toBeNull();
  });

  it('is nothing for a path or text that is not Mermaid', () => {
    expect(liveSource('flow.mmd', true)).toBeNull();
    expect(liveSource('Here is my diagram:\n', false)).toBeNull();
    expect(liveSource(undefined, false)).toBeNull();
  });

  it('reads \\n typed on one line, and takes a ``` fence off', () => {
    expect(liveSource('flowchart LR\\n  A --> B\\n  B --', false)).toBe('flowchart LR\n  A --> B');
    expect(liveSource('```mermaid\nflowchart TD\n  A --> B\n```', true)).toBe(
      'flowchart TD\n  A --> B',
    );
  });

  it('closes what is still open, innermost first, so a group builds as it is typed', () => {
    expect(liveSource('flowchart TD\n  subgraph W\n    A --> B\n    B --', false)).toBe(
      'flowchart TD\n  subgraph W\n    A --> B\nend',
    );
    expect(
      liveSource(
        'sequenceDiagram\n  alt ok\n    A->>B: hi\n    loop again\n      B->>A: x\n',
        false,
      ),
    ).toBe('sequenceDiagram\n  alt ok\n    A->>B: hi\n    loop again\n      B->>A: x\nend\nend');
    expect(liveSource('classDiagram\n  class Order {\n    +String id\n', false)).toBe(
      'classDiagram\n  class Order {\n    +String id\n}',
    );
    expect(liveSource('erDiagram\n  CUSTOMER {\n    string name\n  }\n  ORDER {\n', false)).toBe(
      'erDiagram\n  CUSTOMER {\n    string name\n  }\n  ORDER {\n}',
    );
    // A group with nothing in it yet is left out, not drawn as a step of its name.
    expect(liveSource('flowchart TD\n  A --> B\n  subgraph Warehouse\n    C', false)).toBe(
      'flowchart TD\n  A --> B',
    );
    expect(liveSource('flowchart TD\n  A --> B\n  subgraph W\n    subgraph X\n', false)).toBe(
      'flowchart TD\n  A --> B',
    );
    expect(liveSource('sequenceDiagram\n  A->>B: hi\n  loop every day\n', false)).toBe(
      'sequenceDiagram\n  A->>B: hi',
    );
    // …but a class with no members yet is its name.
    expect(liveSource('classDiagram\n  class Order {\n', false)).toBe(
      'classDiagram\n  class Order {\n}',
    );
    // A closed group stays closed; an `else` opens nothing.
    expect(
      liveSource(
        'sequenceDiagram\n  alt ok\n    A->>B: hi\n  else no\n    B->>A: bye\n  end\n',
        false,
      ),
    ).toBe('sequenceDiagram\n  alt ok\n    A->>B: hi\n  else no\n    B->>A: bye\n  end');
  });
});

describe('nextRender — when to ask for the next frame', () => {
  const idle = { lastKey: null, lastAt: 0, inFlight: false };
  it('asks for the first frame at once', () => {
    expect(nextRender(idle, 'a', 1000)).toEqual({ kind: 'now' });
  });

  it('never twice for the same lines, and not for nothing', () => {
    expect(nextRender({ ...idle, lastKey: 'a', lastAt: 0 }, 'a', 5000)).toEqual({ kind: 'skip' });
    expect(nextRender(idle, null, 5000)).toEqual({ kind: 'skip' });
  });

  it('keeps to one frame per gap, and waits out the rest of it', () => {
    const drawn = { lastKey: 'a', lastAt: 1000, inFlight: false };
    expect(nextRender(drawn, 'b', 1000 + FRAME_GAP_MS)).toEqual({ kind: 'now' });
    expect(nextRender(drawn, 'b', 1050)).toEqual({ kind: 'later', waitMs: FRAME_GAP_MS - 50 });
  });

  it('waits while one is being drawn — its reply asks again', () => {
    expect(nextRender({ lastKey: 'a', lastAt: 0, inFlight: true }, 'b', 9000)).toEqual({
      kind: 'later',
      waitMs: FRAME_GAP_MS,
    });
  });
});
