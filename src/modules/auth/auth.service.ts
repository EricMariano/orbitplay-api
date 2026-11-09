import { Inject, Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { newId } from '../../infra/database/schema/_helpers';
import type {
  NewRefreshTokenRow,
  RefreshTokenRow,
} from '../../infra/database/schema/refresh-tokens';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { ErrorCode } from '../../shared/errors/error-envelope';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import type { AuthUser, RoleValue } from '../../shared/auth/roles';
import { slugify } from '../../shared/util/slugify';
import { isAtLeast18 } from './age';
import type {
  AcceptInviteInput,
  AcceptInviteResult,
  AuthUserView,
  ForgotPasswordDto,
  InvitePreview,
  LoginDto,
  LoginResponse,
  LoginResult,
  ResetPasswordDto,
  SignupAvailability,
  SignupPlayerInput,
  SignupStudioInput,
} from './dto/auth.dto';
import { AuthRepository, EmailAlreadyTakenError, type PendingInvite } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const REFRESH_COOKIE = 'refresh_token';
const GENERIC_LOGIN_ERROR = 'Credenciais inválidas';
const GENERIC_FORGOT_MESSAGE = 'Se o e-mail existir, enviaremos instruções de recuperação.';
const GENERIC_RESET_TOKEN_ERROR = 'Token inválido ou expirado';
const UNDERAGE_MESSAGE = 'É necessário ter 18 anos ou mais para se cadastrar';
const EMAIL_TAKEN_MESSAGE = 'E-mail já cadastrado';
const GENERIC_INVITE_TOKEN_ERROR = 'Convite inválido ou expirado';

/** How long the link in an invitation e-mail stays valid. A resend issues a fresh one. */
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a refresh token that was just ROTATED still opens a session. Two
 * tabs refreshing at once — or a reload while `/auth/refresh` is in flight,
 * where the server rotated but the browser never stored the new cookie —
 * present the previous token right after it was consumed; inside this window
 * that is not treated as theft. Revocations other than rotation (logout,
 * password reset, reuse detection) get no grace. Past the window, reuse still
 * revokes the whole family — every sibling minted in the window included.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

/** Revoked by rotation (not logout/reset/reuse detection) and still inside the grace window. */
function isWithinReuseGrace(row: RefreshTokenRow): boolean {
  return (
    row.revokedAt !== null &&
    row.replacedByTokenId !== null &&
    Date.now() - row.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS
  );
}

type IdentifierLimitKind = 'login' | 'forgot' | 'availability' | 'invite';

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly password: PasswordService,
    private readonly token: TokenService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(NOTIFICATION_PORT) private readonly mail: NotificationPort,
  ) {}

  async login(dto: LoginDto, req: Request, res: Response): Promise<LoginResult> {
    const email = dto.email.toLowerCase().trim();
    await this.enforceIdentifierLimit('login', email);

    const user = await this.repo.findUserByEmail(email);

    // Constant-ish time: for an unknown user, still spend an argon2 verify so
    // "unknown user" and "wrong password" are indistinguishable by timing.
    if (!user) {
      await this.password.verifyDummy(dto.password);
      throw AppException.unauthorized(GENERIC_LOGIN_ERROR);
    }

    const passwordOk = await this.password.verify(user.passwordHash, dto.password);
    if (!passwordOk || !user.isActive) {
      throw AppException.unauthorized(GENERIC_LOGIN_ERROR);
    }

    const memberships = await this.repo.findActiveMemberships(user.id);
    if (memberships.length === 0) {
      // No active org → same generic error; never leak the account exists.
      throw AppException.unauthorized(GENERIC_LOGIN_ERROR);
    }

    // GAP-02: a user with more than one active membership (staff invited
    // into a second org, e.g.) can't be resolved by guessing — `role` still
    // never comes from the body, only *which* of the caller's own already-
    // active memberships supplies it does.
    let membership;
    if (dto.organizationId) {
      membership = memberships.find((m) => m.organizationId === dto.organizationId);
      if (!membership) {
        // Not a member of that org (or it doesn't exist) — same generic
        // error as bad credentials, never confirm/deny org membership.
        throw AppException.unauthorized(GENERIC_LOGIN_ERROR);
      }
    } else if (memberships.length === 1) {
      membership = memberships[0];
    } else {
      await this.clearIdentifierLimit('login', email);
      return {
        requiresOrganizationSelection: true,
        organizations: memberships.map((m) => ({
          organizationId: m.organizationId,
          organizationName: m.organizationName,
          role: m.roleKey,
        })),
      };
    }

    await this.clearIdentifierLimit('login', email);

    return this.issueSession(
      {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        organizationId: membership.organizationId,
        role: membership.roleKey,
      },
      req,
      res,
    );
  }

  async refresh(req: Request, res: Response): Promise<LoginResponse> {
    const raw = this.readRefreshCookie(req);
    if (!raw) throw AppException.unauthorized('Sessão ausente');

    try {
      await this.token.verifyRefreshToken(raw);
    } catch {
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }

    const stored = await this.repo.findRefreshTokenByHash(this.token.hashToken(raw));
    if (!stored) {
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }

    // Reuse detection: a token that was already rotated/revoked is being
    // presented again → revoke the whole family and force re-login. Except a
    // token rotated moments ago (REFRESH_REUSE_GRACE_MS): that is a second tab
    // or a reload that lost the race, not a stolen token.
    if (stored.revokedAt && !isWithinReuseGrace(stored)) {
      await this.repo.revokeFamily(stored.familyId);
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão expirada');
    }

    const user = await this.repo.findUserById(stored.userId);
    if (!user || !user.isActive) {
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }
    // Must still be active in the SAME org the refresh token was issued for —
    // not just active in any org — otherwise a user removed from org A could
    // rotate into a JWT for org A carrying their role in unrelated org B.
    const membership = await this.repo.findActiveMembershipForOrg(user.id, stored.organizationId);
    if (!membership) {
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }

    // Rotate within the same family. The revoke-and-insert happens atomically
    // in one transaction so two concurrent requests presenting the same
    // token can't both consume it (see rotateRefreshToken).
    const next = await this.token.createRefreshToken({
      userId: user.id,
      organizationId: stored.organizationId,
      familyId: stored.familyId,
    });
    const nextRow = {
      id: next.tokenId,
      userId: user.id,
      organizationId: stored.organizationId,
      familyId: next.familyId,
      tokenHash: next.tokenHash,
      expiresAt: next.expiresAt,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };
    const issued = stored.revokedAt
      ? // Inside the grace window: the winner keeps its token, this request
        // gets a sibling in the same family — never a reset of the family.
        await this.repo.insertRefreshTokenIfFamilyActive(nextRow)
      : await this.rotateOrJoinWinner(stored.id, nextRow);
    if (!issued) {
      // Reuse outside the grace window, or a family already revoked (logout,
      // password reset, reuse detection) — revoke what's left and force
      // re-login.
      await this.repo.revokeFamily(stored.familyId);
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }

    const accessToken = await this.token.signAccessToken({
      sub: user.id,
      org: stored.organizationId,
      role: membership.roleKey,
      email: user.email,
    });
    this.setRefreshCookie(res, next.token);

    return {
      accessToken,
      user: this.toAuthUserView({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        organizationId: stored.organizationId,
        role: membership.roleKey,
      }),
    };
  }

  /**
   * Rotate `currentId` into `next`. When a concurrent request consumed the
   * token first (two tabs, one cookie), re-read it: if that request ROTATED
   * it, this one lost a race inside the grace window and gets a sibling
   * token; any other revocation (logout, reset) is reuse — `false`.
   */
  private async rotateOrJoinWinner(currentId: string, next: NewRefreshTokenRow): Promise<boolean> {
    if (await this.repo.rotateRefreshToken(currentId, next)) return true;
    const current = await this.repo.findRefreshTokenById(currentId);
    if (!current || !isWithinReuseGrace(current)) return false;
    return this.repo.insertRefreshTokenIfFamilyActive(next);
  }

  async logout(req: Request, res: Response): Promise<{ message: string }> {
    const raw = this.readRefreshCookie(req);
    if (raw) {
      const stored = await this.repo.findRefreshTokenByHash(this.token.hashToken(raw));
      if (stored) await this.repo.revokeFamily(stored.familyId);
    }
    this.clearRefreshCookie(res);
    return { message: 'Sessão encerrada' };
  }

  async me(user: AuthUser): Promise<AuthUserView> {
    const row = await this.repo.findUserById(user.userId);
    if (!row) throw AppException.unauthorized();
    return this.toAuthUserView({
      userId: row.id,
      email: row.email,
      displayName: row.displayName,
      organizationId: user.organizationId,
      role: user.role,
    });
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    // Always throttle before the lookup so a 429 cannot leak account existence.
    await this.enforceIdentifierLimit('forgot', email);

    const user = await this.repo.findUserByEmail(email);
    // Never reveal whether the account exists.
    if (user && user.isActive) {
      await this.issuePasswordResetToken(user);
    }

    return { message: GENERIC_FORGOT_MESSAGE };
  }

  /**
   * Admin-triggered reset (ORB-M2-07, Tela 20 RN-04): same token/e-mail flow
   * as `forgotPassword`, for a member an owner/admin already identified via
   * the members list — no need to hide whether the account exists, unlike the
   * anonymous `forgotPassword` entry point. It shares that path's per-e-mail
   * limit: each call mails the user and voids their previous link, so an
   * unthrottled loop would flood any invited address and keep its owner from
   * ever finishing a recovery.
   */
  async triggerPasswordReset(userId: string): Promise<void> {
    const user = await this.repo.findUserById(userId);
    if (!user || !user.isActive) return;
    await this.enforceIdentifierLimit('forgot', user.email.toLowerCase().trim());
    await this.issuePasswordResetToken(user);
  }

  private async issuePasswordResetToken(user: { id: string; email: string }): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.token.hashToken(rawToken);
    const ttlMs = this.config.get<number>('auth.passwordResetTtlMs')!;
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.repo.invalidateUnusedTokens(user.id);
    await this.repo.insertPasswordResetToken({
      id: newId(),
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const origin = this.config.get<string>('web.origin')!;
    // Must match the web route (`orbitplay-web/src/routes/reset-password.tsx`).
    const link = `${origin}/reset-password?token=${rawToken}`;
    await this.mail.sendEmail({
      to: user.email,
      subject: 'Recuperação de senha — OrbitPlay',
      text: [
        'Recebemos um pedido para redefinir sua senha.',
        '',
        `Abra o link (válido por tempo limitado): ${link}`,
        '',
        `Se preferir, use o token diretamente: ${rawToken}`,
        '',
        'Se você não solicitou isso, ignore este e-mail.',
      ].join('\n'),
    });
  }

  /**
   * Issue the single-use token of an invite (ORB-M2-03) and return it raw, for
   * the caller to put in the invitation e-mail — only its hash is stored. Any
   * earlier token of the same membership stops working (resend).
   */
  async issueInviteToken(membershipId: string, organizationId: string): Promise<string> {
    const rawToken = randomBytes(32).toString('base64url');
    await this.repo.replaceInviteToken({
      organizationId,
      membershipId,
      tokenHash: this.token.hashToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
    });
    return rawToken;
  }

  /**
   * Resend: same as `issueInviteToken`, but it mails the invitee again, so it
   * shares the per-e-mail budget of the other flows that do (`forgot`).
   */
  async reissueInviteToken(
    membershipId: string,
    organizationId: string,
    email: string,
  ): Promise<string> {
    await this.enforceIdentifierLimit('forgot', email.toLowerCase().trim());
    return this.issueInviteToken(membershipId, organizationId);
  }

  /** What the invite link opens: org, role and which form the invitee fills (no auth). */
  async previewInvite(rawToken: string): Promise<InvitePreview> {
    const invite = await this.findInviteOrThrow(rawToken);
    return {
      organizationName: invite.organizationName,
      role: invite.role,
      email: invite.email,
      accountExists: await this.inviteAccountExists(invite),
      birthdateRequired: invite.birthdate === null,
    };
  }

  /**
   * Accept an invite (explicit consent — the only path from `invited` to
   * `active`). A token is not an account takeover: an account that already
   * exists proves it is the invitee with its CURRENT password, and keeps it.
   * Only an account created by the invite picks its password here. Either way
   * a missing birthdate is collected and the 18+ rule enforced (§1.4).
   */
  async acceptInvite(dto: AcceptInviteInput, req: Request): Promise<AcceptInviteResult> {
    const invite = await this.findInviteOrThrow(dto.token);
    const accountExists = await this.inviteAccountExists(invite);

    const birthdate = invite.birthdate === null ? dto.birthdate : undefined;
    if (invite.birthdate === null) {
      if (!birthdate) {
        throw AppException.validation('Dados inválidos', {
          birthdate: 'Data de nascimento obrigatória',
        });
      }
      if (!isAtLeast18(birthdate)) {
        throw AppException.validation(UNDERAGE_MESSAGE, { birthdate: UNDERAGE_MESSAGE });
      }
    }

    let passwordHash: string | undefined;
    if (accountExists) {
      if (!dto.currentPassword) {
        throw AppException.validation('Dados inválidos', {
          currentPassword: 'Informe a senha atual da sua conta',
        });
      }
      const email = invite.email.toLowerCase().trim();
      await this.enforceIdentifierLimit('invite', email);
      const ok = await this.password.verify(invite.passwordHash, dto.currentPassword);
      if (!ok) {
        throw AppException.validation('Dados inválidos', { currentPassword: 'Senha incorreta' });
      }
      await this.clearIdentifierLimit('invite', email);
    } else {
      if (!dto.password) {
        throw AppException.validation('Dados inválidos', { password: 'Senha obrigatória' });
      }
      passwordHash = await this.password.hash(dto.password);
    }

    const accepted = await this.repo.acceptInvite({
      tokenHash: this.token.hashToken(dto.token),
      membershipId: invite.membershipId,
      userId: invite.userId,
      passwordHash,
      birthdate,
    });
    if (!accepted) {
      throw AppException.validation(GENERIC_INVITE_TOKEN_ERROR, {
        token: GENERIC_INVITE_TOKEN_ERROR,
      });
    }

    recordAudit(req, {
      action: 'org.invite_accepted',
      entity: 'memberships',
      entityId: invite.userId,
      before: { status: 'invited' },
      after: {
        status: 'active',
        organizationId: invite.organizationId,
        role: invite.role,
        accountCreated: !accountExists,
      },
    });

    return {
      message: 'Convite aceito. Entre com seu e-mail e senha.',
      email: invite.email,
      organizationName: invite.organizationName,
    };
  }

  private async findInviteOrThrow(rawToken: string): Promise<PendingInvite> {
    const invite = await this.repo.findPendingInviteByTokenHash(this.token.hashToken(rawToken));
    if (!invite) {
      throw AppException.validation(GENERIC_INVITE_TOKEN_ERROR, {
        token: GENERIC_INVITE_TOKEN_ERROR,
      });
    }
    return invite;
  }

  /**
   * Whether the invited e-mail has an account of its own, beyond the invite:
   * one that signed up (signup always records a birthdate) or that is already
   * active in some organization. An account the invite created has neither
   * until it accepts.
   */
  private async inviteAccountExists(invite: PendingInvite): Promise<boolean> {
    if (invite.birthdate !== null) return true;
    const active = await this.repo.findActiveMemberships(invite.userId);
    return active.length > 0;
  }

  async resetPassword(dto: ResetPasswordDto, req: Request): Promise<{ message: string }> {
    const tokenHash = this.token.hashToken(dto.token);
    const passwordHash = await this.password.hash(dto.password);

    const userId = await this.repo.applyPasswordReset(tokenHash, passwordHash);
    if (!userId) {
      throw AppException.validation(GENERIC_RESET_TOKEN_ERROR, {
        token: GENERIC_RESET_TOKEN_ERROR,
      });
    }

    recordAudit(req, {
      action: 'auth.password_reset',
      entity: 'users',
      entityId: userId,
      before: null,
      after: { passwordChanged: true, sessionsRevoked: true },
    });

    return { message: 'Senha redefinida com sucesso.' };
  }

  /**
   * Studio onboarding (ORB-M1-02 / DECISIONS.md §1.1): create user + org +
   * owner membership in one transaction, then open a session (same shape as
   * login). Age 18+ is enforced server-side (§1.4).
   */
  async signupStudio(dto: SignupStudioInput, req: Request, res: Response): Promise<LoginResponse> {
    if (!isAtLeast18(dto.birthdate)) {
      throw AppException.validation(UNDERAGE_MESSAGE, { birthdate: UNDERAGE_MESSAGE });
    }

    const email = dto.email.toLowerCase().trim();
    const passwordHash = await this.password.hash(dto.password);
    const userId = newId();
    const organizationId = newId();
    const organizationSlug = slugifyOrgName(dto.organizationName, organizationId);

    let created;
    try {
      created = await this.repo.createStudioAccount({
        userId,
        email,
        passwordHash,
        displayName: dto.displayName.trim(),
        birthdate: dto.birthdate,
        organizationId,
        organizationName: dto.organizationName.trim(),
        organizationSlug,
      });
    } catch (err) {
      if (err instanceof EmailAlreadyTakenError) {
        throw AppException.conflict(EMAIL_TAKEN_MESSAGE);
      }
      throw err;
    }

    recordAudit(req, {
      action: 'auth.signup_studio',
      entity: 'organizations',
      entityId: created.organizationId,
      before: null,
      after: {
        userId: created.userId,
        email: created.email,
        organizationName: created.organizationName,
        role: created.role,
      },
    });

    return this.issueSession(
      {
        userId: created.userId,
        email: created.email,
        displayName: created.displayName,
        organizationId: created.organizationId,
        role: created.role,
      },
      req,
      res,
    );
  }

  /**
   * Player onboarding (ORB-M1-03): create user + personal org + player
   * membership in one transaction, then open a session. Age 18+ is enforced
   * server-side (DECISIONS.md §1.4). Role in the token is `player` (not owner).
   */
  async signupPlayer(dto: SignupPlayerInput, req: Request, res: Response): Promise<LoginResponse> {
    if (!isAtLeast18(dto.birthdate)) {
      throw AppException.validation(UNDERAGE_MESSAGE, { birthdate: UNDERAGE_MESSAGE });
    }

    const email = dto.email.toLowerCase().trim();
    const displayName = dto.displayName.trim();
    const passwordHash = await this.password.hash(dto.password);
    const userId = newId();
    const organizationId = newId();
    const organizationName = `Conta de ${displayName}`;
    const organizationSlug = `player-${organizationId.replace(/-/g, '')}`;

    let created;
    try {
      created = await this.repo.createPlayerAccount({
        userId,
        email,
        passwordHash,
        displayName,
        birthdate: dto.birthdate,
        organizationId,
        organizationName,
        organizationSlug,
      });
    } catch (err) {
      if (err instanceof EmailAlreadyTakenError) {
        throw AppException.conflict(EMAIL_TAKEN_MESSAGE);
      }
      throw err;
    }

    recordAudit(req, {
      action: 'auth.signup_player',
      entity: 'users',
      entityId: created.userId,
      before: null,
      after: {
        userId: created.userId,
        email: created.email,
        organizationId: created.organizationId,
        organizationName: created.organizationName,
        role: created.role,
      },
    });

    return this.issueSession(
      {
        userId: created.userId,
        email: created.email,
        displayName: created.displayName,
        organizationId: created.organizationId,
        role: created.role,
      },
      req,
      res,
    );
  }

  /**
   * Sparse email-availability check for signup forms (ORB-M1-04).
   * Returns only `{ available }` — rate limits (IP + email) contain enumeration.
   */
  async checkSignupAvailability(rawEmail: string): Promise<SignupAvailability> {
    const email = rawEmail.toLowerCase().trim();
    await this.enforceIdentifierLimit('availability', email);
    const taken = await this.repo.emailExists(email);
    return { available: !taken };
  }

  // --- helpers ---

  private async issueSession(
    principal: {
      userId: string;
      email: string;
      displayName: string;
      organizationId: string;
      role: RoleValue;
    },
    req: Request,
    res: Response,
  ): Promise<LoginResponse> {
    const accessToken = await this.token.signAccessToken({
      sub: principal.userId,
      org: principal.organizationId,
      role: principal.role,
      email: principal.email,
    });
    const refresh = await this.token.createRefreshToken({
      userId: principal.userId,
      organizationId: principal.organizationId,
    });
    await this.repo.insertRefreshToken({
      id: refresh.tokenId,
      userId: principal.userId,
      organizationId: principal.organizationId,
      familyId: refresh.familyId,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    this.setRefreshCookie(res, refresh.token);
    return { accessToken, user: this.toAuthUserView(principal) };
  }

  private toAuthUserView(principal: {
    userId: string;
    email: string;
    displayName: string;
    organizationId: string;
    role: RoleValue;
  }): AuthUserView {
    return {
      id: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      organizationId: principal.organizationId,
      role: principal.role,
    };
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    return cookies?.[REFRESH_COOKIE];
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.get<boolean>('isProduction') ?? false,
      path: '/',
      maxAge: this.config.get<number>('jwt.refreshTtlMs'),
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  /**
   * Per-identifier (email) rate limit, independent of IP — so a distributed
   * attack against ONE account is still throttled (the ThrottlerGuard covers
   * the per-IP dimension). Both are required; IP-only wouldn't stop it.
   */
  private async enforceIdentifierLimit(kind: IdentifierLimitKind, email: string): Promise<void> {
    const { limit, ttl } = this.identifierLimitConfig(kind);
    const key = `${kind}:id:${email}`;
    const count = await this.redis.incr(key);
    // INCR and EXPIRE are separate commands: also re-arm the TTL if a previous
    // attempt crashed in between, or the key would block this e-mail forever.
    if (count === 1 || (await this.redis.ttl(key)) === -1) await this.redis.expire(key, ttl);
    if (count > limit) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.TOO_MANY_REQUESTS,
        'Muitas tentativas para esta conta. Tente novamente em instantes.',
      );
    }
  }

  private identifierLimitConfig(kind: IdentifierLimitKind): { limit: number; ttl: number } {
    if (kind === 'availability') {
      return {
        limit: this.config.get<number>('authThrottle.availabilityLimit')!,
        ttl: this.config.get<number>('authThrottle.availabilityTtl')!,
      };
    }
    return {
      limit: this.config.get<number>('authThrottle.limit')!,
      ttl: this.config.get<number>('authThrottle.ttl')!,
    };
  }

  private async clearIdentifierLimit(
    kind: 'login' | 'forgot' | 'invite',
    email: string,
  ): Promise<void> {
    await this.redis.del(`${kind}:id:${email}`);
  }
}

/** Org slug from name; symbols-only names fall back to studio-<id>. */
function slugifyOrgName(name: string, organizationId: string): string {
  const slug = slugify(name);
  if (slug.length > 0) return slug;
  return `studio-${organizationId.replace(/-/g, '').slice(0, 8)}`;
}
