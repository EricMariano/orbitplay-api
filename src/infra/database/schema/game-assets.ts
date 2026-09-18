import { bigint, foreignKey, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';
import { assetKindEnum } from './enums';
import { games } from './games';
import { organizations } from './organizations';

/**
 * Binary assets for a game (cover, banner, screenshot) stored in MinIO. The
 * row holds the storage key + metadata; the bytes live in object storage.
 */
export const gameAssets = pgTable(
  'game_assets',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // No single-column .references() here on purpose — the composite FK
    // below (gameId, organizationId) is what actually enforces the
    // relationship (DAT-03).
    gameId: uuid('game_id').notNull(),
    kind: assetKindEnum('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('game_assets_game_idx').on(t.gameId),
    // DAT-03: an asset's organizationId must match the org that actually
    // owns the game it belongs to.
    foreignKey({
      name: 'game_assets_game_org_fk',
      columns: [t.gameId, t.organizationId],
      foreignColumns: [games.id, games.organizationId],
    }).onDelete('cascade'),
  ],
);

export type GameAssetRow = typeof gameAssets.$inferSelect;
export type NewGameAssetRow = typeof gameAssets.$inferInsert;
