import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { AppException } from '../../shared/errors/app.exception';
import { newId } from '../../infra/database/schema/_helpers';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations, type OrganizationRow } from '../../infra/database/schema/organizations';
import { roles } from '../../infra/database/schema/roles';
import { users } from '../../infra/database/schema/users';
import type { RoleValue } from '../../shared/auth/roles';

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
}
