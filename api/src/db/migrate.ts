import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {db, getPool} from './client';

/**
 * Applies the Drizzle schema migrations, then installs the PL/pgSQL integrity
 * triggers (triggers.sql). Run before the app boots (Dockerfile CMD).
 */
function resolve(file: string): string {
  const candidates = [
    join(__dirname, file), // dist/db/<file> (nest-cli asset copy)
    join(__dirname, '..', '..', 'src', 'db', file), // ts-node / bun dev
    join(process.cwd(), 'src', 'db', file),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`Cannot locate ${file} (looked in ${candidates.join(', ')})`);
  return found;
}

function migrationsFolder(): string {
  const candidates = [
    join(__dirname, '..', '..', 'drizzle'), // dist/db -> api/drizzle
    join(process.cwd(), 'drizzle'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Cannot locate the drizzle migrations folder. Run `bun run db:generate` first.');
  return found;
}

async function main() {
  const database = db();
  console.log('[migrate] applying schema migrations…');
  await migrate(database, {migrationsFolder: migrationsFolder()});
  console.log('[migrate] applying integrity triggers…');
  const triggersSql = readFileSync(resolve('triggers.sql'), 'utf8');
  // Run the triggers file as ONE simple-protocol query (multiple statements +
  // dollar-quoted PL/pgSQL bodies). Going through the raw pool guarantees the
  // simple query protocol (the extended protocol forbids multi-statement SQL).
  await getPool().query(triggersSql);
  console.log('[migrate] done.');
  await getPool().end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
