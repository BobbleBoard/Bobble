/**
 * THE TASKS YOU LEFT — the rules behind the button beside the sidebar toggle.
 *
 * The user (2026-09-24): the button "only appears when you leave a running task".
 * These pin what "left" means (its place is not on screen), when a finished
 * task is news (it ended while you were elsewhere) and when it stops being
 * news (you went there, or dismissed it).
 */
import type { ChatMsg } from '@pi-desktop/engine';
import { describe, expect, it } from 'vitest';
import {
  type ChatSnapshot,
  chatOutcome,
  dismissed,
  isOnScreen,
  liveChats,
  placeKey,
  resurfaced,
  type Surface,
  settled,
  surfaceOf,
  type TrayModel,
  type TrayTask,
  tracked,
  trayRows,
  trayTone,
  untracked,
} from './task-tray';

const CHAT: Surface = { kind: 'chat', sessionFile: '/s/other.jsonl' };
const IMAGE_ROOM: Surface = { kind: 'studio', modality: 'image' };
const empty = (surface: Surface = CHAT): TrayModel => ({ live: {}, ended: {}, surface });

const picture = (over: Partial<TrayTask> = {}): TrayTask => ({
  key: 'studio:image',
  place: { kind: 'studio', modality: 'image' },
  title: 'A red fox asleep in tall grass',
  state: 'running',
  startedAt: 1_000,
  ...over,
});
const chat = (file: string, over: Partial<TrayTask> = {}): TrayTask => ({
  key: placeKey({ kind: 'chat', sessionFile: file }),
  place: { kind: 'chat', sessionFile: file },
  title: 'Plan the Lisbon trip',
  state: 'running',
  startedAt: 2_000,
  ...over,
});

describe('where a task lives', () => {
  it('has one key per place — a newer run of the same place is the same row', () => {
    expect(placeKey({ kind: 'studio', modality: 'image' })).toBe('studio:image');
    expect(placeKey({ kind: 'chat', sessionFile: '/s/a.jsonl' })).toBe('chat:/s/a.jsonl');
  });

  it('is on screen only when THAT chat or THAT studio is', () => {
    const place = { kind: 'chat', sessionFile: '/s/a.jsonl' } as const;
    expect(isOnScreen(place, { kind: 'chat', sessionFile: '/s/a.jsonl' })).toBe(true);
    expect(isOnScreen(place, { kind: 'chat', sessionFile: '/s/b.jsonl' })).toBe(false);
    // The chat is under a studio or the model hub: left, even though it is "viewed".
    expect(isOnScreen(place, IMAGE_ROOM)).toBe(false);
    expect(isOnScreen(place, { kind: 'elsewhere' })).toBe(false);
    expect(isOnScreen(picture().place, IMAGE_ROOM)).toBe(true);
    expect(isOnScreen(picture().place, { kind: 'studio', modality: 'video' })).toBe(false);
  });

  it('reads the surface off the three facts that decide it', () => {
    expect(surfaceOf({ modality: 'image', covered: true, viewedFile: '/s/a.jsonl' })).toEqual(
      IMAGE_ROOM,
    );
    expect(surfaceOf({ modality: 'chat', covered: true, viewedFile: '/s/a.jsonl' })).toEqual({
      kind: 'elsewhere',
    });
    expect(surfaceOf({ modality: 'chat', covered: false, viewedFile: '/s/a.jsonl' })).toEqual({
      kind: 'chat',
      sessionFile: '/s/a.jsonl',
    });
  });
});

describe('a running task', () => {
  it('is listed only while you are somewhere else', () => {
    let m = tracked(empty(IMAGE_ROOM), picture());
    expect(trayRows(m)).toEqual([]); // you are watching it
    m = resurfaced(m, CHAT);
    expect(trayRows(m).map((r) => r.key)).toEqual(['studio:image']); // you left it
    m = resurfaced(m, IMAGE_ROOM);
    expect(trayRows(m)).toEqual([]); // back again: not listed, not forgotten
    m = resurfaced(m, CHAT);
    expect(trayRows(m)).toHaveLength(1);
  });

  it('leaves no row when it is stopped — stopping is something you did', () => {
    const m = untracked(tracked(empty(), picture()), 'studio:image');
    expect(trayRows(m)).toEqual([]);
  });
});

describe('a finished task', () => {
  it('is news when it ended while you were elsewhere', () => {
    const m = settled(tracked(empty(), picture()), picture({ state: 'done', endedAt: 5_000 }));
    expect(trayRows(m).map((r) => r.state)).toEqual(['done']);
  });

  it('is not news when you watched it end', () => {
    const m = settled(
      tracked(empty(IMAGE_ROOM), picture()),
      picture({ state: 'done', endedAt: 5_000 }),
    );
    expect(trayRows(m)).toEqual([]);
    // …and leaving afterwards does not resurrect it.
    expect(trayRows(resurfaced(m, CHAT))).toEqual([]);
  });

  it('is reported even if it started and ended between two looks', () => {
    const m = settled(empty(), picture({ state: 'failed', endedAt: 5_000, error: 'no memory' }));
    expect(trayRows(m)[0]?.error).toBe('no memory');
  });

  it('clears when you open its place, and stays cleared when you leave again', () => {
    let m = settled(tracked(empty(), picture()), picture({ state: 'done', endedAt: 5_000 }));
    m = resurfaced(m, IMAGE_ROOM);
    expect(Object.keys(m.ended)).toEqual([]);
    expect(trayRows(resurfaced(m, CHAT))).toEqual([]);
  });

  it('can be dismissed without opening it — one, or all', () => {
    let m = settled(empty(), picture({ state: 'done', endedAt: 5_000 }));
    m = settled(m, chat('/s/a.jsonl', { state: 'failed', endedAt: 6_000 }));
    expect(trayRows(dismissed(m, 'studio:image')).map((r) => r.key)).toEqual(['chat:/s/a.jsonl']);
    expect(trayRows(dismissed(m, 'all'))).toEqual([]);
  });

  it('is replaced by a newer run of the same place, not listed beside it', () => {
    let m = settled(empty(), chat('/s/a.jsonl', { state: 'done', endedAt: 5_000 }));
    m = tracked(m, chat('/s/a.jsonl', { startedAt: 9_000 }));
    expect(trayRows(m).map((r) => `${r.key}:${r.state}`)).toEqual(['chat:/s/a.jsonl:running']);
  });
});

describe('the list', () => {
  it('puts what waits on you first, then what is going, then what finished — newest first', () => {
    let m = empty({ kind: 'elsewhere' });
    m = settled(m, picture({ state: 'done', endedAt: 5_000 }));
    m = settled(m, chat('/s/old.jsonl', { state: 'failed', endedAt: 7_000, title: 'Older news' }));
    m = tracked(m, { ...picture(), key: 'studio:3d', place: { kind: 'studio', modality: '3d' } });
    m = tracked(m, chat('/s/ask.jsonl', { state: 'needs-input' }));
    expect(trayRows(m).map((r) => r.state)).toEqual(['needs-input', 'running', 'failed', 'done']);
  });

  it("gives the button one mark: the most urgent row's", () => {
    const needs = chat('/s/a.jsonl', { state: 'needs-input' });
    const failed = picture({ state: 'failed' });
    const done = picture({ state: 'done' });
    expect(trayTone([done, failed, needs])).toBe('needs-input');
    expect(trayTone([done, failed])).toBe('failed');
    expect(trayTone([done, picture()])).toBe('done');
    // Only running: no mark — the button being there is the whole message.
    expect(trayTone([picture()])).toBeNull();
  });
});

describe('the chats', () => {
  const user = (text: string, timestamp: number): ChatMsg => ({
    kind: 'user',
    id: `u${timestamp}`,
    text,
    timestamp,
  });
  const reply = (over: Partial<Extract<ChatMsg, { kind: 'assistant' }>> = {}): ChatMsg => ({
    kind: 'assistant',
    id: 'a1',
    blocks: [{ type: 'text', text: 'Here is a plan.' }],
    timestamp: 9_999,
    ...over,
  });
  const quiet: ChatSnapshot = {
    bgRun: null,
    viewedFile: '/s/viewed.jsonl',
    viewedTitle: 'Viewed chat',
    viewedMessages: [],
    viewedBusy: false,
    asking: [],
  };

  it('lists the chat running in the background, from its own thread', () => {
    const live = liveChats({
      ...quiet,
      bgRun: {
        sessionFile: '/s/bg.jsonl',
        streaming: true,
        title: 'Plan the Lisbon trip',
        messages: [user('first', 100), reply(), user('and the hotels?', 4_200)],
      },
    });
    expect(live).toEqual([
      {
        file: '/s/bg.jsonl',
        title: 'Plan the Lisbon trip',
        needsInput: false,
        startedAt: 4_200,
      },
    ]);
  });

  it('lists the viewed chat while it runs — whether it counts as LEFT is the surface’s call', () => {
    const live = liveChats({ ...quiet, viewedBusy: true, viewedTitle: null });
    expect(live).toEqual([{ file: '/s/viewed.jsonl', title: 'New chat', needsInput: false }]);
  });

  it('says "needs your input" for a chat with a question waiting', () => {
    const live = liveChats({
      ...quiet,
      bgRun: { sessionFile: '/s/bg.jsonl', streaming: true, title: null, messages: [] },
      asking: ['/s/bg.jsonl'],
    });
    expect(live[0]?.needsInput).toBe(true);
  });

  it('lists nothing when nothing runs, and ignores a finished background slot', () => {
    expect(liveChats(quiet)).toEqual([]);
    expect(
      liveChats({
        ...quiet,
        bgRun: { sessionFile: '/s/bg.jsonl', streaming: false, title: 'Done', messages: [] },
      }),
    ).toEqual([]);
  });

  it('reads how a turn ended off its last reply', () => {
    expect(chatOutcome([user('hi', 1), reply({ stopReason: 'stop' })])).toEqual({
      state: 'done',
    });
    expect(
      chatOutcome([user('hi', 1), reply({ stopReason: 'error', errorMessage: 'fetch failed' })]),
      // Said in words, never the engine's raw line.
    ).toEqual({ state: 'failed', error: 'The model engine was not running when this was sent.' });
    expect(chatOutcome([user('hi', 1), reply({ stopReason: 'aborted' })])).toBe('stopped');
    // A reply from an EARLIER turn does not speak for this one.
    expect(chatOutcome([reply({ stopReason: 'error' }), user('again', 2)])).toEqual({
      state: 'done',
    });
  });
});
