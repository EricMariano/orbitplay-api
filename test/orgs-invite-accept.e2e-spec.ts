import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { CapturingMailAdapter, createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

const NEW_PASSWORD = 'Convite@Novo123';
const ADULT = '1995-06-15';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

const uniqueEmail = (prefix: string) => `${prefix}-${uuidv7()}@convite-e2e.dev`;

/**
 * Explicit invite acceptance: the e-mail carries a single-use link, and only
 * accepting it turns `invited` into `active`. An account created by the invite
 * picks password + birthdate there (18+); an existing account proves it is the
 * invitee with its current password, which the invite never changes.
 */
describe('Org invites — explicit acceptance (e2e)', () => {
  let app: INestApplication;
  let mail: CapturingMailAdapter;
  let sql: postgres.Sql;
  let ownerToken: string;
  let adminToken: string;
  let studioToken: string;

  const http = () => request(app.getHttpServer());

  /** The raw token from the last invitation e-mail sent to `to`. */
  function inviteTokenFor(to: string): string {
    const sent = mail.sent.filter((m) => m.to === to).at(-1);
    const match = /\/accept-invite\?token=([A-Za-z0-9_-]+)/.exec(sent?.text ?? '');
    if (!match) throw new Error(`nenhum convite enviado para ${to}`);
    return match[1]!;
  }

  async function invite(email: string, role = 'studio', token = ownerToken) {
    const res = await http()
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, role });
    expect(res.status).toBe(201);
    return res.body as { userId: string };
  }

  async function membershipStatus(userId: string): Promise<string | undefined> {
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM memberships WHERE organization_id = ${ORG_ID} AND user_id = ${userId}`;
    return rows[0]?.status;
  }

  beforeAll(async () => {
    mail = new CapturingMailAdapter();
    app = await createE2EApp({ mail });
    sql = postgres(TEST_DATABASE_URL, { max: 1 });
    ownerToken = await bearer(app, SEED_EMAILS.owner);
    adminToken = await bearer(app, SEED_EMAILS.admin);
    studioToken = await bearer(app, SEED_EMAILS.studio);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  describe('account created by the invite', () => {
    const email = uniqueEmail('novo');
    let userId: string;
    let token: string;

    beforeAll(async () => {
      ({ userId } = await invite(email));
      token = inviteTokenFor(email);
    });

    it('preview asks for a new password and a birthdate', async () => {
      const res = await http().post('/auth/invite/preview').send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        organizationName: 'OrbitPlay Studio Demo',
        role: 'studio',
        email,
        accountExists: false,
        birthdateRequired: true,
      });
    });

    it('refuses an under-18 birthdate and a missing password (422), changing nothing', async () => {
      const minor = await http()
        .post('/auth/invite/accept')
        .send({ token, password: NEW_PASSWORD, birthdate: '2015-01-01' });
      expect(minor.status).toBe(422);
      expect(minor.body.fieldErrors).toHaveProperty('birthdate');

      const noPassword = await http().post('/auth/invite/accept').send({ token, birthdate: ADULT });
      expect(noPassword.status).toBe(422);
      expect(noPassword.body.fieldErrors).toHaveProperty('password');

      expect(await membershipStatus(userId)).toBe('invited');
    });

    it('accepting sets password + birthdate, activates the membership and opens login', async () => {
      const res = await http()
        .post('/auth/invite/accept')
        .send({ token, password: NEW_PASSWORD, birthdate: ADULT });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email, organizationName: 'OrbitPlay Studio Demo' });

      expect(await membershipStatus(userId)).toBe('active');
      const [user] = await sql<{ birthdate: string }[]>`
        SELECT birthdate::text AS birthdate FROM users WHERE id = ${userId}`;
      expect(user.birthdate).toBe(ADULT);

      const login = await http().post('/auth/login').send({ email, password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.user).toMatchObject({ organizationId: ORG_ID, role: 'studio' });

      const audit = await sql<{ action: string }[]>`
        SELECT action FROM audit_log WHERE action = 'org.invite_accepted' AND entity_id = ${userId}`;
      expect(audit).toHaveLength(1);
    });

    it('the link is single-use', async () => {
      const again = await http()
        .post('/auth/invite/accept')
        .send({ token, password: 'OutraSenha123', birthdate: ADULT });
      expect(again.status).toBe(422);
      expect(again.body.fieldErrors).toHaveProperty('token');

      const preview = await http().post('/auth/invite/preview').send({ token });
      expect(preview.status).toBe(422);
    });

    it('resend answers 409 once the invite was accepted', async () => {
      const res = await http()
        .post(`/orgs/members/${userId}/invite/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(409);
    });
  });

  describe('password reset and resend', () => {
    const email = uniqueEmail('reset');
    let userId: string;
    let firstToken: string;

    beforeAll(async () => {
      ({ userId } = await invite(email));
      firstToken = inviteTokenFor(email);
    });

    it('recovering the password does NOT accept the invite', async () => {
      mail.clear();
      const forgot = await http().post('/auth/password/forgot').send({ email });
      expect(forgot.status).toBe(200);
      const resetToken = mail.lastResetToken();
      expect(resetToken).toBeTypeOf('string');

      const reset = await http()
        .post('/auth/password/reset')
        .send({ token: resetToken, password: NEW_PASSWORD });
      expect(reset.status).toBe(200);

      expect(await membershipStatus(userId)).toBe('invited');
      const login = await http().post('/auth/login').send({ email, password: NEW_PASSWORD });
      expect(login.status).toBe(401);
    });

    it('the members area answers 409 to a password reset for a pending invite', async () => {
      const res = await http()
        .post(`/orgs/members/${userId}/password-reset`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(409);
    });

    it('resend issues a fresh link and voids the previous one', async () => {
      // Invites created before explicit acceptance existed have no token at
      // all — resend is how they recover. Here there is one, and it must die.
      const oldToken = firstToken;
      mail.clear();

      const res = await http()
        .post(`/orgs/members/${userId}/invite/resend`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(202);
      const freshToken = inviteTokenFor(email);
      expect(freshToken).not.toBe(oldToken);

      const old = await http().post('/auth/invite/preview').send({ token: oldToken });
      expect(old.status).toBe(422);

      const accepted = await http()
        .post('/auth/invite/accept')
        .send({ token: freshToken, password: NEW_PASSWORD, birthdate: ADULT });
      expect(accepted.status).toBe(200);
      expect(await membershipStatus(userId)).toBe('active');
    });
  });

  describe('existing account', () => {
    const email = uniqueEmail('existente');
    const ownPassword = 'MinhaSenha@123';
    let userId: string;
    let token: string;

    beforeAll(async () => {
      const signup = await http().post('/auth/signup/player').send({
        displayName: 'Jogadora Existente',
        email,
        password: ownPassword,
        birthdate: ADULT,
      });
      expect(signup.status).toBe(201);
      ({ userId } = await invite(email));
      token = inviteTokenFor(email);
    });

    it('preview says the account exists and asks for no birthdate', async () => {
      const res = await http().post('/auth/invite/preview').send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ accountExists: true, birthdateRequired: false });
    });

    it('the token alone is no takeover: a new password, or a wrong current one, is refused', async () => {
      const takeover = await http()
        .post('/auth/invite/accept')
        .send({ token, password: 'SenhaDoAtacante1', birthdate: ADULT });
      expect(takeover.status).toBe(422);
      expect(takeover.body.fieldErrors).toHaveProperty('currentPassword');

      const wrong = await http()
        .post('/auth/invite/accept')
        .send({ token, currentPassword: 'NaoEhEssa123' });
      expect(wrong.status).toBe(422);
      expect(wrong.body.fieldErrors).toHaveProperty('currentPassword');

      expect(await membershipStatus(userId)).toBe('invited');
    });

    it('accepts with the current password, which stays the account password', async () => {
      const res = await http()
        .post('/auth/invite/accept')
        .send({ token, currentPassword: ownPassword, password: 'IgnoradaAqui1' });
      expect(res.status).toBe(200);
      expect(await membershipStatus(userId)).toBe('active');

      const login = await http()
        .post('/auth/login')
        .send({ email, password: ownPassword, organizationId: ORG_ID });
      expect(login.status).toBe(200);
      expect(login.body.user).toMatchObject({ organizationId: ORG_ID, role: 'studio' });

      const ignored = await http()
        .post('/auth/login')
        .send({ email, password: 'IgnoradaAqui1', organizationId: ORG_ID });
      expect(ignored.status).toBe(401);
    });
  });

  describe('resend: roles and hierarchy', () => {
    it("only an owner resends an owner's invite; studio can't resend at all", async () => {
      const email = uniqueEmail('socio');
      const { userId } = await invite(email, 'owner');

      const asAdmin = await http()
        .post(`/orgs/members/${userId}/invite/resend`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(asAdmin.status).toBe(403);

      const asStudio = await http()
        .post(`/orgs/members/${userId}/invite/resend`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(asStudio.status).toBe(403);

      const asOwner = await http()
        .post(`/orgs/members/${userId}/invite/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(asOwner.status).toBe(202);
    });

    it('404s for someone outside the organization', async () => {
      const res = await http()
        .post('/orgs/members/00000000-0000-7000-8000-000000000000/invite/resend')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  it('rejects an unknown token with 422 on preview and accept', async () => {
    const preview = await http().post('/auth/invite/preview').send({ token: 'nao-existe' });
    expect(preview.status).toBe(422);
    const accept = await http()
      .post('/auth/invite/accept')
      .send({ token: 'nao-existe', password: NEW_PASSWORD, birthdate: ADULT });
    expect(accept.status).toBe(422);
  });
});
