import { describe, expect, it } from 'vitest';
import {
  findByToken,
  fingerprintFromHash,
  hashToken,
  looksLikeToken,
  mintId,
  mintNonce,
  mintToken,
  normalizeTokenHash,
  redactTokens,
  TOKEN_BYTES,
  tokenFingerprint,
  verifyToken,
} from './tokens';

describe('device tokens', () => {
  it('are 256 random bits, recognisable, and never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const t = mintToken();
      expect(looksLikeToken(t)).toBe(true);
      expect(Buffer.from(t.slice(4), 'base64url')).toHaveLength(TOKEN_BYTES);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
  });

  it('come from the injected randomness (so tests can be exact)', () => {
    const t = mintToken((n) => Buffer.alloc(n, 7));
    expect(t).toBe(`bdt_${Buffer.alloc(32, 7).toString('base64url')}`);
  });

  it('are stored as sha256 hex, and verified against it', () => {
    const t = mintToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyToken(t, h)).toBe(true);
    expect(verifyToken(t, h.toUpperCase())).toBe(true);
    expect(verifyToken(`${t}x`, h)).toBe(false);
    expect(verifyToken(mintToken(), h)).toBe(false);
  });

  it('never throw on a malformed stored hash', () => {
    const t = mintToken();
    for (const bad of ['', 'abc', 'z'.repeat(64), hashToken(t).slice(0, 63)]) {
      expect(verifyToken(t, bad)).toBe(false);
    }
    expect(normalizeTokenHash(42)).toBeNull();
  });

  it('find their client among many, comparing against every record', () => {
    const tokens = Array.from({ length: 5 }, () => mintToken());
    const records = tokens.map((t, i) => ({ id: `c${i}`, tokenHash: hashToken(t) }));
    records.splice(2, 0, { id: 'broken', tokenHash: 'not-a-hash' });
    expect(findByToken(records, tokens[3] as string)?.id).toBe('c3');
    expect(findByToken(records, mintToken())).toBeUndefined();
    expect(findByToken([], mintToken())).toBeUndefined();
  });

  it('have one fingerprint whether you hold the token or its hash', () => {
    const t = mintToken();
    expect(tokenFingerprint(t)).toBe(fingerprintFromHash(hashToken(t)));
    expect(tokenFingerprint(t)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('are redacted to their fingerprint in anything that might be logged', () => {
    const t = mintToken();
    const line = `GET /cluster/info Authorization: Bearer ${t} from 100.101.102.110`;
    const redacted = redactTokens(line);
    expect(redacted).not.toContain(t);
    expect(redacted).toContain(`bdt_…${tokenFingerprint(t)}`);
  });
});

describe('nonces and ids', () => {
  it('nonces carry 32 random bytes; ids a prefix and 16', () => {
    expect(Buffer.from(mintNonce(), 'base64url')).toHaveLength(32);
    const id = mintId('dev');
    expect(id).toMatch(/^dev_[A-Za-z0-9_-]{22}$/);
    expect(mintId('dev')).not.toBe(id);
  });
});
