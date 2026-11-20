import type {Response} from 'express';
import {AppError, fail} from './errors';

export const UPLOAD_BUSY = 'Trop d’envois de photos en cours. Réessayez dans quelques secondes.';

/**
 * Photo bodies (up to ~20 MB each) are buffered in memory before parsing, so
 * only a few may be read at once. Extra uploads wait in a short queue; beyond
 * it, or after waiting too long, they get 503 and the phone retries later.
 */
export class UploadLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly slots = 4,
    readonly queue = 8,
    readonly waitMs = 20_000,
  ) {}

  stats() {
    return {active: this.active, waiting: this.waiting.length};
  }

  /** Resolves with an idempotent release function once a slot is held. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) fail(UPLOAD_BUSY, 503);
    if (this.active < this.slots) this.active++;
    else {
      if (this.waiting.length >= this.queue) fail(UPLOAD_BUSY, 503);
      // A release hands its slot straight to the first waiter, so `active` is unchanged.
      await new Promise<void>((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        };
        const grant = () => {
          settle();
          resolve();
        };
        const cancel = () => {
          settle();
          const at = this.waiting.indexOf(grant);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(new AppError(UPLOAD_BUSY, 503));
        };
        const timer = setTimeout(cancel, this.waitMs);
        signal?.addEventListener('abort', cancel, {once: true});
        this.waiting.push(grant);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export const photoUploads = new UploadLimiter();

/**
 * Runs an upload inside a limiter slot. The slot is always released (success,
 * error, or a client abort that breaks the body read); a waiter whose client
 * disconnects leaves the queue. A 503 carries Retry-After for the client.
 */
export async function withUploadSlot<T>(res: Response, work: () => Promise<T>, limiter = photoUploads): Promise<T> {
  const gone = new AbortController();
  const abort = () => gone.abort();
  res.once('close', abort);
  let release: () => void;
  try {
    release = await limiter.acquire(gone.signal);
  } catch (e) {
    res.setHeader('Retry-After', '5');
    throw e;
  } finally {
    res.off('close', abort);
  }
  try {
    return await work();
  } finally {
    release();
  }
}
