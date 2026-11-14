const PHOTO_BODY_LIMIT = 5_300_000;

function reject(message: string, status: number): never {
  throw Object.assign(new Error(message), {status});
}

/** Limit bytes actually received, including requests without Content-Length. */
export async function photoFormData(request: Request): Promise<FormData> {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('multipart/form-data;') || !/boundary=/i.test(type)) {
    reject('Un formulaire photo est requis.', 415);
  }
  const advertised = Number(request.headers.get('content-length') || '0');
  if (!Number.isFinite(advertised) || advertised < 0 || advertised > PHOTO_BODY_LIMIT) {
    reject('Photo trop volumineuse.', 413);
  }
  if (!request.body) reject('Aucune photo reçue.', 400);
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > PHOTO_BODY_LIMIT) {
        await reader.cancel();
        reject('Photo trop volumineuse.', 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes, {headers: {'Content-Type': type}}).formData();
  } catch {
    reject('Le formulaire photo est incomplet. Réessayez l’envoi.', 400);
  }
}
