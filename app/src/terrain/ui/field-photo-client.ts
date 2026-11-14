import {compress} from './QuickTools';

export interface PickedPhoto {
  id: string;
  file: File;
}

const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function selectPhotos(files: File[], remaining = 5): PickedPhoto[] {
  if (files.length > remaining) {
    throw new Error('Cinq photos maximum par observation.');
  }
  if (files.some(file => file.size > 15_000_000 || file.size === 0 || !allowedTypes.has(file.type))) {
    throw new Error('Choisissez une photo JPEG, PNG ou WebP de 15 Mo maximum.');
  }
  return files.map(file => ({id: crypto.randomUUID(), file}));
}

export async function sendFieldPhoto(noteId: string, selected: PickedPhoto): Promise<void> {
  selectPhotos([selected.file], 1);
  const file = await compress(selected.file);
  if (!file.size || file.size > 5_000_000) {
    throw new Error('La photo reste trop volumineuse. Choisissez une image plus petite.');
  }
  const body = new FormData();
  body.set('note_id', noteId);
  body.set('photo_id', selected.id);
  body.set('photo', file, 'rayon.jpg');
  body.set('no_person', 'true');
  const response = await fetch('/api/field-photos', {
    method: 'POST',
    body,
    credentials: 'same-origin'
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Envoi non confirmé. Vérifiez votre connexion puis réessayez.');
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object') {
    throw new Error('Envoi non confirmé. Réessayez cette photo.');
  }
  const data = result as {ok?: boolean; error?: unknown};
  if (!response.ok || data.ok !== true) {
    const message = typeof data.error === 'string' ? data.error : 'Photo non enregistrée.';
    throw new Error(message);
  }
}
