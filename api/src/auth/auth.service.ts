import {Injectable} from '@nestjs/common';
import type {Request, Response} from 'express';
import {z} from 'zod';
import {db} from '../db/client';
import {first, run, sql} from '../db/tx';
import {fail} from '../common/errors';
import {sha, passwordHash, equal, randomToken, randomSalt, randomUUID} from '../common/crypto';
import type {User} from '../domain/core';

export const COOKIE = '__Host-terrain-session';
const SESSION_MS = 28800000; // 8h
const THROTTLE_WINDOW_MS = 900000; // 15 min
const DEFAULT_SALT = '0123456789abcdef0123456789abcdef';

const text = (n = 1200) => z.string().trim().max(n);

@Injectable()
export class AuthService {
  /** Raw session token from the __Host- cookie (cookie-parser populates req.cookies). */
  token(req: Request): string {
    const fromParser = (req.cookies && req.cookies[COOKIE]) as string | undefined;
    if (fromParser) return fromParser;
    // Fallback: parse the header directly.
    const raw = req.headers.cookie || '';
    const hit = raw
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(COOKIE + '='));
    return hit ? hit.slice(COOKIE.length + 1) : '';
  }

  /** Resolve the authenticated, active user or throw the original 401s. */
  async current(req: Request): Promise<User> {
    const t = this.token(req);
    if (!/^[a-f0-9]{64}$/.test(t)) fail('Connectez-vous à votre espace.', 401);
    const u = await first<User>(
      db(),
      sql`SELECT u.id,u.username,u.label,u.role,u.active,u.force_change
          FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
          WHERE s.token_hash=${sha(t)} AND s.expires>${Date.now()} AND u.active=1`,
    );
    if (!u) fail('Votre session a expiré.', 401);
    return u!;
  }

  /** Origin/CSRF check on POST. APP_ORIGIN pins the canonical origin on Railway. */
  requireOrigin(req: Request): void {
    const origin = req.headers.origin;
    const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (origin !== expected) fail('Origine non autorisée.', 403);
  }

  /** Throttle bucket IP — first X-Forwarded-For hop (design §9.1.2), trust proxy enabled. */
  private clientIp(req: Request): string {
    const xff = (req.headers['x-forwarded-for'] as string | undefined) || '';
    const first = xff.split(',')[0].trim();
    return first || req.ip || 'unknown';
  }

  async login(body: unknown, req: Request, res: Response): Promise<{ok: true}> {
    const v = z
      .object({action: z.literal('login'), username: text(60).min(1), password: z.string().min(1).max(200)})
      .strict()
      .parse(body);
    const now = Date.now();
    const key = sha(this.clientIp(req) + '|' + Math.floor(now / THROTTLE_WINDOW_MS));
    await run(
      db(),
      sql`INSERT INTO tf_throttle(bucket,count,expires) VALUES(${key},1,${now + THROTTLE_WINDOW_MS})
          ON CONFLICT(bucket) DO UPDATE SET count=tf_throttle.count+1`,
    );
    const limit = await first<{count: number}>(db(), sql`SELECT count FROM tf_throttle WHERE bucket=${key}`);
    if ((limit?.count ?? 0) > 20) fail('Trop de tentatives. Réessayez dans 15 minutes.', 429);
    const r = await first<any>(db(), sql`SELECT * FROM tf_users WHERE username=${v.username.toLowerCase()}`);
    const h = passwordHash(v.password, r?.salt || DEFAULT_SALT);
    if (!r || !r.active || !equal(h, r.password_hash)) fail('Identifiant ou mot de passe incorrect.', 401);
    const t = randomToken();
    await run(db(), sql`INSERT INTO tf_sessions(token_hash,user_id,expires) VALUES(${sha(t)},${r.id},${now + SESSION_MS})`);
    await run(db(), sql`DELETE FROM tf_sessions WHERE expires<${now}`);
    await run(db(), sql`DELETE FROM tf_throttle WHERE expires<${now}`);
    this.setCookie(res, t, SESSION_MS);
    return {ok: true};
  }

  async logout(req: Request, res: Response): Promise<{ok: true}> {
    await run(db(), sql`DELETE FROM tf_sessions WHERE token_hash=${sha(this.token(req))}`);
    this.setCookie(res, '', 0);
    return {ok: true};
  }

  async changePassword(user: User, body: unknown, req: Request): Promise<{ok: true}> {
    const v = z
      .object({action: z.literal('password'), current: z.string().max(200), next: z.string().min(14).max(200)})
      .strict()
      .parse(body);
    const r = await first<any>(db(), sql`SELECT salt,password_hash FROM tf_users WHERE id=${user.id}`);
    if (!equal(passwordHash(v.current, r.salt), r.password_hash)) fail('Mot de passe actuel incorrect.');
    if (v.current === v.next) fail('Choisissez un nouveau mot de passe.');
    const salt = randomSalt();
    const hash = passwordHash(v.next, salt);
    const now = new Date().toISOString();
    await run(
      db(),
      sql`UPDATE tf_users SET salt=${salt},password_hash=${hash},force_change=0 WHERE id=${user.id}`,
    );
    await run(
      db(),
      sql`DELETE FROM tf_sessions WHERE user_id=${user.id} AND token_hash<>${sha(this.token(req))}`,
    );
    await run(
      db(),
      sql`INSERT INTO tf_audit(id,user_id,at,action,target,detail) VALUES(${randomUUID()},${user.id},${now},'account.password',${user.id},${'{}'}::jsonb)`,
    );
    return {ok: true};
  }

  private setCookie(res: Response, token: string, maxAgeMs: number) {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: maxAgeMs,
    });
  }
}
