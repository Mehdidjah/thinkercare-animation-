export const PHOTO_MAX_BYTES = 20_000_000;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validatePhoto(file: File): void {
  if (!file.size || file.size > PHOTO_MAX_BYTES || !allowedTypes.has(file.type)) {
    throw new Error('Choisissez une photo JPEG, PNG ou WebP de 20 Mo maximum.');
  }
}
