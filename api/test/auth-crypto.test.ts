import {expect, test} from 'bun:test';
import {DUMMY_PASSWORD_HASH, hashNewPassword, passwordHash, passwordHashAsync, randomSalt, verifyPassword} from '../src/common/crypto';

// PBKDF2-HMAC-SHA256("password", "salt"), 32 bytes, cross-checked with Python's hashlib.
const SALT = '73616c74';
const LEGACY = '0394a2ede332c9a13eb82e9b24631604c31df978b4e2f0fbd2c549944f9d79a5'; // 100,000 iterations
const CURRENT = 'pbkdf2-sha256$600000$669cfe52482116fda1aa2cbe409b2f56c8e4563752b7a28f6eaab614ee005178';

test('legacy hashing keeps its parameters and verifies, asking for an upgrade', async () => {
  expect(passwordHash('password', SALT)).toBe(LEGACY);
  expect(await passwordHashAsync('password', SALT)).toBe(LEGACY);
  expect(await verifyPassword('password', SALT, LEGACY)).toEqual({ok: true, needsUpgrade: true});
  expect(await verifyPassword('Password', SALT, LEGACY)).toEqual({ok: false, needsUpgrade: false});
  expect(await verifyPassword('password', randomSalt(), LEGACY)).toEqual({ok: false, needsUpgrade: false});
});

test('current hashes are self-describing, salted per call and need no upgrade', async () => {
  expect(await verifyPassword('password', SALT, CURRENT)).toEqual({ok: true, needsUpgrade: false});
  expect(await verifyPassword('Password', SALT, CURRENT)).toEqual({ok: false, needsUpgrade: false});
  const a = await hashNewPassword('secret'), b = await hashNewPassword('secret');
  expect(a.hash).toMatch(/^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/);
  expect(a.salt).toMatch(/^[a-f0-9]{32}$/);
  expect(a.salt).not.toBe(b.salt);
  expect(a.hash).not.toBe(b.hash);
  expect(await verifyPassword('secret', a.salt, a.hash)).toEqual({ok: true, needsUpgrade: false});
  expect(await verifyPassword('secret', b.salt, a.hash)).toEqual({ok: false, needsUpgrade: false});
  expect(await verifyPassword('wrong', a.salt, a.hash)).toEqual({ok: false, needsUpgrade: false});
});

test('a cheaper current-format hash asks for an upgrade; malformed hashes never match', async () => {
  const salt = randomSalt();
  const legacy = passwordHash('secret', salt);
  expect(await verifyPassword('secret', salt, 'pbkdf2-sha256$100000$' + legacy)).toEqual({ok: true, needsUpgrade: true});
  for (const stored of ['', 'pbkdf2-sha256$0$' + legacy, 'pbkdf2-sha256$99999999$' + legacy, 'pbkdf2-sha256$600000$zz', legacy.toUpperCase()]) {
    expect(await verifyPassword('secret', salt, stored)).toEqual({ok: false, needsUpgrade: false});
  }
});

test('the unknown-account dummy hash costs a current-format verification and matches nothing', async () => {
  const sample = await hashNewPassword('');
  expect(DUMMY_PASSWORD_HASH.split('$').slice(0, 2)).toEqual(sample.hash.split('$').slice(0, 2));
  expect((await verifyPassword('', '0123456789abcdef0123456789abcdef', DUMMY_PASSWORD_HASH)).ok).toBe(false);
});

test('a failed check on a legacy hash is padded to the cost of an unknown username', async () => {
  const median = async (stored: string) => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await verifyPassword('wrong', SALT, stored);
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[1];
  };
  // Unpadded, a legacy check costs a sixth of the dummy one; allow wide scheduling noise.
  expect(await median(LEGACY)).toBeGreaterThan((await median(DUMMY_PASSWORD_HASH)) * 0.6);
});
