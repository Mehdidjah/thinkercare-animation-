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
 * 503 "Stockage indisponible"; the rest of the app still works.
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
    if (S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
      this.client = new S3Client({
        region: S3_REGION || 'auto',
        endpoint: S3_ENDPOINT || undefined,
        forcePathStyle: !!S3_ENDPOINT,
        credentials: {accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY},
      });
      this.bucket = S3_BUCKET;
    } else if (STORAGE_DIR) {
      this.dir = resolve(STORAGE_DIR);
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
    if (this.client) {
      await this.client.send(
        new PutObjectCommand({Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType}),
      );
      return;
    }
    const p = this.path(key);
    await fsp.mkdir(dirname(p), {recursive: true});
    await fsp.writeFile(p, bytes);
  }

  /** Returns a Node Readable for streaming to the response, or null if absent. */
  async get(key: string): Promise<Readable | null> {
    if (this.client) {
      try {
        const out = await this.client.send(new GetObjectCommand({Bucket: this.bucket, Key: key}));
        return (out.Body as Readable) || null;
      } catch {
        return null;
      }
    }
    const p = this.path(key);
    try {
      await fsp.access(p);
      return createReadStream(p);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.client) {
      try {
        await this.client.send(new DeleteObjectCommand({Bucket: this.bucket, Key: key}));
      } catch {
        /* best-effort rollback delete */
      }
      return;
    }
    try {
      await fsp.unlink(this.path(key));
    } catch {
      /* best-effort */
    }
  }
}
