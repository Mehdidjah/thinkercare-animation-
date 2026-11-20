import {expect, test} from 'bun:test';
import {PHOTO_MAX_BYTES, THUMB_MAX_BYTES, UPLOAD_MAX_BYTES, attachPhoto, fit, shrink, validatePhoto} from '../src/terrain/ui/photo-file';

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

test('grid thumbnails keep the proportions within 480 px and never enlarge', () => {
  expect(fit(1280, 960, 480)).toEqual([480, 360]);
  expect(fit(960, 1280, 480)).toEqual([360, 480]);
  expect(fit(300, 200, 480)).toEqual([300, 200]);
  expect(fit(5000, 1, 480)).toEqual([480, 1]);
});

test('an upload carries its thumbnail when one could be made and is small enough', async () => {
  const photo = new Blob([new Uint8Array(1000)], {type: 'image/jpeg'});
  const sent = async (thumbnail: Blob | null) => {
    const body = new FormData();
    await attachPhoto(body, photo, 'stock.jpg', async () => thumbnail);
    return {photo: body.get('photo') as File, thumb: body.get('thumb') as File | null};
  };
  const ok = await sent(new Blob([new Uint8Array(200)], {type: 'image/jpeg'}));
  expect([ok.photo.name, ok.photo.size, ok.thumb?.name, ok.thumb?.size]).toEqual(['stock.jpg', 1000, 'miniature.jpg', 200]);
  for (const without of [null, new Blob([]), new Blob([new Uint8Array(THUMB_MAX_BYTES + 1)])]) {
    const result = await sent(without);
    expect(result.photo.size).toBe(1000);
    expect(result.thumb).toBeNull();
  }
});
