import { sql } from 'drizzle-orm';
import { boolean, date, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';

/**
 * A user is a person/account — global, not org-scoped. Membership in an
 * organization (studio) is expressed by the memberships table. Registration is
 * 18+ (decision §1.4); birthdate is stored to enforce it.
 *
 * `users_email_unique` is on `lower(email)`: uniqueness is case-insensitive,
 * and every lookup (login, forgot password, availability, invite) filters by
 * `lower(email) = $1`, so the same expression index serves them. The name is
 * matched by application code on unique violations — keep it.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    birthdate: date('birthdate'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
