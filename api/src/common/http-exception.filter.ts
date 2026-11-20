import {Catch, type ArgumentsHost, type ExceptionFilter} from '@nestjs/common';
import type {Request, Response} from 'express';
import {ZodError} from 'zod';
import {AppError} from './errors';

/**
 * Reproduces the original `errorResponse(e)` mapping exactly (same French
 * strings, same precedence):
 *   ZodError                      -> 400 "Vérifiez les champs : …"
 *   AppError (status-tagged)      -> that status, that message
 *   SCHEDULE_CONFLICT             -> 409
 *   STOCK_INSUFFICIENT            -> 409
 *   REPORT_LOCKED                 -> 409
 *   known unique constraint       -> 409 with a field-specific message
 *   unique / serialization clash  -> 409
 *   fallback                      -> 500 (logged with its cause)
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const {status, body} = map(exception);
    log(exception, status, http.getRequest<Request>());
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.status(status).json(body);
    }
  }
}

const UNIQUE: Record<string, string> = {
  tf_one_ongoing: 'Une autre animation est encore en cours. Pointez d’abord votre départ de cette animation.',
  tf_users_username_unique: 'Cet identifiant est déjà utilisé.',
  tf_devices_name_unique: 'Ce nom d’appareil est déjà utilisé.',
  tf_products_brand_sku: 'Cette référence (SKU) existe déjà.',
};

function map(e: any): {status: number; body: {error: string}} {
  if (e instanceof ZodError) {
    const detail = e.issues
      .slice(0, 2)
      .map((x) => x.path.join('.') + ' ' + x.message)
      .join('; ');
    return {status: 400, body: {error: 'Vérifiez les champs : ' + detail}};
  }
  if (e instanceof AppError || (e && typeof e.status === 'number')) {
    return {status: e.status, body: {error: String(e.message)}};
  }
  const msg = String(e?.message || '');
  const code = e?.code; // node-postgres SQLSTATE
  if (msg.includes('SCHEDULE_CONFLICT'))
    return {status: 409, body: {error: 'Chevauchement : l’animatrice ou ce Dermoscan est déjà programmé sur cet horaire.'}};
  if (msg.includes('STOCK_INSUFFICIENT'))
    return {status: 409, body: {error: 'Quantité supérieure au stock compté disponible. Actualisez le stock.'}};
  if (msg.includes('REPORT_LOCKED'))
    return {status: 409, body: {error: 'Le rapport a été verrouillé entre-temps. Actualisez.'}};
  if (code === '23505' && Object.hasOwn(UNIQUE, e.constraint)) return {status: 409, body: {error: UNIQUE[e.constraint]}};
  if (code === '23505' || code === '40001' || code === '40P01' || msg.includes('UNIQUE') || msg.includes('tf_guards'))
    return {status: 409, body: {error: 'Données modifiées ou enregistrement déjà présent. Actualisez avant de réessayer.'}};
  return {status: 500, body: {error: 'L’opération n’a pas abouti. Les données confirmées sont conservées.'}};
}

/**
 * Server-side trace for failures the user cannot act on: every 500 (with its
 * stack), 5xx answers, and 409s raised by the database. Only routing metadata
 * is logged — never request bodies, cookies, passwords or tokens.
 */
function log(e: any, status: number, req: Request | undefined) {
  const db = typeof e?.code === 'string' && typeof e?.severity === 'string'; // node-postgres DatabaseError
  if (status < 500 && !(status === 409 && db)) return;
  const where = [
    req?.method,
    String(req?.originalUrl || req?.url || '').split('?')[0],
    'action=' + action(req),
    'user=' + ((req as any)?.user?.id || '-'),
  ].join(' ');
  if (status === 409) return console.warn(`[http] 409 ${where} sqlstate=${e.code} constraint=${e.constraint || '-'}`);
  if (e instanceof AppError) return console.warn(`[http] ${status} ${where} ${e.message}`);
  console.error(`[http] ${status} ${where} ${db ? `sqlstate=${e.code} constraint=${e.constraint || '-'} ` : ''}${e?.stack || e?.name + ': ' + e?.message}`);
}

/** The dispatched `action` (query string, or the raw JSON body of /api/terrain), sanitised. */
function action(req: Request | undefined): string {
  let a: unknown = req?.query?.action;
  if (!a && typeof req?.body === 'string' && req.body.length <= 70000) {
    try {
      a = JSON.parse(req.body)?.action;
    } catch {
      a = undefined;
    }
  }
  return typeof a === 'string' && /^[a-z-]{1,40}$/.test(a) ? a : '-';
}
