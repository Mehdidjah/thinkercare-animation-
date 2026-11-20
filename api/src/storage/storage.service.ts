import {Injectable} from '@nestjs/common';
import {Readable} from 'node:stream';
import {createReadStream, promises as fsp} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

/** Which backend StorageService will use for this environment (S3 wins when both are set). */
export function storageBackend(env: NodeJS.ProcessEnv = process.env): 's3' | 'filesystem' | null {
  if (env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) return 's3';
  return env.STORAGE_DIR ? 'filesystem' : null;
}

/** Logs a storage failure with the key and error code only — never file contents or credentials. */
function report(operation: string, key: string, e: any) {
  const missing = e?.code === 'ENOENT' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
  const detail = [e?.name, e?.code, e?.message].filter(Boolean).join(' ');
  (missing ? console.warn : console.error)(`[storage] ${operation} ${key} failed: ${detail}`);
}

/**
 * Photo storage with two interchangeable backends. Keys are `terrain/<uuid>`
 * (mission photos) and `terrain-notes/<uuid>` (field-note photos).
 *
 *  1. S3-compatible (Cloudflare R2 / AWS S3 / Backblaze / MinIO) — when the
 *     S3_* env vars are set.
 *  2. Filesystem — when STORAGE_DIR is set (e.g. a mounted Railway volume at
 *     /data). This keeps photos on Railway with no external storage account.
 *
 * If neither is set, `configured() === false` and the photo endpoints answer
 * 503 "Stockage indisponible" (check-in and check-out need a photo).
 * (Content-Type is taken from the DB `mime` column when serving, so the
 * filesystem backend does not need to persist it.)
 */
@Injectable()
export class StorageService {
  private client: S3Client | null = null;
  private bucket = '';
  private dir: string | null = null;

  constructor() {
    const {
      S3_ENDPOINT,
      S3_BUCKET,
      S3_REGION,
      S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY,
      STORAGE_DIR,
    } = process.env;
    const backend = storageBackend();
    if (backend === 's3') {
      this.client = new S3Client({
        region: S3_REGION || 'auto',
        endpoint: S3_ENDPOINT || undefined,
        forcePathStyle: !!S3_ENDPOINT,
        credentials: {accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY!},
        // The SDK default is no timeout at all: a stalled connection would hold
        // one of its 50 sockets forever and eventually block every photo.
        requestHandler: {connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true, socketTimeout: 30_000},
      });
      this.bucket = S3_BUCKET!;
    } else if (backend === 'filesystem') {
      this.dir = resolve(STORAGE_DIR!);
    }
  }

  configured(): boolean {
    return this.client !== null || this.dir !== null;
  }

  /** Map a storage key to an absolute path inside STORAGE_DIR, blocking traversal. */
  private path(key: string): string {
    const safe = key
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
    return join(this.dir!, safe);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try {
      if (this.client) {
        await this.client.send(
          new PutObjectCommand({Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType}),
        );
        return;
      }
      const p = this.path(key);
      await fsp.mkdir(dirname(p), {recursive: true});
      await fsp.writeFile(p, bytes);
    } catch (e) {
      report('put', key, e);
      throw e;
    }
  }

  /** Opens an object for streaming, with its byte size when known, or null if absent/unreadable. */
  async open(key: string): Promise<{stream: Readable; size?: number} | null> {
    if (this.client) {
      try {
        const out = await this.client.send(new GetObjectCommand({Bucket: this.bucket, Key: key}));
        return out.Body ? {stream: out.Body as Readable, size: out.ContentLength} : null;
      } catch (e) {
        report('get', key, e);
        return null;
      }
    }
    const p = this.path(key);
    try {
      const {size} = await fsp.stat(p);
      return {stream: createReadStream(p), size};
    } catch (e) {
      report('get', key, e);
      return null;
    }
  }

  /** Returns a Node Readable for streaming to the response, or null if absent. */
  async get(key: string): Promise<Readable | null> {
    return (await this.open(key))?.stream ?? null;
  }

  async delete(key: string): Promise<void> {
    try {
      if (this.client) await this.client.send(new DeleteObjectCommand({Bucket: this.bucket, Key: key}));
      else await fsp.unlink(this.path(key));
    } catch (e) {
      /* best-effort rollback delete */
      report('delete', key, e);
    }
  }
}
