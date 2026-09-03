import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { CapturingMailAdapter, createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// Someone who already has an account but no membership in the demo org —
// proves the invite reuses the user row instead of creating a second one.
const OUTSIDER = {
  userId: '01940000-0000-7000-8000-0000000000e1',
  email: 'outsider@rival.dev',
};

const FRESH = 'convidado-novo@estudio.dev';
const DUPLICATE = 'convidado-dup@estudio.dev';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Org members — invite (e2e)', () => {
  let app: INestApplication;
  let mail: CapturingMailAdapter;
  let sql: postgres.Sql;
  let ownerToken: string;
  let adminToken: string;
  let studioToken: string;
  let playerToken: string;

  beforeAll(async () => {
    mail = new CapturingMailAdapter();
    app = await createE2EApp({ mail });
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    // An existing account with no membership in the seeded organization.
    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${OUTSIDER.userId}, ${OUTSIDER.email}, password_hash, 'Outsider'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;

    ownerToken = await bearer(app, SEED_EMAILS.owner);
    adminToken = await bearer(app, SEED_EMAILS.admin);
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('owner invites a new e-mail: 201 with an invited membership', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: FRESH, displayName: 'Ana Souza', role: 'studio' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: FRESH,
      displayName: 'Ana Souza',
      role: 'studio',
      status: 'invited',
    });
    expect(res.body.userId).toBeTruthy();
  });

  it('the invited member appears in the members list as invited', async () => {
    const res = await request(app.getHttpServer())
      .get('/orgs/members')
      .set('Authorization', `Bearer ${ownerToken}`);

    const invited = (res.body.data as { email: string; status: string }[]).find(
      (m) => m.email === FRESH,
    );
    expect(invited).toMatchObject({ status: 'invited' });
  });

  it('sends an invitation e-mail carrying no token and no password', async () => {
    const sent = mail.sent.find((m) => m.to === FRESH);
    expect(sent).toBeDefined();
    expect(sent!.text).toContain('Esqueci minha senha');
    expect(sent!.text).not.toContain('token');
    expect(sent!.text).not.toContain(SEED_PASSWORD);
  });

  it('the invited user cannot log in until they set a password', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: FRESH, password: SEED_PASSWORD });

    expect(res.status).toBe(401);
  });

  it('reuses the existing user row when the e-mail already has an account', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: OUTSIDER.email, role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(OUTSIDER.userId);
    expect(res.body.displayName).toBe('Outsider');

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users WHERE lower(email) = ${OUTSIDER.email}`;
    expect(rows[0].count).toBe('1');
  });

  it('rejects a second invite for the same person with 409 (unique membership)', async () => {
    const first = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: DUPLICATE, role: 'studio' });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: DUPLICATE, role: 'studio' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CONFLICT');
  });

  it('rejects an invite for someone already a member of the org', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: SEED_EMAILS.player, role: 'studio' });

    expect(res.status).toBe(409);
  });

  it('admin may invite (Tela 20 RN-01)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'convidado-por-admin@estudio.dev', role: 'studio' });

    expect(res.status).toBe(201);
  });

  it('studio role cannot invite: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ email: 'nao-deveria@estudio.dev', role: 'studio' });

    expect(res.status).toBe(403);
  });

  it('player cannot invite: 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ email: 'nao-deveria-2@estudio.dev', role: 'studio' });

    expect(res.status).toBe(403);
  });

  it('rejects an invalid e-mail with 422 and a field error', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'nao-e-email', role: 'studio' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('email');
  });

  it('rejects an unknown role with 422', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'papel-invalido@estudio.dev', role: 'superuser' });

    expect(res.status).toBe(422);
  });
});
