import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations, type OrganizationRow } from '../../infra/database/schema/organizations';
import { roles } from '../../infra/database/schema/roles';
import { users } from '../../infra/database/schema/users';
import type { RoleValue } from '../../shared/auth/roles';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
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
}

/** Escape `\`, `%` and `_` so user search cannot broaden an ILIKE pattern. */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
