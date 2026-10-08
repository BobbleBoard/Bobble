// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileTabKey } from '../chat/canvas/file-tabs';
import { useCanvasStore } from './canvas-store';
import {
  chartsInTranscript,
  classifyPresented,
  earlierVersion,
  extOf,
  isInlinePresented,
  openPresented,
  presentedFor,
  presentingCall,
  presentTabKey,
  rehydratePresented,
  showPresented,
  UNSAVED_CHAT,
  usePresentStore,
} from './present-store';

describe('classifyPresented', () => {
  it('opens an image as an image', () => {
    expect(classifyPresented('/a/logo.png')).toEqual({ kind: 'image', tab: 'image' });
  });

  it('renders a page rather than showing its source', () => {
    expect(classifyPresented('/a/index.html')).toEqual({ kind: 'page', tab: 'html' });
  });

  /* The Godot run wrote 14 files and opened none. A tree is the surface that
   * makes "does this actually contain a game?" answerable at a glance. */
  it('treats an extensionless path as a project, opened as a tree', () => {
    expect(classifyPresented('/a/platformer_game')).toEqual({ kind: 'project', tab: 'filetree' });
  });

  it('falls back to a plain file surface for anything unknown', () => {
    expect(classifyPresented('/a/thing.bin')).toEqual({ kind: 'file', tab: 'file' });
  });

  it('is case-insensitive about extensions', () => {
    expect(classifyPresented('/a/SHOT.PNG').kind).toBe('image');
  });
});

describe('extOf', () => {
  it('ignores dots in parent directories', () => {
    expect(extOf('/a.b/c/file')).toBe('');
  });
  it('takes the last extension', () => {
    expect(extOf('/a/x.tar.gz')).toBe('gz');
  });
});

describe('usePresentStore', () => {
  beforeEach(() => usePresentStore.getState().clear());
  const items = (chat = UNSAVED_CHAT) => presentedFor(usePresentStore.getState(), chat);

  it('records what was presented, with its kind', () => {
    usePresentStore.getState().add({ path: '/a/logo.png', note: 'third pass' });
    const [item] = items();
    expect(item).toMatchObject({ path: '/a/logo.png', kind: 'image', note: 'third pass' });
  });

  /* Iterating on one artefact within ONE message is the normal case — present,
   * look, fix, present again. That must update the row, not stack duplicates. */
  it('replaces an artefact re-presented from the same message', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/logo.png', note: 'first', afterMessageId: 'm1' });
    s.add({ path: '/a/other.png', afterMessageId: 'm1' });
    s.add({ path: '/a/logo.png', note: 'fixed', afterMessageId: 'm1' });
    expect(items()).toHaveLength(2);
    expect(items()[items().length - 1]).toMatchObject({ path: '/a/logo.png', note: 'fixed' });
  });

  it('keeps presentation order', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/1.png' });
    s.add({ path: '/a/2.png' });
    expect(items().map((i) => i.path)).toEqual(['/a/1.png', '/a/2.png']);
  });

  /* the user (2026-09-12): cards from one conversation were falling to the foot of
   * every other, because there was one list for all of them. */
  it('keeps each chat’s cards to that chat', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/1.png', chat: '/s/a.jsonl', afterMessageId: 'a1' });
    s.add({ path: '/b/2.png', chat: '/s/b.jsonl', afterMessageId: 'b1' });
    expect(items('/s/a.jsonl').map((i) => i.path)).toEqual(['/a/1.png']);
    expect(items('/s/b.jsonl').map((i) => i.path)).toEqual(['/b/2.png']);
    expect(items('/s/c.jsonl')).toEqual([]);
  });

  it('attaches the open-with apps to the artefact in whichever chat it is in', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/1.png', chat: '/s/a.jsonl' });
    s.setApps('/a/1.png', [{ id: 'x', name: 'X' } as never], 'x');
    expect(items('/s/a.jsonl')[0]?.defaultApp).toMatchObject({ id: 'x' });
  });
});

describe('a presented card remembers where it was handed over', () => {
  beforeEach(() => usePresentStore.getState().clear());
  /*
   * the user: "file presentation cards seem pinned to the bottom of the chat for
   * some time instead of staying at the position they were created at." The
   * record now carries the message it followed, and the thread draws it there.
   */
  it('keeps the anchor it was added with', () => {
    const rec = usePresentStore.getState().add({ path: '/a/one.png', afterMessageId: 'm7' });
    expect(rec.afterMessageId).toBe('m7');
  });

  it('defaults to the foot when nothing had been said yet', () => {
    expect(usePresentStore.getState().add({ path: '/a/two.png' }).afterMessageId).toBeNull();
  });

  /* the user (2026-09-12): "if the model presents the same file and it has an
   * update that's when a new file card appears below but they don't travel
   * through a user sent message." */
  it('a RE-present from a later message is a new card; the earlier one stays put', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/a/logo.png', afterMessageId: 'm1' });
    s.add({ path: '/a/logo.png', afterMessageId: 'm9' });
    const logos = presentedFor(usePresentStore.getState(), UNSAVED_CHAT).filter(
      (i) => i.path === '/a/logo.png',
    );
    expect(logos.map((i) => i.afterMessageId)).toEqual(['m1', 'm9']);
  });

  it('a new version knows the card it follows (what an edited diagram moves on from)', () => {
    const s = usePresentStore.getState();
    const first = s.add({ path: '/a/flow.svg', afterMessageId: 'm1' });
    s.add({ path: '/a/other.svg', afterMessageId: 'm2' });
    const second = s.add({ path: '/a/flow.svg', afterMessageId: 'm3', shownAt: 123 });
    expect(second.shownAt).toBe(123);
    expect(earlierVersion(usePresentStore.getState(), second)).toBe(first);
    expect(earlierVersion(usePresentStore.getState(), first)).toBeUndefined();
  });
});

describe('openPresented — what door a presented file goes through', () => {
  /* MEASURED 2026-09-15: a presented PNG was read as TEXT into an image tab with
     no mediaSrc — "Failed to load file content" beside a card that said the
     picture was ready. The preview surfaces stream bytes over pd-file://. */
  const controller = () => {
    const tabs: Array<{
      id: string;
      key: string;
      filePath?: string;
      mediaSrc?: string;
      kind: string;
    }> = [];
    return {
      tabs,
      upsertTab: vi.fn((key: string, spec: Record<string, unknown>) => {
        const id = `t${tabs.length + 1}`;
        tabs.push({ id, key, ...(spec as object) } as never);
        return id;
      }),
      updateTab: vi.fn(),
      focusTab: vi.fn(),
      getState: () => ({ tabs }),
    };
  };

  it('opens a picture as a media tab with a pd-file src, never as text', async () => {
    const c = controller();
    (window as unknown as { piDesktop: unknown }).piDesktop = {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'fs:read-file') throw new Error('binary read must not happen');
        if (channel === 'fs:list-dir') return { entries: [] };
        return {};
      }),
    };
    await openPresented(c as never, { path: '/work/image-of-a-cow/cow-on-moon.png' });
    const tab = c.tabs.find((t) => t.kind === 'image');
    expect(tab?.mediaSrc).toMatch(/^pd-file:\/\/f\/work\/image-of-a-cow\/cow-on-moon\.png$/);
  });

  /* SEEN 2026-09-23 (open-buttons-probe): a presented .md opened into a tab with
     its TEXT and no PATH, so the bar's Open, its ▾ and "Open in folder" had no
     file to act on and did nothing. It goes through the file door now. */
  it('opens a presented text file AS the file, its path on the tab', async () => {
    const c = controller();
    (window as unknown as { piDesktop: unknown }).piDesktop = {
      invoke: vi.fn(async (channel: string) =>
        channel === 'fs:read-file'
          ? { text: '# Notes', truncated: false, tooLarge: false, binary: false, bytes: 7 }
          : { entries: [] },
      ),
    };
    await openPresented(c as never, { path: '/work/notes/notes.md', note: 'the notes' });
    const tab = c.tabs.find((t) => t.filePath === '/work/notes/notes.md');
    expect(tab?.kind).toBe('file');
    expect(tab?.key).toBe(fileTabKey('/work/notes/notes.md'));
    expect(c.tabs.some((t) => t.key.startsWith('present:'))).toBe(false);
  });

  /* The Activity tab is usually showing the file the model just presented, and
     sits earlier in the strip — a path match alone put the note on IT. */
  it('puts the note on the file tab it opened, not on the Activity tab showing the same file', async () => {
    const c = controller();
    c.tabs.push({ id: 'act', key: 'pi:activity', filePath: '/work/notes/notes.md', kind: 'file' });
    (window as unknown as { piDesktop: unknown }).piDesktop = {
      invoke: vi.fn(async (channel: string) =>
        channel === 'fs:read-file'
          ? { text: '# Notes', truncated: false, tooLarge: false, binary: false, bytes: 7 }
          : { entries: [] },
      ),
    };
    await openPresented(c as never, { path: '/work/notes/notes.md', note: 'the notes' });
    const fileTab = c.tabs.find((t) => t.key === fileTabKey('/work/notes/notes.md'));
    expect(fileTab).toBeDefined();
    expect(c.updateTab).toHaveBeenCalledWith(fileTab?.id, { subtitle: 'the notes' });
    expect(c.updateTab).not.toHaveBeenCalledWith('act', { subtitle: 'the notes' });
  });

  /* The rail opens itself only when the tab COUNT grows, so the blue Open on a
     card whose tab already existed focused it behind a closed canvas. */
  it('the card’s Open puts the canvas on screen even when its tab is already there', async () => {
    const c = controller();
    c.tabs.push({
      id: 't1',
      key: fileTabKey('/work/a.png'),
      filePath: '/work/a.png',
      kind: 'image',
    });
    (window as unknown as { piDesktop: unknown }).piDesktop = {
      invoke: vi.fn(async () => ({ entries: [] })),
    };
    useCanvasStore.getState().setCanvasOpen(false);
    await showPresented(c as never, { path: '/work/a.png' });
    expect(useCanvasStore.getState().canvasOpen).toBe(true);
    expect(c.focusTab).toHaveBeenCalledWith('t1');
    expect(c.tabs).toHaveLength(1);
  });

  it('still reads a page as text, so the html surface renders it', async () => {
    const c = controller();
    (window as unknown as { piDesktop: unknown }).piDesktop = {
      invoke: vi.fn(async (channel: string) =>
        channel === 'fs:read-file' ? { text: '<h1>hi</h1>' } : { entries: [] },
      ),
    };
    await openPresented(c as never, { path: '/work/site/index.html' });
    const tab = c.tabs[0] as unknown as { kind: string; artifact?: { content: { text: string } } };
    expect(tab.kind).toBe('html');
    expect(tab.artifact?.content.text).toBe('<h1>hi</h1>');
  });
});

describe('a chart, or a small SVG, is shown IN the thread', () => {
  beforeEach(() => usePresentStore.getState().clear());
  const items = () => presentedFor(usePresentStore.getState(), UNSAVED_CHAT);
  const RAW = {
    type: 'bar',
    title: 'Units Sold by Year',
    labels: ['2021', '2022'],
    values: [12, 19],
  };

  it('a presented .svg with its chart spec records a chart card, normalised', () => {
    usePresentStore.getState().add({ path: '/ws/units.svg', chart: RAW });
    const [item] = items();
    expect(item?.kind).toBe('chart');
    expect(item?.chart?.series[0]?.points).toEqual([
      { label: '2021', value: 12 },
      { label: '2022', value: 19 },
    ]);
    expect(isInlinePresented(item as never)).toBe(true);
  });

  it('a spec the chart model cannot read leaves a plain image card, never a throw', () => {
    usePresentStore.getState().add({ path: '/ws/broken.svg', chart: { title: 'no data' } });
    const [item] = items();
    expect(item?.kind).toBe('image');
    expect(item?.chart).toBeUndefined();
    expect(isInlinePresented(item as never)).toBe(false);
  });

  it('a small SVG travels with its markup and is inline; a poster is a canvas card', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/ws/icon.svg', svg: { width: 64, height: 64, bytes: 90, text: '<svg/>' } });
    s.add({ path: '/ws/poster.svg', svg: { width: 1920, height: 1080, bytes: 90000 } });
    const [icon, poster] = items();
    expect(isInlinePresented(icon as never)).toBe(true);
    expect(isInlinePresented(poster as never)).toBe(false);
  });

  it('openPresented lifts a chart into a chart tab synchronously, keyed as the card, marked inline', () => {
    const tabs: Array<Record<string, unknown>> = [];
    const c = {
      upsertTab: vi.fn((key: string, spec: Record<string, unknown>) => {
        tabs.push({ key, ...spec });
        return 't1';
      }),
      updateTab: vi.fn(),
      focusTab: vi.fn(),
      getState: () => ({ tabs }),
    };
    usePresentStore.getState().add({ path: '/ws/units.svg', chart: RAW });
    const [item] = items();
    // Not awaited on purpose: the tab must exist before the promise settles,
    // because the click runs inside a view transition's synchronous update.
    void openPresented(c as never, item as never);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      key: presentTabKey('/ws/units.svg'),
      kind: 'chart',
      title: 'Units Sold by Year',
      filePath: '/ws/units.svg',
      inline: true,
    });
    const artifact = tabs[0]?.artifact as { content: { kind: string; text: string } };
    expect(artifact.content.kind).toBe('chart');
    expect(JSON.parse(artifact.content.text)).toMatchObject({ type: 'bar' });
  });

  it('openPresented lifts a small SVG into an svg tab from its markup, marked inline', () => {
    const tabs: Array<Record<string, unknown>> = [];
    const c = {
      upsertTab: vi.fn((key: string, spec: Record<string, unknown>) => {
        tabs.push({ key, ...spec });
        return 't1';
      }),
      updateTab: vi.fn(),
      focusTab: vi.fn(),
      getState: () => ({ tabs }),
    };
    usePresentStore
      .getState()
      .add({ path: '/ws/icon.svg', svg: { width: 64, height: 64, bytes: 90, text: '<svg/>' } });
    const [item] = items();
    void openPresented(c as never, item as never);
    expect(tabs[0]).toMatchObject({ kind: 'svg', inline: true, filePath: '/ws/icon.svg' });
    expect((tabs[0]?.artifact as { content: { text: string } }).content.text).toBe('<svg/>');
  });

  /* VQ-10: a diagram shows IN the thread (both drawings travel with it) and
     opens full size in the canvas, as the drawing for the app's theme. */
  const DIAGRAM = {
    title: 'Order fulfilment',
    kind: 'flowchart',
    kit: 'paper-blue',
    source: 'flowchart LR\n  A --> B',
    light: { svg: '<svg>light</svg>', width: 1332, height: 322, paper: '#FBFAF7' },
    dark: { svg: '<svg>dark</svg>', width: 1332, height: 322, paper: '#191816' },
  };

  it('a presented diagram is an inline card, and opens as its drawing for the theme', () => {
    usePresentStore.getState().add({ path: '/ws/flow.svg', diagram: DIAGRAM });
    const [item] = items();
    expect(item?.diagram?.title).toBe('Order fulfilment');
    expect(isInlinePresented(item as never)).toBe(true);
    const tabs: Array<Record<string, unknown>> = [];
    const c = {
      upsertTab: vi.fn((key: string, spec: Record<string, unknown>) => {
        tabs.push({ key, ...spec });
        return 't1';
      }),
      updateTab: vi.fn(),
      focusTab: vi.fn(),
      getState: () => ({ tabs }),
    };
    document.documentElement.setAttribute('data-mode', 'dark');
    void openPresented(c as never, item as never);
    document.documentElement.removeAttribute('data-mode');
    expect(tabs[0]).toMatchObject({
      key: presentTabKey('/ws/flow.svg'),
      kind: 'svg',
      title: 'Order fulfilment',
      filePath: '/ws/flow.svg',
      inline: true,
    });
    expect((tabs[0]?.artifact as { content: { text: string } }).content.text).toBe(
      '<svg>dark</svg>',
    );
  });
});

/*
 * THE CARDS FOLLOW THE CHAT. the user (2026-09-17): "I just went back to a chat I
 * earlier made some visuals in and it didn't have them there."
 */
describe('the cards follow the chat', () => {
  beforeEach(() => usePresentStore.getState().clear());

  it('a chat that gets its session file keeps the cards it made while unsaved', () => {
    const s = usePresentStore.getState();
    s.add({ path: '/w/units.svg', chart: { labels: ['a'], values: [1] } });
    expect(presentedFor(usePresentStore.getState(), UNSAVED_CHAT)).toHaveLength(1);
    usePresentStore.getState().claimUnsaved('/sessions/2026-09-17.jsonl');
    expect(presentedFor(usePresentStore.getState(), UNSAVED_CHAT)).toHaveLength(0);
    expect(presentedFor(usePresentStore.getState(), '/sessions/2026-09-17.jsonl')).toHaveLength(1);
  });

  it('finds the charts a transcript names, anchored to the message that made them', () => {
    const messages = [
      { kind: 'user', id: 'u1' },
      {
        kind: 'assistant',
        id: 'a1',
        blocks: [
          { type: 'toolCall', id: 'c1', name: 'chart', arguments: { type: 'bar' } },
          {
            type: 'toolCall',
            id: 'c2',
            name: 'bash',
            arguments: { command: 'chart line "Trend"' },
          },
          { type: 'toolCall', id: 'c3', name: 'chart_edit', arguments: {} },
        ],
      },
      {
        kind: 'toolResult',
        id: 'tr1',
        toolCallId: 'c1',
        toolName: 'chart',
        text: 'Drew a bar chart "Units" (4 points, look clean): /w/units.svg (the spec beside it: units.chart.json). Shown.',
      },
      {
        kind: 'toolResult',
        id: 'tr2',
        toolCallId: 'c2',
        toolName: 'bash',
        text: 'Drew a line chart "Trend" (6 points, look ocean): /w/trend.svg (the spec beside it: trend.chart.json).',
      },
      {
        kind: 'toolResult',
        id: 'tr3',
        toolCallId: 'c3',
        toolName: 'chart_edit',
        text: 'Changed look → a bar chart "Units" (4 points, look sunset): /w/units.svg. Shown.',
      },
      {
        kind: 'toolResult',
        id: 'tr4',
        toolCallId: 'c9',
        toolName: 'chart',
        text: 'Drew x: /w/orphan.svg',
      },
    ];
    expect(chartsInTranscript(messages)).toEqual([
      { path: '/w/units.svg', afterMessageId: 'a1', callId: 'c1' },
      { path: '/w/trend.svg', afterMessageId: 'a1', callId: 'c2' },
    ]);
  });

  it('resolves the relative path a reply says (2026-09-17) against the working folder', () => {
    const messages = [
      {
        kind: 'assistant',
        id: 'a1',
        blocks: [{ type: 'toolCall', id: 'c1', name: 'chart', arguments: { type: 'bar' } }],
      },
      {
        kind: 'toolResult',
        id: 'tr1',
        toolCallId: 'c1',
        toolName: 'chart',
        text: 'Drew a bar chart "Units" (4 points, look clean): charts/units.svg (the spec beside it: units.chart.json). Shown.',
      },
    ];
    expect(chartsInTranscript(messages, '/w/chat/')).toEqual([
      { path: '/w/chat/charts/units.svg', afterMessageId: 'a1', callId: 'c1' },
    ]);
    // Without a root a relative name stays as said — never invented.
    expect(chartsInTranscript(messages)).toEqual([
      { path: 'charts/units.svg', afterMessageId: 'a1', callId: 'c1' },
    ]);
  });

  it("rebuilds a reopened chat's cards from the specs beside its chart files", async () => {
    const invoke = vi.fn(async (channel: string, req: { path: string }) => {
      if (channel === 'fs:read-file') {
        if (req.path === '/w/units.chart.json')
          return { text: JSON.stringify({ title: 'Units', labels: ['a', 'b'], values: [1, 2] }) };
        throw new Error('no such file');
      }
      return {};
    });
    (window as unknown as { piDesktop: unknown }).piDesktop = { invoke, onEvent: () => () => {} };
    const messages = [
      {
        kind: 'assistant',
        id: 'a1',
        blocks: [
          { type: 'toolCall', id: 'c1', name: 'chart', arguments: {} },
          { type: 'toolCall', id: 'c2', name: 'chart', arguments: {} },
        ],
      },
      {
        kind: 'toolResult',
        id: 'tr1',
        toolCallId: 'c1',
        toolName: 'chart',
        text: 'Drew a bar chart: /w/units.svg (the spec beside it: units.chart.json).',
      },
      {
        kind: 'toolResult',
        id: 'tr2',
        toolCallId: 'c2',
        toolName: 'chart',
        text: 'Drew a bar chart: /w/gone.svg (the spec beside it: gone.chart.json).',
      },
    ];
    const n = await rehydratePresented('/sessions/x.jsonl', messages);
    expect(n).toBe(1);
    const cards = presentedFor(usePresentStore.getState(), '/sessions/x.jsonl');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      path: '/w/units.svg',
      kind: 'chart',
      afterMessageId: 'a1',
      callId: 'c1',
    });
    expect(cards[0]?.chart?.title).toBe('Units');
    // Twice is still once.
    expect(await rehydratePresented('/sessions/x.jsonl', messages)).toBe(0);
  });

  /*
   * the user (2026-10-08): "I asked for a radar chart, it was made, then I asked
   * about something else, it failed, but then going out and back into the chat,
   * it showed two radar charts at the bottom, not where they were originally".
   * MEASURED (chart-reentry-probe, PIRESTART=1): after pi restarted under the
   * chat, its messages came back with the transcript's ids (`a-h1`), the card
   * still named the live one (`a-1791…`) and fell to the foot.
   */
  it('a card whose message id changed under it is re-anchored, never copied', async () => {
    const invoke = vi.fn(async (channel: string, req: { path: string }) => {
      if (channel === 'fs:read-file' && req.path === '/w/radar.chart.json') {
        return {
          text: JSON.stringify({ type: 'radar', labels: ['a', 'b', 'c'], values: [1, 2, 3] }),
        };
      }
      return {};
    });
    (window as unknown as { piDesktop: unknown }).piDesktop = { invoke, onEvent: () => () => {} };
    const chat = '/sessions/radar.jsonl';
    // Handed over live: anchored to the router's id for the message.
    usePresentStore.getState().add({ path: '/w/radar.svg', chat, afterMessageId: 'a-1791-1' });
    // The chat read back: the same conversation, the transcript's ids.
    const messages = [
      { kind: 'user', id: 'u-h0' },
      { kind: 'assistant', id: 'a-h1', blocks: [{ type: 'toolCall', id: 'call_1', name: 'bash' }] },
      {
        kind: 'toolResult',
        id: 'tr-h2',
        toolCallId: 'call_1',
        toolName: 'bash',
        text: 'Drew a radar chart "Skills" (3 points, look mono): /w/radar.svg (the spec beside it: radar.chart.json).',
      },
    ];
    expect(await rehydratePresented(chat, messages)).toBe(0);
    const cards = presentedFor(usePresentStore.getState(), chat);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ afterMessageId: 'a-h1', callId: 'call_1' });
    // And a card that knows its call is left where it is.
    expect(await rehydratePresented(chat, messages)).toBe(0);
    expect(presentedFor(usePresentStore.getState(), chat)).toHaveLength(1);
  });

  it('presentingCall: the newest tool call of the latest assistant message', () => {
    expect(
      presentingCall([
        { kind: 'assistant', blocks: [{ type: 'toolCall', id: 'old' }] },
        { kind: 'toolResult' },
        {
          kind: 'assistant',
          blocks: [
            { type: 'text' },
            { type: 'toolCall', id: 'c1' },
            { type: 'toolCall', id: 'c2' },
          ],
        },
      ]),
    ).toBe('c2');
    expect(presentingCall([{ kind: 'user' }])).toBeUndefined();
  });
});
