// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPresented,
  extOf,
  openPresented,
  presentedFor,
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
