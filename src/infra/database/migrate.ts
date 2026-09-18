import 'dotenv/config';
import { createHash } from 'node:crypto';
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

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * MAI-01: a manual migration was tracked by filename alone — editing an
 * already-applied file's content (instead of adding a new one, per the
 * documented convention) went undetected forever, silently skipped on every
 * future run. Each row now also stores a checksum of the file it applied, so
 * a content change on a name we've already seen fails loudly instead of
 * drifting the DB away from what's on disk.
 */
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
       checksum text,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  // Deployments whose __manual_migrations predates this column.
  await client.unsafe(`ALTER TABLE __manual_migrations ADD COLUMN IF NOT EXISTS checksum text`);

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = checksumOf(sql);

    const [existing] = await client<{ checksum: string | null }[]>`
      SELECT checksum FROM __manual_migrations WHERE name = ${file}
    `;

    if (existing) {
      if (existing.checksum === null) {
        // Applied before checksums were tracked — backfill, don't re-run.
        await client`UPDATE __manual_migrations SET checksum = ${checksum} WHERE name = ${file}`;
        continue;
      }
      if (existing.checksum !== checksum) {
        throw new Error(
          `Manual migration "${file}" was already applied but its content changed ` +
            `(checksum mismatch) — never edit an applied file in drizzle/manual/, ` +
            `add a new one instead.`,
        );
      }
      continue; // already applied, unchanged
    }

    console.log(`  · ${file}`);
    await client.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO __manual_migrations (name, checksum) VALUES (${file}, ${checksum})`;
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
