import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import { memberships } from './memberships';
import { organizations } from './organizations';

/**
 * Single-use tokens for accepting an organization invite. Only the SHA-256
 * hash is stored; the raw token lives solely in the invitation e-mail
 * (`/accept-invite?token=…`). `used_at` marks a token consumed — by the
 * invitee accepting it, or voided because the invite was resent. Accepting is
 * the only thing that flips the membership from `invited` to `active`.
 */
export const inviteTokens = pgTable(
  'invite_tokens',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invite_tokens_hash_unique').on(t.tokenHash),
    index('invite_tokens_membership_idx').on(t.membershipId),
  ],
);

export type InviteTokenRow = typeof inviteTokens.$inferSelect;
export type NewInviteTokenRow = typeof inviteTokens.$inferInsert;
