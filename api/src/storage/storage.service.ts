import {Injectable} from '@nestjs/common';
import {Readable} from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

/**
 * S3-compatible object storage for photos (Cloudflare R2 / AWS S3 / Backblaze /
 * MinIO), replacing the R2 binding. Keys: `terrain/<uuid>` (mission photos),
 * `terrain-notes/<uuid>` (field-note photos).
 *
 * If the S3 env is NOT set the service reports `configured() === false` and the
 * photo endpoints answer 503 "Stockage indisponible", so the app still deploys
 * and the dashboard works before storage is wired up.
 */
@Injectable()
export class StorageService {
  private client: S3Client | null = null;
  private bucket = process.env.S3_BUCKET || '';

  constructor() {
    const {S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY} = process.env;
    if (S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
      this.client = new S3Client({
        region: S3_REGION || 'auto',
        endpoint: S3_ENDPOINT || undefined,
        forcePathStyle: !!S3_ENDPOINT, // path-style for R2/MinIO & most S3-compatible endpoints
        credentials: {accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY},
      });
      this.bucket = S3_BUCKET;
    }
  }

  configured(): boolean {
    return this.client !== null;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client!.send(
      new PutObjectCommand({Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType}),
    );
  }

  /** Returns a Node Readable for streaming to the response, or null if absent. */
  async get(key: string): Promise<Readable | null> {
    try {
      const out = await this.client!.send(new GetObjectCommand({Bucket: this.bucket, Key: key}));
      return (out.Body as Readable) || null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client!.send(new DeleteObjectCommand({Bucket: this.bucket, Key: key}));
    } catch {
      /* best-effort rollback delete */
    }
  }
}
