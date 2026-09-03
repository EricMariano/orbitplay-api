import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS } from '../src/infra/database/seed';
import { SEED_PASSWORD } from '../src/infra/database/seed';
import { CapturingMailAdapter, createE2EApp } from './helpers/e2e-app';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let mail: CapturingMailAdapter;

  beforeAll(async () => {
    mail = new CapturingMailAdapter();
    app = await createE2EApp({ mail });
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in the studio user: access token + httpOnly refresh cookie (criterion #2)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: SEED_EMAILS.studio, password: SEED_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user.role).toBe('studio');

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('refresh_token=') && /HttpOnly/i.test(c))).toBe(true);
  });

  it('rejects wrong password with a generic 401 (no user/pass distinction, RN-02)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: SEED_EMAILS.admin, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    // Same generic message an unknown user would get.
    expect(res.body.message).toBe('Credenciais inválidas');
  });

  it('returns the same generic 401 for an unknown user', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ghost@nowhere.dev', password: 'whatever' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Credenciais inválidas');
  });

  it('never accepts a role from the body (RN-03)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: SEED_EMAILS.player, password: SEED_PASSWORD, role: 'owner' });

    expect(res.status).toBe(200);
    // Role comes from the membership, not the body.
    expect(res.body.user.role).toBe('player');
  });

  it('rotates the refresh token and lets /me work with the new access token', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/auth/login')
      .send({ email: SEED_EMAILS.owner, password: SEED_PASSWORD });
    expect(login.status).toBe(200);
    const loginCookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;

    const refresh = await agent.post('/auth/refresh').send();
    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toBeTypeOf('string');
    // The refresh token itself rotates (a fresh cookie is issued). The access
    // token may be byte-identical if issued in the same second (JWT iat is in
    // whole seconds), so we assert rotation on the cookie, not the access token.
    const refreshedCookie = (refresh.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;
    expect(refreshedCookie).not.toBe(loginCookie);

    const me = await agent
      .get('/auth/me')
      .set('Authorization', `Bearer ${refresh.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(SEED_EMAILS.owner);
  });

  it('detects refresh-token reuse and revokes the family', async () => {
    // Login to obtain a concrete refresh cookie we can replay.
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: SEED_EMAILS.admin, password: SEED_PASSWORD });
    const oldCookie = (loginRes.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;

    // First use rotates successfully (old token becomes revoked/replaced).
    const firstUse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', oldCookie);
    expect(firstUse.status).toBe(200);

    // Replaying the now-rotated cookie is detected as reuse → 401.
    const reuse = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', oldCookie);
    expect(reuse.status).toBe(401);
  });

  describe('password reset (ORB-M1-01 / RN-05)', () => {
    const NEW_PASSWORD = 'ResetPass99';
    // Dedicated seed user for this suite — restored to SEED_PASSWORD in the last test.
    const email = SEED_EMAILS.player;

    it('forgot: unknown email still returns the generic 200 and sends no mail', async () => {
      mail.clear();
      const res = await request(app.getHttpServer())
        .post('/auth/password/forgot')
        .send({ email: 'ghost-reset@nowhere.dev' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Se o e-mail existir, enviaremos instruções de recuperação.');
      expect(mail.sent).toHaveLength(0);
    });

    it('forgot → reset → old sessions die; token is single-use', async () => {
      mail.clear();

      // Open a session we expect to be revoked after reset.
      const loginBefore = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: SEED_PASSWORD });
      expect(loginBefore.status).toBe(200);
      const oldCookie = (loginBefore.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('refresh_token='),
      )!;

      const forgot = await request(app.getHttpServer())
        .post('/auth/password/forgot')
        .send({ email });
      expect(forgot.status).toBe(200);
      expect(forgot.body.message).toBe(
        'Se o e-mail existir, enviaremos instruções de recuperação.',
      );

      const rawToken = mail.lastResetToken();
      expect(rawToken).toBeTypeOf('string');

      const reset = await request(app.getHttpServer())
        .post('/auth/password/reset')
        .send({ token: rawToken, password: NEW_PASSWORD });
      expect(reset.status).toBe(200);
      expect(reset.body.message).toBe('Senha redefinida com sucesso.');

      // Token cannot be reused.
      const reuse = await request(app.getHttpServer())
        .post('/auth/password/reset')
        .send({ token: rawToken, password: 'AnotherPass1' });
      expect(reuse.status).toBe(422);
      expect(reuse.body.code).toBe('VALIDATION_ERROR');

      // Old password no longer works; new one does.
      const oldLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: SEED_PASSWORD });
      expect(oldLogin.status).toBe(401);

      const newLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: NEW_PASSWORD });
      expect(newLogin.status).toBe(200);

      // Pre-reset refresh cookie is dead.
      const staleRefresh = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', oldCookie);
      expect(staleRefresh.status).toBe(401);
    });

    it('reset: password shorter than 8 chars → 422 with fieldErrors.password', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/password/reset')
        .send({ token: 'any-token', password: 'short' });

      expect(res.status).toBe(422);
      expect(res.body.fieldErrors?.password).toBeTypeOf('string');
    });

    it('restores the seed password so later suites stay deterministic', async () => {
      mail.clear();
      const forgot = await request(app.getHttpServer())
        .post('/auth/password/forgot')
        .send({ email });
      expect(forgot.status).toBe(200);
      const rawToken = mail.lastResetToken();
      expect(rawToken).toBeTypeOf('string');

      const reset = await request(app.getHttpServer())
        .post('/auth/password/reset')
        .send({ token: rawToken, password: SEED_PASSWORD });
      expect(reset.status).toBe(200);

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: SEED_PASSWORD });
      expect(login.status).toBe(200);
    });
  });

  describe('signup studio (ORB-M1-02)', () => {
    const uniqueEmail = () =>
      `studio-signup-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const password = 'SignupPass99';
    const organizationName = 'Acme Interactive';

    it('creates user+org+owner and opens a session (201 + refresh cookie)', async () => {
      const email = uniqueEmail();
      const res = await request(app.getHttpServer()).post('/auth/signup/studio').send({
        displayName: 'Acme Owner',
        email,
        password,
        birthdate: '1990-01-15',
        organizationName,
      });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.user).toMatchObject({
        email,
        displayName: 'Acme Owner',
        role: 'owner',
      });
      expect(res.body.user.organizationId).toBeTypeOf('string');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('refresh_token=') && /HttpOnly/i.test(c))).toBe(true);

      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(email);
      expect(me.body.role).toBe('owner');

      const org = await request(app.getHttpServer())
        .get('/orgs/current')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(org.status).toBe(200);
      expect(org.body.name).toBe(organizationName);
      expect(org.body.id).toBe(res.body.user.organizationId);

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe('owner');
    });

    it('duplicate email → 409 CONFLICT', async () => {
      const email = uniqueEmail();
      const body = {
        displayName: 'Dup Owner',
        email,
        password,
        birthdate: '1988-03-20',
        organizationName: 'Dup Studio',
      };
      const first = await request(app.getHttpServer()).post('/auth/signup/studio').send(body);
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer()).post('/auth/signup/studio').send(body);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('CONFLICT');
      expect(second.body.message).toBe('E-mail já cadastrado');
    });

    it('under-18 birthdate → 422 with fieldErrors.birthdate', async () => {
      const res = await request(app.getHttpServer()).post('/auth/signup/studio').send({
        displayName: 'Minor',
        email: uniqueEmail(),
        password,
        birthdate: '2015-01-01',
        organizationName: 'Kids Studio',
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors?.birthdate).toBeTypeOf('string');
    });

    it('missing organizationName → 422', async () => {
      const res = await request(app.getHttpServer()).post('/auth/signup/studio').send({
        displayName: 'No Org',
        email: uniqueEmail(),
        password,
        birthdate: '1992-05-05',
      });

      expect(res.status).toBe(422);
      expect(res.body.fieldErrors?.organizationName).toBeTypeOf('string');
    });
  });

  describe('signup player (ORB-M1-03)', () => {
    const uniqueEmail = () =>
      `player-signup-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const password = 'SignupPass99';

    it('creates user+personal-org+player and opens a session (201 + refresh cookie)', async () => {
      const email = uniqueEmail();
      const res = await request(app.getHttpServer()).post('/auth/signup/player').send({
        displayName: 'Ana Tester',
        email,
        password,
        birthdate: '1992-04-10',
      });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.user).toMatchObject({
        email,
        displayName: 'Ana Tester',
        role: 'player',
      });
      expect(res.body.user.organizationId).toBeTypeOf('string');

      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('refresh_token=') && /HttpOnly/i.test(c))).toBe(true);

      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(email);
      expect(me.body.role).toBe('player');

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe('player');
    });

    it('duplicate email (player→player) → 409 CONFLICT', async () => {
      const email = uniqueEmail();
      const body = {
        displayName: 'Dup Player',
        email,
        password,
        birthdate: '1988-03-20',
      };
      const first = await request(app.getHttpServer()).post('/auth/signup/player').send(body);
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer()).post('/auth/signup/player').send(body);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('CONFLICT');
      expect(second.body.message).toBe('E-mail já cadastrado');
    });

    it('duplicate email across studio and player → 409 CONFLICT', async () => {
      const email = uniqueEmail();
      const studio = await request(app.getHttpServer()).post('/auth/signup/studio').send({
        displayName: 'Cross Studio',
        email,
        password,
        birthdate: '1985-07-01',
        organizationName: 'Cross Org',
      });
      expect(studio.status).toBe(201);

      const player = await request(app.getHttpServer()).post('/auth/signup/player').send({
        displayName: 'Cross Player',
        email,
        password,
        birthdate: '1991-02-14',
      });
      expect(player.status).toBe(409);
      expect(player.body.code).toBe('CONFLICT');
    });

    it('under-18 birthdate → 422 with fieldErrors.birthdate', async () => {
      const res = await request(app.getHttpServer()).post('/auth/signup/player').send({
        displayName: 'Minor',
        email: uniqueEmail(),
        password,
        birthdate: '2015-01-01',
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors?.birthdate).toBeTypeOf('string');
    });

    it('succeeds without organizationName (extra field ignored)', async () => {
      const email = uniqueEmail();
      const res = await request(app.getHttpServer()).post('/auth/signup/player').send({
        displayName: 'No Org Field',
        email,
        password,
        birthdate: '1993-11-22',
        organizationName: 'Should Be Ignored',
      });

      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('player');
    });
  });

  describe('signup availability (ORB-M1-04)', () => {
    let availApp: INestApplication;
    const previousLimit = process.env.AUTH_AVAILABILITY_THROTTLE_LIMIT;

    beforeAll(async () => {
      // Headroom for functional cases; aggressive default is asserted in ratelimit.e2e.
      process.env.AUTH_AVAILABILITY_THROTTLE_LIMIT = '20';
      availApp = await createE2EApp();
    });

    afterAll(async () => {
      await availApp.close();
      if (previousLimit === undefined) {
        delete process.env.AUTH_AVAILABILITY_THROTTLE_LIMIT;
      } else {
        process.env.AUTH_AVAILABILITY_THROTTLE_LIMIT = previousLimit;
      }
    });

    it('returns available:false for a seed email', async () => {
      const res = await request(availApp.getHttpServer())
        .get('/auth/signup/availability')
        .query({ email: SEED_EMAILS.studio });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: false });
    });

    it('returns available:true for an unused email', async () => {
      const email = `avail-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
      const res = await request(availApp.getHttpServer())
        .get('/auth/signup/availability')
        .query({ email });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true });
    });

    it('rejects missing email with 422 VALIDATION_ERROR', async () => {
      const res = await request(availApp.getHttpServer()).get('/auth/signup/availability');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid email with 422 VALIDATION_ERROR', async () => {
      const res = await request(availApp.getHttpServer())
        .get('/auth/signup/availability')
        .query({ email: 'not-an-email' });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.fieldErrors?.email).toBeTypeOf('string');
    });
  });
});
