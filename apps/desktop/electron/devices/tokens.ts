/**
 * DEVICE TOKENS — what a paired computer presents on every request.
 *
 * Pairing ends with the serving device minting a 256-bit random token and
 * handing it to the client exactly once (devices-tailscale §4.5). From then on:
 *
 *   - the client keeps the token itself, sealed with the OS keychain
 *     (secret-box.ts) and sends it as `Authorization: Bearer <token>`;
 *   - the serving device keeps ONLY `sha256(token)`, so a copy of its
 *     devices.json cannot be replayed against it;
 *   - comparisons are constant-time, and a lookup across several clients
 *     compares against every record, so neither the bytes of a hash nor which
 *     client matched leak through timing;
 *   - logs and the Details view show a fingerprint (the first 12 hex digits of
 *     the hash), which both sides can compute and compare, never the token.
 *
 * Electron-free: node:crypto only.
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

/** Marks a Bobble device token, for secret scanners and the log redactor. */
export const TOKEN_PREFIX = 'bdt_';

/** 256 bits of randomness per token. */
export const TOKEN_BYTES = 32;

/** base64url of 32 bytes is 43 characters. */
const TOKEN_RE = /^bdt_[A-Za-z0-9_-]{43}$/;

export type RandomBytes = (size: number) => Buffer;

/** A new device token: `bdt_` + 43 base64url characters (256 bits). */
export function mintToken(random: RandomBytes = nodeRandomBytes): string {
  return `${TOKEN_PREFIX}${random(TOKEN_BYTES).toString('base64url')}`;
}

/** Is this shaped like a device token? (Format only — says nothing about validity.) */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/** sha256 of the token, as 64 lowercase hex digits — what the serving device stores. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A stored hash, validated: 64 hex digits, lowercased. Null for anything else. */
export function normalizeTokenHash(hash: unknown): string | null {
  return typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null;
}

/** The short, shareable identity of a token: the first 12 hex digits of its hash. */
export function fingerprintFromHash(hash: string): string {
  return hash.slice(0, 12);
}

/** The fingerprint of a token, equal to {@link fingerprintFromHash} of its hash. */
export function tokenFingerprint(token: string): string {
  return fingerprintFromHash(hashToken(token));
}

/**
 * Does `presented` hash to `storedHash`? Constant-time; false (never a throw)
 * for a malformed stored hash.
 */
export function verifyToken(presented: string, storedHash: string): boolean {
  const stored = normalizeTokenHash(storedHash);
  if (stored === null) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The record whose `tokenHash` matches, comparing against EVERY record in
 * constant time each — no early return, so how long the lookup takes does not
 * say which client (or how many) matched.
 */
export function findByToken<T extends { readonly tokenHash: string }>(
  records: readonly T[],
  presented: string,
): T | undefined {
  const presentedHash = Buffer.from(hashToken(presented), 'hex');
  let match: T | undefined;
  for (const record of records) {
    const stored = normalizeTokenHash(record.tokenHash);
    const candidate =
      stored === null ? Buffer.alloc(presentedHash.length) : Buffer.from(stored, 'hex');
    const equal = timingSafeEqual(presentedHash, candidate) && stored !== null;
    if (equal && match === undefined) match = record;
  }
  return match;
}

/** A pairing nonce: 32 random bytes, base64url. */
export function mintNonce(random: RandomBytes = nodeRandomBytes): string {
  return random(32).toString('base64url');
}

/** A device / request id: a prefix and 16 random bytes, base64url. */
export function mintId(prefix: string, random: RandomBytes = nodeRandomBytes): string {
  return `${prefix}_${random(16).toString('base64url')}`;
}

/**
 * Replace every device token in `text` with its fingerprint, for anything that
 * might be logged. A token must never reach a log (devices-tailscale §4.11).
 */
export function redactTokens(text: string): string {
  return text.replace(/bdt_[A-Za-z0-9_-]{43}/g, (t) => `bdt_…${tokenFingerprint(t)}`);
}
