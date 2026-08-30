import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations, type OrganizationRow } from '../../infra/database/schema/organizations';
import { roles } from '../../infra/database/schema/roles';
import { users } from '../../infra/database/schema/users';

export interface MemberRecord {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
}

@Injectable()
export class OrgsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findById(organizationId: string): Promise<OrganizationRow | null> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listMembers(organizationId: string): Promise<MemberRecord[]> {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: roles.key,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(and(eq(memberships.organizationId, organizationId), isNull(memberships.deletedAt)))
      .orderBy(memberships.createdAt);
  }
}
