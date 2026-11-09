import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { inviteTokens } from '../../infra/database/schema/invite-tokens';
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

export interface ActiveMembershipWithOrg extends ActiveMembership {
  organizationName: string;
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

/** A pending invite reached through a still-valid, unused token. */
export interface PendingInvite {
  inviteTokenId: string;
  membershipId: string;
  organizationId: string;
  organizationName: string;
  role: RoleValue;
  userId: string;
  email: string;
  passwordHash: string;
  birthdate: string | null;
}

export interface InviteAcceptance {
  tokenHash: string;
  membershipId: string;
  userId: string;
  /** Set only when the invite created the account: the invitee picks the password here. */
  passwordHash?: string;
  /** Set when the account has none yet (18+ is checked by the service). */
  birthdate?: string;
}

/** Thrown when `users.email` unique index is hit (race-safe signup). */
export class EmailAlreadyTakenError extends Error {
  constructor() {
    super('E-mail já cadastrado');
    this.name = 'EmailAlreadyTakenError';
  }
}

/** Rolls `acceptInvite`'s transaction back when the membership left `invited` meanwhile. */
class InviteNoLongerPendingError extends Error {}

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
   * Signup uniqueness is the `users_email_unique` index on `lower(email)` —
   * deleted addresses cannot be reused, so availability must match that rule.
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

  /**
   * Every org the user is an active member of, with the role and org name
   * needed to let them pick one at login — a user invited into a second org
   * (GAP-02) is no longer silently locked into whichever membership happens
   * to be oldest.
   */
  async findActiveMemberships(userId: string): Promise<ActiveMembershipWithOrg[]> {
    const rows = await this.db
      .select({
        organizationId: memberships.organizationId,
        organizationName: organizations.name,
        roleKey: roles.key,
      })
      .from(memberships)
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      )
      .orderBy(memberships.createdAt);
    return rows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      roleKey: row.roleKey as RoleValue,
    }));
  }

  /** The user's active membership in a specific org, or null if they no longer belong to it. */
  async findActiveMembershipForOrg(
    userId: string,
    organizationId: string,
  ): Promise<ActiveMembership | null> {
    const rows = await this.db
      .select({ organizationId: memberships.organizationId, roleKey: roles.key })
      .from(memberships)
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, organizationId),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { organizationId: row.organizationId, roleKey: row.roleKey as RoleValue } : null;
  }

  async insertRefreshToken(row: NewRefreshTokenRow): Promise<void> {
    await this.db.insert(refreshTokens).values(row);
  }

  /**
   * Atomically consume `currentId` and insert its successor in one transaction.
   * The revoke is a conditional `WHERE revoked_at IS NULL` UPDATE — if a
   * concurrent request already rotated/revoked this token, zero rows come
   * back and we roll back without inserting a second successor. Without this,
   * two racing requests could each insert their own "next" token for the same
   * predecessor, minting two valid successors from one refresh token.
   */
  async rotateRefreshToken(currentId: string, next: NewRefreshTokenRow): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), replacedByTokenId: next.id })
        .where(and(eq(refreshTokens.id, currentId), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (updated.length === 0) return false;

      await tx.insert(refreshTokens).values(next);
      return true;
    });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    const rows = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenRow | null> {
    const rows = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert another token into a family whose predecessor was already rotated
   * (the reuse grace window in `AuthService.refresh`) — but only while the
   * family still holds a live token. Rotation leaves the rotated row with its
   * own `revoked_at`, so a logout, a password reset or a reuse detection that
   * revoked the rest of the family would otherwise not stop a just-rotated
   * token from reopening it. `FOR UPDATE` makes a revocation already in flight
   * be waited for and seen, instead of read past from a stale snapshot.
   */
  async insertRefreshTokenIfFamilyActive(row: NewRefreshTokenRow): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const live = await tx
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.familyId, row.familyId),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (live.length === 0) return false;

      await tx.insert(refreshTokens).values(row);
      return true;
    });
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
   * Consume the reset token, set the new password hash and revoke every active
   * refresh token — all in one transaction. Memberships are left alone: a
   * pending invite is accepted only through its own token (`acceptInvite`),
   * never as a side effect of recovering a password. Returns the user id, or
   * null when the token is invalid/expired/already used.
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

  /**
   * Issue the invite's token: void every unused one of the same membership
   * (a resend makes the previous link stop working) and store the new hash.
   */
  async replaceInviteToken(row: {
    organizationId: string;
    membershipId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(inviteTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(inviteTokens.membershipId, row.membershipId), isNull(inviteTokens.usedAt)));
      await tx.insert(inviteTokens).values({ id: newId(), ...row });
    });
  }

  /**
   * The invite behind a token, while it can still be accepted: token unused
   * and unexpired, membership still `invited` (not removed), organization and
   * account still there and active.
   */
  async findPendingInviteByTokenHash(tokenHash: string): Promise<PendingInvite | null> {
    const rows = await this.db
      .select({
        inviteTokenId: inviteTokens.id,
        membershipId: memberships.id,
        organizationId: organizations.id,
        organizationName: organizations.name,
        role: roles.key,
        userId: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        birthdate: users.birthdate,
      })
      .from(inviteTokens)
      .innerJoin(memberships, eq(inviteTokens.membershipId, memberships.id))
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(inviteTokens.tokenHash, tokenHash),
          isNull(inviteTokens.usedAt),
          gt(inviteTokens.expiresAt, new Date()),
          eq(memberships.status, 'invited'),
          isNull(memberships.deletedAt),
          isNull(organizations.deletedAt),
          isNull(users.deletedAt),
          eq(users.isActive, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { ...row, role: row.role as RoleValue } : null;
  }

  /**
   * Accept an invite in one transaction: consume the token, flip the
   * membership `invited` → `active`, and — for an account the invite created —
   * store the password (revoking any session) and birthdate. False when the
   * token was consumed or the membership changed in the meantime (nothing is
   * written then).
   */
  async acceptInvite(input: InviteAcceptance): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const consumed = await tx
          .update(inviteTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(inviteTokens.tokenHash, input.tokenHash),
              eq(inviteTokens.membershipId, input.membershipId),
              isNull(inviteTokens.usedAt),
              gt(inviteTokens.expiresAt, new Date()),
            ),
          )
          .returning({ id: inviteTokens.id });
        if (consumed.length === 0) return false;

        const activated = await tx
          .update(memberships)
          .set({ status: 'active' })
          .where(
            and(
              eq(memberships.id, input.membershipId),
              eq(memberships.userId, input.userId),
              eq(memberships.status, 'invited'),
              isNull(memberships.deletedAt),
            ),
          )
          .returning({ id: memberships.id });
        if (activated.length === 0) throw new InviteNoLongerPendingError();

        const profile = {
          ...(input.passwordHash ? { passwordHash: input.passwordHash } : {}),
          ...(input.birthdate ? { birthdate: input.birthdate } : {}),
        };
        if (Object.keys(profile).length > 0) {
          await tx.update(users).set(profile).where(eq(users.id, input.userId));
        }
        if (input.passwordHash) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(refreshTokens.userId, input.userId), isNull(refreshTokens.revokedAt)));
        }
        // Any other link of the same invite stops working too.
        await tx
          .update(inviteTokens)
          .set({ usedAt: new Date() })
          .where(
            and(eq(inviteTokens.membershipId, input.membershipId), isNull(inviteTokens.usedAt)),
          );
        return true;
      });
    } catch (err) {
      if (err instanceof InviteNoLongerPendingError) return false;
      throw err;
    }
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
      throw new Error('Role "owner" missing from catalogue — run db:migrate');
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
      throw new Error('Role "player" missing from catalogue — run db:migrate');
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
