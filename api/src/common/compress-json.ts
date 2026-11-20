import type {Request, Response, NextFunction} from 'express';
import {brotliCompress, constants, gzip} from 'node:zlib';
import {promisify} from 'node:util';

const MIN_BYTES = 1024;
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** The encoding to use for this request: brotli, else gzip, when the client accepts it (q > 0). */
function negotiate(header: string): 'br' | 'gzip' | '' {
  const accepted = new Set(
    header
      .split(',')
      .map((part) => part.trim().split(';'))
      .filter(([, q]) => !q || Number(q.trim().replace(/^q=/, '')) > 0)
      .map(([name]) => name.trim().toLowerCase()),
  );
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : '';
}

/**
 * Compresses JSON API answers above 1 KB (bootstrap, planning weeks, reports)
 * at the origin, so they cross the long edge-to-origin leg already small; the
 * edge alone would only gzip them after it. Compression runs in libuv's thread
 * pool, off the event loop; brotli at quality 4 suits answers built per request.
 */
export function compressJson(req: Request, res: Response, next: NextFunction) {
  const encoding = negotiate(String(req.headers['accept-encoding'] || ''));
  if (!encoding) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const text = JSON.stringify(body);
    if (text === undefined || text.length < MIN_BYTES) return json(body);
    const raw = Buffer.from(text);
    const zipped =
      encoding === 'br'
        ? brotli(raw, {params: {[constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length}})
        : gzipAsync(raw);
    zipped.then(
      (bytes) => {
        if (res.headersSent) return;
        res.setHeader('Content-Encoding', encoding);
        res.vary('Accept-Encoding');
        res.type('application/json');
        res.send(bytes);
      },
      () => json(body),
    );
    return res;
  };
  next();
}
