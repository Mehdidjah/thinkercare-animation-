import {attachPhoto, compress, validatePhoto} from './photo-file';
import {upload} from './client';

export interface PickedPhoto {
  id: string;
  file: File;
}

export function selectPhotos(files: File[], remaining = 5): PickedPhoto[] {
  if (files.length > remaining) {
    throw new Error(remaining === 5 ? 'Cinq photos maximum par observation.' : 'Cinq photos maximum par observation : ' + remaining + ' encore possible(s).');
  }
  files.forEach(validatePhoto);
  return files.map(file => ({id: crypto.randomUUID(), file}));
}

export async function sendFieldPhoto(noteId: string, selected: PickedPhoto): Promise<void> {
  selectPhotos([selected.file], 1);
  const body = new FormData();
  body.set('note_id', noteId);
  body.set('photo_id', selected.id);
  await attachPhoto(body, await compress(selected.file), 'rayon.jpg');
  body.set('no_person', 'true');
  const result = await upload('/api/field-photos', body);
  if (result.ok !== true) throw new Error('Photo non enregistrée. Réessayez cette photo.');
}
