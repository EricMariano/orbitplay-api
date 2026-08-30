import { boolean, date, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';

/**
 * A user is a person/account — global, not org-scoped. Membership in an
 * organization (studio) is expressed by the memberships table. Registration is
 * 18+ (decision §1.4); birthdate is stored to enforce it.
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
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
