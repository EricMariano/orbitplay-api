import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { AppException } from '../../shared/errors/app.exception';
import { ErrorCode } from '../../shared/errors/error-envelope';
import { HttpStatus } from '@nestjs/common';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import type { AuthUser, RoleValue } from '../../shared/auth/roles';
import type { AuthUserView, ForgotPasswordDto, LoginDto, LoginResponse } from './dto/auth.dto';
import { IamRepository } from './iam.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const REFRESH_COOKIE = 'refresh_token';
const GENERIC_LOGIN_ERROR = 'Credenciais inválidas';

@Injectable()
export class IamService {
  constructor(
    private readonly repo: IamRepository,
    private readonly password: PasswordService,
    private readonly token: TokenService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(NOTIFICATION_PORT) private readonly mail: NotificationPort,
  ) {}

  async login(dto: LoginDto, req: Request, res: Response): Promise<LoginResponse> {
    const email = dto.email.toLowerCase().trim();
    await this.enforceIdentifierLimit(email);

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

    await this.clearIdentifierLimit(email);

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
    const user = await this.repo.findUserByEmail(email);
    // Never reveal whether the account exists.
    if (user) {
      await this.mail.sendEmail({
        to: user.email,
        subject: 'Recuperação de senha — OrbitPlay',
        text: 'Recebemos um pedido para redefinir sua senha. (fluxo de reset completo virá em etapa futura)',
      });
    }
    return { message: 'Se o e-mail existir, enviaremos instruções de recuperação.' };
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
  private async enforceIdentifierLimit(email: string): Promise<void> {
    const limit = this.config.get<number>('authThrottle.limit')!;
    const ttl = this.config.get<number>('authThrottle.ttl')!;
    const key = `login:id:${email}`;
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

  private async clearIdentifierLimit(email: string): Promise<void> {
    await this.redis.del(`login:id:${email}`);
  }
}
