import {Injectable} from '@nestjs/common';
import type {Request, Response} from 'express';
import {pipeline} from 'node:stream';
import {z} from 'zod';
import {db} from '../db/client';
import {first, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {randomUUID} from '../common/crypto';
import {uuid, text} from '../common/validation';
import {mission, noteBy, auditSql, batchMission} from './helpers';
import {StorageService} from '../storage/storage.service';
import {canEdit, clockIssue, manages, type User} from '../domain/core';
import {photoFormData} from './body';
import {photoFile} from './photo-limits';

const iso = () => new Date().toISOString();

/** Magic-byte MIME sniffing (JPEG / PNG / WebP), ported verbatim. */
function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (Array.from(bytes.slice(0, 8)).join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}

@Injectable()
export class PhotosService {
  constructor(private readonly storage: StorageService) {}

  // POST /api/photos — port of uploadPhoto(). (Origin check performed by controller.)
  async uploadPhoto(u: User, req: Request): Promise<any> {
    if (u.force_change) fail('Changez votre mot de passe.', 403);
    const form = await photoFormData(req);
    const file = photoFile(form.get('photo'));
    const key = uuid.parse(form.get('mission_id'));
    const purpose = z.enum(['report', 'checkin', 'checkout']).parse(form.get('purpose') || 'report');
    const photo = uuid.parse(form.get('photo_id') || randomUUID());
    const m = await mission(db(), u, key);

    const old = await first<any>(db(), sql`SELECT mission_id,user_id,purpose FROM tf_photos WHERE id=${photo}`);
    if (old) {
      if (old.mission_id !== m.id || old.user_id !== u.id || old.purpose !== purpose)
        fail('Identifiant photo déjà utilisé.', 409);
      return {ok: true, id: photo, duplicate: true};
    }
    if (purpose === 'report') {
      if (!canEdit(u, m)) fail('Cette animation est verrouillée.', 409);
    } else {
      const issue = clockIssue(u, m, purpose);
      if (issue) fail(issue, 409);
    }
    if (purpose === 'checkin') {
      // tf_one_ongoing would reject the check-in only after the photo is stored, with a generic message.
      const busy = await first<any>(
        db(),
        sql`SELECT m.day,s.name FROM tf_missions m JOIN tf_stores s ON s.id=m.store_id
            WHERE m.field_id=${m.field_id} AND m.status='ongoing' AND m.id<>${m.id} LIMIT 1`,
      );
      if (busy)
        fail(`Une autre animation est encore en cours (${busy.name}, ${busy.day.split('-').reverse().join('/')}). Pointez d’abord votre départ de cette animation.`, 409);
    }
    if (form.get('no_person') !== 'true') fail('Confirmez une photo du lieu sans personnes ni documents personnels.');
    const caption = text(300).parse(form.get('caption') || '');
    const bytes = new Uint8Array(await (file as File).arrayBuffer());
    const mime = sniff(bytes);
    if (!mime) fail('Format image non reconnu.');
    const n = await first<any>(db(), sql`SELECT COUNT(*) AS n FROM tf_photos WHERE mission_id=${m.id} AND purpose='report'`);
    if (purpose === 'report' && n.n >= 15) fail('15 photos de suivi maximum par animation.');

    if (!this.storage.configured()) fail('Stockage photo indisponible.', 503);
    const objectKey = 'terrain/' + randomUUID();
    const at = iso();
    await this.storage.put(objectKey, bytes, mime!);
    try {
      const writes = [
        sql`INSERT INTO tf_photos(id,mission_id,user_id,created_at,caption,mime,size,object_key,purpose)
            VALUES(${photo},${m.id},${u.id},${at},${caption},${mime},${(file as File).size},${objectKey},${purpose})`,
      ];
      if (purpose === 'checkin')
        writes.push(sql`UPDATE tf_missions SET status='ongoing',actual_start=${at},start_photo_id=${photo} WHERE id=${m.id}`);
      if (purpose === 'checkout')
        writes.push(sql`UPDATE tf_missions SET status='completed',actual_end=${at},end_photo_id=${photo} WHERE id=${m.id}`);
      await batchMission(u, m, purpose === 'report' ? 'photo.added' : 'clock.' + purpose, writes, {photo, purpose});
    } catch (e) {
      await this.storage.delete(objectKey);
      throw e;
    }
    return {ok: true, id: photo, serverTime: at};
  }

  // GET /api/photos?id= — port of getPhoto().
  async getPhoto(u: User, req: Request, res: Response): Promise<void> {
    if (u.force_change) fail('Changez votre mot de passe.', 403);
    const p = await first<any>(db(), sql`SELECT * FROM tf_photos WHERE id=${uuid.parse(req.query.id)}`);
    if (!p) fail('Photo introuvable.', 404);
    await mission(db(), u, p.mission_id);
    await this.send(req, res, p, {'Content-Disposition': 'inline'});
  }

  /**
   * Streams a stored photo after the caller's access check. A photo id always
   * names the same bytes, so the browser may keep it (private: never shared
   * caches) and revalidate by ETag. pipeline() destroys the storage stream when
   * the client aborts or either side fails, so no file handle or socket leaks.
   */
  private async send(req: Request, res: Response, p: any, extra: Record<string, string> = {}): Promise<void> {
    const cache = {'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${p.id}"`};
    const known = String(req.headers['if-none-match'] || '').split(',');
    if (known.some((tag) => tag.trim().replace(/^W\//, '') === cache.ETag)) {
      res.set(cache).status(304).end();
      return;
    }
    if (!this.storage.configured()) fail('Stockage indisponible.', 503);
    const file = await this.storage.open(p.object_key);
    if (!file) fail('Photo indisponible.', 404);
    res.set({...cache, 'Content-Type': p.mime, 'X-Content-Type-Options': 'nosniff', ...extra});
    if (file!.size !== undefined) res.setHeader('Content-Length', String(file!.size));
    pipeline(file!.stream, res, (e) => {
      if (e && (e as any).code !== 'ERR_STREAM_PREMATURE_CLOSE')
        console.error(`[photos] streaming ${p.object_key} failed: ${e.message}`);
    });
  }

  // GET/POST /api/field-photos — port of fieldPhotoEndpoint() (uploadFieldMedia / readFieldMedia).
  async uploadFieldMedia(u: User, req: Request): Promise<any> {
    if (u.role === 'doctor') fail('Accès non autorisé.', 403);
    const f = await photoFormData(req);
    const input = photoFile(f.get('photo'));
    const key = uuid.parse(f.get('note_id'));
    const photo = uuid.parse(f.get('photo_id'));
    const n = await noteBy(db(), u, key);
    if (n.author_id !== u.id && !manages(u)) fail('Ajout non autorisé.', 403);
    const old = await first<any>(db(), sql`SELECT note_id,user_id FROM tf_field_photos WHERE id=${photo}`);
    if (old) {
      if (old.note_id !== key || old.user_id !== u.id) fail('Identifiant déjà utilisé.', 409);
      return {ok: true, id: photo};
    }
    if (f.get('no_person') !== 'true') fail('Confirmez une photo de rayon sans personnes ni documents personnels.');
    const bytes = new Uint8Array(await (input as File).arrayBuffer());
    const mime = sniff(bytes);
    if (!mime) fail('Format image non reconnu.');
    if (!this.storage.configured()) fail('Stockage indisponible.', 503);
    const object = 'terrain-notes/' + randomUUID();
    await this.storage.put(object, bytes, mime!);
    try {
      await serializable(async (tx) => {
        await run(
          tx,
          sql`INSERT INTO tf_field_photos(id,note_id,user_id,object_key,mime,size,created_at)
              VALUES(${photo},${key},${u.id},${object},${mime},${(input as File).size},${iso()})`,
        );
        await run(tx, auditSql(u, 'field-note.photo', key));
      });
    } catch (e) {
      await this.storage.delete(object);
      if (String(e).includes('FIELD_PHOTO_LIMIT')) fail('Cinq photos maximum par observation.');
      throw e;
    }
    return {ok: true, id: photo};
  }

  async readFieldMedia(u: User, req: Request, res: Response): Promise<void> {
    const p = await first<any>(db(), sql`SELECT * FROM tf_field_photos WHERE id=${uuid.parse(req.query.id)}`);
    if (!p) fail('Photo introuvable.', 404);
    await noteBy(db(), u, p.note_id);
    await this.send(req, res, p);
  }
}
