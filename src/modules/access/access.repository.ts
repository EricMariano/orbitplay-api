import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  gameAccess,
  orgGroupMembers,
  orgGroups,
  type GameAccessRow,
  type NewGameAccessRow,
  type OrgGroupRow,
} from '../../infra/database/schema/game-access';
import { AppException } from '../../shared/errors/app.exception';
import { isUuid } from '../../shared/util/uuid';

export interface GroupRecord extends OrgGroupRow {
  memberUserIds: string[];
}

/** Org-scoped data access for member groups and per-game permissions. */
@Injectable()
export class AccessRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listGroups(organizationId: string): Promise<GroupRecord[]> {
    const groups = await this.db
      .select()
      .from(orgGroups)
      .where(and(eq(orgGroups.organizationId, organizationId), isNull(orgGroups.deletedAt)))
      .orderBy(asc(orgGroups.name));
    return this.withMembers(groups);
  }

  async findGroupsByIds(organizationId: string, ids: string[]): Promise<GroupRecord[]> {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return [];
    const groups = await this.db
      .select()
      .from(orgGroups)
      .where(
        and(
          eq(orgGroups.organizationId, organizationId),
          isNull(orgGroups.deletedAt),
          inArray(orgGroups.id, valid),
        ),
      );
    return this.withMembers(groups);
  }

  async findGroupByName(organizationId: string, name: string): Promise<OrgGroupRow | null> {
    const rows = await this.db
      .select()
      .from(orgGroups)
      .where(
        and(
          eq(orgGroups.organizationId, organizationId),
          eq(orgGroups.name, name),
          isNull(orgGroups.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async createGroup(
    organizationId: string,
    name: string,
    memberUserIds: string[],
  ): Promise<GroupRecord> {
    return this.db.transaction(async (tx) => {
      const [group] = await tx.insert(orgGroups).values({ organizationId, name }).returning();
      if (memberUserIds.length > 0) {
        await tx
          .insert(orgGroupMembers)
          .values(memberUserIds.map((userId) => ({ groupId: group.id, userId })));
      }
      return { ...group, memberUserIds };
    });
  }

  async updateGroup(
    organizationId: string,
    id: string,
    patch: { name?: string; memberUserIds?: string[] },
  ): Promise<GroupRecord> {
    if (!isUuid(id)) throw AppException.notFound();
    return this.db.transaction(async (tx) => {
      const scope = and(
        eq(orgGroups.id, id),
        eq(orgGroups.organizationId, organizationId),
        isNull(orgGroups.deletedAt),
      );
      const rows =
        patch.name !== undefined
          ? await tx.update(orgGroups).set({ name: patch.name }).where(scope).returning()
          : await tx.select().from(orgGroups).where(scope);
      if (rows.length === 0) throw AppException.notFound();

      if (patch.memberUserIds !== undefined) {
        await tx.delete(orgGroupMembers).where(eq(orgGroupMembers.groupId, id));
        if (patch.memberUserIds.length > 0) {
          await tx
            .insert(orgGroupMembers)
            .values(patch.memberUserIds.map((userId) => ({ groupId: id, userId })));
        }
      }
      const members = await tx
        .select({ userId: orgGroupMembers.userId })
        .from(orgGroupMembers)
        .where(eq(orgGroupMembers.groupId, id));
      return { ...rows[0], memberUserIds: members.map((m) => m.userId) };
    });
  }

  /** Soft-deletes the group and drops the permissions that pointed at it. */
  async softDeleteGroup(organizationId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw AppException.notFound();
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(orgGroups)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(orgGroups.id, id),
            eq(orgGroups.organizationId, organizationId),
            isNull(orgGroups.deletedAt),
          ),
        )
        .returning({ id: orgGroups.id });
      if (rows.length === 0) throw AppException.notFound();
      await tx.delete(gameAccess).where(eq(gameAccess.groupId, id));
    });
  }

  async listGameAccess(organizationId: string, gameId: string): Promise<GameAccessRow[]> {
    return this.db
      .select()
      .from(gameAccess)
      .where(and(eq(gameAccess.organizationId, organizationId), eq(gameAccess.gameId, gameId)))
      .orderBy(asc(gameAccess.createdAt), asc(gameAccess.id));
  }

  /** Replaces every permission row of the game atomically. */
  async replaceGameAccess(
    organizationId: string,
    gameId: string,
    rows: Omit<NewGameAccessRow, 'organizationId' | 'gameId'>[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(gameAccess)
        .where(and(eq(gameAccess.organizationId, organizationId), eq(gameAccess.gameId, gameId)));
      if (rows.length > 0) {
        await tx.insert(gameAccess).values(rows.map((row) => ({ ...row, organizationId, gameId })));
      }
    });
  }

  private async withMembers(groups: OrgGroupRow[]): Promise<GroupRecord[]> {
    if (groups.length === 0) return [];
    const members = await this.db
      .select({ groupId: orgGroupMembers.groupId, userId: orgGroupMembers.userId })
      .from(orgGroupMembers)
      .where(
        inArray(
          orgGroupMembers.groupId,
          groups.map((g) => g.id),
        ),
      );
    return groups.map((group) => ({
      ...group,
      memberUserIds: members.filter((m) => m.groupId === group.id).map((m) => m.userId),
    }));
  }
}
