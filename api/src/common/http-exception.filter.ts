import {Catch, type ArgumentsHost, type ExceptionFilter} from '@nestjs/common';
import type {Response} from 'express';
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
 *   unique / serialization clash  -> 409
 *   fallback                      -> 500
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const {status, body} = map(exception);
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.status(status).json(body);
    }
  }
}

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
  if (code === '23505' || code === '40001' || code === '40P01' || msg.includes('UNIQUE') || msg.includes('tf_guards'))
    return {status: 409, body: {error: 'Données modifiées ou enregistrement déjà présent. Actualisez avant de réessayer.'}};
  return {status: 500, body: {error: 'L’opération n’a pas abouti. Les données confirmées sont conservées.'}};
}
