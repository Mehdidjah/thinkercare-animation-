import type {Request} from 'express';
import {AppError, fail} from '../common/errors';
import {PHOTO_BODY_LIMIT} from './photo-limits';

/** No byte for this long, or a body still arriving after the total: the connection is cut. */
export const BODY_IDLE_MS = 20_000;
export const BODY_TOTAL_MS = 60_000;

/**
 * Port of body.server.ts — reads the multipart body off the raw Express request
 * stream with a hard byte cap (including requests without Content-Length), then
 * parses it with the WHATWG FormData parser (undici, built into Node 20+),
 * exactly like the original `new Response(bytes).formData()`.
 *
 * The read holds an upload slot (upload-limiter.ts), so a stalled or trickling
 * phone connection is dropped after BODY_IDLE_MS without data or BODY_TOTAL_MS
 * in all, instead of blocking every other photo upload. Clients send ≤600 KB.
 *
 * Requires that NO upstream body parser consumed the stream — main.ts only
 * applies express.text() to /api/terrain, leaving the photo routes untouched.
 */
export async function photoFormData(req: Request, idleMs = BODY_IDLE_MS, totalMs = BODY_TOTAL_MS): Promise<FormData> {
  const type = req.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('multipart/form-data;') || !/boundary=/i.test(type))
    fail('Un formulaire photo est requis.', 415);
  const advertised = Number(req.headers['content-length'] || '0');
  if (!Number.isFinite(advertised) || advertised < 0 || advertised > PHOTO_BODY_LIMIT)
    fail('Photo trop volumineuse.', 413);

  const chunks: Buffer[] = [];
  let size = 0;
  let slow = false;
  const cut = () => {
    slow = true;
    req.destroy();
  };
  const idle = setTimeout(cut, idleMs);
  const total = setTimeout(cut, totalMs);
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      idle.refresh();
      size += chunk.byteLength;
      if (size > PHOTO_BODY_LIMIT) {
        req.destroy();
        fail('Photo trop volumineuse.', 413);
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    // A dropped phone connection is not a server fault: answered as a 4xx, so it is not logged as a 500.
    fail(slow ? 'Envoi trop lent. Réessayez.' : 'Envoi interrompu. Réessayez.', slow ? 408 : 400);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
  if (slow) fail('Envoi trop lent. Réessayez.', 408);
  const bytes = Buffer.concat(chunks);
  try {
    return await new Response(bytes, {headers: {'Content-Type': type}}).formData();
  } catch {
    fail('Le formulaire photo est incomplet. Réessayez l’envoi.', 400);
  }
}
