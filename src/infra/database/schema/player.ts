import {
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId } from './_helpers';
import { games } from './games';
import { users } from './users';

/** Signals for the organic feed ranking. Weights are still TBD. */
export const playerPreferences = pgTable('player_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  genres: text('genres').array(),
  platforms: text('platforms').array(),
  deviceProfile: jsonb('device_profile'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Frozen feed order for one navigation session. Ranked feeds shuffle between
 * requests; paginating without freezing repeats/skips items. Redis is an
 * acceptable alternative because these rows are ephemeral.
 */
export const feedRankingSnapshots = pgTable('feed_ranking_snapshots', {
  seed: text('seed').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  filtersHash: text('filters_hash'),
  itemIds: uuid('item_ids').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/**
 * Append-only XP ledger. Total XP and level are DERIVED from the sum; the
 * composite unique is what makes reload not duplicate XP (Tela 19 RN-03).
 */
export const xpEvents = pgTable(
  'xp_events',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    xp: integer('xp').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('xp_events_source_unique').on(t.userId, t.sourceType, t.sourceId)],
);

export const achievements = pgTable('achievements', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  iconKey: text('icon_key'),
  rule: jsonb('rule'),
});

export const playerAchievements = pgTable(
  'player_achievements',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    achievementKey: text('achievement_key')
      .notNull()
      .references(() => achievements.key),
    progress: numeric('progress').notNull().default('0'),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('player_achievements_unique').on(t.userId, t.achievementKey)],
);

export const missions = pgTable('missions', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  rewardXp: integer('reward_xp'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const playerMissions = pgTable(
  'player_missions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    missionKey: text('mission_key')
      .notNull()
      .references(() => missions.key),
    progress: numeric('progress').notNull().default('0'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('player_missions_unique').on(t.userId, t.missionKey)],
);

/** Materialized by a job — ranking computed per request does not scale. */
export const rankingSnapshots = pgTable('ranking_snapshots', {
  id: primaryId(),
  scope: text('scope').notNull(),
  period: text('period').notNull(),
  gameId: uuid('game_id').references(() => games.id, { onDelete: 'cascade' }),
  entries: jsonb('entries').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PlayerPreferenceRow = typeof playerPreferences.$inferSelect;
export type FeedRankingSnapshotRow = typeof feedRankingSnapshots.$inferSelect;
export type XpEventRow = typeof xpEvents.$inferSelect;
export type AchievementRow = typeof achievements.$inferSelect;
export type PlayerAchievementRow = typeof playerAchievements.$inferSelect;
export type MissionRow = typeof missions.$inferSelect;
export type PlayerMissionRow = typeof playerMissions.$inferSelect;
export type RankingSnapshotRow = typeof rankingSnapshots.$inferSelect;
