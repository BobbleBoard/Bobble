import { describe, expect, it } from 'vitest';
import {
  checkGatewayRequest,
  checkRelayRequest,
  DEFAULT_SCOPES,
  decideTrust,
  defaultTrustMyDevices,
  isLoopbackAddress,
  isTailscaleAddress,
  mayPresentToken,
  normalizeRemoteAddress,
  type PairingMode,
  type PeerIdentity,
  pairingModeFor,
  parseHostHeader,
  scopeAllows,
  type TrustDecision,
  tokenBoundToPeer,
} from './trust-policy';

const ME = '3240365473728001';

const peer = (over: Partial<PeerIdentity> = {}): PeerIdentity => ({
  stableId: 'nbYS7qLqVy11CNTRL',
  userId: ME,
  loginName: 'someone@github',
  nodeName: 'my-macbook-pro',
  tags: [],
  shared: false,
  ...over,
});

describe('decideTrust — the devices-tailscale §4.5 table, row by row', () => {
  const rows: Array<[string, PeerIdentity | null, PairingMode, string | undefined, TrustDecision]> =
    [
      // Same Tailscale user, untagged, not shared-in: one click; automatic when "Trust my devices" is on.
      ['my device, trust on', peer(), 'auto', ME, { kind: 'auto', caller: 'my-device' }],
      ['my device, trust off', peer(), 'approval', ME, { kind: 'ask', caller: 'my-device' }],
      // Another user in the tailnet (family / company): the dialog, with the code.
      [
        'another user, trust on',
        peer({ userId: '77' }),
        'auto',
        ME,
        { kind: 'ask', caller: 'other-user' },
      ],
      [
        'another user, trust off',
        peer({ userId: '77' }),
        'approval',
        ME,
        { kind: 'ask', caller: 'other-user' },
      ],
      // Tagged node / shared-in node: the dialog, labelled.
      [
        'tagged node (tagged-devices owner)',
        peer({ userId: '1', tags: ['tag:server'] }),
        'auto',
        ME,
        { kind: 'ask', caller: 'tagged' },
      ],
      [
        'tagged node that shares my user id',
        peer({ tags: ['tag:gpu'] }),
        'auto',
        ME,
        { kind: 'ask', caller: 'tagged' },
      ],
      [
        'shared-in node',
        peer({ userId: '99', shared: true }),
        'auto',
        ME,
        { kind: 'ask', caller: 'shared' },
      ],
      [
        'shared-in node that shares my user id',
        peer({ shared: true }),
        'auto',
        ME,
        { kind: 'ask', caller: 'shared' },
      ],
      // No identity, or sharing closed: refused.
      ['whois failed', null, 'auto', ME, { kind: 'reject', reason: 'no-identity' }],
      [
        'identity without an owner id',
        peer({ userId: '' }),
        'auto',
        ME,
        { kind: 'reject', reason: 'no-identity' },
      ],
      ['sharing closed, my device', peer(), 'closed', ME, { kind: 'reject', reason: 'closed' }],
      [
        'sharing closed, anyone',
        peer({ userId: '77' }),
        'closed',
        ME,
        { kind: 'reject', reason: 'closed' },
      ],
      // This node is tagged, so it has no "own user": nobody is "my device".
      [
        'this node has no owner id',
        peer(),
        'auto',
        undefined,
        { kind: 'ask', caller: 'other-user' },
      ],
    ];
  for (const [name, who, pairing, selfUserId, expected] of rows) {
    it(name, () => {
      expect(
        decideTrust(who, { pairing, ...(selfUserId !== undefined ? { selfUserId } : {}) }),
      ).toEqual(expected);
    });
  }

  it('maps the settings to the advertised mode', () => {
    expect(pairingModeFor({ enabled: false, trustMyDevices: true })).toBe('closed');
    expect(pairingModeFor({ enabled: true, trustMyDevices: true })).toBe('auto');
    expect(pairingModeFor({ enabled: true, trustMyDevices: false })).toBe('approval');
  });
});

describe('defaultTrustMyDevices — on for a one-user tailnet', () => {
  const node = (userId: string | undefined, over: { tags?: string[]; sharee?: boolean } = {}) => ({
    ...(userId !== undefined ? { userId } : {}),
    tags: over.tags ?? [],
    sharee: over.sharee ?? false,
  });

  it('is on when every own node has one owner (the user's tailnet today)', () => {
    expect(defaultTrustMyDevices([node(ME), node(ME), node(ME), node(ME)])).toBe(true);
  });

  it('is off with a second person on the tailnet', () => {
    expect(defaultTrustMyDevices([node(ME), node('77')])).toBe(false);
  });

  it('ignores tagged servers and shared-in nodes', () => {
    expect(
      defaultTrustMyDevices([
        node(ME),
        node('1', { tags: ['tag:server'] }),
        node('99', { sharee: true }),
      ]),
    ).toBe(true);
  });

  it('is off when it cannot tell', () => {
    expect(defaultTrustMyDevices([node(ME), node(undefined)])).toBe(false);
    expect(defaultTrustMyDevices([])).toBe(false);
  });
});

describe('tokens are bound to nodes', () => {
  it('serving side: honoured only from the node it was issued to', () => {
    const record = { tsStableId: 'nA' };
    expect(tokenBoundToPeer(record, { found: true, stableId: 'nA' })).toBe(true);
    expect(tokenBoundToPeer(record, { found: true, stableId: 'nB' })).toBe(false);
    expect(tokenBoundToPeer(record, { found: false })).toBe(false);
    expect(tokenBoundToPeer(record, null)).toBe(false);
    expect(tokenBoundToPeer({ tsStableId: '' }, { found: true, stableId: '' })).toBe(false);
  });

  it('client side: sent only to the node pinned at pairing (an address can move)', () => {
    expect(mayPresentToken('nServer', { found: true, stableId: 'nServer' })).toBe(true);
    expect(mayPresentToken('nServer', { found: true, stableId: 'nImposter' })).toBe(false);
    expect(mayPresentToken('nServer', { found: false })).toBe(false);
  });
});

describe('addresses', () => {
  it('knows the tailnet ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48', () => {
    for (const ok of [
      '100.64.0.1',
      '100.101.102.110',
      '100.127.255.255',
      'fd7a:115c:a1e0::ab12:cd40',
      '::ffff:100.101.102.103',
    ]) {
      expect(isTailscaleAddress(ok)).toBe(true);
    }
    for (const bad of [
      '100.63.255.255',
      '100.128.0.1',
      '192.168.1.33',
      '8.8.8.8',
      '127.0.0.1',
      '::1',
      'fd7a:115c:a1e1::1',
      'nonsense',
      '',
    ]) {
      expect(isTailscaleAddress(bad)).toBe(false);
    }
  });

  it('knows loopback, and unwraps IPv4-mapped IPv6', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('100.101.102.110')).toBe(false);
    expect(normalizeRemoteAddress('::ffff:100.101.102.110')).toBe('100.101.102.110');
  });

  it('reads Host headers the way HTTP writes them', () => {
    expect(parseHostHeader('100.101.102.103:8765')).toEqual({ host: '100.101.102.103', port: 8765 });
    expect(parseHostHeader('[fd7a:115c:a1e0::ab12:cd34]:8765')).toEqual({
      host: 'fd7a:115c:a1e0::ab12:cd34',
      port: 8765,
    });
    expect(parseHostHeader('my-macbook-pro.tail0f0f0f.ts.net.')).toEqual({
      host: 'my-macbook-pro.tail0f0f0f.ts.net',
    });
    expect(parseHostHeader('fd7a::1')).toBeNull();
    expect(parseHostHeader('')).toBeNull();
  });
});

describe('checkGatewayRequest — the last row: Origin, Host, source', () => {
  const addressing = {
    hosts: ['100.101.102.103', 'fd7a:115c:a1e0::ab12:cd34', 'my-macbook-pro.tail0f0f0f.ts.net'],
    port: 8765,
  };
  const ok = { host: '100.101.102.103:8765', remoteAddress: '100.101.102.110' };

  it('lets a Bobble on the tailnet through', () => {
    expect(checkGatewayRequest(ok, addressing)).toEqual({ ok: true });
    expect(checkGatewayRequest({ ...ok, host: '100.101.102.103' }, addressing)).toEqual({ ok: true });
    expect(
      checkGatewayRequest(
        {
          ...ok,
          host: '[fd7a:115c:a1e0::ab12:cd34]:8765',
          remoteAddress: 'fd7a:115c:a1e0::ab12:cd40',
        },
        addressing,
      ),
    ).toEqual({ ok: true });
    expect(
      checkGatewayRequest({ ...ok, host: 'my-macbook-pro.tail0f0f0f.ts.net.:8765' }, addressing),
    ).toEqual({ ok: true });
  });

  it('refuses anything a browser sent (any Origin, even "null")', () => {
    for (const origin of ['https://evil.example', 'null', 'http://100.101.102.103:8765', '']) {
      expect(checkGatewayRequest({ ...ok, origin }, addressing)).toEqual({
        ok: false,
        status: 403,
        reason: 'origin',
      });
    }
  });

  it('refuses a foreign Host (DNS rebinding) or the wrong port', () => {
    for (const host of [
      'evil.example:8765',
      'localhost:8765',
      '100.101.102.104:8765',
      '100.101.102.103:9999',
      undefined,
    ]) {
      expect(checkGatewayRequest({ ...ok, host }, addressing)).toEqual({
        ok: false,
        status: 403,
        reason: 'host',
      });
    }
  });

  it('refuses a source that is not on the tailnet (LAN, café Wi-Fi, loopback)', () => {
    for (const remoteAddress of ['192.168.1.33', '10.0.0.5', '127.0.0.1', undefined]) {
      expect(checkGatewayRequest({ ...ok, remoteAddress }, addressing)).toEqual({
        ok: false,
        status: 403,
        reason: 'source',
      });
    }
  });

  it('accepts loopback only under the two-instances test seam', () => {
    const seam = { ...addressing, hosts: [], allowLoopback: true };
    expect(
      checkGatewayRequest({ host: '127.0.0.1:8765', remoteAddress: '127.0.0.1' }, seam),
    ).toEqual({ ok: true });
    expect(
      checkGatewayRequest(
        { host: '127.0.0.1:8765', remoteAddress: '127.0.0.1' },
        { ...seam, allowLoopback: false },
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('checkRelayRequest — a page in the person’s own browser cannot borrow the relay', () => {
  it('lets the app’s own loopback callers through', () => {
    for (const host of ['127.0.0.1:41234', 'localhost:41234', '[::1]:41234']) {
      expect(checkRelayRequest({ host, remoteAddress: '127.0.0.1' }, { port: 41234 })).toEqual({
        ok: true,
      });
    }
  });

  it('refuses an Origin, a foreign Host, a wrong port, or a non-loopback source', () => {
    const base = { host: '127.0.0.1:41234', remoteAddress: '127.0.0.1' };
    expect(
      checkRelayRequest({ ...base, origin: 'http://localhost:3000' }, { port: 41234 }),
    ).toMatchObject({ reason: 'origin' });
    expect(
      checkRelayRequest({ ...base, host: 'attacker.example:41234' }, { port: 41234 }),
    ).toMatchObject({ reason: 'host' });
    expect(checkRelayRequest({ ...base, host: '127.0.0.1:1' }, { port: 41234 })).toMatchObject({
      reason: 'host',
    });
    expect(
      checkRelayRequest({ ...base, remoteAddress: '100.101.102.110' }, { port: 41234 }),
    ).toMatchObject({ reason: 'source' });
  });
});

describe('scopes', () => {
  it('grant chat and generation by default, never model management', () => {
    expect(DEFAULT_SCOPES).toEqual({ chat: true, generate: true, manage: false });
    expect(scopeAllows(DEFAULT_SCOPES, 'chat')).toBe(true);
    expect(scopeAllows(DEFAULT_SCOPES, 'manage')).toBe(false);
  });
});
