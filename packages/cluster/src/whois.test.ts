import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWhoisCache, parseWhois, type WhoisResult, whoisFailure, whoisKey } from './whois';

/* `tailscale whois --json 100.101.102.110`, captured on this Mac (keys and endpoints redacted). */
const WHOIS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailscale-whois.fixture.json'),
  'utf8',
);

describe('parseWhois', () => {
  it('reads the captured answer: node, owner, no tags, not shared', () => {
    expect(parseWhois(WHOIS)).toEqual({
      found: true,
      stableId: 'nbYS7qLqVy11CNTRL',
      nodeName: 'linux-ms-7e59',
      hostName: 'linux-ms-7e59',
      os: 'linux',
      userId: '3240365473728001',
      loginName: 'someone@github',
      displayName: 'Someone',
      tags: [],
      shared: false,
      online: true,
      keyExpiry: '2027-03-14T02:35:15.000Z',
      addresses: ['100.101.102.110', 'fd7a:115c:a1e0::ab12:cd40'],
    });
  });

  it('reads an already-parsed LocalAPI body the same way', () => {
    expect(parseWhois(JSON.parse(WHOIS) as unknown)).toMatchObject({
      found: true,
      stableId: 'nbYS7qLqVy11CNTRL',
    });
  });

  it('reads tags and a sharer: nodes with no human owner here', () => {
    const doc = JSON.parse(WHOIS) as {
      Node: Record<string, unknown>;
      UserProfile: Record<string, unknown>;
    };
    doc.Node.Tags = ['tag:server'];
    doc.UserProfile = { ID: 123, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' };
    expect(parseWhois(JSON.stringify(doc))).toMatchObject({
      found: true,
      tags: ['tag:server'],
      loginName: 'tagged-devices',
      shared: false,
    });
    const shared = JSON.parse(WHOIS) as { Node: Record<string, unknown> };
    shared.Node.Sharer = 999;
    expect(parseWhois(JSON.stringify(shared))).toMatchObject({ shared: true, sharerUserId: '999' });
  });

  it('keeps an owner id past 2^53 exact', () => {
    const text = WHOIS.replace(/"ID": 3240365473728001/, '"ID": 9007199254740993').replace(
      /"User": 3240365473728001/,
      '"User": 9007199254740993',
    );
    const r = parseWhois(text);
    expect(r.found && r.userId).toBe('9007199254740993');
  });

  it('refuses an answer that names no node', () => {
    expect(parseWhois('{}')).toMatchObject({ found: false, reason: 'error' });
    expect(parseWhois('nope')).toMatchObject({ found: false, reason: 'error' });
    expect(parseWhois({ Node: { StableID: 'n1' } })).toMatchObject({ found: false });
  });
});

describe('whoisFailure', () => {
  it('reads both MEASURED "unknown address" answers as not-found', () => {
    expect(whoisFailure('peer not found')).toMatchObject({ found: false, reason: 'not-found' });
    expect(whoisFailure('no match for IP:port\n')).toEqual({
      found: false,
      reason: 'not-found',
      detail: 'no match for IP:port',
    });
    expect(whoisFailure('connection refused')).toMatchObject({ reason: 'error' });
  });
});

describe('whoisKey', () => {
  it('keys by IP: the port does not change who is calling', () => {
    expect(whoisKey('100.101.102.110:51234')).toBe('100.101.102.110');
    expect(whoisKey('100.101.102.110')).toBe('100.101.102.110');
    expect(whoisKey('[fd7a:115c:a1e0::1]:8765')).toBe('fd7a:115c:a1e0::1');
    expect(whoisKey('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1');
  });

  it('unwraps an IPv4-mapped IPv6 caller, as a dual-stack listener reports it', () => {
    expect(whoisKey('::ffff:100.101.102.110')).toBe('100.101.102.110');
    expect(whoisKey('::FFFF:100.101.102.110')).toBe('100.101.102.110');
    expect(whoisKey('[::ffff:100.101.102.110]:51234')).toBe('100.101.102.110');
  });
});

describe('createWhoisCache', () => {
  const found = (id: string): WhoisResult => ({
    found: true,
    stableId: id,
    nodeName: id,
    userId: '1',
    loginName: '',
    displayName: '',
    tags: [],
    shared: false,
    addresses: [],
  });

  it('asks Tailscale about the IPv4 address a mapped caller really is', async () => {
    const asked: string[] = [];
    const cache = createWhoisCache(async (addr) => {
      asked.push(addr);
      return found('n');
    });
    await cache.get('::ffff:100.101.102.110');
    await cache.get('100.101.102.110:9');
    expect(asked).toEqual(['100.101.102.110']);
  });

  it('answers from cache for a minute, then asks again', async () => {
    let t = 0;
    let calls = 0;
    const cache = createWhoisCache(
      async () => {
        calls += 1;
        return found(`n${calls}`);
      },
      { now: () => t },
    );
    expect(await cache.get('100.1.1.1:1000')).toMatchObject({ stableId: 'n1' });
    t = 59_000;
    expect(await cache.get('100.1.1.1:2000')).toMatchObject({ stableId: 'n1' });
    t = 61_000;
    expect(await cache.get('100.1.1.1')).toMatchObject({ stableId: 'n2' });
    expect(calls).toBe(2);
  });

  it('does not cache a failure, so a node that just joined is seen next time', async () => {
    let joined = false;
    const cache = createWhoisCache(async () =>
      joined ? found('new') : { found: false, reason: 'not-found', detail: 'no match' },
    );
    expect((await cache.get('100.1.1.2')).found).toBe(false);
    joined = true;
    expect(await cache.get('100.1.1.2')).toMatchObject({ found: true, stableId: 'new' });
  });

  it('shares one lookup between simultaneous callers', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cache = createWhoisCache(async () => {
      calls += 1;
      await gate;
      return found('n');
    });
    const all = Promise.all([
      cache.get('100.1.1.3'),
      cache.get('100.1.1.3:9'),
      cache.get('100.1.1.3'),
    ]);
    release();
    await all;
    expect(calls).toBe(1);
  });

  it('evicts the least recently used past its size, and forgets on request', async () => {
    const cache = createWhoisCache(async (addr) => found(addr), { max: 2 });
    await cache.get('100.0.0.1');
    await cache.get('100.0.0.2');
    await cache.get('100.0.0.1'); // touch: .2 is now the oldest
    await cache.get('100.0.0.3');
    expect(cache.size).toBe(2);
    cache.invalidate('100.0.0.1');
    expect(cache.size).toBe(1);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  it('turns a thrown lookup into an answer', async () => {
    const cache = createWhoisCache(async () => {
      throw new Error('socket hang up');
    });
    expect(await cache.get('100.0.0.9')).toMatchObject({ found: false, reason: 'error' });
  });
});
