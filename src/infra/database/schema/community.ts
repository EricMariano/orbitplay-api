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
import { postStatusEnum, processingStatusEnum } from './enums';
import { games } from './games';
import { tests } from './tests';
import { users } from './users';

/**
 * One row per report block, not one payload per test. A failing block does
 * not take down the rest; telemetry/AI land later as new `block_key`s.
 */
export const testReportSnapshots = pgTable(
  'test_report_snapshots',
  {
    id: primaryId(),
    testId: uuid('test_id')
      .notNull()
      .references(() => tests.id, { onDelete: 'cascade' }),
    blockKey: text('block_key').notNull(),
    status: processingStatusEnum('status').notNull().default('processing'),
    payload: jsonb('payload'),
    computedAt: timestamp('computed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('test_report_snapshots_unique').on(t.testId, t.blockKey)],
);

export const gameReviews = pgTable(
  'game_reviews',
  {
    id: primaryId(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: numeric('rating').notNull(),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('game_reviews_unique').on(t.gameId, t.userId)],
);

export const communityPosts = pgTable('community_posts', {
  id: primaryId(),
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  authorUserId: uuid('author_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  status: postStatusEnum('status').notNull().default('visible'),
  moderatedBy: uuid('moderated_by').references(() => users.id),
  moderatedAt: timestamp('moderated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const communityReports = pgTable('community_reports', {
  id: primaryId(),
  postId: uuid('post_id')
    .notNull()
    .references(() => communityPosts.id, { onDelete: 'cascade' }),
  reporterUserId: uuid('reporter_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: primaryId(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Durable copy of an idempotent response. Redis covers the common case; the
 * real race protection is unique constraints on the resource tables.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  requestHash: text('request_hash'),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type TestReportSnapshotRow = typeof testReportSnapshots.$inferSelect;
export type GameReviewRow = typeof gameReviews.$inferSelect;
export type CommunityPostRow = typeof communityPosts.$inferSelect;
export type CommunityReportRow = typeof communityReports.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
