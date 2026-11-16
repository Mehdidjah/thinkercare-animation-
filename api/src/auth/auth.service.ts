import {Injectable} from '@nestjs/common';
import type {Request, Response} from 'express';
import {z} from 'zod';
import {db} from '../db/client';
import {first, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {sha, passwordHash, passwordHashAsync, equal, randomToken, randomSalt, randomUUID} from '../common/crypto';
import type {User} from '../domain/core';
import {sealPassword, openPassword} from '../common/password-vault';

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

  /**
   * Origin/CSRF check on POST. The app's own origin (same host) is always
   * allowed. APP_ORIGIN may list additional allowed origins (comma-separated)
   * — e.g. a Vercel front end that reaches this API through its /api
   * reverse-proxy, whose browser Origin header is the Vercel domain.
   */
  requireOrigin(req: Request): void {
    const origin = req.headers.origin;
    const allowed = new Set<string>([`${req.protocol}://${req.get('host')}`]);
    for (const o of (process.env.APP_ORIGIN || '').split(',')) {
      const trimmed = o.trim();
      if (trimmed) allowed.add(trimmed);
    }
    if (!origin || !allowed.has(origin)) fail('Origine non autorisée.', 403);
  }

  /** Throttle bucket IP — first X-Forwarded-For hop (design §9.1.2), trust proxy enabled. */
  private clientIp(req: Request): string {
    const xff = (req.headers['x-forwarded-for'] as string | undefined) || '';
    const first = xff.split(',')[0].trim();
    return first || req.ip || 'unknown';
  }

  async login(body: unknown, req: Request, res: Response): Promise<{ok: true; user: User}> {
    const v = z
      .object({action: z.literal('login'), username: text(60).min(1), password: z.string().min(1).max(200)})
      .strict()
      .parse(body);
    const now = Date.now();
    const key = sha(this.clientIp(req) + '|' + Math.floor(now / THROTTLE_WINDOW_MS));
    const limit = await first<{count: number}>(
      db(),
      sql`INSERT INTO tf_throttle(bucket,count,expires) VALUES(${key},1,${now + THROTTLE_WINDOW_MS})
          ON CONFLICT(bucket) DO UPDATE SET count=tf_throttle.count+1 RETURNING count`,
    );
    if ((limit?.count ?? 0) > 20) fail('Trop de tentatives. Réessayez dans 15 minutes.', 429);
    const r = await first<any>(db(), sql`SELECT * FROM tf_users WHERE username=${v.username.toLowerCase()}`);
    const h = await passwordHashAsync(v.password, r?.salt || DEFAULT_SALT);
    if (!r || !r.active || !equal(h, r.password_hash)) fail('Identifiant ou mot de passe incorrect.', 401);
    const t = randomToken();
    await Promise.all([
      run(db(), sql`INSERT INTO tf_sessions(token_hash,user_id,expires) VALUES(${sha(t)},${r.id},${now + SESSION_MS})`),
      run(db(), sql`DELETE FROM tf_sessions WHERE expires<${now}`),
      run(db(), sql`DELETE FROM tf_throttle WHERE expires<${now}`),
    ]);
    this.setCookie(res, t, SESSION_MS);
    const {id, username, label, role, active, force_change} = r;
    return {ok: true, user: {id, username, label, role, active, force_change}};
  }

  async logout(req: Request, res: Response): Promise<{ok: true}> {
    await run(db(), sql`DELETE FROM tf_sessions WHERE token_hash=${sha(this.token(req))}`);
    this.setCookie(res, '', 0);
    return {ok: true};
  }

  async changePassword(user: User, body: unknown, req: Request): Promise<{ok: true}> {
    const v = z
      .object({action: z.literal('password'), current: z.string().max(200), next: z.string().min(1).max(200)})
      .strict()
      .parse(body);
    if (v.current === v.next) fail('Choisissez un nouveau mot de passe.');
    const salt = randomSalt();
    const hash = passwordHash(v.next, salt);
    const sealed = user.role === 'admin' ? null : sealPassword(user.id, v.next);
    const now = new Date().toISOString();
    const tokenHash = sha(this.token(req));
    await serializable(async (tx) => {
      // Recheck and lock the account inside the transaction, including the
      // session: a concurrent admin reset/deactivation must not be overwritten.
      const r = await first<{salt: string; password_hash: string}>(
        tx,
        sql`SELECT u.salt,u.password_hash FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
            WHERE u.id=${user.id} AND u.active=1 AND s.token_hash=${tokenHash} AND s.expires>${Date.now()}
            FOR UPDATE OF u`,
      );
      if (!r) fail('Votre session a expiré.', 401);
      if (!equal(passwordHash(v.current, r.salt), r.password_hash)) fail('Mot de passe actuel incorrect.');
      await run(tx, sql`UPDATE tf_users SET salt=${salt},password_hash=${hash},password_ciphertext=${sealed},force_change=0 WHERE id=${user.id}`);
      await run(tx, sql`DELETE FROM tf_sessions WHERE user_id=${user.id} AND token_hash<>${tokenHash}`);
      await run(
        tx,
        sql`INSERT INTO tf_audit(id,user_id,at,action,target,detail) VALUES(${randomUUID()},${user.id},${now},'account.password',${user.id},${'{}'}::jsonb)`,
      );
    });
    return {ok: true};
  }

  async revealPassword(user: User, body: unknown, req: Request): Promise<{password: string | null}> {
    if (user.role !== 'admin' || user.force_change) fail('Accès direction requis.', 403);
    const v = z.object({action: z.literal('user-password'), id: z.string().uuid(), adminPassword: z.string().min(1).max(200)}).strict().parse(body);
    const now = Date.now();
    const bucket = sha('password-reveal|' + user.id + '|' + Math.floor(now / THROTTLE_WINDOW_MS));
    const limit = await first<{count: number}>(db(), sql`INSERT INTO tf_throttle(bucket,count,expires)
      VALUES(${bucket},1,${now + THROTTLE_WINDOW_MS}) ON CONFLICT(bucket) DO UPDATE SET count=tf_throttle.count+1 RETURNING count`);
    if ((limit?.count ?? 0) > 10) fail('Trop de consultations. Réessayez dans 15 minutes.', 429);

    return serializable(async (tx) => {
      const admin = await first<{salt: string; password_hash: string}>(tx,
        sql`SELECT u.salt,u.password_hash FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
            WHERE u.id=${user.id} AND u.role='admin' AND u.active=1 AND u.force_change=0
            AND s.token_hash=${sha(this.token(req))} AND s.expires>${now} FOR UPDATE OF u`);
      if (!admin) fail('Votre session a expiré.', 401);
      if (!equal(passwordHash(v.adminPassword, admin.salt), admin.password_hash)) fail('Votre mot de passe administrateur est incorrect.', 403);
      const target = await first<{role: string; password_ciphertext: string | null}>(tx,
        sql`SELECT role,password_ciphertext FROM tf_users WHERE id=${v.id}`);
      if (!target) fail('Compte introuvable.', 404);
      if (target.role === 'admin') fail('Le compte direction se gère séparément.', 403);
      const password = target.password_ciphertext ? openPassword(v.id, target.password_ciphertext) : null;
      await run(tx, sql`INSERT INTO tf_audit(id,user_id,at,action,target,detail)
        VALUES(${randomUUID()},${user.id},${new Date(now).toISOString()},'account.password_viewed',${v.id},${'{}'}::jsonb)`);
      return {password};
    });
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
