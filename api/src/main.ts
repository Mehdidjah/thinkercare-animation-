import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import {Catch, NotFoundException, type ArgumentsHost} from '@nestjs/common';
import {type NestExpressApplication} from '@nestjs/platform-express';
import express from 'express';
import cookieParser from 'cookie-parser';
import {existsSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {AppModule} from './app.module';
import {HttpExceptionFilter} from './common/http-exception.filter';
import {AppError} from './common/errors';
import {checkConfig} from './common/config-check';
import {isApi, securityHeaders} from './common/security-headers.middleware';
import {compressJson} from './common/compress-json';
import {getPool} from './db/client';
import type {Request, Response, NextFunction} from 'express';

/** Nest's own "Cannot GET /x" for unmatched routes becomes the API's French {error} 404. */
@Catch()
class ApiExceptionFilter extends HttpExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    super.catch(exception instanceof NotFoundException ? new AppError('Ressource introuvable.', 404) : exception, host);
  }
}

/** Static caching: Vite's content-hashed bundles never change; public/assets files may. */
function staticCache(staticDir: string) {
  return (res: Response, file: string) => {
    const path = relative(staticDir, file).split(sep).join('/');
    if (!path.startsWith('assets/')) res.setHeader('Cache-Control', 'no-cache');
    else if (/\.(js|css)$/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else res.setHeader('Cache-Control', 'public, max-age=86400');
  };
}

/** PUBLIC_APP_URL as an origin, or null when unset or not a bare https origin (reported by checkConfig). */
function publicOrigin(value: string | undefined): URL | null {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && url.origin === value ? url : null;
  } catch {
    return null;
  }
}

async function healthz(_req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getPool().query('SELECT 1'),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out after 5 s')), 5000))),
    ]);
    res.json({ok: true});
  } catch (e) {
    console.error('[health] database check failed:', (e as Error).message);
    res.status(503).json({error: 'Base de données indisponible.'});
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap() {
  if (!(await checkConfig())) process.exit(1);

  // Disable Nest's default body parser — /api/terrain needs the RAW body (manual
  // 70kb check + JSON.parse, matching the original), and the photo routes read
  // the multipart stream directly. We add scoped parsers below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {bodyParser: false});

  // Railway terminates TLS at its edge; trust the proxy so req.protocol is https
  // and X-Forwarded-For drives the login throttle (design §9.1.2).
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // First, so API responses, static files and the SPA fallback all carry them.
  app.use(securityHeaders);
  app.use('/api', compressJson);
  app.use(cookieParser());
  // Raw text body only for /api/terrain (GET has none; POST gets the string).
  app.use('/api/terrain', express.text({type: () => true, limit: '1mb'}));

  app.useGlobalFilters(new ApiExceptionFilter());

  const instance = app.getHttpAdapter().getInstance();
  // Railway healthcheck: no auth, answers before the SPA fallback.
  instance.get('/healthz', healthz);

  // Serve the already-built Vite SPA (app/dist) same-origin → cookies & fetch
  // keep working unchanged. One Railway service for API + UI.
  const staticDir = process.env.STATIC_DIR || resolve(__dirname, '..', '..', 'app', 'dist');
  const indexHtml = join(staticDir, 'index.html');
  if (existsSync(staticDir)) {
    app.useStaticAssets(staticDir, {index: false, setHeaders: staticCache(resolve(staticDir))});
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[main] static dir not found: ${staticDir} (frontend will 404 until built)`);
  }

  instance.get('/robots.txt', (_req: Request, res: Response) =>
    res.type('text/plain').send('User-agent: *\nDisallow: /\n'),
  );
  instance.get('/sitemap.xml', (_req: Request, res: Response) =>
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'),
  );

  // SPA fallback: any non-API GET that is not a static file returns index.html.
  // Unknown /api paths fall through to Nest's 404 (ApiExceptionFilter).
  // With PUBLIC_APP_URL (the Vercel front end), a page opened on another host —
  // this service's own Railway URL — is sent there, where the app loads from the
  // CDN; /api, /healthz and static files are served as before.
  const publicApp = publicOrigin(process.env.PUBLIC_APP_URL);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || isApi(req.originalUrl) || !existsSync(indexHtml)) return next();
    if (publicApp && req.get('host') !== publicApp.host) return res.redirect(308, publicApp.origin + req.originalUrl);
    res.setHeader('Cache-Control', 'no-cache');
    // Relative to root: without it, send() refuses any absolute path containing a dot-directory.
    res.sendFile('index.html', {root: staticDir});
  });

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[main] ThinkerCare Terrain API listening on :${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[main] fatal bootstrap error:', err);
  process.exit(1);
});
