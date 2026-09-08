import { describe, expect, it, vi } from 'vitest';
import { reconcileWindowStreams, type WindowStreamHandle } from './window-stream';

/** A handle whose video records whether its tracks were stopped. */
function fakeHandle(sourceId: string, windowId: number, stopped: string[]): WindowStreamHandle {
  const track = { stop: () => stopped.push(sourceId) };
  const video = {
    srcObject: { getTracks: () => [track] },
  } as unknown as HTMLVideoElement;
  return { sourceId, windowId, video };
}

describe('reconcileWindowStreams', () => {
  it('keeps a stream that is still wanted, and does not reopen it', async () => {
    const stopped: string[] = [];
    const open = [fakeHandle('window:1:0', 1, stopped)];
    const next = await reconcileWindowStreams(open, [{ sourceId: 'window:1:0', windowId: 1 }]);
    expect(next).toEqual(open);
    expect(stopped).toEqual([]);
  });

  it('stops a stream that is no longer wanted — a live capture keeps the macOS recording indicator lit', async () => {
    const stopped: string[] = [];
    const open = [fakeHandle('window:1:0', 1, stopped), fakeHandle('window:2:0', 2, stopped)];
    const next = await reconcileWindowStreams(open, [{ sourceId: 'window:2:0', windowId: 2 }]);
    expect(next.map((h) => h.sourceId)).toEqual(['window:2:0']);
    expect(stopped).toEqual(['window:1:0']);
  });

  it('returns the streams in the order asked for, because that order is z-order', async () => {
    const stopped: string[] = [];
    const a = fakeHandle('window:1:0', 1, stopped);
    const b = fakeHandle('window:2:0', 2, stopped);
    const next = await reconcileWindowStreams(
      [a, b],
      [
        { sourceId: 'window:2:0', windowId: 2 },
        { sourceId: 'window:1:0', windowId: 1 },
      ],
    );
    expect(next.map((h) => h.windowId)).toEqual([2, 1]);
  });

  it('drops a window whose stream will not open rather than failing the whole set', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => {
          throw new Error('denied');
        },
      },
    });
    const next = await reconcileWindowStreams([], [{ sourceId: 'window:9:0', windowId: 9 }]);
    expect(next).toEqual([]);
    vi.unstubAllGlobals();
  });
});
