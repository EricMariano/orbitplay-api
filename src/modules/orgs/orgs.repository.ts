import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations, type OrganizationRow } from '../../infra/database/schema/organizations';
import { roles } from '../../infra/database/schema/roles';
import { users } from '../../infra/database/schema/users';
import type { RoleValue } from '../../shared/auth/roles';
import { isUuid } from '../../shared/util/uuid';

export interface MemberRecord {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
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

export interface ChangeMemberRoleInput {
  organizationId: string;
  userId: string;
  role: RoleValue;
}

export interface MemberRoleRecord {
  userId: string;
  email: string;
  displayName: string;
  role: RoleValue;
  status: string;
}

export interface RoleChangeResult {
  previousRole: RoleValue;
  member: MemberRoleRecord;
}

/** Thrown when `memberships_org_user_unique` is hit (race-safe invite). */
export class MemberAlreadyExistsError extends Error {
  constructor() {
    super('Usuário já é membro da organização');
    this.name = 'MemberAlreadyExistsError';
  }
}

/** Thrown when a demotion would leave the organization without an active owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('A organização precisa de pelo menos um owner ativo');
    this.name = 'LastOwnerError';
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

  /**
   * Change a member's role (ORB-M2-04). Returns null when the user is not a
   * member of this organization — a malformed id included, so a bad path
   * parameter answers 404 and never 500.
   *
   * RN-03: demoting the last ACTIVE owner is refused. The active owners are
   * locked before the count, because two concurrent demotions would otherwise
   * both read "two owners" and both succeed, leaving the org with none. An
   * `invited` owner does not count: that membership cannot log in yet.
   *
   * `organizations.owner_user_id` is deliberately left untouched — see
   * DECISIONS.md §3.
   */
  async changeMemberRole(input: ChangeMemberRoleInput): Promise<RoleChangeResult | null> {
    if (!isUuid(input.userId)) return null;

    const nextRoleId = await this.findRoleIdByKey(input.role);
    if (!nextRoleId) {
      throw new Error(`Role "${input.role}" missing from catalogue — run db:seed`);
    }
    const ownerRoleId = await this.findRoleIdByKey('owner');
    if (!ownerRoleId) {
      throw new Error('Role "owner" missing from catalogue — run db:seed');
    }

    return this.db.transaction(async (tx) => {
      const activeOwners = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, input.organizationId),
            eq(memberships.roleId, ownerRoleId),
            eq(memberships.status, 'active'),
            isNull(memberships.deletedAt),
          ),
        )
        .for('update');

      const rows = await tx
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
            eq(memberships.organizationId, input.organizationId),
            eq(memberships.userId, input.userId),
            isNull(memberships.deletedAt),
          ),
        )
        .limit(1);

      const current = rows[0];
      if (!current) return null;

      const previousRole = current.role as RoleValue;
      const losesAnActiveOwner =
        previousRole === 'owner' && input.role !== 'owner' && current.status === 'active';
      if (losesAnActiveOwner && activeOwners.length <= 1) {
        throw new LastOwnerError();
      }

      await tx
        .update(memberships)
        .set({ roleId: nextRoleId })
        .where(eq(memberships.id, current.membershipId));

      return {
        previousRole,
        member: {
          userId: current.userId,
          email: current.email,
          displayName: current.displayName,
          role: input.role,
          status: current.status,
        },
      };
    });
  }
}
