import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';

/**
 * Global role catalogue (owner, admin, studio, player). A membership points at
 * one role. Kept as a table (not just an enum) because §5 lists it explicitly
 * and roles may later carry metadata/permissions.
 */
export const roles = pgTable(
  'roles',
  {
    id: primaryId(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('roles_key_unique').on(t.key)],
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRoleRow = typeof roles.$inferInsert;
