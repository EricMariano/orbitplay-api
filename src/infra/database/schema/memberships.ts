import { pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, softDelete, timestamps } from './_helpers';
import { membershipStatusEnum } from './enums';
import { organizations } from './organizations';
import { roles } from './roles';
import { users } from './users';

/**
 * Links a user to an organization with a role. One active membership per
 * (organization, user). Deactivation via status/deleted_at preserves history.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    status: membershipStatusEnum('status').notNull().default('active'),
    ...timestamps,
    ...softDelete,
  },
  (t) => [uniqueIndex('memberships_org_user_unique').on(t.organizationId, t.userId)],
);

export type MembershipRow = typeof memberships.$inferSelect;
export type NewMembershipRow = typeof memberships.$inferInsert;
