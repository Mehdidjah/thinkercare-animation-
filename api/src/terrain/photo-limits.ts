import {fail} from '../common/errors';

export const PHOTO_MAX_BYTES = 20_000_000;
// Allow multipart boundaries and form fields in addition to the image itself.
export const PHOTO_BODY_LIMIT = PHOTO_MAX_BYTES + 300_000;

export function photoFile(value: unknown): File {
  if (!(value instanceof File) || value.size < 12) fail('Une photo JPEG, PNG ou WebP est requise.');
  if (value.size > PHOTO_MAX_BYTES) fail('Photo de 20 Mo maximum.', 413);
  return value;
}
