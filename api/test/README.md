# API tests

Run every suite from `api/`:

```sh
bun test                    # all suites in test/
bun run test:passwords      # password workflow, sessions and login throttle
bun run test:auth           # the above plus password hashing (auth-crypto, no database)
bun run test:data           # data integrity, attendance, migrations and seed
bun run test:platform       # HTTP server: headers, caching, photos, upload limiter, /healthz
bun run test:midway         # middle photo: unlock time, departure lock, retries, migration 0003
bun run test:presentoir     # présentoir photos: edit rules, cap of 10, Stocks gallery by role
bun run test:uploads        # photo body limits only (no database)
bun run --bun tsc --noEmit -p tsconfig.json   # typecheck
```

Suites:

- `passwords.test.ts`: password changes, resets and reveals, sliding session renewal, logout without a valid session (`Clear-Site-Data`), the per-IP and per-username login throttle and the signed known-browser cookie that keeps the real user out of a lockout caused elsewhere, legacy hash upgrade at login, login audit rows.
- `auth-crypto.test.ts`: hash formats and known-answer vectors (no database).
- `data.test.ts`: unknown motives, account usernames, strict dates, bootstrap caps and `prefetch` (week, bonus strip, attendance alerts), `missing_end` alerts, `close-mission`, the visits listed when an animatrice is deactivated, unique-violation messages, error logging, an idle connection closed by Postgres (logged, not fatal), seed (manager edits kept, `SEED_DEMO_DATA`), void-sale price restore or removal, set-based stock writes, reports limit, audit window, migration `0002` on a fresh and on an existing database, and the boot trigger script taking no table lock.
- `midway.test.ts`: the middle photo through the real photo and terrain services: refused before the midpoint with the unlock time, departure refused until it exists (also for missions started before the deploy), one per mission with idempotent `photo_id` retries, assigned animatrice only, readable by the mission’s viewers, available at once after a late arrival, manager `close-mission` without it (and never before it when there is one), and migration `0003` on a database already at `0002` with data.
- `presentoir.test.ts`: présentoir photos through the real photo and terrain services: recorded with caption and thumbnail on an editable mission only (same rules as suivi photos), `no_person` and image checks, idempotent `photo_id`, audited as `photo.added`, a cap of 10 separate from the 15 suivi photos, listed in the mission detail, no effect on the clock steps or the report submission, and the `stocks` gallery (8 newest of the pharmacy, cancelled missions excluded, an animatrice only gets photos of her own missions).
- `platform.test.ts`: boots the real `src/main.ts` in a subprocess and checks security headers and the CSP, static `Cache-Control`, JSON compression, the `PUBLIC_APP_URL` redirect, photo caching (`ETag`, `304`) and grid thumbnails, the upload limiter (global and per account) and the cut of stalled or trickling bodies, the check-in pre-check, `/healthz` and JSON 404s.
- `photo-body.test.ts`: multipart size limits (no database).

`bun test` runs every file in one process. The shared pool in `src/db/client.ts` is replaced when a previous suite has ended it, so database suites can follow each other in any order.

Requirements:

- Bun.
- The PostgreSQL server binaries `initdb` and `pg_ctl` on `PATH`, for example `brew install postgresql@17`.

How the database suites run:

- Each suite starts its own throwaway cluster in a temporary directory, on a free `127.0.0.1` port, and deletes it afterwards.
- It sets `DATABASE_URL`, `DATABASE_SSL=false`, a random `ACCOUNT_PASSWORD_KEY` and a temporary `STORAGE_DIR` itself.
- It runs the real `src/db/migrate.ts` and `src/db/seed.ts`.
- It never uses a configured application database, Railway or production.

To add a database test:

- Reuse the setup in `passwords.test.ts`.
- Set the environment before the first query, because the pool reads `DATABASE_URL` on first use.
- Drive the real controller and services instead of mocking SQL.

## Password workflow checks

Run `bun run test:passwords` from `api/`.

The checks exercise the real controller and services, migrations and seed against Postgres:

- personal changes;
- admin resets and reveals;
- restart persistence;
- session revocation;
- role restrictions;
- reauthentication;
- throttling;
- legacy accounts;
- transactional rollback;
- encrypted-copy integrity.

## Deployment configuration

Set `ACCOUNT_PASSWORD_KEY` in the service's secret store before deploying the password migration. It must contain 32 random bytes encoded as 64 hexadecimal characters.

- Keep it and back it up separately from the database.
- Changing or losing it prevents reading existing encrypted copies. Login hashes still work.
- Do not rotate it without first re-encrypting the existing copies with the new key.

Login still verifies a salted hash. Non-admin accounts also store an AES-256-GCM encrypted copy, as required for administrative password visibility. This copy:

- is bound to the account ID;
- is excluded from bootstrap responses;
- is decrypted only by the admin-only POST action, after checking the admin's own password.

Reads are rate-limited, marked `no-store`, and audited without credentials. The UI clears revealed values after one minute, when the page is hidden, or when the dialog closes.

Existing hash-only passwords cannot be recovered. Their next personal change or admin reset creates the encrypted copy. Migration and seeding change no existing credentials. Admin passwords themselves are never recoverable.

In the admin UI, open **Gestion → Comptes & mots de passe → Mot de passe & accès**:

- **Voir le mot de passe enregistré** shows the password.
- **Réinitialiser le mot de passe** replaces it. The reset revokes the user's sessions and requires a personal password at the next login.

Saving account details with an empty password field keeps the existing password.

The full production runbook (all environment variables, volume, backups) is in [`docs/DEPLOY.md`](../../docs/DEPLOY.md).
