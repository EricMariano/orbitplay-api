import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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
  membershipId: string;
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
  status: 'active' | 'disabled';
  /** Role of the member making the change — only an owner may act on an owner. */
  callerRole: RoleValue;
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

/**
 * Thrown when the invited e-mail belongs only to a soft-deleted account. The
 * invite never reuses a deleted account (it could never log in again), and
 * `users_email_unique` keeps the address from going to a new one.
 */
export class InviteEmailUnavailableError extends Error {
  constructor() {
    super('Este e-mail pertence a uma conta excluída e não pode ser convidado');
    this.name = 'InviteEmailUnavailableError';
  }
}

/**
 * Thrown when a non-owner (an admin) tries to disable, remove or otherwise act
 * on an owner. Role hierarchy: an admin manages admins, studio members and
 * players; only an owner acts on an owner.
 */
export class OwnerOnlyError extends Error {
  constructor() {
    super('Somente owners podem gerenciar outro owner');
    this.name = 'OwnerOnlyError';
  }
}

/** True when `callerRole` may act on a member whose role is `targetRole`. */
export function canManageRole(callerRole: RoleValue, targetRole: string): boolean {
  return targetRole !== 'owner' || callerRole === 'owner';
}

/** Thrown when a demotion would leave the organization without an active owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('A organização precisa de pelo menos um owner ativo');
    this.name = 'LastOwnerError';
  }
}

/**
 * Thrown when an owner/admin tries to change the status of a pending
 * invitation. The invite reuses any existing account by e-mail, so activating
 * it by hand — directly, or by disabling it first and then "re-activating" —
 * would drop someone from another tenant into this organization without their
 * consent. Only the invitee accepts, through the link in the invitation
 * e-mail; cancelling is removing the member (a removed membership can't come
 * back).
 */
export class PendingInviteError extends Error {
  constructor() {
    super(
      'Convite pendente: só o convidado o aceita, pelo link do convite. Para cancelar, remova o membro',
    );
    this.name = 'PendingInviteError';
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

/**
 * The name a member shows to their organization. The invite reuses any
 * existing account by e-mail, so an invited membership may point at someone
 * else's account: its real name isn't the inviting org's to see (or to search
 * for) until they accept. Until then it shows the e-mail the org itself typed —
 * the same thing the invite response already echoes.
 */
const memberDisplayName = sql<string>`case when ${memberships.status} = 'invited' then ${users.email} else ${users.displayName} end`;

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
      filters.push(or(ilike(memberDisplayName, pattern), ilike(users.email, pattern))!);
    }

    const rows = await this.db
      .select({
        id: memberships.id,
        userId: users.id,
        email: users.email,
        displayName: memberDisplayName,
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

  /** Memberships (any status) of `userIds` inside the org — for cross-module validation. */
  async findMembersByUserIds(organizationId: string, userIds: string[]): Promise<MemberRecord[]> {
    const valid = userIds.filter(isUuid);
    if (valid.length === 0) return [];
    return this.db
      .select({
        id: memberships.id,
        userId: users.id,
        email: users.email,
        displayName: memberDisplayName,
        role: roles.key,
        status: memberships.status,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          isNull(memberships.deletedAt),
          inArray(memberships.userId, valid),
        ),
      );
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
   * A soft-deleted account is never reused: it can't log in, so the invite
   * would point at someone who can never accept it. Its e-mail still holds
   * `users_email_unique`, which then answers `InviteEmailUnavailableError`.
   *
   * The (organization_id, user_id) unique index is what makes a double invite
   * safe under concurrency — checking first and inserting after would let two
   * simultaneous requests through.
   */
  async createInvitedMember(input: InviteMemberInput): Promise<InvitedMemberRecord> {
    const roleId = await this.findRoleIdByKey(input.role);
    if (!roleId) {
      throw new Error(`Role "${input.role}" missing from catalogue — run db:migrate`);
    }

    try {
      return await this.insertInvitedMember(input, roleId);
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_org_user_unique')) {
        throw new MemberAlreadyExistsError();
      }
      if (!isUniqueViolation(err, 'users_email_unique')) throw err;
    }

    // `users_email_unique` with no live account found: either the address
    // belongs to a deleted account, or a concurrent invite created the account
    // between our lookup and our insert — then retry once, now reusing it.
    if (!(await this.findLiveUserIdByEmail(this.db, input.email))) {
      throw new InviteEmailUnavailableError();
    }
    try {
      return await this.insertInvitedMember(input, roleId);
    } catch (err) {
      if (isUniqueViolation(err, 'memberships_org_user_unique')) {
        throw new MemberAlreadyExistsError();
      }
      throw err;
    }
  }

  private async insertInvitedMember(
    input: InviteMemberInput,
    roleId: string,
  ): Promise<InvitedMemberRecord> {
    return this.db.transaction(async (tx) => {
      const found = await this.findLiveUserIdByEmail(tx, input.email);
      const userId = found ?? newId();
      // Never echo the stored name of an account that already exists: the
      // inviter is not entitled to it, and it would reveal which e-mails
      // are registered.
      const displayName = input.displayName;

      if (!found) {
        await tx.insert(users).values({
          id: userId,
          email: input.email,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
          isActive: true,
        });
      }

      const membershipId = newId();
      await tx.insert(memberships).values({
        id: membershipId,
        organizationId: input.organizationId,
        userId,
        roleId,
        status: 'invited',
      });

      return {
        membershipId,
        userId,
        email: input.email,
        displayName,
        role: input.role,
        status: 'invited' as const,
      };
    });
  }

  /** The non-deleted account that owns this (lower-cased) e-mail, if any. */
  private async findLiveUserIdByEmail(db: Database | Tx, email: string): Promise<string | null> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, email), isNull(users.deletedAt)))
      .limit(1);
    return rows[0]?.id ?? null;
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
      throw new Error(`Role "${input.role}" missing from catalogue — run db:migrate`);
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
   * is refused with a 409, never silently allowed. An admin can't act on an
   * owner (`OwnerOnlyError`) — checked on the row read inside the transaction,
   * after the owner rows are locked, so a concurrent promotion can't slip by.
   */
  async changeMemberStatus(input: ChangeMemberStatusInput): Promise<StatusChangeResult | null> {
    if (!isUuid(input.userId)) return null;

    const ownerRoleId = await this.requireOwnerRoleId();

    return this.db.transaction(async (tx) => {
      const activeOwners = await lockActiveOwners(tx, input.organizationId, ownerRoleId);

      const current = await findMembershipForUpdate(tx, input.organizationId, input.userId);
      if (!current) return null;
      if (!canManageRole(input.callerRole, current.role)) throw new OwnerOnlyError();
      if (current.status === 'invited') throw new PendingInviteError();

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
   * (audit, past test participation) stays intact. Same last-owner guard, and
   * the same role hierarchy as `changeMemberStatus` (`OwnerOnlyError`).
   */
  async removeMember(
    organizationId: string,
    userId: string,
    callerRole: RoleValue,
  ): Promise<RemoveMemberResult | null> {
    if (!isUuid(userId)) return null;

    const ownerRoleId = await this.requireOwnerRoleId();

    return this.db.transaction(async (tx) => {
      const activeOwners = await lockActiveOwners(tx, organizationId, ownerRoleId);

      const current = await findMembershipForUpdate(tx, organizationId, userId);
      if (!current) return null;
      if (!canManageRole(callerRole, current.role)) throw new OwnerOnlyError();

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
      throw new Error('Role "owner" missing from catalogue — run db:migrate');
    }
    return ownerRoleId;
  }

  /** Read-only membership lookup — no row lock, used outside mutating flows. */
  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<(MemberRoleRecord & { membershipId: string }) | null> {
    // Same guard as role/status/remove: a malformed id is a 404, not a 22P02 → 500.
    if (!isUuid(userId)) return null;
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
      displayName: memberDisplayName,
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
