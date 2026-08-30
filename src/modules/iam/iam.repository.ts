import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { memberships } from '../../infra/database/schema/memberships';
import {
  refreshTokens,
  type NewRefreshTokenRow,
  type RefreshTokenRow,
} from '../../infra/database/schema/refresh-tokens';
import { roles } from '../../infra/database/schema/roles';
import { users, type UserRow } from '../../infra/database/schema/users';
import type { RoleValue } from '../../shared/auth/roles';

export interface ActiveMembership {
  organizationId: string;
  roleKey: RoleValue;
}

@Injectable()
export class IamRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The user's active membership + role. Oldest membership wins (the owned org). */
  async findActiveMembership(userId: string): Promise<ActiveMembership | null> {
    const rows = await this.db
      .select({ organizationId: memberships.organizationId, roleKey: roles.key })
      .from(memberships)
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      )
      .orderBy(memberships.createdAt)
      .limit(1);
    const row = rows[0];
    return row ? { organizationId: row.organizationId, roleKey: row.roleKey as RoleValue } : null;
  }

  async insertRefreshToken(row: NewRefreshTokenRow): Promise<void> {
    await this.db.insert(refreshTokens).values(row);
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    const rows = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async revokeToken(id: string, replacedByTokenId?: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedByTokenId: replacedByTokenId ?? null })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
  }

  /** Reuse detected: revoke every still-active token in the family. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }
}
