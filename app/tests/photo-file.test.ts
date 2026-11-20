import {expect, test} from 'bun:test';
import {PHOTO_MAX_BYTES, UPLOAD_MAX_BYTES, shrink, validatePhoto} from '../src/terrain/ui/photo-file';

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

// Fake encoder: the JPEG size grows with the pixel count and the quality.
function encoder(bytesPerPixel: number) {
  const calls: {width: number; height: number; quality: number}[] = [];
  const encode = async (width: number, height: number, quality: number) => {
    calls.push({width, height, quality});
    return new Blob([new Uint8Array(Math.round(width * height * bytesPerPixel * quality))]);
  };
  return {calls, encode};
}

test('every upload is capped: the first encoding under 600 KB is kept, at 1280 px at most', async () => {
  const {calls, encode} = encoder(0.4);
  const blob = await shrink(4000, 3000, encode);
  expect(calls[0]).toEqual({width: 1280, height: 960, quality: 0.72});
  expect(blob.size).toBeLessThanOrEqual(UPLOAD_MAX_BYTES);
  expect(calls).toHaveLength(1);
});

test('a heavy photo is re-encoded smaller and at lower quality until it fits', async () => {
  const {calls, encode} = encoder(1.2);
  const blob = await shrink(3000, 4000, encode);
  expect(blob.size).toBeLessThanOrEqual(UPLOAD_MAX_BYTES);
  expect(calls.length).toBeGreaterThan(1);
  for (let i = 1; i < calls.length; i++) {
    expect(calls[i].height).toBeLessThan(calls[i - 1].height);
    expect(calls[i].quality).toBeLessThan(calls[i - 1].quality);
  }
  expect(Math.max(calls[0].width, calls[0].height)).toBe(1280);
});

test('small photos are never enlarged', async () => {
  const {calls, encode} = encoder(0.4);
  await shrink(800, 600, encode);
  expect(calls[0]).toMatchObject({width: 800, height: 600});
});

test('a photo that never fits is refused instead of sending an oversized upload', async () => {
  const {calls, encode} = encoder(50);
  await expect(shrink(4000, 3000, encode)).rejects.toThrow('trop volumineuse');
  expect(calls).toHaveLength(5);
});
