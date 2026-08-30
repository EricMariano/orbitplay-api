import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS } from '../src/infra/database/seed';
import { SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2EApp();
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
});
