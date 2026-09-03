import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import { triggerTypeEnum } from './enums';
import { sessions } from './participations';
import { builds } from './tests';

/**
 * Plug-in / telemetry model (section 9). Created now, fed later. These shapes
 * are FROZEN because published builds and the SDK depend on them.
 *
 * NOTE: `telemetry_events` is intentionally NOT declared here — it is a
 * day-partitioned table that Drizzle cannot express, so it lives in
 * drizzle/manual/ (see section 7). The Postgres TelemetryStore adapter talks to
 * it via raw SQL.
 */

export const pluginManifests = pgTable('plugin_manifests', {
  id: primaryId(),
  buildId: uuid('build_id').references(() => builds.id),
  sdkVersion: text('sdk_version').notNull(),
  engine: text('engine').notNull(),
  rawManifest: jsonb('raw_manifest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const triggerDefinitions = pgTable('trigger_definitions', {
  id: primaryId(),
  manifestId: uuid('manifest_id')
    .notNull()
    .references(() => pluginManifests.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: triggerTypeEnum('type').notNull(),
  unit: text('unit'),
  config: jsonb('config'),
  ...timestamps,
});

/**
 * Aggregated spatial heatmap buckets per session. Composite PK (session_id,
 * x, y, z) so an upsert increments `count`.
 */
export const heatmapCells = pgTable(
  'heatmap_cells',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    z: integer('z').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.x, t.y, t.z] })],
);

/** Short-lived tokens authenticating a plug-in telemetry session. */
export const sessionTokens = pgTable('session_tokens', {
  id: primaryId(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PluginManifestRow = typeof pluginManifests.$inferSelect;
export type TriggerDefinitionRow = typeof triggerDefinitions.$inferSelect;
export type HeatmapCellRow = typeof heatmapCells.$inferSelect;
export type SessionTokenRow = typeof sessionTokens.$inferSelect;
