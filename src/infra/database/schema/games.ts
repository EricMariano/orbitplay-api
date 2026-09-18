import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';
import { gameStatusEnum } from './enums';
import { organizations } from './organizations';

/**
 * A game belongs to exactly one organization. organization_id is the tenancy
 * key enforced by BaseRepository (RN-01) — services never filter by it.
 */
export const games = pgTable(
  'games',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    genre: text('genre'),
    platform: text('platform'),
    status: gameStatusEnum('status').notNull().default('draft'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('games_org_slug_unique').on(t.organizationId, t.slug),
    index('games_org_idx').on(t.organizationId),
    // DAT-03: lets org-scoped children (tests, game_assets) declare a
    // composite FK of (gameId, organizationId) → (id, organizationId) — a
    // real DB-level guarantee that a child can never claim a different org
    // than the game it points at actually belongs to, not just an
    // application-level filter that a future write path could forget.
    uniqueIndex('games_id_org_unique').on(t.id, t.organizationId),
  ],
);

export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;
