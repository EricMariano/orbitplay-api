import { relations } from 'drizzle-orm';
import { games } from './games';
import { memberships } from './memberships';
import { organizations } from './organizations';
import { roles } from './roles';
import { users } from './users';

/**
 * Drizzle `relations()` — declared on BOTH sides per AGENTS.md ("Banco de
 * dados e migrações"). Existing repositories keep querying with
 * select()/where() directly; this only makes the `db.query.*` relational
 * API available where it's useful. Added gradually (MAI-01) — this covers
 * the core tenancy graph (users/organizations/roles/memberships) plus
 * organizations→games; the rest of the schema (tests, builds, media,
 * community, ...) is left for follow-up passes rather than one large,
 * riskier change.
 */
export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  ownedOrganizations: many(organizations),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, {
    fields: [organizations.ownerUserId],
    references: [users.id],
  }),
  memberships: many(memberships),
  games: many(games),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
  role: one(roles, {
    fields: [memberships.roleId],
    references: [roles.id],
  }),
}));

export const gamesRelations = relations(games, ({ one }) => ({
  organization: one(organizations, {
    fields: [games.organizationId],
    references: [organizations.id],
  }),
}));
