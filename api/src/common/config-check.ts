import {promises as fsp} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {storageBackend} from '../storage/storage.service';

/**
 * Boot-time configuration report, so a broken environment shows up in the
 * Railway logs at deploy time instead of when a user reaches the feature.
 * Prints variable names and non-secret values only. Returns false when the
 * server cannot run at all (no DATABASE_URL); everything else is logged.
 */
export async function checkConfig(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.DATABASE_URL) {
    console.error('[config] DATABASE_URL is not set: the API cannot start.');
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(env.ACCOUNT_PASSWORD_KEY || ''))
    console.error(
      '[config] ACCOUNT_PASSWORD_KEY is missing or is not 64 hex characters: creating or resetting ' +
        'accounts, non-admin password changes and password reveal will fail (503). Login still works.',
    );

  const s3 = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((name) => env[name]);
  const backend = storageBackend(env);
  if (s3.length && backend !== 's3')
    console.error(
      `[config] incomplete S3 configuration (only ${s3.join(', ')} set): S3 needs S3_BUCKET, ` +
        'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
    );
  if (backend === 's3') {
    console.log('[config] photo storage: S3-compatible bucket');
    if (env.STORAGE_DIR) console.warn('[config] STORAGE_DIR is ignored while S3 is configured.');
  } else if (backend === 'filesystem') {
    const dir = resolve(env.STORAGE_DIR!);
    console.log(`[config] photo storage: filesystem at ${dir}`);
    await probe(dir);
  } else {
    console.error(
      '[config] no photo storage configured (STORAGE_DIR or S3_*): check-in, check-out and every ' +
        'photo upload will fail with 503.',
    );
  }

  const origins = (env.APP_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origins.length)
    console.warn('[config] APP_ORIGIN is not set: only same-host POSTs are accepted, so logins through the Vercel front end get 403.');
  for (const o of origins)
    if (!isOrigin(o)) console.warn(`[config] APP_ORIGIN entry "${o}" is not a bare origin (e.g. https://app.vercel.app) and never matches.`);
  return true;
}

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** Write, read back and delete a small file, the way photo uploads use the volume. */
async function probe(dir: string) {
  const file = join(dir, `.config-probe-${randomUUID()}`);
  const content = randomUUID();
  try {
    await fsp.mkdir(dir, {recursive: true});
    await fsp.writeFile(file, content);
    if ((await fsp.readFile(file, 'utf8')) !== content) throw new Error('read back different content');
    await fsp.unlink(file);
    console.log('[config] STORAGE_DIR write/read/delete check passed');
  } catch (e: any) {
    console.error(`[config] STORAGE_DIR write/read/delete check FAILED: ${[e?.code, e?.message].filter(Boolean).join(' ')}`);
    await fsp.rm(file, {force: true}).catch(() => {});
  }
}
