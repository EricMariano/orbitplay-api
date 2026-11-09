import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshTokenRow } from '../../infra/database/schema/refresh-tokens';
import type { UserRow } from '../../infra/database/schema/users';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { NotificationPort } from '../../shared/ports/notification.port';
import { AuthRepository, EmailAlreadyTakenError, type PendingInvite } from './auth.repository';
import { AuthService, INVITE_TOKEN_TTL_MS, REFRESH_REUSE_GRACE_MS } from './auth.service';
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

const OTHER_ORG_ID = '01920000-0000-7000-8000-0000000000b7';

describe('AuthService login', () => {
  let repo: {
    findUserByEmail: ReturnType<typeof vi.fn>;
    findActiveMemberships: ReturnType<typeof vi.fn>;
    insertRefreshToken: ReturnType<typeof vi.fn>;
  };
  let password: {
    verify: ReturnType<typeof vi.fn>;
    verifyDummy: ReturnType<typeof vi.fn>;
  };
  let token: {
    signAccessToken: ReturnType<typeof vi.fn>;
    createRefreshToken: ReturnType<typeof vi.fn>;
  };
  let config: { get: ReturnType<typeof vi.fn> };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    ttl: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;
  let req: Request;
  let res: Response;

  beforeEach(() => {
    repo = {
      findUserByEmail: vi.fn().mockResolvedValue(makeUser()),
      findActiveMemberships: vi.fn(),
      insertRefreshToken: vi.fn().mockResolvedValue(undefined),
    };
    password = {
      verify: vi.fn().mockResolvedValue(true),
      verifyDummy: vi.fn().mockResolvedValue(undefined),
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
        if (key === 'authThrottle.limit') return 5;
        if (key === 'authThrottle.ttl') return 60;
        if (key === 'jwt.refreshTtlMs') return 7 * 24 * 60 * 60 * 1000;
        if (key === 'isProduction') return false;
        return undefined;
      }),
    };
    redis = {
      incr: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(60),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };
    service = new AuthService(
      repo as unknown as AuthRepository,
      password as unknown as PasswordService,
      token as unknown as TokenService,
      config as unknown as ConfigService,
      redis as unknown as Redis,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = { headers: {} } as Request;
    res = makeRes();
  });

  it('401s with no active membership at all', async () => {
    repo.findActiveMemberships.mockResolvedValue([]);

    await expect(
      service.login({ email: 'studio@orbitplay.dev', password: 'x' }, req, res),
    ).rejects.toMatchObject({ status: 401 });
    expect(repo.insertRefreshToken).not.toHaveBeenCalled();
  });

  it('logs straight in when there is exactly one active membership', async () => {
    repo.findActiveMemberships.mockResolvedValue([
      { organizationId: ORG_ID, organizationName: 'Studio A', roleKey: 'owner' },
    ]);

    const result = await service.login({ email: 'studio@orbitplay.dev', password: 'x' }, req, res);

    expect('accessToken' in result && result.accessToken).toBe('access-token');
    expect('user' in result && result.user.organizationId).toBe(ORG_ID);
    expect(repo.insertRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('asks the client to pick an org when more than one membership is active and none was specified', async () => {
    repo.findActiveMemberships.mockResolvedValue([
      { organizationId: ORG_ID, organizationName: 'Studio A', roleKey: 'owner' },
      { organizationId: OTHER_ORG_ID, organizationName: 'Studio B', roleKey: 'admin' },
    ]);

    const result = await service.login({ email: 'studio@orbitplay.dev', password: 'x' }, req, res);

    expect(result).toEqual({
      requiresOrganizationSelection: true,
      organizations: [
        { organizationId: ORG_ID, organizationName: 'Studio A', role: 'owner' },
        { organizationId: OTHER_ORG_ID, organizationName: 'Studio B', role: 'admin' },
      ],
    });
    expect(repo.insertRefreshToken).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
  });

  it('logs into the specified org when organizationId matches one of the active memberships', async () => {
    repo.findActiveMemberships.mockResolvedValue([
      { organizationId: ORG_ID, organizationName: 'Studio A', roleKey: 'owner' },
      { organizationId: OTHER_ORG_ID, organizationName: 'Studio B', roleKey: 'admin' },
    ]);

    const result = await service.login(
      { email: 'studio@orbitplay.dev', password: 'x', organizationId: OTHER_ORG_ID },
      req,
      res,
    );

    expect('user' in result && result.user.organizationId).toBe(OTHER_ORG_ID);
    expect('user' in result && result.user.role).toBe('admin');
  });

  it('401s (generic) when organizationId does not match any active membership', async () => {
    repo.findActiveMemberships.mockResolvedValue([
      { organizationId: ORG_ID, organizationName: 'Studio A', roleKey: 'owner' },
    ]);

    await expect(
      service.login(
        { email: 'studio@orbitplay.dev', password: 'x', organizationId: OTHER_ORG_ID },
        req,
        res,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(repo.insertRefreshToken).not.toHaveBeenCalled();
  });
});

describe('AuthService refresh (rotation + reuse grace window)', () => {
  const TOKEN_ID = '01920000-0000-7000-8000-0000000000e1';
  const SUCCESSOR_ID = '01920000-0000-7000-8000-0000000000e2';
  const FAMILY_ID = '01920000-0000-7000-8000-0000000000f1';

  let repo: {
    findRefreshTokenByHash: ReturnType<typeof vi.fn>;
    findRefreshTokenById: ReturnType<typeof vi.fn>;
    findUserById: ReturnType<typeof vi.fn>;
    findActiveMembershipForOrg: ReturnType<typeof vi.fn>;
    rotateRefreshToken: ReturnType<typeof vi.fn>;
    insertRefreshTokenIfFamilyActive: ReturnType<typeof vi.fn>;
    revokeFamily: ReturnType<typeof vi.fn>;
  };
  let token: {
    verifyRefreshToken: ReturnType<typeof vi.fn>;
    hashToken: ReturnType<typeof vi.fn>;
    createRefreshToken: ReturnType<typeof vi.fn>;
    signAccessToken: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;
  let req: Request;
  let res: Response;

  function storedToken(overrides: Partial<RefreshTokenRow> = {}): RefreshTokenRow {
    const now = new Date();
    return {
      id: TOKEN_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      familyId: FAMILY_ID,
      tokenHash: 'hash:presented',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      revokedAt: null,
      replacedByTokenId: null,
      ip: null,
      userAgent: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /** Revoked `ageMs` ago — by rotation unless `replacedByTokenId` is overridden to null. */
  function rotatedToken(ageMs: number, overrides: Partial<RefreshTokenRow> = {}) {
    return storedToken({
      revokedAt: new Date(Date.now() - ageMs),
      replacedByTokenId: SUCCESSOR_ID,
      ...overrides,
    });
  }

  beforeEach(() => {
    repo = {
      findRefreshTokenByHash: vi.fn().mockResolvedValue(storedToken()),
      findRefreshTokenById: vi.fn(),
      findUserById: vi.fn().mockResolvedValue(makeUser()),
      findActiveMembershipForOrg: vi
        .fn()
        .mockResolvedValue({ organizationId: ORG_ID, roleKey: 'studio' }),
      rotateRefreshToken: vi.fn().mockResolvedValue(true),
      insertRefreshTokenIfFamilyActive: vi.fn().mockResolvedValue(true),
      revokeFamily: vi.fn().mockResolvedValue(undefined),
    };
    token = {
      verifyRefreshToken: vi.fn().mockResolvedValue({}),
      hashToken: vi.fn((raw: string) => `hash:${raw}`),
      createRefreshToken: vi.fn().mockResolvedValue({
        token: 'next-raw',
        tokenId: 'next-id',
        familyId: FAMILY_ID,
        tokenHash: 'hash:next-raw',
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
      signAccessToken: vi.fn().mockResolvedValue('access-token'),
    };
    const config = {
      get: vi.fn((key: string) => {
        if (key === 'jwt.refreshTtlMs') return 7 * 24 * 60 * 60 * 1000;
        if (key === 'isProduction') return false;
        return undefined;
      }),
    };
    service = new AuthService(
      repo as unknown as AuthRepository,
      {} as unknown as PasswordService,
      token as unknown as TokenService,
      config as unknown as ConfigService,
      {} as unknown as Redis,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = { headers: {}, cookies: { refresh_token: 'presented' } } as unknown as Request;
    res = makeRes();
  });

  const expectSession = (result: { accessToken: string }) => {
    expect(result.accessToken).toBe('access-token');
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      'next-raw',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(repo.revokeFamily).not.toHaveBeenCalled();
  };

  const expectFamilyRevoked = async () => {
    await expect(service.refresh(req, res)).rejects.toMatchObject({ status: 401 });
    expect(repo.revokeFamily).toHaveBeenCalledWith(FAMILY_ID);
    expect(res.clearCookie).toHaveBeenCalledWith('refresh_token', { path: '/' });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
  };

  it('rotates a live token within its family', async () => {
    const result = await service.refresh(req, res);

    expectSession(result);
    expect(repo.rotateRefreshToken).toHaveBeenCalledWith(
      TOKEN_ID,
      expect.objectContaining({ id: 'next-id', familyId: FAMILY_ID, tokenHash: 'hash:next-raw' }),
    );
    expect(repo.insertRefreshTokenIfFamilyActive).not.toHaveBeenCalled();
  });

  it('a token rotated moments ago (second tab / reload) gets a sibling, not a family revoke', async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(rotatedToken(5_000));

    const result = await service.refresh(req, res);

    expectSession(result);
    expect(repo.rotateRefreshToken).not.toHaveBeenCalled();
    expect(repo.insertRefreshTokenIfFamilyActive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'next-id', familyId: FAMILY_ID, userId: USER_ID }),
    );
    expect(token.createRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: FAMILY_ID }),
    );
  });

  it('still checks the user and the membership inside the grace window', async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(rotatedToken(1_000));
    repo.findActiveMembershipForOrg.mockResolvedValue(null);

    await expect(service.refresh(req, res)).rejects.toMatchObject({ status: 401 });
    expect(repo.insertRefreshTokenIfFamilyActive).not.toHaveBeenCalled();
    expect(token.signAccessToken).not.toHaveBeenCalled();
  });

  it(`revokes the family when a rotated token comes back after ${REFRESH_REUSE_GRACE_MS} ms`, async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(rotatedToken(REFRESH_REUSE_GRACE_MS + 1_000));

    await expectFamilyRevoked();
    expect(repo.insertRefreshTokenIfFamilyActive).not.toHaveBeenCalled();
  });

  it('gives no grace to a token revoked by logout/password reset (no successor)', async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(rotatedToken(1_000, { replacedByTokenId: null }));

    await expectFamilyRevoked();
    expect(repo.insertRefreshTokenIfFamilyActive).not.toHaveBeenCalled();
  });

  it('refuses the grace once the rest of the family was revoked (logout after the rotation)', async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(rotatedToken(2_000));
    repo.insertRefreshTokenIfFamilyActive.mockResolvedValue(false);

    await expectFamilyRevoked();
  });

  it('losing the rotation race to a concurrent rotation joins the winner instead of revoking', async () => {
    repo.rotateRefreshToken.mockResolvedValue(false);
    repo.findRefreshTokenById.mockResolvedValue(rotatedToken(10));

    const result = await service.refresh(req, res);

    expectSession(result);
    expect(repo.findRefreshTokenById).toHaveBeenCalledWith(TOKEN_ID);
    expect(repo.insertRefreshTokenIfFamilyActive).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'next-id', familyId: FAMILY_ID }),
    );
  });

  it('losing the race to a logout (revoked without successor) still revokes the family', async () => {
    repo.rotateRefreshToken.mockResolvedValue(false);
    repo.findRefreshTokenById.mockResolvedValue(rotatedToken(10, { replacedByTokenId: null }));

    await expectFamilyRevoked();
    expect(repo.insertRefreshTokenIfFamilyActive).not.toHaveBeenCalled();
  });
});

describe('AuthService password reset', () => {
  let repo: {
    findUserByEmail: ReturnType<typeof vi.fn>;
    findUserById: ReturnType<typeof vi.fn>;
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
    ttl: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: AuthService;
  let req: Request;

  beforeEach(() => {
    repo = {
      findUserByEmail: vi.fn(),
      findUserById: vi.fn(),
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
      ttl: vi.fn().mockResolvedValue(60),
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

  it('admin-triggered reset shares the per-e-mail limit of "forgot"', async () => {
    repo.findUserById.mockResolvedValue(makeUser());
    redis.incr.mockResolvedValue(6);

    await expect(service.triggerPasswordReset(USER_ID)).rejects.toMatchObject({ status: 429 });
    expect(redis.incr).toHaveBeenCalledWith('forgot:id:studio@orbitplay.dev');
    expect(repo.invalidateUnusedTokens).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
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
        text: expect.stringContaining('/reset-password?token='),
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
    ttl: ReturnType<typeof vi.fn>;
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
      ttl: vi.fn().mockResolvedValue(60),
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
    ttl: ReturnType<typeof vi.fn>;
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
      ttl: vi.fn().mockResolvedValue(60),
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
    ttl: ReturnType<typeof vi.fn>;
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
      ttl: vi.fn().mockResolvedValue(60),
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

describe('AuthService invites (explicit acceptance)', () => {
  const MEMBERSHIP_ID = '01920000-0000-7000-8000-0000000000d7';
  const INVITED_ID = '01920000-0000-7000-8000-0000000000c8';

  let repo: {
    replaceInviteToken: ReturnType<typeof vi.fn>;
    findPendingInviteByTokenHash: ReturnType<typeof vi.fn>;
    findActiveMemberships: ReturnType<typeof vi.fn>;
    acceptInvite: ReturnType<typeof vi.fn>;
  };
  let password: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let redis: {
    incr: ReturnType<typeof vi.fn>;
    ttl: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;
  let req: Request;

  function pendingInvite(overrides: Partial<PendingInvite> = {}): PendingInvite {
    return {
      inviteTokenId: 'invite-token-id',
      membershipId: MEMBERSHIP_ID,
      organizationId: ORG_ID,
      organizationName: 'Studio A',
      role: 'studio',
      userId: INVITED_ID,
      email: 'convidado@estudio.dev',
      passwordHash: 'stored-hash',
      birthdate: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    repo = {
      replaceInviteToken: vi.fn().mockResolvedValue(undefined),
      findPendingInviteByTokenHash: vi.fn().mockResolvedValue(pendingInvite()),
      findActiveMemberships: vi.fn().mockResolvedValue([]),
      acceptInvite: vi.fn().mockResolvedValue(true),
    };
    password = {
      hash: vi.fn().mockResolvedValue('new-hash'),
      verify: vi.fn().mockResolvedValue(true),
    };
    redis = {
      incr: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(60),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    };
    const config = {
      get: vi.fn((key: string) => {
        if (key === 'authThrottle.limit') return 5;
        if (key === 'authThrottle.ttl') return 60;
        return undefined;
      }),
    };
    service = new AuthService(
      repo as unknown as AuthRepository,
      password as unknown as PasswordService,
      { hashToken: vi.fn((raw: string) => `hash:${raw}`) } as unknown as TokenService,
      config as unknown as ConfigService,
      redis as unknown as Redis,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('issues a random token valid for 7 days, storing only its hash', async () => {
    const before = Date.now();
    const raw = await service.issueInviteToken(MEMBERSHIP_ID, ORG_ID);

    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = repo.replaceInviteToken.mock.calls[0]![0] as {
      tokenHash: string;
      expiresAt: Date;
      membershipId: string;
      organizationId: string;
    };
    expect(stored).toMatchObject({
      membershipId: MEMBERSHIP_ID,
      organizationId: ORG_ID,
      tokenHash: `hash:${raw}`,
    });
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITE_TOKEN_TTL_MS);
    expect(INVITE_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('a resend shares the per-e-mail mail budget (429 past it)', async () => {
    redis.incr.mockResolvedValue(6);

    await expect(
      service.reissueInviteToken(MEMBERSHIP_ID, ORG_ID, 'Convidado@Estudio.dev'),
    ).rejects.toMatchObject({ status: 429 });
    expect(redis.incr).toHaveBeenCalledWith('forgot:id:convidado@estudio.dev');
    expect(repo.replaceInviteToken).not.toHaveBeenCalled();
  });

  describe('preview', () => {
    it('shows a new account (created by the invite) as needing password and birthdate', async () => {
      await expect(service.previewInvite('tok')).resolves.toEqual({
        organizationName: 'Studio A',
        role: 'studio',
        email: 'convidado@estudio.dev',
        accountExists: false,
        birthdateRequired: true,
      });
      expect(repo.findPendingInviteByTokenHash).toHaveBeenCalledWith('hash:tok');
    });

    it('treats an account with a birthdate (signed up) as existing', async () => {
      repo.findPendingInviteByTokenHash.mockResolvedValue(
        pendingInvite({ birthdate: '1990-01-01' }),
      );
      await expect(service.previewInvite('tok')).resolves.toMatchObject({
        accountExists: true,
        birthdateRequired: false,
      });
    });

    it('treats an account already active in another org as existing', async () => {
      repo.findActiveMemberships.mockResolvedValue([
        { organizationId: 'other', organizationName: 'Outra', roleKey: 'player' },
      ]);
      await expect(service.previewInvite('tok')).resolves.toMatchObject({
        accountExists: true,
        birthdateRequired: true,
      });
    });

    it('answers 422 (token) for an unknown, used or expired token', async () => {
      repo.findPendingInviteByTokenHash.mockResolvedValue(null);
      await expect(service.previewInvite('nope')).rejects.toMatchObject({ status: 422 });
    });
  });

  describe('accept — account created by the invite', () => {
    it('sets password + birthdate and activates the membership', async () => {
      const result = await service.acceptInvite(
        { token: 'tok', password: 'NovaSenha1', birthdate: '1995-06-15' },
        req,
      );

      expect(result).toMatchObject({
        email: 'convidado@estudio.dev',
        organizationName: 'Studio A',
      });
      expect(password.hash).toHaveBeenCalledWith('NovaSenha1');
      expect(repo.acceptInvite).toHaveBeenCalledWith({
        tokenHash: 'hash:tok',
        membershipId: MEMBERSHIP_ID,
        userId: INVITED_ID,
        passwordHash: 'new-hash',
        birthdate: '1995-06-15',
      });
      expect(drainAuditDrafts(req)[0]).toMatchObject({
        action: 'org.invite_accepted',
        entityId: INVITED_ID,
        after: { status: 'active', organizationId: ORG_ID, accountCreated: true },
      });
    });

    it('requires a birthdate and enforces 18+', async () => {
      await expect(
        service.acceptInvite({ token: 'tok', password: 'NovaSenha1' }, req),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        service.acceptInvite(
          { token: 'tok', password: 'NovaSenha1', birthdate: '2015-01-01' },
          req,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.acceptInvite).not.toHaveBeenCalled();
    });

    it('requires a password', async () => {
      await expect(
        service.acceptInvite({ token: 'tok', birthdate: '1995-06-15' }, req),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.acceptInvite).not.toHaveBeenCalled();
    });
  });

  describe('accept — existing account', () => {
    beforeEach(() => {
      repo.findPendingInviteByTokenHash.mockResolvedValue(
        pendingInvite({ birthdate: '1990-01-01' }),
      );
    });

    it('accepts with the CURRENT password and never changes it', async () => {
      await service.acceptInvite(
        { token: 'tok', currentPassword: 'Atual123', password: 'TentaTrocar1' },
        req,
      );

      expect(password.verify).toHaveBeenCalledWith('stored-hash', 'Atual123');
      expect(password.hash).not.toHaveBeenCalled();
      expect(repo.acceptInvite).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: undefined, birthdate: undefined }),
      );
    });

    it('refuses a token holder who does not know the password — no takeover', async () => {
      password.verify.mockResolvedValue(false);

      await expect(
        service.acceptInvite({ token: 'tok', currentPassword: 'chute' }, req),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        service.acceptInvite({ token: 'tok', password: 'NovaSenha1' }, req),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.acceptInvite).not.toHaveBeenCalled();
      expect(redis.incr).toHaveBeenCalledWith('invite:id:convidado@estudio.dev');
    });

    it('throttles password guesses per e-mail', async () => {
      redis.incr.mockResolvedValue(6);
      await expect(
        service.acceptInvite({ token: 'tok', currentPassword: 'chute' }, req),
      ).rejects.toMatchObject({ status: 429 });
      expect(password.verify).not.toHaveBeenCalled();
    });

    it('still collects a missing birthdate (18+) from an existing account', async () => {
      repo.findPendingInviteByTokenHash.mockResolvedValue(pendingInvite({ birthdate: null }));
      repo.findActiveMemberships.mockResolvedValue([
        { organizationId: 'other', organizationName: 'Outra', roleKey: 'studio' },
      ]);

      await expect(
        service.acceptInvite({ token: 'tok', currentPassword: 'Atual123' }, req),
      ).rejects.toMatchObject({ status: 422 });

      await service.acceptInvite(
        { token: 'tok', currentPassword: 'Atual123', birthdate: '1990-02-02' },
        req,
      );
      expect(repo.acceptInvite).toHaveBeenCalledWith(
        expect.objectContaining({ birthdate: '1990-02-02', passwordHash: undefined }),
      );
    });
  });

  it('answers 422 when the token was consumed concurrently', async () => {
    repo.acceptInvite.mockResolvedValue(false);
    await expect(
      service.acceptInvite({ token: 'tok', password: 'NovaSenha1', birthdate: '1995-06-15' }, req),
    ).rejects.toMatchObject({ status: 422 });
    expect(drainAuditDrafts(req)).toHaveLength(0);
  });
});
