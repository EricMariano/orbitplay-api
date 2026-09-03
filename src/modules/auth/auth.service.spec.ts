import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRow } from '../../infra/database/schema/users';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { NotificationPort } from '../../shared/ports/notification.port';
import { AuthRepository, EmailAlreadyTakenError } from './auth.repository';
import { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import type { TokenService } from './token.service';

const USER_ID = '01920000-0000-7000-8000-0000000000c3';
const ORG_ID = '01920000-0000-7000-8000-0000000000a9';

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: USER_ID,
    email: 'studio@orbitplay.dev',
    passwordHash: 'argon2-hash',
    displayName: 'Studio',
    birthdate: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makeRes(): Response {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response;
}

describe('AuthService password reset', () => {
  let repo: {
    findUserByEmail: ReturnType<typeof vi.fn>;
    invalidateUnusedTokens: ReturnType<typeof vi.fn>;
    insertPasswordResetToken: ReturnType<typeof vi.fn>;
    applyPasswordReset: ReturnType<typeof vi.fn>;
    createStudioAccount: ReturnType<typeof vi.fn>;
    insertRefreshToken: ReturnType<typeof vi.fn>;
  };
  let password: {
    hash: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    verifyDummy: ReturnType<typeof vi.fn>;
  };
  let token: {
    hashToken: ReturnType<typeof vi.fn>;
    signAccessToken: ReturnType<typeof vi.fn>;
    createRefreshToken: ReturnType<typeof vi.fn>;
  };
  let config: { get: ReturnType<typeof vi.fn> };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: AuthService;
  let req: Request;

  beforeEach(() => {
    repo = {
      findUserByEmail: vi.fn(),
      invalidateUnusedTokens: vi.fn().mockResolvedValue(undefined),
      insertPasswordResetToken: vi.fn().mockResolvedValue(undefined),
      applyPasswordReset: vi.fn(),
      createStudioAccount: vi.fn(),
      insertRefreshToken: vi.fn().mockResolvedValue(undefined),
    };
    password = {
      hash: vi.fn().mockResolvedValue('new-argon2-hash'),
      verify: vi.fn(),
      verifyDummy: vi.fn(),
    };
    token = {
      hashToken: vi.fn((raw: string) => `hash:${raw}`),
      signAccessToken: vi.fn().mockResolvedValue('access-token'),
      createRefreshToken: vi.fn().mockResolvedValue({
        token: 'refresh-raw',
        tokenId: 'token-id',
        familyId: 'family-id',
        tokenHash: 'hash:refresh-raw',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    };
    config = {
      get: vi.fn((key: string) => {
        if (key === 'authThrottle.limit') return 5;
        if (key === 'authThrottle.ttl') return 60;
        if (key === 'auth.passwordResetTtlMs') return 3_600_000;
        if (key === 'web.origin') return 'http://localhost:5173';
        if (key === 'jwt.refreshTtlMs') return 7 * 24 * 60 * 60 * 1000;
        if (key === 'isProduction') return false;
        return undefined;
      }),
    };
    redis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };
    mail = {
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };
    service = new AuthService(
      repo as unknown as AuthRepository,
      password as unknown as PasswordService,
      token as unknown as TokenService,
      config as unknown as ConfigService,
      redis as unknown as Redis,
      mail as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('forgot: unknown email returns the generic message and sends no mail', async () => {
    repo.findUserByEmail.mockResolvedValue(null);

    const result = await service.forgotPassword({ email: 'ghost@nowhere.dev' });

    expect(result.message).toBe('Se o e-mail existir, enviaremos instruções de recuperação.');
    expect(repo.insertPasswordResetToken).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(redis.incr).toHaveBeenCalledWith('forgot:id:ghost@nowhere.dev');
  });

  it('forgot: known email issues a hashed token and mails the raw token', async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser());

    const result = await service.forgotPassword({ email: 'Studio@Orbitplay.dev' });

    expect(result.message).toBe('Se o e-mail existir, enviaremos instruções de recuperação.');
    expect(repo.invalidateUnusedTokens).toHaveBeenCalledWith(USER_ID);
    expect(repo.insertPasswordResetToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        tokenHash: expect.stringMatching(/^hash:/),
        expiresAt: expect.any(Date),
      }),
    );
    expect(mail.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'studio@orbitplay.dev',
        text: expect.stringContaining('redefinir-senha?token='),
      }),
    );
    const mailed = mail.sendEmail.mock.calls[0]![0] as { text: string };
    const match = /token=([A-Za-z0-9_-]+)/.exec(mailed.text);
    expect(match?.[1]).toBeTruthy();
    expect(token.hashToken).toHaveBeenCalledWith(match![1]);
  });

  it('reset: invalid/used/expired token → 422 and no audit', async () => {
    repo.applyPasswordReset.mockResolvedValue(null);

    await expect(
      service.resetPassword({ token: 'bad-token', password: 'NewPass99' }, req),
    ).rejects.toMatchObject({ status: 422 });

    expect(password.hash).toHaveBeenCalledWith('NewPass99');
    expect(repo.applyPasswordReset).toHaveBeenCalledWith('hash:bad-token', 'new-argon2-hash');
    expect(drainAuditDrafts(req)).toHaveLength(0);
  });

  it('reset: success updates password, revokes sessions, and records audit', async () => {
    repo.applyPasswordReset.mockResolvedValue(USER_ID);

    const result = await service.resetPassword({ token: 'good-token', password: 'NewPass99' }, req);

    expect(result.message).toBe('Senha redefinida com sucesso.');
    expect(repo.applyPasswordReset).toHaveBeenCalledWith('hash:good-token', 'new-argon2-hash');
    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'auth.password_reset',
      entity: 'users',
      entityId: USER_ID,
    });
  });
});

describe('AuthService signupStudio', () => {
  let repo: {
    createStudioAccount: ReturnType<typeof vi.fn>;
    insertRefreshToken: ReturnType<typeof vi.fn>;
  };
  let password: { hash: ReturnType<typeof vi.fn> };
  let token: {
    signAccessToken: ReturnType<typeof vi.fn>;
    createRefreshToken: ReturnType<typeof vi.fn>;
  };
  let config: { get: ReturnType<typeof vi.fn> };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: AuthService;
  let req: Request;
  let res: Response;

  const validDto = {
    displayName: 'Nova Studio',
    email: 'New.Studio@Example.com',
    password: 'SecurePass1',
    birthdate: '1995-06-15',
    organizationName: 'Nova Games',
  };

  beforeEach(() => {
    repo = {
      createStudioAccount: vi.fn().mockResolvedValue({
        userId: USER_ID,
        email: 'new.studio@example.com',
        displayName: 'Nova Studio',
        organizationId: ORG_ID,
        organizationName: 'Nova Games',
        role: 'owner' as const,
      }),
      insertRefreshToken: vi.fn().mockResolvedValue(undefined),
    };
    password = {
      hash: vi.fn().mockResolvedValue('hashed-password'),
    };
    token = {
      signAccessToken: vi.fn().mockResolvedValue('access-token'),
      createRefreshToken: vi.fn().mockResolvedValue({
        token: 'refresh-raw',
        tokenId: 'token-id',
        familyId: 'family-id',
        tokenHash: 'hash:refresh-raw',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    };
    config = {
      get: vi.fn((key: string) => {
        if (key === 'jwt.refreshTtlMs') return 7 * 24 * 60 * 60 * 1000;
        if (key === 'isProduction') return false;
        return undefined;
      }),
    };
    redis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };
    mail = { sendEmail: vi.fn() };
    service = new AuthService(
      repo as unknown as AuthRepository,
      password as unknown as PasswordService,
      token as unknown as TokenService,
      config as unknown as ConfigService,
      redis as unknown as Redis,
      mail as unknown as NotificationPort,
    );
    req = { headers: {} } as Request;
    res = makeRes();
  });

  it('rejects under-18 birthdate without touching the repository', async () => {
    await expect(
      service.signupStudio({ ...validDto, birthdate: '2015-01-01' }, req, res),
    ).rejects.toMatchObject({ status: 422 });

    expect(repo.createStudioAccount).not.toHaveBeenCalled();
    expect(password.hash).not.toHaveBeenCalled();
  });

  it('maps EmailAlreadyTakenError to 409 conflict', async () => {
    repo.createStudioAccount.mockRejectedValue(new EmailAlreadyTakenError());

    await expect(service.signupStudio(validDto, req, res)).rejects.toMatchObject({
      status: 409,
    });

    expect(password.hash).toHaveBeenCalledWith('SecurePass1');
  });

  it('creates the account with lowercased email and issues a session', async () => {
    const result = await service.signupStudio(validDto, req, res);

    expect(repo.createStudioAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new.studio@example.com',
        displayName: 'Nova Studio',
        organizationName: 'Nova Games',
        birthdate: '1995-06-15',
        passwordHash: 'hashed-password',
      }),
    );
    expect(result.accessToken).toBe('access-token');
    expect(result.user).toMatchObject({
      id: USER_ID,
      email: 'new.studio@example.com',
      displayName: 'Nova Studio',
      organizationId: ORG_ID,
      role: 'owner',
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh-raw',
      expect.objectContaining({ httpOnly: true }),
    );
    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'auth.signup_studio',
      entity: 'organizations',
      entityId: ORG_ID,
    });
  });
});

describe('AuthService signupPlayer', () => {
  let repo: {
    createPlayerAccount: ReturnType<typeof vi.fn>;
    insertRefreshToken: ReturnType<typeof vi.fn>;
  };
  let password: { hash: ReturnType<typeof vi.fn> };
  let token: {
    signAccessToken: ReturnType<typeof vi.fn>;
    createRefreshToken: ReturnType<typeof vi.fn>;
  };
  let config: { get: ReturnType<typeof vi.fn> };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: AuthService;
  let req: Request;
  let res: Response;

  const validDto = {
    displayName: 'Nova Player',
    email: 'New.Player@Example.com',
    password: 'SecurePass1',
    birthdate: '1995-06-15',
  };

  beforeEach(() => {
    repo = {
      createPlayerAccount: vi.fn().mockResolvedValue({
        userId: USER_ID,
        email: 'new.player@example.com',
        displayName: 'Nova Player',
        organizationId: ORG_ID,
        organizationName: 'Conta de Nova Player',
        role: 'player' as const,
      }),
      insertRefreshToken: vi.fn().mockResolvedValue(undefined),
    };
    password = {
      hash: vi.fn().mockResolvedValue('hashed-password'),
    };
    token = {
      signAccessToken: vi.fn().mockResolvedValue('access-token'),
      createRefreshToken: vi.fn().mockResolvedValue({
        token: 'refresh-raw',
        tokenId: 'token-id',
        familyId: 'family-id',
        tokenHash: 'hash:refresh-raw',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    };
    config = {
      get: vi.fn((key: string) => {
        if (key === 'jwt.refreshTtlMs') return 7 * 24 * 60 * 60 * 1000;
        if (key === 'isProduction') return false;
        return undefined;
      }),
    };
    redis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };
    mail = { sendEmail: vi.fn() };
    service = new AuthService(
      repo as unknown as AuthRepository,
      password as unknown as PasswordService,
      token as unknown as TokenService,
      config as unknown as ConfigService,
      redis as unknown as Redis,
      mail as unknown as NotificationPort,
    );
    req = { headers: {} } as Request;
    res = makeRes();
  });

  it('rejects under-18 birthdate without touching the repository', async () => {
    await expect(
      service.signupPlayer({ ...validDto, birthdate: '2015-01-01' }, req, res),
    ).rejects.toMatchObject({ status: 422 });

    expect(repo.createPlayerAccount).not.toHaveBeenCalled();
    expect(password.hash).not.toHaveBeenCalled();
  });

  it('maps EmailAlreadyTakenError to 409 conflict', async () => {
    repo.createPlayerAccount.mockRejectedValue(new EmailAlreadyTakenError());

    await expect(service.signupPlayer(validDto, req, res)).rejects.toMatchObject({
      status: 409,
    });

    expect(password.hash).toHaveBeenCalledWith('SecurePass1');
  });

  it('creates the account with lowercased email and issues a session', async () => {
    const result = await service.signupPlayer(validDto, req, res);

    expect(repo.createPlayerAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new.player@example.com',
        displayName: 'Nova Player',
        organizationName: 'Conta de Nova Player',
        birthdate: '1995-06-15',
        passwordHash: 'hashed-password',
        organizationSlug: expect.stringMatching(/^player-[a-f0-9]{32}$/),
      }),
    );
    expect(result.accessToken).toBe('access-token');
    expect(result.user).toMatchObject({
      id: USER_ID,
      email: 'new.player@example.com',
      displayName: 'Nova Player',
      organizationId: ORG_ID,
      role: 'player',
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'refresh-raw',
      expect.objectContaining({ httpOnly: true }),
    );
    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'auth.signup_player',
      entity: 'users',
      entityId: USER_ID,
    });
  });
});

describe('AuthService checkSignupAvailability', () => {
  let repo: { emailExists: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;

  beforeEach(() => {
    repo = { emailExists: vi.fn() };
    config = {
      get: vi.fn((key: string) => {
        if (key === 'authThrottle.availabilityLimit') return 3;
        if (key === 'authThrottle.availabilityTtl') return 60;
        return undefined;
      }),
    };
    redis = {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };
    service = new AuthService(
      repo as unknown as AuthRepository,
      {} as unknown as PasswordService,
      {} as unknown as TokenService,
      config as unknown as ConfigService,
      redis as unknown as Redis,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
  });

  it('returns available:true for an unknown email and keys Redis by normalized email', async () => {
    repo.emailExists.mockResolvedValue(false);

    const result = await service.checkSignupAvailability('Ghost@Nowhere.DEV');

    expect(result).toEqual({ available: true });
    expect(redis.incr).toHaveBeenCalledWith('availability:id:ghost@nowhere.dev');
    expect(repo.emailExists).toHaveBeenCalledWith('ghost@nowhere.dev');
  });

  it('returns available:false for a known email (case-insensitive)', async () => {
    repo.emailExists.mockResolvedValue(true);

    const result = await service.checkSignupAvailability('Studio@Orbitplay.dev');

    expect(result).toEqual({ available: false });
    expect(repo.emailExists).toHaveBeenCalledWith('studio@orbitplay.dev');
  });

  it('throws 429 when the per-email availability limit is exceeded', async () => {
    redis.incr.mockResolvedValue(4);

    await expect(service.checkSignupAvailability('busy@example.com')).rejects.toMatchObject({
      status: 429,
    });
    expect(repo.emailExists).not.toHaveBeenCalled();
  });
});
