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

  it('admin cannot grant the owner role: 403 (privilege escalation)', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'admin-quer-ser-owner@estudio.dev', role: 'owner' });

    expect(res.status).toBe(403);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM users
      WHERE lower(email) = 'admin-quer-ser-owner@estudio.dev'`;
    expect(rows[0].count).toBe('0');
  });

  it('owner may grant the owner role', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'socio@estudio.dev', role: 'owner' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'owner', status: 'invited' });
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

// A separate organization with TWO active owners, so the last-owner rule can be
// exercised without touching the seeded org other specs rely on.
const ROLE_ORG = {
  orgId: '01950000-0000-7000-8000-0000000000f1',
  ownerA: { id: '01950000-0000-7000-8000-0000000000a1', email: 'owner-a@papeis.dev' },
  ownerB: { id: '01950000-0000-7000-8000-0000000000a2', email: 'owner-b@papeis.dev' },
  member: { id: '01950000-0000-7000-8000-0000000000a3', email: 'membro@papeis.dev' },
};

describe('Org members — change role (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let ownerAToken: string;
  let seededOwnerToken: string;
  let seededAdminToken: string;
  let seededStudioToken: string;
  let seededPlayerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    for (const person of [ROLE_ORG.ownerA, ROLE_ORG.ownerB, ROLE_ORG.member]) {
      await sql`
        INSERT INTO users (id, email, password_hash, display_name)
        SELECT ${person.id}, ${person.email}, password_hash, ${person.email}
        FROM users WHERE email = ${SEED_EMAILS.studio}
        ON CONFLICT DO NOTHING`;
    }
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${ROLE_ORG.orgId}, 'Papeis Studio', 'papeis-studio', ${ROLE_ORG.ownerA.id})
      ON CONFLICT DO NOTHING`;
    for (const [person, roleKey] of [
      [ROLE_ORG.ownerA, 'owner'],
      [ROLE_ORG.ownerB, 'owner'],
      [ROLE_ORG.member, 'studio'],
    ] as const) {
      await sql`
        INSERT INTO memberships (id, organization_id, user_id, role_id, status)
        VALUES (gen_random_uuid(), ${ROLE_ORG.orgId}, ${person.id},
                (SELECT id FROM roles WHERE key = ${roleKey}), 'active')
        ON CONFLICT DO NOTHING`;
    }

    ownerAToken = await bearer(app, ROLE_ORG.ownerA.email);
    seededOwnerToken = await bearer(app, SEED_EMAILS.owner);
    seededAdminToken = await bearer(app, SEED_EMAILS.admin);
    seededStudioToken = await bearer(app, SEED_EMAILS.studio);
    seededPlayerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  function patchRole(token: string, userId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/orgs/members/${userId}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('owner promotes a studio member to admin', async () => {
    const res = await patchRole(ownerAToken, ROLE_ORG.member.id, {
      role: 'admin',
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: ROLE_ORG.member.id,
      role: 'admin',
      status: 'active',
    });
  });

  it('the new role shows up in the members list', async () => {
    const res = await request(app.getHttpServer())
      .get('/orgs/members')
      .set('Authorization', `Bearer ${ownerAToken}`);

    const member = (res.body.data as { userId: string; role: string }[]).find(
      (m) => m.userId === ROLE_ORG.member.id,
    );
    expect(member).toMatchObject({ role: 'admin' });
  });

  it('records the change in audit_log with both roles (RN-05)', async () => {
    const rows = await sql<{ action: string; before: unknown; after: unknown }[]>`
      SELECT action, before, after FROM audit_log
      WHERE action = 'org.member_role_changed' AND entity_id = ${ROLE_ORG.member.id}
      ORDER BY created_at DESC LIMIT 1`;

    expect(rows[0]).toMatchObject({
      action: 'org.member_role_changed',
      before: { role: 'studio' },
      after: { role: 'admin' },
    });
  });

  it('demotes one of two active owners', async () => {
    const res = await patchRole(ownerAToken, ROLE_ORG.ownerB.id, {
      role: 'studio',
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: ROLE_ORG.ownerB.id, role: 'studio' });
  });

  it('refuses to demote the last active owner with 409 (RN-03)', async () => {
    const res = await patchRole(ownerAToken, ROLE_ORG.ownerA.id, {
      role: 'studio',
      confirm: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('admin cannot change roles: 403 (owner-only, RN-01)', async () => {
    const res = await patchRole(seededAdminToken, ROLE_ORG.member.id, {
      role: 'studio',
      confirm: true,
    });
    expect(res.status).toBe(403);
  });

  it('studio cannot change roles: 403', async () => {
    const res = await patchRole(seededStudioToken, ROLE_ORG.member.id, {
      role: 'studio',
      confirm: true,
    });
    expect(res.status).toBe(403);
  });

  it('player cannot change roles: 403', async () => {
    const res = await patchRole(seededPlayerToken, ROLE_ORG.member.id, {
      role: 'studio',
      confirm: true,
    });
    expect(res.status).toBe(403);
  });

  it('404s for a member of another organization (never 403)', async () => {
    const res = await patchRole(seededOwnerToken, ROLE_ORG.member.id, {
      role: 'studio',
      confirm: true,
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('404s for a malformed userId, never 500', async () => {
    const res = await patchRole(ownerAToken, 'nao-e-uuid', { role: 'studio', confirm: true });
    expect(res.status).toBe(404);
  });

  it('422s when confirm is missing (RN-02)', async () => {
    const res = await patchRole(ownerAToken, ROLE_ORG.member.id, { role: 'studio' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('confirm');
  });

  it('422s when confirm is false — never a silent no-op', async () => {
    const res = await patchRole(ownerAToken, ROLE_ORG.member.id, {
      role: 'studio',
      confirm: false,
    });
    expect(res.status).toBe(422);
  });

  it('422s for an unknown role', async () => {
    const res = await patchRole(ownerAToken, ROLE_ORG.member.id, {
      role: 'superuser',
      confirm: true,
    });
    expect(res.status).toBe(422);
  });

  it('leaves organizations.owner_user_id untouched (DECISIONS.md §3)', async () => {
    const rows = await sql<{ ownerUserId: string }[]>`
      SELECT owner_user_id AS "ownerUserId" FROM organizations WHERE id = ${ROLE_ORG.orgId}`;
    expect(rows[0].ownerUserId).toBe(ROLE_ORG.ownerA.id);
  });
});
