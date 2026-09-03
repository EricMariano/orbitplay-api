import { Inject, Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { newId } from '../../infra/database/schema/_helpers';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { ErrorCode } from '../../shared/errors/error-envelope';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import type { AuthUser, RoleValue } from '../../shared/auth/roles';
import { slugify } from '../../shared/util/slugify';
import { isAtLeast18 } from './age';
import type {
  AuthUserView,
  ForgotPasswordDto,
  LoginDto,
  LoginResponse,
  ResetPasswordDto,
  SignupAvailability,
  SignupPlayerInput,
  SignupStudioInput,
} from './dto/auth.dto';
import { AuthRepository, EmailAlreadyTakenError } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const REFRESH_COOKIE = 'refresh_token';
const GENERIC_LOGIN_ERROR = 'Credenciais inválidas';
const GENERIC_FORGOT_MESSAGE = 'Se o e-mail existir, enviaremos instruções de recuperação.';
const GENERIC_RESET_TOKEN_ERROR = 'Token inválido ou expirado';
const UNDERAGE_MESSAGE = 'É necessário ter 18 anos ou mais para se cadastrar';
const EMAIL_TAKEN_MESSAGE = 'E-mail já cadastrado';

type IdentifierLimitKind = 'login' | 'forgot' | 'availability';

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

  async login(dto: LoginDto, req: Request, res: Response): Promise<LoginResponse> {
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

    const membership = await this.repo.findActiveMembership(user.id);
    if (!membership) {
      // No active org → same generic error; never leak the account exists.
      throw AppException.unauthorized(GENERIC_LOGIN_ERROR);
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
    // presented again → revoke the whole family and force re-login.
    if (stored.revokedAt) {
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
    const membership = await this.repo.findActiveMembership(user.id);
    if (!membership) {
      this.clearRefreshCookie(res);
      throw AppException.unauthorized('Sessão inválida');
    }

    // Rotate within the same family.
    const next = await this.token.createRefreshToken({
      userId: user.id,
      organizationId: stored.organizationId,
      familyId: stored.familyId,
    });
    await this.repo.insertRefreshToken({
      id: next.tokenId,
      userId: user.id,
      organizationId: stored.organizationId,
      familyId: next.familyId,
      tokenHash: next.tokenHash,
      expiresAt: next.expiresAt,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    await this.repo.revokeToken(stored.id, next.tokenId);

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
      const link = `${origin}/redefinir-senha?token=${rawToken}`;
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

    return { message: GENERIC_FORGOT_MESSAGE };
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
    if (count === 1) await this.redis.expire(key, ttl);
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

  private async clearIdentifierLimit(kind: 'login' | 'forgot', email: string): Promise<void> {
    await this.redis.del(`${kind}:id:${email}`);
  }
}

/** Org slug from name; symbols-only names fall back to studio-<id>. */
function slugifyOrgName(name: string, organizationId: string): string {
  const slug = slugify(name);
  if (slug.length > 0) return slug;
  return `studio-${organizationId.replace(/-/g, '').slice(0, 8)}`;
}
