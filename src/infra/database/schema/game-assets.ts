import { bigint, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';
import { games } from './games';
import { organizations } from './organizations';

/**
 * Binary assets for a game (cover, screenshots, …) stored in MinIO. The row
 * holds the storage key + metadata; the bytes live in object storage.
 */
export const gameAssets = pgTable(
  'game_assets',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // e.g. cover | screenshot
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('game_assets_game_idx').on(t.gameId)],
);

export type GameAssetRow = typeof gameAssets.$inferSelect;
export type NewGameAssetRow = typeof gameAssets.$inferInsert;
