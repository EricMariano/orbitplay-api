import { boolean, foreignKey, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { primaryId, softDelete, timestamps } from './_helpers';
import { games } from './games';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Grupo de membros de uma organização (ex.: "Diretores", "QA"). Serve de
 * destinatário das permissões por jogo (Tela 04, etapa "Responsáveis e
 * permissões").
 */
export const orgGroups = pgTable(
  'org_groups',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('org_groups_org_idx').on(t.organizationId),
    uniqueIndex('org_groups_org_name_unique')
      .on(t.organizationId, t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const orgGroupMembers = pgTable(
  'org_group_members',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => orgGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('org_group_members_group_user_unique').on(t.groupId, t.userId),
    index('org_group_members_user_idx').on(t.userId),
  ],
);

/**
 * Permissões de um jogo para um grupo OU para um membro (exatamente um dos
 * dois). As quatro colunas booleanas são as colunas da matriz do Figma.
 */
export const gameAccess = pgTable(
  'game_access',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id').notNull(),
    groupId: uuid('group_id').references(() => orgGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    canManageAccess: boolean('can_manage_access').notNull().default(false),
    canEditInfo: boolean('can_edit_info').notNull().default(false),
    canManageTests: boolean('can_manage_tests').notNull().default(false),
    canViewReports: boolean('can_view_reports').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('game_access_game_idx').on(t.gameId),
    uniqueIndex('game_access_game_group_unique')
      .on(t.gameId, t.groupId)
      .where(sql`${t.groupId} is not null`),
    uniqueIndex('game_access_game_user_unique')
      .on(t.gameId, t.userId)
      .where(sql`${t.userId} is not null`),
    // DAT-03: a linha só pode apontar para um jogo da própria organização.
    foreignKey({
      name: 'game_access_game_org_fk',
      columns: [t.gameId, t.organizationId],
      foreignColumns: [games.id, games.organizationId],
    }).onDelete('cascade'),
  ],
);

export type OrgGroupRow = typeof orgGroups.$inferSelect;
export type NewOrgGroupRow = typeof orgGroups.$inferInsert;
export type OrgGroupMemberRow = typeof orgGroupMembers.$inferSelect;
export type GameAccessRow = typeof gameAccess.$inferSelect;
export type NewGameAccessRow = typeof gameAccess.$inferInsert;
