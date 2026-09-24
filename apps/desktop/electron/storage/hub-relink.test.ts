import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyHubRelinks,
  gen3dHubRepos,
  type HubRelink,
  planHubRelinks,
  relinkAtBoot,
  relinkShelvedHubRepos,
} from './hub-relink';

/** Every scratch world a test made, removed at the end (nothing left in the temp dir). */
const worlds: string[] = [];
afterAll(() => {
  for (const w of worlds) rmSync(w, { recursive: true, force: true });
});

/** A scratch cache + library, and a helper that shelves a repo in the hub layout. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'pd-hub-relink-'));
  worlds.push(root);
  const cache = join(root, 'cache');
  const lib = join(root, 'Models');
  const hub = join(cache, 'gen3d', 'hf', 'hub');
  mkdirSync(join(cache, 'gen3d'), { recursive: true });
  /** `<lib>/<shelf>/<folder>` as the migration leaves it: blobs + a snapshot linking into them. */
  const shelveHubRepo = (shelf: string, folder: string, rev = 'abc123'): string => {
    const dir = join(lib, ...shelf.split('/'), folder);
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    mkdirSync(join(dir, 'refs'), { recursive: true });
    mkdirSync(join(dir, 'snapshots', rev), { recursive: true });
    writeFileSync(join(dir, 'blobs', 'b10b'), '{"_class_name": "MageFlowPipeline"}');
    writeFileSync(join(dir, 'refs', 'main'), rev);
    symlinkSync(join('..', '..', 'blobs', 'b10b'), join(dir, 'snapshots', rev, 'model_index.json'));
    return dir;
  };
  return { root, cache, lib, hub, shelveHubRepo };
}

describe('the 3D engine’s hub repos', () => {
  it('names every source and every legacy repo, each once, in the catalog’s spelling', () => {
    const repos = gen3dHubRepos();
    // Mage-Flow's sources now, and the withdrawn copies it still honours on disk.
    expect(repos).toContain('Comfy-Org/Mage-Flow');
    expect(repos).toContain('Qwen/Qwen3-VL-4B-Instruct');
    expect(repos).toContain('microsoft/Mage-Flow-Turbo');
    expect(repos).toContain('microsoft/Mage-Flow-Edit-Turbo');
    // The rest of the engine too: a reset cache lost every link, not just these.
    expect(repos).toContain('microsoft/TRELLIS.2-4B');
    expect(repos).toContain('Roblox/cubepart');
    // Qwen3-VL-4B is listed by three models; Comfy-Org by two.
    expect(new Set(repos).size).toBe(repos.length);
  });
});

describe('putting back the links a reset 3D cache lost', () => {
  it('links a shelved repo back under its exact hub spelling, relative, reaching the snapshot', () => {
    const s = scratch();
    const shelf = s.shelveHubRepo('Image/Generation', 'microsoft__mage-flow-turbo');
    const { linked, failed } = relinkShelvedHubRepos(s.cache, s.lib);
    expect(failed).toEqual([]);
    expect(linked.map((r) => r.repo)).toEqual(['microsoft/Mage-Flow-Turbo']);
    const at = join(s.hub, 'models--microsoft--Mage-Flow-Turbo');
    // The catalog's spelling — the hub cache is keyed by it on a case-sensitive volume.
    expect(readdirSync(s.hub)).toEqual(['models--microsoft--Mage-Flow-Turbo']);
    expect(lstatSync(at).isSymbolicLink()).toBe(true);
    // Relative, as the migration writes it, so the pair survives moving together.
    expect(readlinkSync(at).startsWith('/')).toBe(false);
    expect(realpathSync(at)).toBe(realpathSync(shelf));
    // What the engine reads: refs/main, then the snapshot's file through the blob link.
    expect(readFileSync(join(at, 'refs', 'main'), 'utf8')).toBe('abc123');
    expect(readFileSync(join(at, 'snapshots', 'abc123', 'model_index.json'), 'utf8')).toContain(
      'MageFlowPipeline',
    );
  });

  it('finds a repo on whichever shelf holds it (a support model on Support)', () => {
    const s = scratch();
    s.shelveHubRepo('Support', 'qwen__qwen3-vl-4b-instruct');
    s.shelveHubRepo('Image/Editing', 'microsoft__mage-flow-edit-turbo');
    const { linked } = relinkShelvedHubRepos(s.cache, s.lib);
    expect(linked.map((r) => r.repo).sort()).toEqual([
      'Qwen/Qwen3-VL-4B-Instruct',
      'microsoft/Mage-Flow-Edit-Turbo',
    ]);
    expect(realpathSync(join(s.hub, 'models--Qwen--Qwen3-VL-4B-Instruct'))).toBe(
      realpathSync(join(s.lib, 'Support', 'qwen__qwen3-vl-4b-instruct')),
    );
  });

  it('never touches an entry that is there in any form', () => {
    const s = scratch();
    s.shelveHubRepo('Image/Generation', 'microsoft__mage-flow-turbo');
    s.shelveHubRepo('3D/Generation', 'roblox__cubepart');
    s.shelveHubRepo('Support', 'qwen__qwen3-vl-4b-instruct');
    mkdirSync(s.hub, { recursive: true });
    // A real folder (a download under way, or one not migrated yet)…
    mkdirSync(join(s.hub, 'models--microsoft--Mage-Flow-Turbo', 'blobs'), { recursive: true });
    // …a link somewhere else…
    symlinkSync('/somewhere/else', join(s.hub, 'models--Roblox--cubepart'));
    // …even a dangling link: someone put it there, and it is not ours to judge.
    symlinkSync(join(s.root, 'gone'), join(s.hub, 'models--Qwen--Qwen3-VL-4B-Instruct'));
    const { linked } = relinkShelvedHubRepos(s.cache, s.lib);
    expect(linked).toEqual([]);
    expect(lstatSync(join(s.hub, 'models--microsoft--Mage-Flow-Turbo')).isDirectory()).toBe(true);
    expect(readlinkSync(join(s.hub, 'models--Roblox--cubepart'))).toBe('/somewhere/else');
    expect(readlinkSync(join(s.hub, 'models--Qwen--Qwen3-VL-4B-Instruct'))).toBe(
      join(s.root, 'gone'),
    );
  });

  it('links only a folder in the hub layout — never a model store folder of the same name', () => {
    const s = scratch();
    // The model store keeps plain files + model.json, which no hub cache can read.
    const plain = join(s.lib, 'Image', 'Generation', 'comfy-org__mage-flow');
    mkdirSync(join(plain, 'diffusion_models'), { recursive: true });
    writeFileSync(join(plain, 'model.json'), '{}');
    expect(relinkShelvedHubRepos(s.cache, s.lib).linked).toEqual([]);
    expect(existsSync(s.hub)).toBe(false);
  });

  it('leaves alone a repo being downloaded, and is idempotent', () => {
    const s = scratch();
    s.shelveHubRepo('Image/Generation', 'microsoft__mage-flow-turbo');
    s.shelveHubRepo('3D/Generation', 'roblox__cubepart');
    const first = relinkShelvedHubRepos(s.cache, s.lib, new Set(['Roblox/cubepart']));
    expect(first.linked.map((r) => r.repo)).toEqual(['microsoft/Mage-Flow-Turbo']);
    expect(relinkShelvedHubRepos(s.cache, s.lib, new Set(['Roblox/cubepart'])).linked).toEqual([]);
    // Once the download is over, the next boot links it.
    expect(relinkShelvedHubRepos(s.cache, s.lib).linked.map((r) => r.repo)).toEqual([
      'Roblox/cubepart',
    ]);
    expect(relinkShelvedHubRepos(s.cache, s.lib).linked).toEqual([]);
  });

  it('plans nothing where there is no library', () => {
    const s = scratch();
    expect(
      planHubRelinks({
        cacheRoot: s.cache,
        libraryRoot: join(s.root, 'nope'),
        repos: gen3dHubRepos(),
      }),
    ).toEqual([]);
  });

  it('takes the first shelf in the sidebar order when two hold the same folder', () => {
    const plan = planHubRelinks(
      { cacheRoot: '/c', libraryRoot: '/L', repos: ['microsoft/Mage-Flow-Turbo'] },
      {
        present: () => false,
        isHubRepo: (p) =>
          p === '/L/Image/Generation/microsoft__mage-flow-turbo' ||
          p === '/L/Unsorted/microsoft__mage-flow-turbo',
      },
    );
    expect(plan).toEqual([
      {
        repo: 'microsoft/Mage-Flow-Turbo',
        at: '/c/gen3d/hf/hub/models--microsoft--Mage-Flow-Turbo',
        to: '/L/Image/Generation/microsoft__mage-flow-turbo',
      },
    ]);
  });

  it('at boot says what it did, and a link it cannot make costs nothing else', () => {
    const s = scratch();
    s.shelveHubRepo('Image/Generation', 'microsoft__mage-flow-turbo');
    const said: [string, string, Record<string, unknown>][] = [];
    const log = {
      info: (m: string, d: Record<string, unknown>) => said.push(['info', m, d]),
      warn: (m: string, d: Record<string, unknown>) => said.push(['warn', m, d]),
    };
    relinkAtBoot(s.cache, s.lib, new Set(), log);
    expect(said).toEqual([
      [
        'info',
        'hub link put back',
        {
          repo: 'microsoft/Mage-Flow-Turbo',
          to: join(s.lib, 'Image', 'Generation', 'microsoft__mage-flow-turbo'),
        },
      ],
    ]);
    // A cache whose `hf` is a FILE: no folder can be made under it. Reported, not thrown.
    const t = scratch();
    t.shelveHubRepo('Image/Generation', 'microsoft__mage-flow-turbo');
    writeFileSync(join(t.cache, 'gen3d', 'hf'), 'not a folder');
    said.length = 0;
    expect(() => relinkAtBoot(t.cache, t.lib, new Set(), log)).not.toThrow();
    expect(said.map(([level, m, d]) => [level, m, d.repo])).toEqual([
      ['warn', 'hub link not put back', 'microsoft/Mage-Flow-Turbo'],
    ]);
  });

  it('reports a link it could not make and makes the rest', () => {
    const plan: HubRelink[] = [
      { repo: 'a/one', at: '/c/gen3d/hf/hub/models--a--one', to: '/L/Support/a__one' },
      { repo: 'b/two', at: '/c/gen3d/hf/hub/models--b--two', to: '/L/Support/b__two' },
    ];
    const made: [string, string][] = [];
    const { linked, failed } = applyHubRelinks(plan, {
      mkdirp: () => undefined,
      symlink: (target, at) => {
        if (at.endsWith('one')) throw Object.assign(new Error('nope'), { code: 'EACCES' });
        made.push([target, at]);
      },
    });
    expect(failed).toEqual([{ relink: plan[0], why: 'EACCES' }]);
    expect(linked).toEqual([plan[1]]);
    expect(made).toEqual([['../../../../L/Support/b__two', '/c/gen3d/hf/hub/models--b--two']]);
  });
});
