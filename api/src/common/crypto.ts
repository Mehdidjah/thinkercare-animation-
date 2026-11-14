import {createHash, pbkdf2Sync, randomBytes, randomUUID} from 'node:crypto';

/** Hex-encode bytes. */
export const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString('hex');

/** SHA-256 hex of a string (session token hashing + throttle bucket keys). */
export function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * PBKDF2-SHA256, 100k iterations, per-user salt (hex) — identical parameters to
 * the original Cloudflare `crypto.subtle` derivation, 256-bit output.
 */
export function passwordHash(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, 'hex');
  return hex(pbkdf2Sync(password, salt, 100000, 32, 'sha256'));
}

/**
 * Length-independent constant-time-ish string comparison, ported verbatim from
 * the original `equal()` so hashes of differing length never early-return.
 */
export function equal(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/** 32 random bytes hex — the raw session token stored client-side (cookie). */
export const randomToken = () => hex(randomBytes(32));

/** 16 random bytes hex — a per-user password salt. */
export const randomSalt = () => hex(randomBytes(16));

export {randomUUID};
