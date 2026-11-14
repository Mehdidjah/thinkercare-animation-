import {Injectable, type NestMiddleware} from '@nestjs/common';
import type {Request, Response, NextFunction} from 'express';

/**
 * Port of the Cloudflare `applySecurityHeaders`, PLUS the clickjacking headers
 * the original deliberately omitted because the Higgsfield host injected them
 * (design §9.1.5). This Railway service is accessed directly (not iframed), so
 * it sets its own `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 *
 * API responses additionally get `no-store` + `noindex` (the `j()`/`json()`
 * headers from the originals). `/api/photos` & `/api/field-photos` controllers
 * override Cache-Control with `private, no-store` for the image stream.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data: blob: https:; media-src 'self' https:; " +
        "connect-src 'self' https:; " +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('X-XSS-Protection', '0');

    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
  }
}
