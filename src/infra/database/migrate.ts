import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * The single migration runner. Applies, in order:
 *   1. GENERATED migrations in drizzle/ (from `pnpm db:generate`).
 *   2. MANUAL DDL in drizzle/manual/*.sql — the documented exception for DDL
 *      Drizzle can't express (partitioning, triggers, extensions). Tracked in
 *      __manual_migrations so each runs exactly once, in filename order.
 *
 * Never edit files in drizzle/ by hand (section 7). Manual SQL goes ONLY in
 * drizzle/manual/, never inside a generated file.
 */
export async function runMigrations(databaseUrl: string, quiet = false): Promise<void> {
  const log = (msg: string) => {
    if (!quiet) console.log(msg);
  };
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    log('→ applying generated migrations (drizzle/)…');
    await migrate(db, { migrationsFolder: 'drizzle' });

    log('→ applying manual migrations (drizzle/manual/)…');
    await applyManual(client);

    log('✓ migrations up to date');
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');
  await runMigrations(url);
}

async function applyManual(client: postgres.Sql): Promise<void> {
  const dir = join(process.cwd(), 'drizzle', 'manual');
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    return; // no manual dir yet
  }

  await client.unsafe(
    `CREATE TABLE IF NOT EXISTS __manual_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  for (const file of files) {
    const already = await client<{ name: string }[]>`
      SELECT name FROM __manual_migrations WHERE name = ${file}
    `;
    if (already.length > 0) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    console.log(`  · ${file}`);
    await client.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO __manual_migrations (name) VALUES (${file})`;
    });
  }
}

// Only run when invoked directly (pnpm db:migrate), not when imported by tests.
if (require.main === module) {
  run().catch((err) => {
    console.error('✗ migration failed');
    console.error(err);
    process.exit(1);
  });
}
