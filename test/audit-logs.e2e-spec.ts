import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

/** A dedicated org so the audit trail asserted here can't be polluted by
 * other e2e specs writing to the seeded org's audit_log. */
const AUDIT_ORG = {
  orgId: '01980000-0000-7000-8000-0000000000f1',
  owner: { id: '01980000-0000-7000-8000-0000000000a1', email: 'owner@audit-org.dev' },
};

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('GET /audit-logs (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let ownerToken: string;
  let seededStudioToken: string;
  let seededPlayerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${AUDIT_ORG.owner.id}, ${AUDIT_ORG.owner.email}, password_hash, 'Owner Audit'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${AUDIT_ORG.orgId}, 'Audit Org', 'audit-org', ${AUDIT_ORG.owner.id})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id, status)
      VALUES (gen_random_uuid(), ${AUDIT_ORG.orgId}, ${AUDIT_ORG.owner.id},
              (SELECT id FROM roles WHERE key = 'owner'), 'active')
      ON CONFLICT DO NOTHING`;

    ownerToken = await bearer(app, AUDIT_ORG.owner.email);
    seededStudioToken = await bearer(app, SEED_EMAILS.studio);
    seededPlayerToken = await bearer(app, SEED_EMAILS.player);

    // Generate two deterministic audit rows scoped to this org.
    await request(app.getHttpServer())
      .patch('/orgs/current')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Audit Org Renomeada' });

    await request(app.getHttpServer())
      .post('/orgs/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'convidado@audit-org.dev', role: 'studio' });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('owner reads the org-scoped audit trail, most recent first', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const actions = (res.body.data as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['org.member_invited', 'org.updated']);
  });

  it('filters by action', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs?action=org.updated')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ action: 'org.updated', entity: 'organizations' });
  });

  it('filters by actorUserId', async () => {
    const res = await request(app.getHttpServer())
      .get(`/audit-logs?actorUserId=${AUDIT_ORG.owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body.data as { actorUserId: string; actorEmail: string }[]) {
      expect(row.actorUserId).toBe(AUDIT_ORG.owner.id);
      expect(row.actorEmail).toBe(AUDIT_ORG.owner.email);
    }
  });

  it('paginates by cursor', async () => {
    const first = await request(app.getHttpServer())
      .get('/audit-logs?limit=1')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app.getHttpServer())
      .get(`/audit-logs?limit=1&cursor=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it('studio cannot read the audit trail: 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${seededStudioToken}`);
    expect(res.status).toBe(403);
  });

  it('player cannot read the audit trail: 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${seededPlayerToken}`);
    expect(res.status).toBe(403);
  });

  it('requires authentication: 401 without a token', async () => {
    const res = await request(app.getHttpServer()).get('/audit-logs');
    expect(res.status).toBe(401);
  });
});
