# Password workflow checks

Run `bun run test:passwords` from `api/`. This requires Bun and PostgreSQL
(`initdb` and `pg_ctl` on PATH). The suite starts and removes its own temporary
local database; it never uses a configured application or production database.

The checks exercise the real controller/services, migrations and seed against
Postgres: personal changes, admin resets and reveals, restart persistence,
session revocation, role restrictions, reauthentication, throttling, legacy
accounts, transactional rollback, and encrypted-copy integrity.

# Deployment configuration

Set `ACCOUNT_PASSWORD_KEY` in the service's secret store before deploying the
password migration. It must contain 32 random bytes encoded as 64 hexadecimal
characters. Retain and back it up separately from the database. Changing or
losing it prevents reading existing encrypted copies; login hashes still work.
Do not rotate it without first re-encrypting the existing copies with the new key.

Login still verifies a salted hash. Non-admin accounts also store an AES-256-GCM
encrypted copy, as required for administrative password visibility. The copy is
bound to the account ID, excluded from bootstrap responses, and only decrypted
by the admin-only POST action after checking the admin's own password. Reads are
rate-limited, marked `no-store`, and audited without credentials. The UI clears
revealed values after one minute, when hidden, or when the dialog closes.

Existing hash-only passwords cannot be recovered. Their next personal change
or admin reset creates the encrypted copy. No existing credentials are changed
by migration or seeding. Admin passwords themselves are never recoverable.

In the admin UI, open **Gestion → Comptes & mots de passe → Mot de passe & accès**.
Use **Voir le mot de passe enregistré** to view, or **Réinitialiser le mot de passe**
to replace it. Resetting revokes the user's sessions and requires a personal
password at the next login. Saving account details with an empty password field
preserves the existing password.
