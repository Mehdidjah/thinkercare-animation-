import {z} from 'zod';

/** Zod primitives reused verbatim from the original api.server / operations.server. */
export const id = z.string().regex(/^[a-zA-Z0-9_-]{2,64}$/);
export const uuid = z.string().uuid();
export const brand = z.enum(['TOUCHE', 'BELNCO', 'NOOM']);
export const text = (n = 1200) => z.string().trim().max(n);
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) => !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s,
  );
export const optionalDate = z.union([z.literal(''), date]);
export const qty = z.number().int().min(0).max(100000);
