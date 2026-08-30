/**
 * Barrel for the Drizzle schema — the SINGLE SOURCE OF TRUTH for structure.
 * Migrations are generated from this (`pnpm db:generate`), never hand-written.
 * The day-partitioned `telemetry_events` table is the sole exception and lives
 * in drizzle/manual/ (section 7).
 */
export * from './enums';
export * from './users';
export * from './organizations';
export * from './roles';
export * from './memberships';
export * from './games';
export * from './game-assets';
export * from './audit-log';
export * from './refresh-tokens';
export * from './plugin';
