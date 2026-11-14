import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import {type NestExpressApplication} from '@nestjs/platform-express';
import express from 'express';
import cookieParser from 'cookie-parser';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {AppModule} from './app.module';
import {HttpExceptionFilter} from './common/http-exception.filter';
import type {Request, Response, NextFunction} from 'express';

async function bootstrap() {
  // Disable Nest's default body parser — /api/terrain needs the RAW body (manual
  // 70kb check + JSON.parse, matching the original), and the photo routes read
  // the multipart stream directly. We add scoped parsers below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {bodyParser: false});

  // Railway terminates TLS at its edge; trust the proxy so req.protocol is https
  // and X-Forwarded-For drives the login throttle (design §9.1.2).
  app.set('trust proxy', true);

  app.use(cookieParser());
  // Raw text body only for /api/terrain (GET has none; POST gets the string).
  app.use('/api/terrain', express.text({type: () => true, limit: '1mb'}));

  app.useGlobalFilters(new HttpExceptionFilter());

  // Serve the already-built Vite SPA (app/dist) same-origin → cookies & fetch
  // keep working unchanged. One Railway service for API + UI.
  const staticDir = process.env.STATIC_DIR || resolve(__dirname, '..', '..', 'app', 'dist');
  const indexHtml = join(staticDir, 'index.html');
  if (existsSync(staticDir)) {
    app.useStaticAssets(staticDir, {index: false, maxAge: '1h'});
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[main] static dir not found: ${staticDir} (frontend will 404 until built)`);
  }

  const instance = app.getHttpAdapter().getInstance();
  instance.get('/robots.txt', (_req: Request, res: Response) =>
    res.type('text/plain').send('User-agent: *\nDisallow: /\n'),
  );
  instance.get('/sitemap.xml', (_req: Request, res: Response) =>
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'),
  );

  // SPA fallback: any non-API GET that is not a static file returns index.html.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || !existsSync(indexHtml)) return next();
    res.sendFile(indexHtml);
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
