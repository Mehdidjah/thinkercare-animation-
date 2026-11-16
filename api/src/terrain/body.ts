import type {Request} from 'express';
import {fail} from '../common/errors';
import {PHOTO_BODY_LIMIT} from './photo-limits';

/**
 * Port of body.server.ts — reads the multipart body off the raw Express request
 * stream with a hard byte cap (including requests without Content-Length), then
 * parses it with the WHATWG FormData parser (undici, built into Node 20+),
 * exactly like the original `new Response(bytes).formData()`.
 *
 * Requires that NO upstream body parser consumed the stream — main.ts only
 * applies express.text() to /api/terrain, leaving the photo routes untouched.
 */
export async function photoFormData(req: Request): Promise<FormData> {
  const type = req.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('multipart/form-data;') || !/boundary=/i.test(type))
    fail('Un formulaire photo est requis.', 415);
  const advertised = Number(req.headers['content-length'] || '0');
  if (!Number.isFinite(advertised) || advertised < 0 || advertised > PHOTO_BODY_LIMIT)
    fail('Photo trop volumineuse.', 413);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > PHOTO_BODY_LIMIT) {
      req.destroy();
      fail('Photo trop volumineuse.', 413);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return await new Response(bytes, {headers: {'Content-Type': type}}).formData();
  } catch {
    fail('Le formulaire photo est incomplet. Réessayez l’envoi.', 400);
  }
}
