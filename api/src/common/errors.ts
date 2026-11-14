/**
 * Status-tagged error, matching the original `fail(message, status)` helper that
 * threw `Object.assign(new Error(message), {status})`. The HttpExceptionFilter
 * reproduces `errorResponse()` from the Cloudflare handlers.
 */
export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/** Throw a status-tagged failure. Returns `never` so it type-narrows like the original. */
export function fail(message: string, status = 400): never {
  throw new AppError(message, status);
}
