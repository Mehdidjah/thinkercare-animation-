import {createHash, pbkdf2, pbkdf2Sync, randomBytes, randomUUID} from 'node:crypto';

/** Hex-encode bytes. */
export const hex = (b: Buffer | Uint8Array) => Buffer.from(b).toString('hex');

/** SHA-256 hex of a string (session token hashing + throttle bucket keys). */
export function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const LEGACY_ITERATIONS = 100000;

/**
 * Legacy login hash: PBKDF2-SHA256, 100k iterations, per-user salt (hex) —
 * identical parameters to the original Cloudflare `crypto.subtle` derivation,
 * 256-bit output, stored as bare hex.
 */
export function passwordHash(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, 'hex');
  return hex(pbkdf2Sync(password, salt, LEGACY_ITERATIONS, 32, 'sha256'));
}

/** Same password hash, computed off the request/event-loop thread. */
export function passwordHashAsync(password: string, saltHex: string): Promise<string> {
  return derive(password, saltHex, LEGACY_ITERATIONS);
}

function derive(password: string, saltHex: string, iterations: number): Promise<string> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256', (error, hash) => {
      if (error) reject(error); else resolve(hex(hash));
    });
  });
}

// Current login hash: PBKDF2-SHA256 at OWASP's 600k iterations. The stored value
// names its scheme and cost ("pbkdf2-sha256$600000$<hex>", salt column unchanged)
// so legacy bare-hex hashes stay verifiable and the cost can be raised later.
const ITERATIONS = 600000;
const STORED = /^pbkdf2-sha256\$([1-9]\d{0,6})\$([a-f0-9]{64})$/;

/** Fresh salt + hash in the current format. */
export async function hashNewPassword(password: string): Promise<{salt: string; hash: string}> {
  const salt = randomSalt();
  return {salt, hash: `pbkdf2-sha256$${ITERATIONS}$${await derive(password, salt, ITERATIONS)}`};
}

/** Checks either format; needsUpgrade is true when the password matched a weaker stored hash. */
export async function verifyPassword(password: string, salt: string, stored: string): Promise<{ok: boolean; needsUpgrade: boolean}> {
  const current = stored.match(STORED);
  const iterations = current ? Number(current[1]) : LEGACY_ITERATIONS;
  const ok = equal(await derive(password, salt, iterations), current ? current[2] : stored);
  // A weaker hash is padded to the current cost, so a failed login on a not yet
  // upgraded account takes as long as one on an unknown username.
  if (iterations < ITERATIONS) await derive(password, salt, ITERATIONS - iterations);
  return {ok, needsUpgrade: ok && iterations < ITERATIONS};
}

/** Current-format hash no password matches: verifying it costs as much as a real account. */
export const DUMMY_PASSWORD_HASH = `pbkdf2-sha256$${ITERATIONS}$${'0'.repeat(64)}`;

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
