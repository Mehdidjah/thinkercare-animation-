import {expect, test} from 'bun:test';
import {Readable} from 'node:stream';
import {photoFormData} from '../src/terrain/body';
import {PHOTO_BODY_LIMIT, PHOTO_MAX_BYTES, photoFile} from '../src/terrain/photo-limits';

test('a 20 MB photo is accepted, while a single byte above the limit is rejected', () => {
  const image = new File([new Uint8Array(PHOTO_MAX_BYTES)], 'large.jpg', {type: 'image/jpeg'});
  expect(photoFile(image)).toBe(image);
  expect(() => photoFile(new File([image, 'x'], 'too-large.jpg'))).toThrow('20 Mo maximum');
  expect(() => photoFile(new File([], 'empty.jpg'))).toThrow();
});

test('multipart requests are bounded before reading an oversized advertised body', async () => {
  const request = Readable.from([]) as any;
  request.headers = {'content-type': 'multipart/form-data; boundary=test', 'content-length': String(PHOTO_BODY_LIMIT + 1)};
  await expect(photoFormData(request)).rejects.toMatchObject({status: 413});
});

test('the body cap also applies when Content-Length is missing', async () => {
  const request = Readable.from([Buffer.alloc(PHOTO_BODY_LIMIT), Buffer.alloc(1)]) as any;
  request.headers = {'content-type': 'multipart/form-data; boundary=test'};
  await expect(photoFormData(request)).rejects.toMatchObject({status: 413});
  expect(request.destroyed).toBe(true);
});

test('non-multipart uploads are rejected', async () => {
  const request = Readable.from([]) as any;
  request.headers = {'content-type': 'application/json'};
  await expect(photoFormData(request)).rejects.toMatchObject({status: 415});
});
