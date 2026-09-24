import { describe, expect, it } from 'vitest';
import {
  beginPairing,
  computeSas,
  createPairingManager,
  formatSas,
  type NewClientRecord,
  PAIR_TTL_MS,
  type PairEvent,
  type PairingManagerDeps,
  validatePairRequest,
} from './pairing';
import { hashToken, looksLikeToken, tokenFingerprint } from './tokens';
import type { PairingMode, PeerIdentity } from './trust-policy';

const ME = '3240365473728001';
const SERVER_ID = 'dev_server0000000000000000';

const laptop: PeerIdentity = {
  stableId: 'nLAPTOP',
  userId: ME,
  loginName: 'someone@github',
  nodeName: 'my-macbook-pro',
  tags: [],
  shared: false,
};
const sister: PeerIdentity = {
  ...laptop,
  stableId: 'nSISTER',
  userId: '77',
  loginName: 'sis@github',
  nodeName: 'sisters-pc',
};

function harness(
  opts: { pairing?: PairingMode; persistFails?: boolean } & Partial<PairingManagerDeps> = {},
) {
  let t = 1_000_000;
  const events: PairEvent[] = [];
  const persisted: NewClientRecord[] = [];
  let persistFails = opts.persistFails ?? false;
  const manager = createPairingManager({
    serverId: SERVER_ID,
    trust: () => ({ pairing: opts.pairing ?? 'approval', selfUserId: ME }),
    persistClient: async (c) => {
      if (persistFails) throw new Error('disk full');
      persisted.push(c);
    },
    onEvent: (e) => events.push(e),
    now: () => t,
    ...opts,
  });
  return {
    manager,
    events,
    persisted,
    advance: (ms: number) => {
      t += ms;
    },
    setPersistFails: (v: boolean) => {
      persistFails = v;
    },
  };
}

function requestFrom(name = 'My MacBook Pro', clientId = 'dev_client0000000001') {
  return beginPairing({ clientId, clientName: name });
}

describe('the comparison code', () => {
  it('is the same on both sides', () => {
    const { manager } = harness();
    const client = requestFrom();
    const start = manager.start(client.request, laptop);
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const shownByServer = manager.pending()[0]?.sas;
    expect(shownByServer).toMatch(/^\d{6}$/);
    expect(client.sas(start.serverNonce, start.serverId)).toBe(shownByServer);
  });

  it('changes with every input, and cannot be forged by moving bytes between fields', () => {
    const base = { clientNonce: 'aaaa', serverNonce: 'bbbb', clientId: 'cccc', serverId: 'dddd' };
    const sas = computeSas(base);
    expect(computeSas({ ...base, serverNonce: 'bbbc' })).not.toBe(sas);
    expect(computeSas({ ...base, clientId: 'ccce' })).not.toBe(sas);
    // "ab"+"c" vs "a"+"bc": plain concatenation would make these equal.
    expect(computeSas({ ...base, clientNonce: 'aaaab', serverNonce: 'bbb' })).not.toBe(
      computeSas({ ...base, clientNonce: 'aaaa', serverNonce: 'bbbb' }),
    );
    expect(formatSas('482913')).toBe('482 913');
  });

  it('spreads over the whole six-digit range', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      codes.add(
        computeSas({ clientNonce: `n${i}`, serverNonce: 's', clientId: 'c', serverId: 'd' }),
      );
    }
    expect(codes.size).toBeGreaterThan(490);
  });
});

describe('the request', () => {
  it('is validated, and a name shown in a security dialog is cleaned', () => {
    const nonce = 'x'.repeat(43);
    expect(
      validatePairRequest({ clientId: 'dev_abc1', clientName: 'Mac', clientNonce: nonce }),
    ).toEqual({
      clientId: 'dev_abc1',
      clientName: 'Mac',
      clientNonce: nonce,
    });
    // A right-to-left override would let "exe.gpj" pose as "jpg.exe" in the dialog.
    expect(
      validatePairRequest({
        clientId: 'dev_abc1',
        clientName: 'Evil\u202eMac\u0007',
        clientNonce: nonce,
      })?.clientName,
    ).toBe('EvilMac');
    expect(
      validatePairRequest({
        clientId: 'dev_abc1',
        clientName: 'A\u2066B\u061cC\u200fD\u0000',
        clientNonce: nonce,
      })?.clientName,
    ).toBe('ABCD');
    for (const bad of [
      null,
      {},
      { clientId: 'x', clientName: 'Mac', clientNonce: nonce },
      { clientId: 'dev_abc1', clientName: '   ', clientNonce: nonce },
      { clientId: 'dev_abc1', clientName: 'Mac', clientNonce: 'short' },
      { clientId: 'dev abc1', clientName: 'Mac', clientNonce: nonce },
    ]) {
      expect(validatePairRequest(bad)).toBeNull();
    }
    const { manager } = harness();
    expect(manager.start({ clientId: '?' }, laptop)).toEqual({
      ok: false,
      status: 400,
      error: 'invalid',
    });
  });
});

describe('approval', () => {
  it('auto-approves the owner’s own device when "Trust my devices" is on, and hands the token over once', async () => {
    const { manager, persisted, events } = harness({ pairing: 'auto' });
    const start = manager.start(requestFrom().request, laptop);
    expect(start).toMatchObject({ ok: true, status: 'approved', serverId: SERVER_ID });
    if (!start.ok) return;
    expect(manager.pending()).toEqual([]); // no dialog
    const first = await manager.poll(start.requestId, laptop);
    expect(first.status).toBe('approved');
    if (first.status !== 'approved' || !('token' in first)) throw new Error('no token');
    expect(looksLikeToken(first.token)).toBe(true);
    expect(first.scopes).toEqual({ chat: true, generate: true, manage: false });
    // Recorded at hand-over — the hash only, never the token.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: 'dev_client0000000001',
      tsStableId: 'nLAPTOP',
      tsUserId: ME,
      auto: true,
      tokenHash: hashToken(first.token),
    });
    expect(JSON.stringify(persisted)).not.toContain(first.token);
    expect(events.find((e) => e.type === 'paired')).toMatchObject({
      auto: true,
      fingerprint: tokenFingerprint(first.token),
    });
    // Once.
    expect(await manager.poll(start.requestId, laptop)).toEqual({
      status: 'approved',
      delivered: true,
    });
    expect(persisted).toHaveLength(1);
  });

  it('asks about another person’s device, with the code, and waits for Allow', async () => {
    const { manager, events, persisted } = harness({ pairing: 'auto' });
    const start = manager.start(requestFrom('Sister’s PC', 'dev_sister000000001').request, sister);
    expect(start).toMatchObject({ ok: true, status: 'pending' });
    if (!start.ok) return;
    const dialog = events.find((e) => e.type === 'request');
    expect(dialog).toMatchObject({
      type: 'request',
      request: {
        caller: 'other-user',
        loginName: 'sis@github',
        nodeName: 'sisters-pc',
        clientName: 'Sister’s PC',
      },
    });
    expect(await manager.poll(start.requestId, sister)).toMatchObject({ status: 'pending' });
    expect(
      manager.approve(start.requestId, { scopes: { chat: true, generate: false, manage: false } }),
    ).toBe(true);
    const got = await manager.poll(start.requestId, sister);
    expect(got).toMatchObject({
      status: 'approved',
      scopes: { chat: true, generate: false, manage: false },
    });
    expect(persisted[0]).toMatchObject({ auto: false, tsStableId: 'nSISTER' });
  });

  it('asks even about my own device when "Trust my devices" is off', () => {
    const { manager } = harness({ pairing: 'approval' });
    expect(manager.start(requestFrom().request, laptop)).toMatchObject({
      ok: true,
      status: 'pending',
    });
    expect(manager.pending()[0]?.caller).toBe('my-device');
  });

  it('refuses when sharing is closed, or Tailscale cannot say who is asking', () => {
    const closed = harness({ pairing: 'closed' });
    expect(closed.manager.start(requestFrom().request, laptop)).toEqual({
      ok: false,
      status: 403,
      error: 'closed',
    });
    const open = harness();
    expect(open.manager.start(requestFrom().request, null)).toEqual({
      ok: false,
      status: 403,
      error: 'no-identity',
    });
  });

  it('answers a request only to the node that made it', async () => {
    const { manager } = harness({ pairing: 'auto' });
    const start = manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    expect(await manager.poll(start.requestId, { ...laptop, stableId: 'nIMPOSTER' })).toEqual({
      status: 'unknown',
    });
    expect(await manager.poll(start.requestId, null)).toEqual({ status: 'unknown' });
    expect(await manager.poll('pair_nope', laptop)).toEqual({ status: 'unknown' });
    // The rightful node still gets its token.
    expect(await manager.poll(start.requestId, laptop)).toMatchObject({ status: 'approved' });
  });

  it('withholds the token when recording the client fails, and hands it over on the next poll', async () => {
    const h = harness({ pairing: 'auto', persistFails: true });
    const start = h.manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    expect(await h.manager.poll(start.requestId, laptop)).toEqual({
      status: 'error',
      error: 'disk full',
    });
    h.setPersistFails(false);
    expect(await h.manager.poll(start.requestId, laptop)).toMatchObject({
      status: 'approved',
      token: expect.any(String),
    });
  });

  it('hands the token to exactly one of two simultaneous polls', async () => {
    const { manager, persisted } = harness({ pairing: 'auto' });
    const start = manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    const [a, b] = await Promise.all([
      manager.poll(start.requestId, laptop),
      manager.poll(start.requestId, laptop),
    ]);
    const withToken = [a, b].filter((r) => 'token' in r);
    expect(withToken).toHaveLength(1);
    expect(persisted).toHaveLength(1);
  });
});

describe('expiry at 120 s', () => {
  it('expires a request nobody answered', async () => {
    const { manager, advance, events } = harness();
    const start = manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    expect(start.expiresAt - 1_000_000).toBe(PAIR_TTL_MS);
    advance(PAIR_TTL_MS - 1);
    expect(await manager.poll(start.requestId, laptop)).toMatchObject({ status: 'pending' });
    advance(1);
    expect(await manager.poll(start.requestId, laptop)).toEqual({ status: 'expired' });
    expect(manager.approve(start.requestId)).toBe(false); // too late to Allow
    expect(events.at(-1)).toEqual({
      type: 'resolved',
      requestId: start.requestId,
      status: 'expired',
    });
    expect(manager.pending()).toEqual([]);
  });

  it('drops an approved token nobody collected, having recorded nothing', async () => {
    const { manager, advance, persisted } = harness();
    const start = manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    advance(100_000);
    manager.approve(start.requestId); // late Allow: a fresh 120 s to collect
    advance(PAIR_TTL_MS - 1);
    expect(await manager.poll(start.requestId, laptop)).toMatchObject({
      status: 'approved',
      token: expect.any(String),
    });
    const again = harness();
    const s2 = again.manager.start(requestFrom().request, laptop);
    if (!s2.ok) throw new Error('refused');
    again.manager.approve(s2.requestId);
    again.advance(PAIR_TTL_MS);
    expect(await again.manager.poll(s2.requestId, laptop)).toEqual({ status: 'expired' });
    expect(again.persisted).toEqual([]);
    expect(persisted).toHaveLength(1);
  });

  it('long-polls: wakes on Allow', async () => {
    const { manager } = harness();
    const start = manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    const waiting = manager.waitForChange(start.requestId, laptop, { timeoutMs: 10_000 });
    setTimeout(() => manager.approve(start.requestId), 5);
    expect(await waiting).toMatchObject({ status: 'approved', token: expect.any(String) });
  });

  it('long-polls: wakes at the request’s expiry and says so', async () => {
    // Real clock, short life: the wait ends at expiry, not at its 10 s timeout.
    const m = createPairingManager({
      serverId: SERVER_ID,
      trust: () => ({ pairing: 'approval', selfUserId: ME }),
      persistClient: async () => undefined,
      ttlMs: 30,
    });
    const s = m.start(requestFrom().request, laptop);
    if (!s.ok) throw new Error('refused');
    const started = Date.now();
    expect(await m.waitForChange(s.requestId, laptop, { timeoutMs: 10_000 })).toEqual({
      status: 'expired',
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('long-polls: returns "pending" at its own timeout, and ends on abort', async () => {
    const { manager } = harness();
    const start = manager.start(requestFrom().request, laptop);
    if (!start.ok) throw new Error('refused');
    expect(await manager.waitForChange(start.requestId, laptop, { timeoutMs: 10 })).toMatchObject({
      status: 'pending',
    });
    const ctl = new AbortController();
    const waiting = manager.waitForChange(start.requestId, laptop, {
      timeoutMs: 10_000,
      signal: ctl.signal,
    });
    ctl.abort();
    expect(await waiting).toMatchObject({ status: 'pending' });
  });
});

describe('rate limits and lock-out', () => {
  it('allows five requests a minute per node, then says when to retry', () => {
    const { manager, advance } = harness();
    for (let i = 0; i < 5; i += 1) {
      expect(manager.start(requestFrom().request, laptop)).toMatchObject({ ok: true });
      advance(1000);
    }
    const sixth = manager.start(requestFrom().request, laptop);
    expect(sixth).toMatchObject({ ok: false, status: 429, error: 'rate-limited' });
    if (!sixth.ok) expect(sixth.retryAfterMs).toBe(60_000 - 5000);
    // Another node is not affected.
    expect(manager.start(requestFrom('PC', 'dev_sister000000001').request, sister)).toMatchObject({
      ok: true,
    });
    advance(60_000);
    expect(manager.start(requestFrom().request, laptop)).toMatchObject({ ok: true });
  });

  it('keeps one pending request per node: a new one supersedes it', () => {
    const { manager, events } = harness();
    const a = manager.start(requestFrom().request, laptop);
    const b = manager.start(requestFrom().request, laptop);
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(manager.pending().map((p) => p.requestId)).toEqual([b.requestId]);
    expect(events).toContainEqual({
      type: 'resolved',
      requestId: a.requestId,
      status: 'cancelled',
    });
  });

  it('locks a node out after five denials, until the lock-out passes', () => {
    const { manager, advance } = harness({ lockoutMs: 3_600_000 });
    for (let i = 0; i < 5; i += 1) {
      const s = manager.start(requestFrom().request, laptop);
      if (!s.ok) throw new Error(`refused at ${i}`);
      expect(manager.deny(s.requestId)).toBe(true);
      advance(61_000); // stay under the per-minute limit
    }
    const locked = manager.start(requestFrom().request, laptop);
    expect(locked).toMatchObject({ ok: false, status: 403, error: 'locked-out' });
    // Someone else can still ask.
    expect(manager.start(requestFrom('PC', 'dev_sister000000001').request, sister)).toMatchObject({
      ok: true,
    });
    advance(3_600_000);
    expect(manager.start(requestFrom().request, laptop)).toMatchObject({ ok: true });
  });

  it('an approval clears the denial count', () => {
    const { manager, advance } = harness();
    for (let i = 0; i < 4; i += 1) {
      const s = manager.start(requestFrom().request, laptop);
      if (s.ok) manager.deny(s.requestId);
      advance(61_000);
    }
    const ok = manager.start(requestFrom().request, laptop);
    if (!ok.ok) throw new Error('refused');
    manager.approve(ok.requestId);
    advance(61_000);
    const s = manager.start(requestFrom().request, laptop);
    if (s.ok) manager.deny(s.requestId);
    advance(61_000);
    expect(manager.start(requestFrom().request, laptop)).toMatchObject({ ok: true });
  });

  it('refuses, up front, a client id that belongs to another node', () => {
    const taken = new Map([['dev_client0000000001', 'nSOMEONE_ELSE']]);
    const { manager, events } = harness({
      clientIdConflict: (clientId, stableId) =>
        taken.has(clientId) && taken.get(clientId) !== stableId,
    });
    expect(manager.start(requestFrom().request, laptop)).toEqual({
      ok: false,
      status: 409,
      error: 'id-conflict',
    });
    expect(events).toEqual([]); // no dialog for it
    // The same id from the node that owns it is fine.
    taken.set('dev_client0000000001', 'nLAPTOP');
    expect(manager.start(requestFrom().request, laptop)).toMatchObject({ ok: true });
  });

  it('caps pending requests across all callers', () => {
    const { manager } = harness({ maxPending: 2 });
    const who = (n: number): PeerIdentity => ({ ...sister, stableId: `n${n}` });
    expect(manager.start(requestFrom().request, who(1))).toMatchObject({ ok: true });
    expect(manager.start(requestFrom().request, who(2))).toMatchObject({ ok: true });
    expect(manager.start(requestFrom().request, who(3))).toMatchObject({
      ok: false,
      status: 429,
      error: 'busy',
    });
  });

  it('lets the client cancel its own request, and nobody else’s', () => {
    const { manager } = harness();
    const s = manager.start(requestFrom().request, laptop);
    if (!s.ok) throw new Error('refused');
    expect(manager.cancel(s.requestId, sister)).toBe(false);
    expect(manager.cancel(s.requestId, laptop)).toBe(true);
    expect(manager.deny(s.requestId)).toBe(false);
  });
});
