import {expect, test} from 'bun:test';
import {PHOTO_MAX_BYTES, validatePhoto} from '../src/terrain/ui/photo-file';

test('photo selectors accept files up to 20 MB and reject files above the limit', () => {
  const image = new File([new Uint8Array(PHOTO_MAX_BYTES)], 'large.jpg', {type: 'image/jpeg'});
  expect(() => validatePhoto(image)).not.toThrow();
  expect(() => validatePhoto(new File([image, 'x'], 'large.jpg', {type: 'image/jpeg'}))).toThrow('20 Mo maximum');
});

test('empty files and unsupported formats remain rejected', () => {
  expect(() => validatePhoto(new File([], 'empty.jpg', {type: 'image/jpeg'}))).toThrow();
  expect(() => validatePhoto(new File(['text'], 'not-a-photo.html', {type: 'text/html'}))).toThrow();
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    expect(() => validatePhoto(new File(['image'], 'photo', {type}))).not.toThrow();
  }
});
