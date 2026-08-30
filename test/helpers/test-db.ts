import postgres from 'postgres';
import { runMigrations } from '../../src/infra/database/migrate';
import { seedDatabase } from '../../src/infra/database/seed';

/**
 * The e2e suite runs against a SEPARATE database (orbitplay_test) so it never
 * touches dev data. This URL is also injected into the test workers via
 * vitest.config.e2e.ts (test.env.DATABASE_URL).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://orbitplay:orbitplay@localhost:5432/orbitplay_test';

function adminUrl(): string {
  // Connect to the default "postgres" db to create/manage the test db.
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = '/postgres';
  return u.toString();
}

function testDbName(): string {
  return new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
}

/** Create the test database if it doesn't exist yet. */
export async function ensureTestDatabase(): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1 });
  const name = testDbName();
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (exists.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Drop all schema, re-migrate and seed — deterministic starting point. */
export async function resetAndSeedTestDatabase(): Promise<void> {
  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
  } finally {
    await client.end({ timeout: 5 });
  }
  await runMigrations(TEST_DATABASE_URL, true);
  await seedDatabase(TEST_DATABASE_URL, true);
}
