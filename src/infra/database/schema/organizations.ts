import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';
import { users } from './users';

/**
 * An organization IS the studio and the tenancy boundary. Each registering user
 * creates their own organization and becomes its Owner (decision §1.1); the org
 * may then have additional members ("funcionários") with distinct roles.
 * organization_id on every domain table scopes it to this row.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('organizations_slug_unique').on(t.slug)],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
