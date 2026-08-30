import 'dotenv/config';
import postgres from 'postgres';

/**
 * Dev-only: drop and recreate the public schema, then re-run migrations from
 * scratch. Refuses to run against NODE_ENV=production. After this, run
 * `pnpm db:seed` to repopulate (acceptance criterion #10).
 */
async function reset(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset is disabled in production');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    console.log('→ dropping schemas public + drizzle…');
    // Drop `drizzle` too: it holds the migration history. Leaving it makes the
    // re-migration a no-op and the DB comes back empty.
    await client.unsafe(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
    );
    console.log('✓ schema reset — re-running migrations…');
  } finally {
    await client.end({ timeout: 5 });
  }
}

reset()
  .then(async () => {
    // Re-apply migrations immediately so the DB is usable right after reset.
    await import('./migrate');
  })
  .catch((err) => {
    console.error('✗ reset failed');
    console.error(err);
    process.exit(1);
  });
