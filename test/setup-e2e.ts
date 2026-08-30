import { ensureTestDatabase, resetAndSeedTestDatabase } from './helpers/test-db';

/**
 * Vitest globalSetup: create the test database (if needed) and bring it to a
 * clean, migrated, seeded state ONCE before the e2e suite runs.
 */
export async function setup(): Promise<void> {
  await ensureTestDatabase();
  await resetAndSeedTestDatabase();
}
