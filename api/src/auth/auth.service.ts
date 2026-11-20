import {Injectable} from '@nestjs/common';
import type {Request, Response} from 'express';
import {z} from 'zod';
import {db} from '../db/client';
import {first, run, serializable, sql} from '../db/tx';
import {fail} from '../common/errors';
import {sha, hashNewPassword, verifyPassword, DUMMY_PASSWORD_HASH, randomToken, randomUUID} from '../common/crypto';
import type {User} from '../domain/core';
import {sealPassword, openPassword} from '../common/password-vault';

export const COOKIE = '__Host-terrain-session';
const SESSION_MS = 28800000; // 8h, renewed while in use (see current())
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

  /**
   * Resolve the authenticated, active user or throw the original 401s. With a
   * response, a session past half its lifetime is extended and its cookie
   * re-sent (sliding expiry), so a tab kept open through a full-day mission can
   * still check out; younger sessions are left alone (no write per request).
   */
  async current(req: Request, res?: Response): Promise<User> {
    const t = this.token(req);
    if (!/^[a-f0-9]{64}$/.test(t)) fail('Connectez-vous à votre espace.', 401);
    const now = Date.now();
    const tokenHash = sha(t);
    const row = await first<User & {expires: number}>(
      db(),
      sql`SELECT u.id,u.username,u.label,u.role,u.active,u.force_change,s.expires
          FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
          WHERE s.token_hash=${tokenHash} AND s.expires>${now} AND u.active=1`,
    );
    if (!row) fail('Votre session a expiré.', 401);
    const {expires, ...u} = row!;
    if (res && expires - now < SESSION_MS / 2) {
      await run(db(), sql`UPDATE tf_sessions SET expires=${now + SESSION_MS} WHERE token_hash=${tokenHash}`);
      this.setCookie(res, t, SESSION_MS);
    }
    return u;
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

  /** Throttle bucket IP — first X-Forwarded-For hop (design §9.1.2), trust proxy enabled; bounded as it is also audited. */
  private clientIp(req: Request): string {
    const xff = (req.headers['x-forwarded-for'] as string | undefined) || '';
    const first = xff.split(',')[0].trim();
    return (first || req.ip || 'unknown').slice(0, 64);
  }

  /** Counts one attempt in a throttle bucket and returns the bucket's total. */
  private async attempt(bucket: string, now: number): Promise<number> {
    const r = await first<{count: number}>(
      db(),
      sql`INSERT INTO tf_throttle(bucket,count,expires) VALUES(${bucket},1,${now + THROTTLE_WINDOW_MS})
          ON CONFLICT(bucket) DO UPDATE SET count=tf_throttle.count+1 RETURNING count`,
    );
    return r?.count ?? 0;
  }

  async login(body: unknown, req: Request, res: Response): Promise<{ok: true; user: User}> {
    const v = z
      .object({action: z.literal('login'), username: text(60).min(1), password: z.string().min(1).max(200)})
      .strict()
      .parse(body);
    const now = Date.now();
    const slot = Math.floor(now / THROTTLE_WINDOW_MS);
    const ip = this.clientIp(req);
    // Per-IP bucket: behind the Vercel proxy X-Forwarded-For is the real client IP
    // (Vercel overwrites it), whereas req.ip would put every user behind Vercel's
    // few egress IPs. A caller hitting the Railway URL directly can forge it, so
    // the per-username bucket below caps failed guesses whatever the IP/headers.
    if ((await this.attempt(sha(ip + '|' + slot), now)) > 20) fail('Trop de tentatives. Réessayez dans 15 minutes.', 429);
    const name = v.username.toLowerCase();
    // Reserved before verifying (concurrent guesses cannot all slip under the
    // limit) and given back on success, so only failures count. Unknown
    // usernames are throttled alike, which keeps them indistinguishable.
    const failures = sha('login-user|' + name + '|' + slot);
    if ((await this.attempt(failures, now)) > 10) fail('Trop de tentatives. Réessayez dans 15 minutes.', 429);
    const r = await first<any>(db(), sql`SELECT * FROM tf_users WHERE username=${name}`);
    const check = await verifyPassword(v.password, r?.salt || DEFAULT_SALT, r?.password_hash || DUMMY_PASSWORD_HASH);
    const at = new Date(now).toISOString();
    if (!r || !r.active || !check.ok) {
      if (r) {
        await run(db(), sql`INSERT INTO tf_audit(id,user_id,at,action,target,detail)
          VALUES(${randomUUID()},${r.id},${at},'auth.login_failed',${r.id},${JSON.stringify({ip})}::jsonb)`);
      }
      fail('Identifiant ou mot de passe incorrect.', 401);
    }
    const upgrade = check.needsUpgrade ? await hashNewPassword(v.password) : null;
    const t = randomToken();
    await Promise.all([
      run(db(), sql`INSERT INTO tf_sessions(token_hash,user_id,expires) VALUES(${sha(t)},${r.id},${now + SESSION_MS})`),
      run(db(), sql`UPDATE tf_throttle SET count=count-1 WHERE bucket=${failures}`),
      run(db(), sql`INSERT INTO tf_audit(id,user_id,at,action,target,detail)
        VALUES(${randomUUID()},${r.id},${at},'auth.login',${r.id},${JSON.stringify({ip})}::jsonb)`),
      // Legacy hash re-derived in the current format (the vault copy stays valid);
      // skipped if the password was changed or reset in the meantime.
      upgrade && run(db(), sql`UPDATE tf_users SET salt=${upgrade.salt},password_hash=${upgrade.hash}
        WHERE id=${r.id} AND password_hash=${r.password_hash}`),
      run(db(), sql`DELETE FROM tf_sessions WHERE expires<${now}`),
      run(db(), sql`DELETE FROM tf_throttle WHERE expires<${now}`),
    ]);
    this.setCookie(res, t, SESSION_MS);
    const {id, username, label, role, active, force_change} = r;
    return {ok: true, user: {id, username, label, role, active, force_change}};
  }

  /** Needs no valid session: an expired one must still be able to leave. */
  async logout(req: Request, res: Response): Promise<{ok: true}> {
    const t = this.token(req);
    if (t) await run(db(), sql`DELETE FROM tf_sessions WHERE token_hash=${sha(t)}`);
    this.setCookie(res, '', 0);
    // Drops the browser's HTTP cache for this origin (shared phones).
    res.setHeader('Clear-Site-Data', '"cache"');
    return {ok: true};
  }

  async changePassword(user: User, body: unknown, req: Request): Promise<{ok: true}> {
    const v = z
      .object({action: z.literal('password'), current: z.string().max(200), next: z.string().min(1).max(200)})
      .strict()
      .parse(body);
    if (v.current === v.next) fail('Choisissez un nouveau mot de passe.');
    const tokenHash = sha(this.token(req));
    // Both PBKDF2 runs happen before the transaction, so the account row is never locked while hashing.
    const stored = await first<{salt: string; password_hash: string}>(
      db(),
      sql`SELECT u.salt,u.password_hash FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
          WHERE u.id=${user.id} AND u.active=1 AND s.token_hash=${tokenHash} AND s.expires>${Date.now()}`,
    );
    if (!stored) fail('Votre session a expiré.', 401);
    // 400, not 401: the SPA treats every 401 as an expired session and returns to the login screen.
    if (!(await verifyPassword(v.current, stored.salt, stored.password_hash)).ok) fail('Mot de passe actuel incorrect.');
    const {salt, hash} = await hashNewPassword(v.next);
    const sealed = user.role === 'admin' ? null : sealPassword(user.id, v.next);
    const now = new Date().toISOString();
    await serializable(async (tx) => {
      // Recheck and lock the account inside the transaction, including the
      // session: a concurrent admin reset/deactivation or password change
      // revokes this session and must not be overwritten.
      const r = await first<{id: string}>(
        tx,
        sql`SELECT u.id FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
            WHERE u.id=${user.id} AND u.active=1 AND s.token_hash=${tokenHash} AND s.expires>${Date.now()}
            FOR UPDATE OF u`,
      );
      if (!r) fail('Votre session a expiré.', 401);
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
    if ((await this.attempt(bucket, now)) > 10) fail('Trop de consultations. Réessayez dans 15 minutes.', 429);
    const tokenHash = sha(this.token(req));
    const admin = await first<{salt: string; password_hash: string}>(db(),
      sql`SELECT u.salt,u.password_hash FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
          WHERE u.id=${user.id} AND u.role='admin' AND u.active=1 AND u.force_change=0
          AND s.token_hash=${tokenHash} AND s.expires>${now}`);
    if (!admin) fail('Votre session a expiré.', 401);
    if (!(await verifyPassword(v.adminPassword, admin.salt, admin.password_hash)).ok) fail('Votre mot de passe administrateur est incorrect.', 403);

    return serializable(async (tx) => {
      const locked = await first<{id: string}>(tx,
        sql`SELECT u.id FROM tf_users u JOIN tf_sessions s ON s.user_id=u.id
            WHERE u.id=${user.id} AND u.role='admin' AND u.active=1 AND u.force_change=0
            AND s.token_hash=${tokenHash} AND s.expires>${now} FOR UPDATE OF u`);
      if (!locked) fail('Votre session a expiré.', 401);
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
