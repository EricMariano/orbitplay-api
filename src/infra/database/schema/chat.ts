import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import { postStatusEnum } from './enums';
import { games } from './games';
import { users } from './users';

/**
 * Real-time chat (M13-RT). A game is the "server" and each row here is one of
 * its channels, Discord-style — `community_posts` stays the asynchronous mural
 * of Tela 15 and is untouched.
 *
 * Channels are global content like the rest of the community surface: any
 * authenticated user reads and talks in a channel of any game, while only the
 * owning studio creates, archives and moderates.
 */
export const chatChannels = pgTable(
  'chat_channels',
  {
    id: primaryId(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    topic: text('topic'),
    /** Archived channels stay readable but refuse new messages. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [uniqueIndex('chat_channels_game_slug_unique').on(t.gameId, t.slug)],
);

/**
 * `status` reuses `post_status` (visible | hidden | removed) so moderating a
 * message and moderating a mural post mean exactly the same three things.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: primaryId(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => chatChannels.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    status: postStatusEnum('status').notNull().default('visible'),
    moderatedBy: uuid('moderated_by').references(() => users.id),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // History pages walk one channel by descending id (UUIDv7 ⇒ chronological).
  (t) => [index('chat_messages_channel_id_idx').on(t.channelId, t.id)],
);

export type ChatChannelRow = typeof chatChannels.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
