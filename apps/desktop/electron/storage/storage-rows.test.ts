import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageNode } from './storage-contract';
import {
  featureStorageRoots,
  featureStorageRows,
  registerStorageRows,
  registerSupportNote,
  resetStorageRowsForTests,
  supportNoteFor,
} from './storage-rows';

afterEach(() => resetStorageRowsForTests());

const memoryRow: StorageNode = {
  name: 'Memory',
  path: '/h/.pi/desktop/memory',
  bytes: 300,
  kind: 'dir',
  note: 'What Bobble learned',
};

describe('storage rows (the W0 registry)', () => {
  it('adds nothing to the page until a feature registers', async () => {
    expect(await featureStorageRows()).toEqual([]);
    expect(featureStorageRoots()).toEqual([]);
    expect(supportNoteFor('memory')).toBeUndefined();
  });

  it("collects each provider's rows and roots, in registration order", async () => {
    registerStorageRows({
      id: 'memory',
      roots: () => ['/h/.pi/desktop/memory'],
      rows: () => [memoryRow],
    });
    registerStorageRows({
      id: 'training',
      roots: () => ['/h/Bobble/Training', 'relative/ignored', ''],
      rows: async () => [{ ...memoryRow, name: 'Training runs', path: '/h/Bobble/Training' }],
    });
    expect((await featureStorageRows()).map((r) => r.name)).toEqual(['Memory', 'Training runs']);
    expect(featureStorageRoots()).toEqual(['/h/.pi/desktop/memory', '/h/Bobble/Training']);
  });

  it('a provider whose scan fails is reported and left out; the rest still show', async () => {
    registerStorageRows({
      id: 'broken',
      roots: () => [],
      rows: async () => {
        throw new Error('scan failed');
      },
    });
    registerStorageRows({ id: 'memory', roots: () => [], rows: () => [memoryRow] });
    const onError = vi.fn();
    expect(await featureStorageRows(onError)).toEqual([memoryRow]);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('replaces by id and unregisters', async () => {
    const off = registerStorageRows({ id: 'memory', roots: () => [], rows: () => [memoryRow] });
    registerStorageRows({ id: 'memory', roots: () => [], rows: () => [] });
    off(); // the stale handle leaves the replacement alone
    expect(await featureStorageRows()).toEqual([]);
  });

  it('notes a support-root folder', () => {
    const off = registerSupportNote('memory', 'The memory service and its database');
    expect(supportNoteFor('memory')).toBe('The memory service and its database');
    off();
    expect(supportNoteFor('memory')).toBeUndefined();
  });
});
