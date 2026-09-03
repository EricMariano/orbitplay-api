import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { memberships } from '../../infra/database/schema/memberships';
import { organizations } from '../../infra/database/schema/organizations';
import {
  passwordResetTokens,
  type NewPasswordResetTokenRow,
  type PasswordResetTokenRow,
} from '../../infra/database/schema/password-reset-tokens';
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

export interface CreateStudioAccountInput {
  userId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  birthdate: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
}

export interface CreatedStudioAccount {
  userId: string;
  email: string;
  displayName: string;
  organizationId: string;
  organizationName: string;
  role: 'owner';
}

export interface CreatePlayerAccountInput {
  userId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  birthdate: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
}

export interface CreatedPlayerAccount {
  userId: string;
  email: string;
  displayName: string;
  organizationId: string;
  organizationName: string;
  role: 'player';
}

/** Thrown when `users.email` unique index is hit (race-safe signup). */
export class EmailAlreadyTakenError extends Error {
  constructor() {
    super('E-mail já cadastrado');
    this.name = 'EmailAlreadyTakenError';
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
export class AuthRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * True if any row owns this email (including soft-deleted / inactive).
   * Signup uniqueness is a plain unique index on email — deleted addresses
   * cannot be reused, so availability must match that rule.
   */
  async emailExists(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
      .limit(1);
    return rows.length > 0;
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

  async insertPasswordResetToken(row: NewPasswordResetTokenRow): Promise<void> {
    await this.db.insert(passwordResetTokens).values(row);
  }

  /** Mark every still-unused reset token for the user as used (latest wins). */
  async invalidateUnusedTokens(userId: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
  }

  /**
   * Atomically consume a still-valid, unused token. Returns null when the hash
   * is unknown, already used, or expired.
   */
  async consumePasswordResetToken(tokenHash: string): Promise<PasswordResetTokenRow | null> {
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  async revokeAllRefreshTokensForUser(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  /**
   * Consume the reset token, set the new password hash, and revoke every active
   * refresh token — all in one transaction. Returns the user id, or null when
   * the token is invalid/expired/already used.
   */
  async applyPasswordReset(tokenHash: string, passwordHash: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const consumed = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning();
      const row = consumed[0];
      if (!row) return null;

      await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));

      return row.userId;
    });
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
   * Atomically create user + organization + owner membership (ORB-M1-02 /
   * DECISIONS.md §1.1). Email uniqueness is enforced by the DB unique index —
   * a concurrent insert surfaces as EmailAlreadyTakenError. Slug collisions
   * retry once with a short UUID suffix.
   */
  async createStudioAccount(input: CreateStudioAccountInput): Promise<CreatedStudioAccount> {
    const ownerRoleId = await this.findRoleIdByKey('owner');
    if (!ownerRoleId) {
      throw new Error('Role "owner" missing from catalogue — run db:seed');
    }

    try {
      return await this.insertStudioAccount(input, ownerRoleId, input.organizationSlug);
    } catch (err) {
      if (err instanceof EmailAlreadyTakenError) throw err;
      if (isUniqueViolation(err, 'users_email_unique')) {
        throw new EmailAlreadyTakenError();
      }
      if (isUniqueViolation(err, 'organizations_slug_unique')) {
        const suffix = newId().replace(/-/g, '').slice(0, 8);
        const retrySlug = `${input.organizationSlug.slice(0, 191)}-${suffix}`;
        try {
          return await this.insertStudioAccount(input, ownerRoleId, retrySlug);
        } catch (retryErr) {
          if (isUniqueViolation(retryErr, 'users_email_unique')) {
            throw new EmailAlreadyTakenError();
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async insertStudioAccount(
    input: CreateStudioAccountInput,
    ownerRoleId: string,
    slug: string,
  ): Promise<CreatedStudioAccount> {
    return this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: input.userId,
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        birthdate: input.birthdate,
        isActive: true,
      });

      await tx.insert(organizations).values({
        id: input.organizationId,
        name: input.organizationName,
        slug,
        ownerUserId: input.userId,
      });

      await tx.insert(memberships).values({
        id: newId(),
        organizationId: input.organizationId,
        userId: input.userId,
        roleId: ownerRoleId,
        status: 'active',
      });

      return {
        userId: input.userId,
        email: input.email,
        displayName: input.displayName,
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        role: 'owner' as const,
      };
    });
  }

  /**
   * Atomically create user + personal organization + player membership
   * (ORB-M1-03). Email uniqueness is enforced by the DB unique index.
   * Slug collisions retry once with a short UUID suffix.
   */
  async createPlayerAccount(input: CreatePlayerAccountInput): Promise<CreatedPlayerAccount> {
    const playerRoleId = await this.findRoleIdByKey('player');
    if (!playerRoleId) {
      throw new Error('Role "player" missing from catalogue — run db:seed');
    }

    try {
      return await this.insertPlayerAccount(input, playerRoleId, input.organizationSlug);
    } catch (err) {
      if (err instanceof EmailAlreadyTakenError) throw err;
      if (isUniqueViolation(err, 'users_email_unique')) {
        throw new EmailAlreadyTakenError();
      }
      if (isUniqueViolation(err, 'organizations_slug_unique')) {
        const suffix = newId().replace(/-/g, '').slice(0, 8);
        const retrySlug = `${input.organizationSlug.slice(0, 191)}-${suffix}`;
        try {
          return await this.insertPlayerAccount(input, playerRoleId, retrySlug);
        } catch (retryErr) {
          if (isUniqueViolation(retryErr, 'users_email_unique')) {
            throw new EmailAlreadyTakenError();
          }
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private async insertPlayerAccount(
    input: CreatePlayerAccountInput,
    playerRoleId: string,
    slug: string,
  ): Promise<CreatedPlayerAccount> {
    return this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: input.userId,
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        birthdate: input.birthdate,
        isActive: true,
      });

      await tx.insert(organizations).values({
        id: input.organizationId,
        name: input.organizationName,
        slug,
        ownerUserId: input.userId,
      });

      await tx.insert(memberships).values({
        id: newId(),
        organizationId: input.organizationId,
        userId: input.userId,
        roleId: playerRoleId,
        status: 'active',
      });

      return {
        userId: input.userId,
        email: input.email,
        displayName: input.displayName,
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        role: 'player' as const,
      };
    });
  }
}
