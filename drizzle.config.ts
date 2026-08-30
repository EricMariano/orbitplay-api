import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit reads DATABASE_URL directly from the environment. The schema
// under src/infra/database/schema is the SINGLE SOURCE OF TRUTH — migrations
// are always GENERATED (`pnpm db:generate`), never hand-written. The one
// exception is raw DDL under drizzle/manual/ (see README / section 7).
export default defineConfig({
  schema: './src/infra/database/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://orbitplay:orbitplay@localhost:5432/orbitplay',
  },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
