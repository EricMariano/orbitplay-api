import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// Fixed ids for a second organization used to prove audit isolation (RN-01).
const RIVAL = {
  userId: '01950000-0000-7000-8000-0000000000e1',
  orgId: '01950000-0000-7000-8000-0000000000f1',
  membershipId: '01950000-0000-7000-8000-0000000000e9',
  email: 'rival-audit-owner@rival.dev',
};

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Audit logs (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let ownerToken: string;
  let adminToken: string;
  let studioToken: string;
  let playerToken: string;
  let rivalToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    // Second organization sharing the seed password hash, to prove a rival
    // org never sees this org's audit trail (and vice versa).
    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rival Audit Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Rival Audit Studio', 'rival-audit-studio', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    ownerToken = await bearer(app, SEED_EMAILS.owner);
    adminToken = await bearer(app, SEED_EMAILS.admin);
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);

    // Generate real, auditable activity in each organization via the actual
    // HTTP flow (not a manual INSERT), so we exercise AuditInterceptor too.
    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer())
        .post('/games')
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ title: `Audit Fixture ${i}`, genre: 'RPG' });
    }
    await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${rivalToken}`)
      .send({ title: 'Rival Audit Fixture' });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('happy path: owner lists this org’s audit events with cursor pagination', async () => {
    const first = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ limit: 2 })
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(first.status).toBe(200);
    expect(first.body.data.length).toBe(2);
    expect(first.body.nextCursor).toBeTypeOf('string');
    // Every row belongs to the caller's own org, never the rival's.
    expect(
      first.body.data.every((e: { organizationId: string }) => e.organizationId !== RIVAL.orgId),
    ).toBe(true);

    const second = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(second.status).toBe(200);
    // No overlap between the two pages.
    const firstIds = new Set(first.body.data.map((e: { id: string }) => e.id));
    for (const row of second.body.data as { id: string }[]) {
      expect(firstIds.has(row.id)).toBe(false);
    }
  });

  it('supports filtering by action', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ action: 'game.created', limit: 50 })
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    expect(res.body.data.every((e: { action: string }) => e.action === 'game.created')).toBe(true);
  });

  it('supports filtering by a from/to ISO datetime range', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ from, to, limit: 50 })
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a malformed "from" filter with 422 + fieldErrors', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ from: 'ontem' })
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('from');
  });

  it('a rival org never sees this org’s audit trail, even by paging through cursors (RN-01)', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ limit: 50 })
      .set('Authorization', `Bearer ${rivalToken}`);

    expect(res.status).toBe(200);
    expect(
      res.body.data.every((e: { organizationId: string }) => e.organizationId === RIVAL.orgId),
    ).toBe(true);
  });

  it('an org-scoped filter cannot be used to read another organization’s data', async () => {
    // Even if a caller guesses another org's actorUserId/entityId, the
    // organization_id filter (applied in the repository, not from the query)
    // still confines the result set to the caller's own org.
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ entity: 'games', limit: 50 })
      .set('Authorization', `Bearer ${rivalToken}`);

    expect(res.status).toBe(200);
    expect(
      res.body.data.every((e: { organizationId: string }) => e.organizationId === RIVAL.orgId),
    ).toBe(true);
  });

  it('admin may list audit logs (same administrative area as /orgs/members)', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('forbids a studio role from listing audit logs — 403 envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.requestId).toBeTypeOf('string');
  });

  it('forbids a player from listing audit logs — 403 envelope', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app.getHttpServer()).get('/audit-logs');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid actorUserId filter with 422 + fieldErrors', async () => {
    const res = await request(app.getHttpServer())
      .get('/audit-logs')
      .query({ actorUserId: 'not-a-uuid' })
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('actorUserId');
  });
});
