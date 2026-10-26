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
 *
 * Folders are resolved from `process.cwd()`: run it from the project root (or
 * the image WORKDIR) where `drizzle/` lives, e.g. `pnpm db:migrate` locally or
 * `node dist/infra/database/migrate.js` (`pnpm db:migrate:prod`) in production.
 */

/** Arbitrary constant: every runner, on any replica, contends for this one advisory lock. */
const MIGRATION_LOCK_KEY = 727_274;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 500;

export async function runMigrations(databaseUrl: string, quiet = false): Promise<void> {
  const log = (msg: string) => {
    if (!quiet) console.log(msg);
  };
  // Single connection: the advisory lock below is session-level, so everything
  // that follows (Drizzle's transaction, the manual files) runs in that session.
  // `onnotice` mutes the harmless "already exists, skipping" notices from IF NOT EXISTS.
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(client);

  try {
    await acquireMigrationLock(client, log);

    log('→ applying generated migrations (drizzle/)…');
    await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });

    log('→ applying manual migrations (drizzle/manual/)…');
    await applyManual(client, log);

    log('✓ migrations up to date');
  } finally {
    try {
      await client.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    } catch {
      // Connection already gone: closing the session releases the lock anyway.
    }
    await client.end({ timeout: 5 });
  }
}

/**
 * Serializes concurrent runners (several replicas booting together, or a deploy
 * overlapping a manual run). Drizzle's migrator takes no lock of its own, so two
 * runners could otherwise race on the same pending migration or on the manual
 * DDL. Polls `pg_try_advisory_lock` so a stuck holder produces a clear error
 * after LOCK_TIMEOUT_MS instead of blocking forever.
 */
async function acquireMigrationLock(
  client: postgres.Sql,
  log: (msg: string) => void,
): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  for (;;) {
    const [row] = await client.unsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) AS locked`,
    );
    if (row?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Could not acquire the migration lock within ${LOCK_TIMEOUT_MS / 1000}s — ` +
          `another migration runner is still holding it.`,
      );
    }
    if (!announced) {
      log('→ another migration runner is active, waiting for the lock…');
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');
  await runMigrations(url);
}

export function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Checksums that identify a manual migration independently of its line endings.
 *
 * The file's bytes differ between a Windows checkout (CRLF) and a Linux one
 * (LF) even though the SQL is identical, so hashing raw content produced false
 * "checksum mismatch" failures between environments. `canonical` hashes the
 * LF-normalized text and is what gets stored from now on; `accepted` also
 * includes the raw/LF/CRLF variants so rows written by the previous runner
 * (raw content, whichever EOL it had) keep validating.
 */
export function manualChecksums(sql: string): { canonical: string; accepted: Set<string> } {
  const lf = sql.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const canonical = checksumOf(lf);
  return { canonical, accepted: new Set([canonical, checksumOf(sql), checksumOf(crlf)]) };
}

/**
 * Lists drizzle/manual/*.sql. A missing folder is tolerated outside production
 * (some checkouts have no manual DDL yet), but ONLY a missing folder — any other
 * read error is thrown. In production a missing folder is an error: the usual
 * cause is `drizzle/manual/` not being copied into the image, which would
 * otherwise skip e.g. the telemetry_events table while still logging success.
 */
function listManualFiles(dir: string, log: (msg: string) => void): string[] | null {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const message = `drizzle/manual/ not found at ${dir}`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${message} — make sure the folder is copied next to drizzle/ in the image.`);
    }
    log(`! ${message} — skipping manual migrations`);
    return null;
  }
}

/**
 * MAI-01: a manual migration was tracked by filename alone — editing an
 * already-applied file's content (instead of adding a new one, per the
 * documented convention) went undetected forever, silently skipped on every
 * future run. Each row now also stores a checksum of the file it applied, so
 * a content change on a name we've already seen fails loudly instead of
 * drifting the DB away from what's on disk. Checksums ignore line endings
 * (see {@link manualChecksums}).
 */
async function applyManual(client: postgres.Sql, log: (msg: string) => void): Promise<void> {
  const dir = join(process.cwd(), 'drizzle', 'manual');
  const files = listManualFiles(dir, log);
  if (files === null) return;

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
    const { canonical, accepted } = manualChecksums(sql);

    const [existing] = await client<{ checksum: string | null }[]>`
      SELECT checksum FROM __manual_migrations WHERE name = ${file}
    `;

    if (existing) {
      if (existing.checksum === canonical) continue; // already applied, unchanged
      if (existing.checksum === null || accepted.has(existing.checksum)) {
        // Applied before checksums were tracked, or hashed with other line
        // endings — same SQL either way. Store the canonical form, don't re-run.
        await client`UPDATE __manual_migrations SET checksum = ${canonical} WHERE name = ${file}`;
        continue;
      }
      throw new Error(
        `Manual migration "${file}" was already applied but its content changed ` +
          `(checksum mismatch) — never edit an applied file in drizzle/manual/, ` +
          `add a new one instead.`,
      );
    }

    log(`  · ${file}`);
    await client.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO __manual_migrations (name, checksum) VALUES (${file}, ${canonical})`;
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
