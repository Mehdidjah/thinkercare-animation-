export const PHOTO_MAX_BYTES = 20_000_000;
// Uploads above ~1 MB stall at the Railway edge (b095930): every upload path stays under this.
export const UPLOAD_MAX_BYTES = 600_000;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const QUALITIES = [0.72, 0.6, 0.5, 0.42, 0.35];

export function validatePhoto(file: File): void {
  if (!file.size || file.size > PHOTO_MAX_BYTES || !allowedTypes.has(file.type)) {
    throw new Error('Choisissez une photo JPEG, PNG ou WebP de 20 Mo maximum.');
  }
}

type Encode = (width: number, height: number, quality: number) => Promise<Blob>;

/** Re-encodes from 1280 px on the longest side, lowering quality and size by
 * 15 % per attempt, until the JPEG fits UPLOAD_MAX_BYTES. Never enlarges. */
export async function shrink(width: number, height: number, encode: Encode): Promise<Blob> {
  let longest = 1280;
  for (const quality of QUALITIES) {
    const scale = Math.min(1, longest / Math.max(width, height));
    const blob = await encode(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), quality);
    if (blob.size && blob.size <= UPLOAD_MAX_BYTES) return blob;
    longest = Math.round(longest * 0.85);
  }
  throw new Error('La photo reste trop volumineuse. Choisissez une image plus petite.');
}

/** The single compressor used by every photo upload (pointage, suivi, retours terrain). */
export async function compress(file: File): Promise<Blob> {
  validatePhoto(file);
  const image = await createImageBitmap(file).catch(() => {
    throw new Error('Photo illisible. Choisissez une autre image.');
  });
  try {
    return await shrink(image.width, image.height, (width, height, quality) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
      return new Promise<Blob>((ok, no) => canvas.toBlob(blob => blob ? ok(blob) : no(new Error('Photo illisible. Choisissez une autre image.')), 'image/jpeg', quality));
    });
  } finally {
    image.close();
  }
}
