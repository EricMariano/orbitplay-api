import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { AppException } from '../../shared/errors/app.exception';
import { newId } from '../../infra/database/schema/_helpers';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations, type OrganizationRow } from '../../infra/database/schema/organizations';
import { roles } from '../../infra/database/schema/roles';
import { users } from '../../infra/database/schema/users';
import type { RoleValue } from '../../shared/auth/roles';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { MemberListQuery } from './dto/org.dto';

export interface MemberRecord {
  id: string;
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

export interface ChangeMemberStatusInput {
  organizationId: string;
  userId: string;
  status: 'active' | 'invited' | 'disabled';
}

export interface StatusChangeResult {
  previousStatus: string;
  member: MemberRoleRecord;
}

export interface RemoveMemberResult {
  previousStatus: string;
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

  /** Slug uniqueness check (organizations_slug_unique is global, not per-org). */
  async findBySlug(slug: string): Promise<OrganizationRow | null> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateById(
    organizationId: string,
    patch: Partial<Pick<OrganizationRow, 'name' | 'slug'>>,
  ): Promise<OrganizationRow> {
    const rows = await this.db
      .update(organizations)
      .set(patch)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .returning();
    if (rows.length === 0) throw AppException.notFound('Organização não encontrada');
    return rows[0];
  }

  /**
   * Cursor page of members (ORB-22): paginação por cursor (id da membership,
   * mesma convenção de games/base repository), busca por nome/e-mail (q) e
   * filtros opcionais por role/status.
   */
  async listMembers(organizationId: string, query: MemberListQuery): Promise<Page<MemberRecord>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(memberships.organizationId, organizationId), isNull(memberships.deletedAt)];
    if (cursorId) filters.push(lt(memberships.id, cursorId));
    if (query.role) filters.push(eq(roles.key, query.role));
    if (query.status) filters.push(eq(memberships.status, query.status));

    const term = query.q?.trim();
    if (term) {
      const pattern = `%${escapeIlike(term)}%`;
      filters.push(or(ilike(users.displayName, pattern), ilike(users.email, pattern))!);
    }

    const rows = await this.db
      .select({
        id: memberships.id,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: roles.key,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(and(...filters))
      .orderBy(desc(memberships.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
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
    const ownerRoleId = await this.requireOwnerRoleId();

    return this.db.transaction(async (tx) => {
      const activeOwners = await lockActiveOwners(tx, input.organizationId, ownerRoleId);

      const current = await findMembershipForUpdate(tx, input.organizationId, input.userId);
      if (!current) return null;

      const previousRole = current.role;
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

  /**
   * Change a member's status (ORB-M2-05). Same last-active-owner guard as
   * `changeMemberRole` (RN-03/RN-06): disabling the org's only active owner
   * is refused with a 409, never silently allowed.
   */
  async changeMemberStatus(input: ChangeMemberStatusInput): Promise<StatusChangeResult | null> {
    if (!isUuid(input.userId)) return null;

    const ownerRoleId = await this.requireOwnerRoleId();

    return this.db.transaction(async (tx) => {
      const activeOwners = await lockActiveOwners(tx, input.organizationId, ownerRoleId);

      const current = await findMembershipForUpdate(tx, input.organizationId, input.userId);
      if (!current) return null;

      const losesAnActiveOwner =
        current.role === 'owner' && current.status === 'active' && input.status !== 'active';
      if (losesAnActiveOwner && activeOwners.length <= 1) {
        throw new LastOwnerError();
      }

      await tx
        .update(memberships)
        .set({ status: input.status })
        .where(eq(memberships.id, current.membershipId));

      return {
        previousStatus: current.status,
        member: {
          userId: current.userId,
          email: current.email,
          displayName: current.displayName,
          role: current.role,
          status: input.status,
        },
      };
    });
  }

  /**
   * Remove a member (ORB-M2-06). RN-06: always a logical deactivation
   * (`deleted_at` + `status: disabled`), never a physical delete — history
   * (audit, past test participation) stays intact. Same last-owner guard.
   */
  async removeMember(organizationId: string, userId: string): Promise<RemoveMemberResult | null> {
    if (!isUuid(userId)) return null;

    const ownerRoleId = await this.requireOwnerRoleId();

    return this.db.transaction(async (tx) => {
      const activeOwners = await lockActiveOwners(tx, organizationId, ownerRoleId);

      const current = await findMembershipForUpdate(tx, organizationId, userId);
      if (!current) return null;

      const losesAnActiveOwner = current.role === 'owner' && current.status === 'active';
      if (losesAnActiveOwner && activeOwners.length <= 1) {
        throw new LastOwnerError();
      }

      await tx
        .update(memberships)
        .set({ status: 'disabled', deletedAt: new Date() })
        .where(eq(memberships.id, current.membershipId));

      return { previousStatus: current.status };
    });
  }

  private async requireOwnerRoleId(): Promise<string> {
    const ownerRoleId = await this.findRoleIdByKey('owner');
    if (!ownerRoleId) {
      throw new Error('Role "owner" missing from catalogue — run db:seed');
    }
    return ownerRoleId;
  }

  /** Read-only membership lookup — no row lock, used outside mutating flows. */
  async findMembership(organizationId: string, userId: string): Promise<MemberRoleRecord | null> {
    const row = await findMembershipForUpdate(this.db, organizationId, userId);
    return row ?? null;
  }
}

/** Escape `\`, `%` and `_` so user search cannot broaden an ILIKE pattern. */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Locks every active owner row of the org `FOR UPDATE` so two concurrent
 * demotions/disables/removals can't each read "two owners" and both succeed,
 * leaving none. Shared by changeMemberRole, changeMemberStatus and
 * removeMember (RN-03).
 */
async function lockActiveOwners(
  tx: Tx,
  organizationId: string,
  ownerRoleId: string,
): Promise<{ userId: string }[]> {
  return tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.roleId, ownerRoleId),
        eq(memberships.status, 'active'),
        isNull(memberships.deletedAt),
      ),
    )
    .for('update');
}

async function findMembershipForUpdate(
  db: Database | Tx,
  organizationId: string,
  userId: string,
): Promise<(MemberRoleRecord & { membershipId: string }) | undefined> {
  const rows = await db
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

  return rows[0] as (MemberRoleRecord & { membershipId: string }) | undefined;
}
