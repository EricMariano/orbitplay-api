import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations, type OrganizationRow } from '../../infra/database/schema/organizations';
import { roles } from '../../infra/database/schema/roles';
import { users } from '../../infra/database/schema/users';
import { AppException } from '../../shared/errors/app.exception';
import { Role, type RoleValue } from '../../shared/auth/roles';
import { isUuid } from '../../shared/util/uuid';

export interface MemberRecord {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
}

/** A membership row joined with its role key, scoped to one organization. */
export interface MembershipDetail {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: RoleValue;
  status: 'active' | 'invited' | 'disabled';
}

export interface InviteMemberInput {
  organizationId: string;
  email: string;
  displayName: string;
  role: RoleValue;
  /** Placeholder hash — the invitee sets a real password via recovery (RN-04). */
  passwordHash: string;
}

export interface InvitedMemberRecord {
  userId: string;
  email: string;
  displayName: string;
  role: RoleValue;
  status: 'invited';
}

/** Thrown when `memberships_org_user_unique` is hit (race-safe invite). */
export class MemberAlreadyExistsError extends Error {
  constructor() {
    super('Usuário já é membro da organização');
    this.name = 'MemberAlreadyExistsError';
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const candidates: unknown[] = [err];
  if (err && typeof err === 'object' && 'cause' in err) {
    candidates.push((err as { cause: unknown }).cause);
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const e = candidate as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      message?: string;
    };
    if (e.code !== '23505') continue;
    if (e.constraint_name === constraint || e.constraint === constraint) return true;
    // Fallback: postgres message embeds the constraint name in quotes.
    if (typeof e.message === 'string' && e.message.includes(`"${constraint}"`)) return true;
  }
  return false;
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

  async findRoleIdByKey(key: RoleValue): Promise<string | null> {
    const rows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, key))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Find one member's membership within an organization (ORB-M2-05). Both the
   * `organizationId` and `userId` filters are always applied together here —
   * never split across a service-level WHERE — so a `userId` from another
   * organization simply doesn't match a row (RN-01: 404, never 403).
   */
  async findMembershipInOrg(
    organizationId: string,
    userId: string,
  ): Promise<MembershipDetail | null> {
    if (!isUuid(userId)) return null;
    const rows = await this.db
      .select({
        membershipId: memberships.id,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: roles.key,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { ...row, role: row.role as RoleValue } : null;
  }

  /** Count active owners in the org — used to block leaving it ownerless. */
  async countActiveOwners(organizationId: string, excludingUserId?: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(roles.key, Role.OWNER),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
          excludingUserId ? sql`${memberships.userId} <> ${excludingUserId}` : undefined,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** Update a membership's status, scoped to the organization (RN-01). */
  async updateMemberStatusInOrg(
    organizationId: string,
    userId: string,
    status: 'active' | 'disabled',
  ): Promise<void> {
    const rows = await this.db
      .update(memberships)
      .set({ status })
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          isNull(memberships.deletedAt),
        ),
      )
      .returning({ id: memberships.id });
    if (rows.length === 0) throw AppException.notFound();
  }

  /** Soft-delete (revoke) a membership, scoped to the organization (RN-01). */
  async softDeleteMembershipInOrg(organizationId: string, userId: string): Promise<void> {
    const rows = await this.db
      .update(memberships)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          isNull(memberships.deletedAt),
        ),
      )
      .returning({ id: memberships.id });
    if (rows.length === 0) throw AppException.notFound();
  }

  /**
   * Create the `invited` membership, reusing the user row when the e-mail is
   * already registered (someone who plays on another organization) and creating
   * one otherwise. Both writes share a transaction so a failure never leaves a
   * user without the membership it was created for.
   *
   * The (organization_id, user_id) unique index is what makes a double invite
   * safe under concurrency — checking first and inserting after would let two
   * simultaneous requests through.
   */
  async createInvitedMember(input: InviteMemberInput): Promise<InvitedMemberRecord> {
    const roleId = await this.findRoleIdByKey(input.role);
    if (!roleId) {
      throw new Error(`Role "${input.role}" missing from catalogue — run db:seed`);
    }

    try {
      return await this.db.transaction(async (tx) => {
        // Deliberately NOT filtering deleted_at: users_email_unique is a plain
        // index, so a soft-deleted row still owns the address and inserting a
        // second one would always collide.
        const existing = await tx
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(sql`lower(${users.email})`, input.email))
          .limit(1);

        const found = existing[0];
        const userId = found?.id ?? newId();
        const displayName = found?.displayName ?? input.displayName;

        if (!found) {
          await tx.insert(users).values({
            id: userId,
            email: input.email,
            passwordHash: input.passwordHash,
            displayName: input.displayName,
            isActive: true,
          });
        }

        await tx.insert(memberships).values({
          id: newId(),
          organizationId: input.organizationId,
          userId,
          roleId,
          status: 'invited',
        });

        return {
          userId,
          email: input.email,
          displayName,
          role: input.role,
          status: 'invited' as const,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_org_user_unique')) {
        throw new MemberAlreadyExistsError();
      }
      // A concurrent invite won the user insert between our select and ours;
      // by the time we retried it would already be a member either way.
      if (isUniqueViolation(err, 'users_email_unique')) {
        throw new MemberAlreadyExistsError();
      }
      throw err;
    }
  }
}
