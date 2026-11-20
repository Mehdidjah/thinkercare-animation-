import type {Response} from 'express';
import {AppError, fail} from './errors';

export const UPLOAD_BUSY = 'Trop d’envois de photos en cours. Réessayez dans quelques secondes.';

/**
 * Photo bodies (up to ~20 MB each) are buffered in memory before parsing, so
 * only a few may be read at once. Extra uploads wait in a short queue; beyond
 * it, or after waiting too long, they get 503 and the phone retries later.
 * One account may hold at most `perOwner` uploads (reading or queued), so a
 * single phone with stalled connections never takes every slot; photoFormData
 * bounds how long a slow body can keep its slot.
 */
export class UploadLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly owners = new Map<string, number>();

  constructor(
    readonly slots = 4,
    readonly queue = 8,
    readonly waitMs = 20_000,
    readonly perOwner = 2,
  ) {}

  stats() {
    return {active: this.active, waiting: this.waiting.length};
  }

  /** Resolves with an idempotent release function once a slot is held. */
  async acquire(signal?: AbortSignal, owner = ''): Promise<() => void> {
    if (signal?.aborted) fail(UPLOAD_BUSY, 503);
    if (owner && (this.owners.get(owner) ?? 0) >= this.perOwner) fail(UPLOAD_BUSY, 503);
    if (this.active >= this.slots && this.waiting.length >= this.queue) fail(UPLOAD_BUSY, 503);
    this.count(owner, 1);
    if (this.active < this.slots) this.active++;
    else {
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
          this.count(owner, -1);
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
      this.count(owner, -1);
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }

  private count(owner: string, delta: number) {
    if (!owner) return;
    const n = (this.owners.get(owner) ?? 0) + delta;
    if (n > 0) this.owners.set(owner, n);
    else this.owners.delete(owner);
  }
}

export const photoUploads = new UploadLimiter();

/**
 * Runs an upload inside a limiter slot. The slot is always released (success,
 * error, or a client abort that breaks the body read); a waiter whose client
 * disconnects leaves the queue. A 503 carries Retry-After for the client.
 */
export async function withUploadSlot<T>(res: Response, work: () => Promise<T>, limiter = photoUploads, owner = ''): Promise<T> {
  const gone = new AbortController();
  const abort = () => gone.abort();
  res.once('close', abort);
  let release: () => void;
  try {
    release = await limiter.acquire(gone.signal, owner);
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
