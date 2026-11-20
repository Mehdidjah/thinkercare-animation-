import type {Request, Response, NextFunction} from 'express';

/**
 * Port of the Cloudflare `applySecurityHeaders`, PLUS the clickjacking headers
 * the original deliberately omitted because the Higgsfield host injected them
 * (design §9.1.5). This Railway service is accessed directly (not iframed), so
 * it sets its own `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 * The same policy is sent by Vercel (app/vercel.json); keep both identical.
 * The built SPA has no inline script, so script-src is 'self' only.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https:; media-src 'self' https:; " +
  "connect-src 'self' https:; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

/**
 * Plain Express middleware, registered first in main.ts so every response gets
 * the headers: API, static files, index.html and the SPA fallback.
 *
 * API responses additionally get `no-store` + `noindex` (the `j()`/`json()`
 * headers from the originals). Photo GETs replace Cache-Control with a private
 * immutable policy (photo ids never change). The full path comes from
 * originalUrl: req.path is mount-relative inside mounted middleware.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '0');

  if (isApi(req.originalUrl)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
}

export function isApi(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/api' || path.startsWith('/api/');
}
